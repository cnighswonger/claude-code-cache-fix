import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ext, {
  extractCwdFromSystem,
  deriveSnapshotKey,
  findDeferredToolsBlockInBody,
  persistDeferredTools,
  restoreDeferredTools,
  AVAILABLE_MARKER,
  UNAVAILABLE_MARKER,
} from "../proxy/extensions/deferred-tools-restore.mjs";

// `import.meta.dirname` requires Node 20.11+; CI matrix includes Node 18.
const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Helpers ---

async function newTmp() {
  return mkdtemp(join(tmpdir(), "deferred-tools-test-"));
}

// Build a system block array shaped like real CC v2.1.117+ system prompts:
// [0] = role boilerplate (identical across projects)
// [1] = giant block containing # Environment with the cwd marker.
function makeSystem(cwd, { extra = "" } = {}) {
  return [
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    {
      type: "text",
      text:
        "boilerplate intro line\n" +
        "another line\n" +
        "\n" +
        "# Environment\n" +
        "You have been invoked in the following environment:\n" +
        ` - Primary working directory: ${cwd}\n` +
        "  - Is a git repository: true\n" +
        " - Platform: linux\n" +
        extra,
    },
  ];
}

function makeBaselineBlock(toolCount = 5) {
  const tools = Array.from({ length: toolCount }, (_, i) => `tool_${i}: a tool`).join("\n");
  return (
    `<system-reminder>\n${AVAILABLE_MARKER}:\n${tools}\n</system-reminder>`
  );
}

function makeShrunkBlock() {
  // Shorter; contains both AVAILABLE and UNAVAILABLE markers
  return (
    `<system-reminder>\n${AVAILABLE_MARKER}:\nbuiltin_only_1\nbuiltin_only_2\n` +
    `${UNAVAILABLE_MARKER} (their MCP server disconnected). ` +
    `Do not search for them — ToolSearch will return no match:\n</system-reminder>`
  );
}

function makeBody({ system, deferredText, msgIdx = 0, blockIdx = 0 } = {}) {
  // Build N user messages so deferredText can sit at arbitrary indices
  const messages = [];
  for (let i = 0; i <= msgIdx; i++) {
    if (i === msgIdx) {
      const content = [];
      for (let j = 0; j <= blockIdx; j++) {
        if (j === blockIdx) {
          content.push({ type: "text", text: deferredText });
        } else {
          content.push({ type: "text", text: `padding_block_${j}` });
        }
      }
      messages.push({ role: "user", content });
    } else {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `padding_msg_${i}` }],
      });
    }
  }
  return { system, messages };
}

async function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join("");
}

// --- extractCwdFromSystem ---

test("extractCwdFromSystem: returns null on missing/empty inputs", () => {
  assert.equal(extractCwdFromSystem(null), null);
  assert.equal(extractCwdFromSystem(undefined), null);
  assert.equal(extractCwdFromSystem(""), null);
  assert.equal(extractCwdFromSystem([]), null);
  assert.equal(extractCwdFromSystem(42), null);
});

test("extractCwdFromSystem: parses cwd from CC's # Environment block", () => {
  const sys = makeSystem("/repo/myproject");
  assert.equal(extractCwdFromSystem(sys), "/repo/myproject");
});

test("extractCwdFromSystem: also accepts string system prompt", () => {
  const text =
    "# Environment\n" +
    "You have been invoked in the following environment:\n" +
    " - Primary working directory: /var/projects/foo\n" +
    " - Platform: linux\n";
  assert.equal(extractCwdFromSystem(text), "/var/projects/foo");
});

test("extractCwdFromSystem: returns null when marker is absent", () => {
  const sys = [
    { type: "text", text: "boilerplate" },
    { type: "text", text: "no environment section here" },
  ];
  assert.equal(extractCwdFromSystem(sys), null);
});

test("extractCwdFromSystem: narrative mention of working directory does NOT match", () => {
  // The marker requires line-start "- Primary working directory:"; narrative
  // text mentioning the phrase does not have that structure.
  const sys = [
    {
      type: "text",
      text:
        "When you change the current working directory you should reconsider context. " +
        "Primary working directory should be respected.",
    },
  ];
  assert.equal(extractCwdFromSystem(sys), null);
});

test("extractCwdFromSystem: only the structurally-valid section yields a match", () => {
  const sys = [
    { type: "text", text: "no marker here" },
    {
      type: "text",
      text:
        "# Environment\n" +
        "You have been invoked in the following environment:\n" +
        " - Primary working directory: /first/match\n" +
        "more content",
    },
    {
      // No # Environment header + intro line in this block, so the marker
      // line is ignored even though it's syntactically valid in isolation.
      type: "text",
      text: " - Primary working directory: /should/not/win\n",
    },
  ];
  assert.equal(extractCwdFromSystem(sys), "/first/match");
});

test("extractCwdFromSystem: rejects code-fenced fake marker without # Environment header", () => {
  const sys = [
    {
      type: "text",
      text:
        "Example output:\n" +
        "```\n" +
        " - Primary working directory: /WRONG/path/from/example\n" +
        "```\n",
    },
  ];
  assert.equal(extractCwdFromSystem(sys), null);
});

test("extractCwdFromSystem: rejects bare # Environment header without the intro line", () => {
  // A user note or other section that happens to be titled # Environment
  // but doesn't carry the CC intro line is NOT an env section.
  const sys = [
    {
      type: "text",
      text:
        "# Environment\n" +
        "(this is a user note about environment variables)\n" +
        " - Primary working directory: /not/the/real/marker\n",
    },
  ];
  assert.equal(extractCwdFromSystem(sys), null);
});

test("extractCwdFromSystem: prefers real # Environment marker over earlier fake in fence", () => {
  const fakeBlock = {
    type: "text",
    text:
      "Tutorial section:\n" +
      "```\n" +
      " - Primary working directory: /tutorial/example\n" +
      "```\n",
  };
  const realBlock = {
    type: "text",
    text:
      "# Environment\n" +
      "You have been invoked in the following environment:\n" +
      " - Primary working directory: /actual/cwd\n" +
      " - Platform: linux\n",
  };
  assert.equal(extractCwdFromSystem([fakeBlock, realBlock]), "/actual/cwd");
  assert.equal(extractCwdFromSystem([realBlock, fakeBlock]), "/actual/cwd");
});

test("extractCwdFromSystem: ignores marker that appears BEFORE the # Environment header in same block", () => {
  const sys = [
    {
      type: "text",
      text:
        " - Primary working directory: /pre-env/fake\n" +
        "...much later in the block...\n" +
        "# Environment\n" +
        "You have been invoked in the following environment:\n" +
        " - Primary working directory: /actual/cwd\n",
    },
  ];
  assert.equal(extractCwdFromSystem(sys), "/actual/cwd");
});

test("extractCwdFromSystem: returns null when MULTIPLE structurally-valid env sections disagree", () => {
  // Two valid env sections in the same block (e.g. one inside a code fence
  // showing a full example, one real). Refusing to pick is the safe move.
  const sys = [
    {
      type: "text",
      text:
        "# Environment\n" +
        "You have been invoked in the following environment:\n" +
        " - Primary working directory: /first\n" +
        " - Platform: linux\n" +
        "\n" +
        "Some narrative...\n" +
        "\n" +
        "# Environment\n" +
        "You have been invoked in the following environment:\n" +
        " - Primary working directory: /second\n" +
        " - Platform: linux\n",
    },
  ];
  assert.equal(extractCwdFromSystem(sys), null);
});

test("extractCwdFromSystem: returns null when valid env sections in different blocks disagree", () => {
  const sys = [
    {
      type: "text",
      text:
        "# Environment\n" +
        "You have been invoked in the following environment:\n" +
        " - Primary working directory: /block-A\n",
    },
    {
      type: "text",
      text:
        "# Environment\n" +
        "You have been invoked in the following environment:\n" +
        " - Primary working directory: /block-B\n",
    },
  ];
  assert.equal(extractCwdFromSystem(sys), null);
});

test("extractCwdFromSystem: identical cwds across multiple valid sections still resolve", () => {
  // If multiple env sections exist but all agree, that's not ambiguous.
  const sys = [
    {
      type: "text",
      text:
        "# Environment\n" +
        "You have been invoked in the following environment:\n" +
        " - Primary working directory: /same\n",
    },
    {
      type: "text",
      text:
        "# Environment\n" +
        "You have been invoked in the following environment:\n" +
        " - Primary working directory: /same\n",
    },
  ];
  assert.equal(extractCwdFromSystem(sys), "/same");
});

// --- deriveSnapshotKey ---

test("deriveSnapshotKey: deterministic per cwd, distinct across cwds", () => {
  const a1 = deriveSnapshotKey("/foo");
  const a2 = deriveSnapshotKey("/foo");
  const b = deriveSnapshotKey("/bar");
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.equal(a1.length, 16);
});

// --- findDeferredToolsBlockInBody ---

test("findDeferredToolsBlockInBody: finds block at [0][0]", () => {
  const body = makeBody({ deferredText: makeBaselineBlock() });
  const found = findDeferredToolsBlockInBody(body);
  assert.ok(found);
  assert.equal(found.msgIdx, 0);
  assert.equal(found.blockIdx, 0);
});

test("findDeferredToolsBlockInBody: finds block at arbitrary [N][M]", () => {
  const body = makeBody({ deferredText: makeBaselineBlock(), msgIdx: 4, blockIdx: 3 });
  const found = findDeferredToolsBlockInBody(body);
  assert.ok(found);
  assert.equal(found.msgIdx, 4);
  assert.equal(found.blockIdx, 3);
});

test("findDeferredToolsBlockInBody: skips assistant messages", () => {
  // Place AVAILABLE marker in an assistant message — must NOT match
  const body = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: makeBaselineBlock() }],
      },
    ],
  };
  assert.equal(findDeferredToolsBlockInBody(body), null);
});

test("findDeferredToolsBlockInBody: returns null when block missing", () => {
  const body = {
    messages: [{ role: "user", content: [{ type: "text", text: "no marker" }] }],
  };
  assert.equal(findDeferredToolsBlockInBody(body), null);
});

// --- persist + restore happy paths ---

test("persistDeferredTools: writes snapshot atomically", async () => {
  const dir = await newTmp();
  try {
    const text = makeBaselineBlock();
    const key = "abc1234567890def";
    const result = await persistDeferredTools(text, { dir, key });
    assert.ok(result.persisted);
    assert.equal(result.bytes, Buffer.byteLength(text, "utf-8"));
    const path = join(dir, `deferred-tools-${key}.txt`);
    const onDisk = await readFile(path, "utf-8");
    assert.equal(onDisk, text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restoreDeferredTools: returns the snapshot when valid", async () => {
  const dir = await newTmp();
  try {
    const text = makeBaselineBlock(20);
    const key = "abc1234567890def";
    await persistDeferredTools(text, { dir, key });
    const restored = await restoreDeferredTools({ dir, key });
    assert.equal(restored, text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restoreDeferredTools: returns null when snapshot missing", async () => {
  const dir = await newTmp();
  try {
    const restored = await restoreDeferredTools({ dir, key: "nonexistentkey00" });
    assert.equal(restored, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- snapshot integrity validation ---

test("restoreDeferredTools: rejects truncated snapshot (shorter than AVAILABLE_MARKER)", async () => {
  const dir = await newTmp();
  try {
    const key = "trunc1234567890a";
    const path = join(dir, `deferred-tools-${key}.txt`);
    await writeFile(path, "tiny");
    const restored = await restoreDeferredTools({ dir, key });
    assert.equal(restored, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restoreDeferredTools: rejects same-length snapshot missing AVAILABLE marker", async () => {
  const dir = await newTmp();
  try {
    const key = "missingmark12345";
    const path = join(dir, `deferred-tools-${key}.txt`);
    // Make a snapshot LONGER than AVAILABLE_MARKER but missing the marker text
    await writeFile(path, "x".repeat(AVAILABLE_MARKER.length + 100));
    const restored = await restoreDeferredTools({ dir, key });
    assert.equal(restored, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restoreDeferredTools: rejects snapshot containing UNAVAILABLE marker (defense-in-depth)", async () => {
  // Persisted snapshots should never contain UNAVAILABLE by construction
  // (we only persist when !hasUnavail), but if one ever does, refuse to
  // restore. Restoring a "no longer available" block would be worse than
  // not restoring at all.
  const dir = await newTmp();
  try {
    const key = "hasunavail123456";
    const path = join(dir, `deferred-tools-${key}.txt`);
    await writeFile(
      path,
      `${AVAILABLE_MARKER}: tool1, tool2\n${UNAVAILABLE_MARKER} (their MCP server disconnected)`,
    );
    const restored = await restoreDeferredTools({ dir, key });
    assert.equal(restored, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- atomic write under failure ---

test("persistDeferredTools: rename failure leaves prior snapshot intact", async () => {
  const dir = await newTmp();
  try {
    const key = "renamefail123456";
    const path = join(dir, `deferred-tools-${key}.txt`);
    const original = makeBaselineBlock(50);
    await persistDeferredTools(original, { dir, key });
    const before = await readFile(path, "utf-8");

    const failingFs = {
      rename: async () => {
        throw new Error("simulated rename failure");
      },
    };
    let result;
    await captureStderr(async () => {
      result = await persistDeferredTools(makeBaselineBlock(80), {
        dir,
        key,
        fs: failingFs,
      });
    });
    assert.equal(result.persisted, false);
    const after = await readFile(path, "utf-8");
    assert.equal(after, before, "original snapshot must be unchanged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistDeferredTools: writeFile failure produces no orphan tmp and no rename", async () => {
  const dir = await newTmp();
  try {
    const key = "writefail1234567";

    let renameCalled = false;
    const failingFs = {
      writeFile: async () => {
        throw new Error("simulated writeFile failure");
      },
      rename: async () => {
        renameCalled = true;
      },
    };
    let result;
    await captureStderr(async () => {
      result = await persistDeferredTools(makeBaselineBlock(), {
        dir,
        key,
        fs: failingFs,
      });
    });
    assert.equal(result.persisted, false);
    assert.equal(renameCalled, false, "rename must not be attempted on writeFile failure");
    // No .tmp orphan should exist
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.includes(".tmp")).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- onRequest end-to-end (extension default export) ---

const CWD = "/home/test/project-X";

function fullBody({ deferredText, system = makeSystem(CWD), msgIdx = 0, blockIdx = 0 } = {}) {
  const partial = makeBody({ deferredText, msgIdx, blockIdx });
  return { system, messages: partial.messages };
}

test("onRequest: no-op when CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE=1 (verified via re-import)", async () => {
  const prevSkip = process.env.CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE;
  try {
    process.env.CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE = "1";
    const url =
      pathToFileURL(
        join(__dirname, "..", "proxy", "extensions", "deferred-tools-restore.mjs"),
      ).href + "?skipReload=" + Date.now();
    const reloaded = await import(url);
    const ctx = { body: fullBody({ deferredText: makeBaselineBlock() }), meta: {} };
    const before = JSON.stringify(ctx.body);
    await reloaded.default.onRequest(ctx);
    assert.equal(JSON.stringify(ctx.body), before);
    // No stats set when skip kicks in early
    assert.equal(ctx.meta.deferredToolsRestoreStats, undefined);
  } finally {
    if (prevSkip === undefined) delete process.env.CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE;
    else process.env.CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE = prevSkip;
  }
});

test("onRequest: no-op when system absent", async () => {
  const ctx = { body: { messages: [] }, meta: {} };
  await ext.onRequest(ctx);
  assert.equal(ctx.meta.deferredToolsRestoreStats?.action, "skipped");
  assert.equal(ctx.meta.deferredToolsRestoreStats?.reason, "no-cwd");
});

test("onRequest: no-op when cwd marker not in system", async () => {
  const ctx = {
    body: { system: [{ type: "text", text: "no environment section" }], messages: [] },
    meta: {},
  };
  await ext.onRequest(ctx);
  assert.equal(ctx.meta.deferredToolsRestoreStats?.reason, "no-cwd");
});

test("onRequest: no-op when no deferred-tools block in messages", async () => {
  const ctx = {
    body: {
      system: makeSystem(CWD),
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
    meta: {},
  };
  const before = JSON.stringify(ctx.body);
  await ext.onRequest(ctx);
  assert.equal(JSON.stringify(ctx.body), before);
  assert.equal(ctx.meta.deferredToolsRestoreStats?.reason, "no-block");
});

test("onRequest: persists baseline (no UNAVAILABLE marker)", async () => {
  const dir = await newTmp();
  // Persist via the extension end-to-end
  const baseline = makeBaselineBlock(40);
  const ctx = { body: fullBody({ deferredText: baseline }), meta: {} };

  // Patch the snapshot dir by temporarily setting HOME
  const realHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    await captureStderr(async () => {
      await ext.onRequest(ctx);
    });
    assert.equal(ctx.meta.deferredToolsRestoreStats?.action, "persisted");
    const key = deriveSnapshotKey(CWD);
    const snapPath = join(dir, ".claude", "cache-fix-state", `deferred-tools-${key}.txt`);
    const onDisk = await readFile(snapPath, "utf-8");
    assert.equal(onDisk, baseline);
  } finally {
    process.env.HOME = realHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("onRequest: restores from snapshot when block has UNAVAILABLE marker AND snapshot longer", async () => {
  const dir = await newTmp();
  const baseline = makeBaselineBlock(40);
  const shrunk = makeShrunkBlock();
  assert.ok(baseline.length > shrunk.length, "test fixture sanity");

  const realHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    // First call: persist the baseline
    const ctx1 = { body: fullBody({ deferredText: baseline }), meta: {} };
    await captureStderr(async () => {
      await ext.onRequest(ctx1);
    });

    // Second call: shrunk block, should be restored
    const ctx2 = { body: fullBody({ deferredText: shrunk }), meta: {} };
    await captureStderr(async () => {
      await ext.onRequest(ctx2);
    });
    assert.equal(ctx2.meta.deferredToolsRestoreStats?.action, "restored");
    assert.equal(ctx2.body.messages[0].content[0].text, baseline);
  } finally {
    process.env.HOME = realHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("onRequest: skips restore when no snapshot exists for key", async () => {
  const dir = await newTmp();
  const realHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    // No prior persist; only a shrunk block this time
    const ctx = { body: fullBody({ deferredText: makeShrunkBlock() }), meta: {} };
    const before = JSON.stringify(ctx.body);
    await captureStderr(async () => {
      await ext.onRequest(ctx);
    });
    assert.equal(ctx.meta.deferredToolsRestoreStats?.reason, "no-snapshot");
    assert.equal(JSON.stringify(ctx.body), before);
  } finally {
    process.env.HOME = realHome;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Downgrade guard exhaustive boundary cases ---

async function downgradeTest(snapshotLen, currentLen, expectAction) {
  const dir = await newTmp();
  const realHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    // Build snapshot of exact byte length, ensuring AVAILABLE marker present
    const padding = (n) =>
      "x".repeat(Math.max(0, n - AVAILABLE_MARKER.length));
    const snap = AVAILABLE_MARKER + padding(snapshotLen);
    const cur =
      AVAILABLE_MARKER + padding(currentLen - UNAVAILABLE_MARKER.length) + UNAVAILABLE_MARKER;
    // Sanity: actual lengths
    assert.equal(snap.length, snapshotLen, "snap length sanity");
    assert.equal(cur.length, currentLen, "cur length sanity");

    const key = deriveSnapshotKey(CWD);
    await persistDeferredTools(snap, {
      dir: join(dir, ".claude", "cache-fix-state"),
      key,
    });

    const ctx = { body: fullBody({ deferredText: cur }), meta: {} };
    await captureStderr(async () => {
      await ext.onRequest(ctx);
    });
    assert.equal(
      ctx.meta.deferredToolsRestoreStats?.action,
      expectAction,
      `snapshot=${snapshotLen}, current=${currentLen}, expected ${expectAction}`,
    );
  } finally {
    process.env.HOME = realHome;
    await rm(dir, { recursive: true, force: true });
  }
}

test("downgrade guard: snapshot 1 byte shorter than current → skipped", async () => {
  await downgradeTest(199, 200, "skipped");
});

test("downgrade guard: snapshot many bytes shorter than current → skipped", async () => {
  await downgradeTest(150, 250, "skipped");
});

test("downgrade guard: snapshot exactly equal length to current → skipped", async () => {
  await downgradeTest(200, 200, "skipped");
});

test("downgrade guard: snapshot 1 byte longer than current → restored", async () => {
  await downgradeTest(201, 200, "restored");
});

// --- Concurrency ---

test("onRequest: concurrent persist calls do not corrupt the snapshot", async () => {
  const dir = await newTmp();
  const realHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const blockA = makeBaselineBlock(30);
    const blockB = makeBaselineBlock(31);
    const results = await Promise.all([
      captureStderr(async () => {
        await ext.onRequest({ body: fullBody({ deferredText: blockA }), meta: {} });
      }),
      captureStderr(async () => {
        await ext.onRequest({ body: fullBody({ deferredText: blockB }), meta: {} });
      }),
    ]);
    // No stderr should contain a thrown-stack trace
    for (const out of results) {
      assert.ok(!out.includes("UnhandledRejection"));
    }
    // Final snapshot must be exactly one of the two candidates
    const key = deriveSnapshotKey(CWD);
    const snapPath = join(dir, ".claude", "cache-fix-state", `deferred-tools-${key}.txt`);
    const onDisk = await readFile(snapPath, "utf-8");
    assert.ok(
      onDisk === blockA || onDisk === blockB,
      "final snapshot must equal exactly one of the two candidate blocks",
    );
  } finally {
    process.env.HOME = realHome;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Debug-log paths (deterministic via re-import with DEBUG=1) ---

test("snapshotPrefix-style: snapshot read failure with debug=1 logs", async () => {
  const dir = await newTmp();
  const prevDebug = process.env.CACHE_FIX_DEBUG;
  try {
    process.env.CACHE_FIX_DEBUG = "1";
    const url =
      pathToFileURL(
        join(__dirname, "..", "proxy", "extensions", "deferred-tools-restore.mjs"),
      ).href + "?debugRead=" + Date.now();
    const reloaded = await import(url);

    const failingFs = {
      readFile: async () => {
        const err = new Error("EACCES simulated");
        err.code = "EACCES";
        throw err;
      },
    };
    const stderr = await captureStderr(async () => {
      const out = await reloaded.restoreDeferredTools({
        dir,
        key: "abcdef0123456789",
        fs: failingFs,
      });
      assert.equal(out, null);
    });
    assert.ok(
      stderr.includes("snapshot read failed"),
      `expected debug log, got: ${JSON.stringify(stderr)}`,
    );
  } finally {
    if (prevDebug === undefined) delete process.env.CACHE_FIX_DEBUG;
    else process.env.CACHE_FIX_DEBUG = prevDebug;
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistDeferredTools: write failure with debug=1 logs", async () => {
  const dir = await newTmp();
  const prevDebug = process.env.CACHE_FIX_DEBUG;
  try {
    process.env.CACHE_FIX_DEBUG = "1";
    const url =
      pathToFileURL(
        join(__dirname, "..", "proxy", "extensions", "deferred-tools-restore.mjs"),
      ).href + "?debugWrite=" + Date.now();
    const reloaded = await import(url);

    const failingFs = {
      writeFile: async () => {
        throw new Error("ENOSPC simulated");
      },
    };
    const stderr = await captureStderr(async () => {
      const out = await reloaded.persistDeferredTools(makeBaselineBlock(), {
        dir,
        key: "abcdef0123456789",
        fs: failingFs,
      });
      assert.equal(out.persisted, false);
    });
    assert.ok(
      stderr.includes("persist failed"),
      `expected debug log, got: ${JSON.stringify(stderr)}`,
    );
  } finally {
    if (prevDebug === undefined) delete process.env.CACHE_FIX_DEBUG;
    else process.env.CACHE_FIX_DEBUG = prevDebug;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Extension contract metadata ---

test("default has correct extension contract metadata", () => {
  assert.equal(ext.name, "deferred-tools-restore");
  assert.equal(ext.order, 350);
  assert.equal(ext.enabled, true);
  assert.equal(typeof ext.onRequest, "function");
});

test("onRequest: tolerates missing ctx and missing body", async () => {
  await ext.onRequest({});
  await ext.onRequest({ body: null });
  await ext.onRequest(null);
  // No throw = pass
  assert.ok(true);
});
