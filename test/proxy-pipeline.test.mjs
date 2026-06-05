import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `pipeline-test-${Date.now()}`);
const configPath = join(testDir, "extensions.json");

async function freshImport() {
  const mod = await import("../proxy/pipeline.mjs?t=" + Date.now());
  return mod;
}

describe("extension pipeline", () => {
  before(async () => {
    await mkdir(testDir, { recursive: true });
  });

  after(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("loadExtensions", () => {
    it("loads extensions from directory sorted by order", async () => {
      const extA = `export default { name: "ext-a", order: 200, onRequest(ctx) { ctx.meta.order.push("a"); } };`;
      const extB = `export default { name: "ext-b", order: 100, onRequest(ctx) { ctx.meta.order.push("b"); } };`;

      await writeFile(join(testDir, "ext-a.mjs"), extA);
      await writeFile(join(testDir, "ext-b.mjs"), extB);
      await writeFile(configPath, JSON.stringify({}));

      const { loadExtensions } = await freshImport();
      const exts = await loadExtensions(testDir, configPath);

      assert.equal(exts.length, 2);
      assert.equal(exts[0].name, "ext-b");
      assert.equal(exts[1].name, "ext-a");
    });

    it("respects config enabled=false", async () => {
      await writeFile(configPath, JSON.stringify({ "ext-a": { enabled: false } }));

      const { loadExtensions } = await freshImport();
      const exts = await loadExtensions(testDir, configPath);

      assert.equal(exts.length, 1);
      assert.equal(exts[0].name, "ext-b");
    });

    it("respects config order override", async () => {
      await writeFile(configPath, JSON.stringify({ "ext-a": { enabled: true, order: 50 } }));

      const { loadExtensions } = await freshImport();
      const exts = await loadExtensions(testDir, configPath);

      assert.equal(exts.length, 2);
      assert.equal(exts[0].name, "ext-a");
    });

    it("skips files that fail to load", async () => {
      await writeFile(join(testDir, "bad.mjs"), "throw new Error('oops');");
      await writeFile(configPath, JSON.stringify({}));

      const { loadExtensions } = await freshImport();
      const exts = await loadExtensions(testDir, configPath);

      assert.ok(exts.length >= 2);
      assert.ok(!exts.find((e) => e.name === undefined));

      await rm(join(testDir, "bad.mjs"));
    });

    it("skips modules without name export", async () => {
      await writeFile(join(testDir, "noname.mjs"), "export default { order: 1 };");
      await writeFile(configPath, JSON.stringify({}));

      const { loadExtensions } = await freshImport();
      const exts = await loadExtensions(testDir, configPath);

      assert.ok(!exts.find((e) => e._file === "noname.mjs"));

      await rm(join(testDir, "noname.mjs"));
    });
  });

  describe("runOnRequest", () => {
    it("executes hooks in order and mutates ctx", async () => {
      const { loadExtensions, runOnRequest } = await freshImport();
      await writeFile(configPath, JSON.stringify({}));
      await loadExtensions(testDir, configPath);

      const ctx = { body: { model: "test" }, headers: {}, meta: { order: [] } };
      await runOnRequest(ctx);

      assert.deepEqual(ctx.meta.order, ["b", "a"]);
    });

    it("returns skip result and stops pipeline", async () => {
      const skipExt = `export default { name: "skipper", order: 50, onRequest() { return { skip: true, status: 429, body: { error: "rate_limited" } }; } };`;
      await writeFile(join(testDir, "skipper.mjs"), skipExt);
      await writeFile(configPath, JSON.stringify({}));

      const { loadExtensions, runOnRequest } = await freshImport();
      await loadExtensions(testDir, configPath);

      const ctx = { body: {}, headers: {}, meta: { order: [] } };
      const result = await runOnRequest(ctx);

      assert.equal(result.skip, true);
      assert.equal(result.status, 429);
      assert.deepEqual(ctx.meta.order, []);

      await rm(join(testDir, "skipper.mjs"));
    });

    it("isolates errors — one failing hook does not stop others", async () => {
      const failExt = `export default { name: "failer", order: 90, onRequest() { throw new Error("boom"); } };`;
      await writeFile(join(testDir, "failer.mjs"), failExt);
      await writeFile(configPath, JSON.stringify({}));

      const { loadExtensions, runOnRequest } = await freshImport();
      await loadExtensions(testDir, configPath);

      const ctx = { body: {}, headers: {}, meta: { order: [] } };
      await runOnRequest(ctx);

      assert.ok(ctx.meta.order.includes("b"));
      assert.ok(ctx.meta.order.includes("a"));

      await rm(join(testDir, "failer.mjs"));
    });
  });

  describe("runOnStreamEvent", () => {
    it("passes event through all hooks", async () => {
      const streamExt = `export default { name: "stream-ext", order: 1, onStreamEvent(ctx) { ctx.event.modified = true; } };`;
      await writeFile(join(testDir, "stream-ext.mjs"), streamExt);
      await writeFile(configPath, JSON.stringify({}));

      const { loadExtensions, runOnStreamEvent } = await freshImport();
      await loadExtensions(testDir, configPath);

      const ctx = { event: { type: "content_block_delta" }, meta: {}, telemetry: {} };
      await runOnStreamEvent(ctx);

      assert.equal(ctx.event.modified, true);

      await rm(join(testDir, "stream-ext.mjs"));
    });
  });

  describe("snapshotRegistry", () => {
    it("returns independent copy of registry", async () => {
      await writeFile(configPath, JSON.stringify({}));

      const { loadExtensions, snapshotRegistry, getRegistry } = await freshImport();
      await loadExtensions(testDir, configPath);

      const snapshot = snapshotRegistry();
      assert.deepEqual(snapshot.map((e) => e.name), getRegistry().map((e) => e.name));
      snapshot.push({ name: "injected" });
      assert.ok(!getRegistry().find((e) => e.name === "injected"));
    });
  });

  // Regression coverage for #196: when an extension fails to import (e.g.,
  // because of a Node ESM cache stale-import race against a transitive
  // dependency), it must surface via getFailedExtensions() so that operator-
  // facing observability (/health) can report the degraded state. The prior
  // behavior was to silently stderr-log and proceed; #192's v2 extension
  // was broken in production for 17 hours through exactly this silence.
  describe("getFailedExtensions (#196)", () => {
    it("returns empty array when all extensions load successfully", async () => {
      const goodExt = `export default { name: "good", order: 100, onRequest(ctx) {} };`;
      await writeFile(join(testDir, "good-ext.mjs"), goodExt);
      await writeFile(configPath, JSON.stringify({}));

      const { loadExtensions, getFailedExtensions } = await freshImport();
      await loadExtensions(testDir, configPath);

      assert.deepEqual(getFailedExtensions(), []);

      await rm(join(testDir, "good-ext.mjs"));
    });

    it("records an extension whose import throws (broken syntax)", async () => {
      const brokenExt = `import { nonexistent } from "./nonexistent-helper.mjs"; export default { name: "broken" };`;
      await writeFile(join(testDir, "broken-ext.mjs"), brokenExt);
      await writeFile(configPath, JSON.stringify({}));

      const { loadExtensions, getFailedExtensions } = await freshImport();
      await loadExtensions(testDir, configPath);

      const failed = getFailedExtensions();
      assert.equal(failed.length, 1);
      assert.equal(failed[0].file, "broken-ext.mjs");
      assert.ok(failed[0].error.length > 0);
      assert.match(failed[0].lastAttempt, /^\d{4}-\d{2}-\d{2}T/); // ISO timestamp

      await rm(join(testDir, "broken-ext.mjs"));
    });

    it("clears failed entries on a subsequent successful reload", async () => {
      // First load: broken extension
      const brokenExt = `throw new Error("intentional load failure for test");`;
      await writeFile(join(testDir, "fix-me.mjs"), brokenExt);
      await writeFile(configPath, JSON.stringify({}));

      const { loadExtensions, getFailedExtensions } = await freshImport();
      await loadExtensions(testDir, configPath);
      assert.equal(getFailedExtensions().length, 1);

      // Reload after fixing the extension on disk
      const fixedExt = `export default { name: "fixed", order: 100, onRequest(ctx) {} };`;
      await writeFile(join(testDir, "fix-me.mjs"), fixedExt);
      await loadExtensions(testDir, configPath);
      assert.equal(getFailedExtensions().length, 0);

      await rm(join(testDir, "fix-me.mjs"));
    });

    it("returns independent copy so callers cannot mutate internal state", async () => {
      const brokenExt = `throw new Error("test failure");`;
      await writeFile(join(testDir, "test-mutation.mjs"), brokenExt);
      await writeFile(configPath, JSON.stringify({}));

      const { loadExtensions, getFailedExtensions } = await freshImport();
      await loadExtensions(testDir, configPath);

      const failed = getFailedExtensions();
      failed[0].error = "tampered";
      failed.push({ file: "injected", error: "x", lastAttempt: "y" });

      const stillTrueState = getFailedExtensions();
      assert.equal(stillTrueState.length, 1);
      assert.ok(stillTrueState[0].error !== "tampered");

      await rm(join(testDir, "test-mutation.mjs"));
    });
  });
});
