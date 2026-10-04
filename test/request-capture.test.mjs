import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOnRequest } from "../proxy/pipeline.mjs";
import ext, {
  resolveCaptureKey,
  buildCaptureRecord,
  sweepCaptureDir,
  buildOutcomeRecord,
} from "../proxy/extensions/request-capture.mjs";

function makeCtx(overrides = {}) {
  return {
    body: {
      model: "claude-opus-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      ...overrides.body,
    },
    headers: {
      "anthropic-beta": "context-1m-2025-08-07",
      "x-session-id": "abc-123",
      authorization: "Bearer SECRET",
      ...overrides.headers,
    },
    meta: { route: "messages" },
  };
}

test("request-capture: disabled by default (no env flag) — onRequest is a no-op", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capture-test-"));
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  const prevFlag = process.env.CACHE_FIX_REQUEST_CAPTURE;
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.CACHE_FIX_REQUEST_CAPTURE;
  try {
    await ext.onRequest(makeCtx());
    const entries = await readdir(dir);
    assert.deepEqual(entries, [], "no capture dir should be created when disabled");
  } finally {
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    if (prevFlag !== undefined) process.env.CACHE_FIX_REQUEST_CAPTURE = prevFlag;
    await rm(dir, { recursive: true, force: true });
  }
});

test("request-capture: enabled — appends one full-body NDJSON record per request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capture-test-"));
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  const prevFlag = process.env.CACHE_FIX_REQUEST_CAPTURE;
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.CACHE_FIX_REQUEST_CAPTURE = "1";
  try {
    const ctx = makeCtx();
    await ext.onRequest(ctx);
    await ext.onRequest(ctx);
    const captureDir = join(dir, "cache-fix-captures");
    const files = await readdir(captureDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^s-abc-123-requests\.jsonl$/);
    const all = (await readFile(join(captureDir, files[0]), "utf-8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    // The first write of a boot stamps a provenance record — the restart
    // boundary and the gate set the traffic was captured under. It carries no
    // body and is not a request.
    const boots = all.filter((r) => r.type === "boot");
    assert.equal(boots.length, 1, "one boot record per file per proxy boot");
    assert.ok(boots[0].gates, "the boot record names the gates in force");
    const lines = all.filter((r) => !r.type);
    assert.equal(lines.length, 2);
    const rec = lines[0];
    assert.equal(rec.body.model, "claude-opus-5");
    assert.deepEqual(rec.body.messages, ctx.body.messages, "body captured verbatim");
    assert.equal(rec.headers["anthropic-beta"], "context-1m-2025-08-07");
    assert.ok(rec.id, "every request record carries a join id");
  } finally {
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    if (prevFlag === undefined) delete process.env.CACHE_FIX_REQUEST_CAPTURE;
    else process.env.CACHE_FIX_REQUEST_CAPTURE = prevFlag;
    await rm(dir, { recursive: true, force: true });
  }
});

test("request-capture: record never contains auth material", () => {
  const rec = buildCaptureRecord(makeCtx());
  const flat = JSON.stringify(rec);
  assert.doesNotMatch(flat, /SECRET/, "authorization header must not be captured");
  assert.equal(Object.keys(rec.headers).length, 2, "only beta + session-id headers");
});

test("resolveCaptureKey: session header preferred, content-hash fallback", () => {
  const withSid = resolveCaptureKey({ "x-session-id": "abc" }, { messages: [] });
  assert.equal(withSid, "s-abc");
  const noSid = resolveCaptureKey(
    {},
    { messages: [{ role: "user", content: "x" }] },
  );
  assert.match(noSid, /^c-[0-9a-f]{12}$/);
  const empty = resolveCaptureKey({}, { messages: [] });
  assert.equal(empty, "c-empty");
});

test("sweepCaptureDir: deletes oldest files first until under the cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capture-sweep-"));
  try {
    // Three 100-byte files with distinct mtimes (writes are sequential).
    for (const name of ["a", "b", "c"]) {
      await writeFile(join(dir, `s-${name}-requests.jsonl`), "x".repeat(100));
      await new Promise((r) => setTimeout(r, 10));
    }
    const deleted = await sweepCaptureDir(dir, 150);
    assert.equal(deleted, 2, "two oldest deleted to get 300 bytes under 150");
    const left = await readdir(dir);
    assert.deepEqual(left, ["s-c-requests.jsonl"], "newest survives");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sweepCaptureDir: no-op under the cap and on missing dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capture-sweep-"));
  try {
    await writeFile(join(dir, "s-a-requests.jsonl"), "x".repeat(50));
    assert.equal(await sweepCaptureDir(dir, 1000), 0);
    assert.equal(await sweepCaptureDir(join(dir, "does-not-exist"), 1000), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Outcome records: what the API actually charged ---
//
// A capture recorded what was SENT and never what it cost, so every cache
// question was answered by inference. prefix-diff's `cause` is a hypothesis
// about what the API keyed on, not a measurement, and correlating a bust to a
// request meant comparing wall clocks against a separate ledger — which
// mis-attributed a 484k event to the wrong session twice in one evening.

test("outcome record carries the full usage the API reported", () => {
  const ctx = {
    meta: {
      cacheStats: { cacheRead: 1000, cacheCreation: 484000, inputTokens: 5, outputTokens: 20, ephemeral1h: 484000, ephemeral5m: 0 },
      _servedModel: "claude-opus-5",
      _captureRequestId: "req_abc",
      _captureStart: Date.now() - 100,
    },
  };
  const r = buildOutcomeRecord(ctx, "cap123", "s-key");
  assert.equal(r.type, "outcome");
  assert.equal(r.id, "cap123", "the join key back to the request record");
  assert.equal(r.requestId, "req_abc", "joins to CC's own transcript");
  // A zero read beside a large creation IS a cold rewrite — the event the
  // corpus exists to explain, now observable rather than inferred.
  assert.equal(r.usage.cacheCreation, 484000);
  assert.equal(r.usage.cacheRead, 1000);
  assert.equal(r.usage.outputTokens, 20);
  assert.equal(r.usage.ephemeral1h, 484000, "tier split says which TTL the cache actually used");
  assert.ok(r.ms >= 100);
});

test("BITE — no usage means NO record, never a zeroed guess", () => {
  // cache-telemetry populates meta.cacheStats. If it is off, or the stream was
  // cancelled before message_start, there is nothing to report — and emitting
  // zeros would put a fabricated "cold rewrite" into the corpus.
  assert.equal(buildOutcomeRecord({ meta: {} }, "cap123", "s-key"), null);
  assert.equal(buildOutcomeRecord({ meta: { cacheStats: { cacheRead: 1 } } }, null, "s-key"), null,
    "no capture id means the record could never be joined — do not write it");
});

test("request records carry a join id", () => {
  const ctx = { headers: { "session-id": "s1" }, body: { messages: [{ role: "user", content: "hi" }] } };
  const r = buildCaptureRecord(ctx, new Date(), "cap999");
  assert.equal(r.id, "cap999");
  assert.ok(r.body, "the request record still carries the body it always did");
});

test("request-capture: enabled — records the Messages API only, never another route", async () => {
  // Scope has two halves and neither was pinned: the pipeline's route filter
  // (no `routes` here, so it defaults to messages) and this file's body gate.
  // Distinct session ids: _bootWrittenFor is module-scoped, so a mutation that
  // makes one of these write cannot burn a sibling case's boot record.
  const dir = await mkdtemp(join(tmpdir(), "capture-test-"));
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  const prevFlag = process.env.CACHE_FIX_REQUEST_CAPTURE;
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.CACHE_FIX_REQUEST_CAPTURE = "1";
  try {
    // Inner half — an UNTAGGED caller, which the route filter admits, so only the
    // body gate is left.
    await ext.onRequest({
      body: { events: [{ type: "worker_started", at: 1 }] },
      headers: { "x-session-id": "scope-check" },
    });
    assert.deepEqual(await readdir(dir), [],
      "a non-Messages body was captured — the corpus would carry shapes replay cannot drive");

    // Outer half — a MESSAGES body on the bootstrap route, so the gate above
    // cannot be what drops it. Declaring `routes` here would widen the corpus.
    await runOnRequest(
      { ...makeCtx({ headers: { "x-session-id": "scope-route" } }), meta: { route: "bootstrap" } },
      [ext],
    );
    assert.deepEqual(await readdir(dir), [],
      "the bootstrap route reached the capture hook");

    // PREMISE, so the case cannot pass because capture was simply off: the same
    // setup with a Messages body must write.
    await ext.onRequest(makeCtx({ headers: { "x-session-id": "scope-premise" } }));
    assert.ok((await readdir(dir)).length, "premise: capture is on, so a Messages body must write");
  } finally {
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    if (prevFlag === undefined) delete process.env.CACHE_FIX_REQUEST_CAPTURE;
    else process.env.CACHE_FIX_REQUEST_CAPTURE = prevFlag;
    await rm(dir, { recursive: true, force: true });
  }
});
