import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseTriggerFromHeaders,
  computeProjection,
  dedupKey,
  formatStderrLine,
  formatJsonlRecord,
  recordSample,
  writeRecord,
  _resetForTest,
} from "../proxy/extensions/overage-warning.mjs";

// Re-import dynamically per scenario when we need a fresh module-scope state.
async function freshExt() {
  const mod = await import(`../proxy/extensions/overage-warning.mjs?t=${Date.now()}`);
  mod._resetForTest();
  return mod;
}

async function newTmp() {
  return mkdtemp(join(tmpdir(), "overage-warning-test-"));
}

function mkHeaders({
  status = "allowed_warning",
  surpassed = "0.75",
  overage = "allowed",
  upgrade = "upgrade_plan,overage",
  q5h = "0.78",
  q7d = "0.82",
  q5hReset = "1712345678",
} = {}) {
  return {
    "anthropic-ratelimit-unified-status": status,
    "anthropic-ratelimit-unified-7d-surpassed-threshold": surpassed,
    "anthropic-ratelimit-unified-overage-status": overage,
    "anthropic-ratelimit-unified-upgrade-paths": upgrade,
    "anthropic-ratelimit-unified-5h-utilization": q5h,
    "anthropic-ratelimit-unified-7d-utilization": q7d,
    "anthropic-ratelimit-unified-5h-reset": q5hReset,
  };
}

// --- 1. Trigger detection ---

test("1. trigger fires for allowed_warning + surpassed=0.75", () => {
  const result = parseTriggerFromHeaders(mkHeaders());
  assert.equal(result.eligible, true);
  assert.equal(result.trigger.status, "allowed_warning");
  assert.equal(result.trigger.surpassed_threshold, 0.75);
  assert.deepEqual(result.trigger.upgrade_paths, ["upgrade_plan", "overage"]);
});

// --- 2. No trigger ---

test("2. no trigger when status=allowed and no surpassed-threshold", () => {
  const headers = mkHeaders({ status: "allowed", surpassed: "" });
  const result = parseTriggerFromHeaders(headers);
  assert.equal(result.eligible, false);
});

// --- 3. Throttled ---

test("3. throttled status fires (treated same as allowed_warning)", () => {
  const headers = mkHeaders({ status: "throttled" });
  const result = parseTriggerFromHeaders(headers);
  assert.equal(result.eligible, true);
  assert.equal(result.trigger.status, "throttled");
});

// --- 4. Dedup within window ---

test("4. dedup within same Q5h window — same threshold fires once", async () => {
  const ext = await freshExt();
  const dir = await newTmp();
  process.env.CACHE_FIX_OVERAGE_WARNING = "1";
  process.env.CACHE_FIX_OVERAGE_WARNING_QUIET = "1";
  process.env.CACHE_FIX_OVERAGE_WARNING_DIR = dir;
  try {
    const headers = mkHeaders();
    const ctx1 = { headers, meta: {}, event: null };
    await ext.default.onResponseStart(ctx1);
    ctx1.event = { type: "message_delta", usage: { output_tokens: 10 } };
    await ext.default.onStreamEvent(ctx1);

    const ctx2 = { headers, meta: {}, event: null };
    await ext.default.onResponseStart(ctx2);
    ctx2.event = { type: "message_delta", usage: { output_tokens: 10 } };
    await ext.default.onStreamEvent(ctx2);

    const out = await readFile(join(dir, "overage-warnings.jsonl"), "utf8");
    const lines = out.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "expected exactly one warning line for repeated same threshold");
  } finally {
    delete process.env.CACHE_FIX_OVERAGE_WARNING;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_QUIET;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 5. New window ---

test("5. new Q5h window resets dedup — same threshold fires twice", async () => {
  const ext = await freshExt();
  const dir = await newTmp();
  process.env.CACHE_FIX_OVERAGE_WARNING = "1";
  process.env.CACHE_FIX_OVERAGE_WARNING_QUIET = "1";
  process.env.CACHE_FIX_OVERAGE_WARNING_DIR = dir;
  try {
    const headersA = mkHeaders({ q5hReset: "1700000000" });
    const ctx1 = { headers: headersA, meta: {}, event: null };
    await ext.default.onResponseStart(ctx1);
    ctx1.event = { type: "message_delta", usage: { output_tokens: 10 } };
    await ext.default.onStreamEvent(ctx1);

    const headersB = mkHeaders({ q5hReset: "1700020000" });
    const ctx2 = { headers: headersB, meta: {}, event: null };
    await ext.default.onResponseStart(ctx2);
    ctx2.event = { type: "message_delta", usage: { output_tokens: 10 } };
    await ext.default.onStreamEvent(ctx2);

    const out = await readFile(join(dir, "overage-warnings.jsonl"), "utf8");
    const lines = out.split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "expected two warnings across distinct Q5h windows");
  } finally {
    delete process.env.CACHE_FIX_OVERAGE_WARNING;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_QUIET;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 6. Higher threshold in same window ---

test("6. distinct threshold in same window — both fire", async () => {
  const ext = await freshExt();
  const dir = await newTmp();
  process.env.CACHE_FIX_OVERAGE_WARNING = "1";
  process.env.CACHE_FIX_OVERAGE_WARNING_QUIET = "1";
  process.env.CACHE_FIX_OVERAGE_WARNING_DIR = dir;
  try {
    const ctx1 = { headers: mkHeaders({ surpassed: "0.75" }), meta: {}, event: null };
    await ext.default.onResponseStart(ctx1);
    ctx1.event = { type: "message_delta", usage: { output_tokens: 10 } };
    await ext.default.onStreamEvent(ctx1);

    const ctx2 = { headers: mkHeaders({ surpassed: "0.90" }), meta: {}, event: null };
    await ext.default.onResponseStart(ctx2);
    ctx2.event = { type: "message_delta", usage: { output_tokens: 10 } };
    await ext.default.onStreamEvent(ctx2);

    const out = await readFile(join(dir, "overage-warnings.jsonl"), "utf8");
    const lines = out.split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "expected two warnings for distinct thresholds in same window");
  } finally {
    delete process.env.CACHE_FIX_OVERAGE_WARNING;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_QUIET;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 7. Projection math ---

test("7. computeProjection produces sensible min_to_100", () => {
  const t0 = 1_000_000;
  const samples = [
    { t: t0,         q5h: 0.50, input: 100, cache_creation: 50, cache_read: 1000, output: 200 },
    { t: t0 + 60000, q5h: 0.55, input: 100, cache_creation: 50, cache_read: 1000, output: 200 },
    { t: t0 + 120000, q5h: 0.60, input: 100, cache_creation: 50, cache_read: 1000, output: 200 },
    { t: t0 + 180000, q5h: 0.65, input: 100, cache_creation: 50, cache_read: 1000, output: 200 },
  ];
  // util_per_min = (0.65 - 0.50) / 3 = 0.05
  // (1 - 0.65) / 0.05 = 7 minutes
  const proj = computeProjection(samples, t0 + 180000);
  assert.equal(proj.window_samples, 4);
  assert.equal(proj.min_to_100, 7);
  assert.ok(proj.tokens_per_min > 0);
  assert.ok(proj.cost_per_hr_usd_coarse > 0);
});

// --- 8. Projection warm-up ---

test("8. projection null when fewer than 3 samples", () => {
  const t0 = 1_000_000;
  const samples = [
    { t: t0,        q5h: 0.50, input: 100, cache_creation: 0, cache_read: 0, output: 100 },
    { t: t0 + 1000, q5h: 0.55, input: 100, cache_creation: 0, cache_read: 0, output: 100 },
  ];
  const proj = computeProjection(samples, t0 + 1000);
  assert.equal(proj.min_to_100, null);
  assert.equal(proj.tokens_per_min, null);
  assert.equal(proj.cost_per_hr_usd_coarse, null);
  assert.equal(proj.window_samples, 2);
});

// --- 9. Decreasing utilization ---

test("9. decreasing utilization yields null projection", () => {
  const t0 = 1_000_000;
  const samples = [
    { t: t0,         q5h: 0.80, input: 100, cache_creation: 0, cache_read: 0, output: 100 },
    { t: t0 + 60000, q5h: 0.78, input: 100, cache_creation: 0, cache_read: 0, output: 100 },
    { t: t0 + 120000, q5h: 0.75, input: 100, cache_creation: 0, cache_read: 0, output: 100 },
  ];
  const proj = computeProjection(samples, t0 + 120000);
  assert.equal(proj.min_to_100, null, "min_to_100 null when util decreasing");
  assert.equal(proj.cost_per_hr_usd_coarse, null);
});

// --- 10. JSONL append ---

test("10. JSONL is append-only, multiple events readable as JSONL", async () => {
  const dir = await newTmp();
  try {
    const r1 = formatJsonlRecord({
      ts: "2026-04-25T10:00:00Z",
      trigger: { status: "allowed_warning", surpassed_threshold: 0.75, overage_status: "allowed", upgrade_paths: ["upgrade_plan"] },
      snapshot: { q5h_pct: 78, q7d_pct: 82, q5h_resets_at: 1700000000 },
      projection: null,
    });
    const r2 = formatJsonlRecord({
      ts: "2026-04-25T10:05:00Z",
      trigger: { status: "throttled", surpassed_threshold: 0.90, overage_status: "allowed", upgrade_paths: [] },
      snapshot: { q5h_pct: 92, q7d_pct: 88, q5h_resets_at: 1700000000 },
      projection: { min_to_100: 5, tokens_per_min: 12000, cost_per_hr_usd_coarse: 3.6, window_samples: 10, window_minutes: 9 },
    });
    await writeRecord(r1, dir);
    await writeRecord(r2, dir);
    const text = await readFile(join(dir, "overage-warnings.jsonl"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]).trigger.surpassed_threshold, 0.75);
    assert.deepEqual(JSON.parse(lines[1]).trigger.surpassed_threshold, 0.90);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 11. Quiet mode ---

test("11. quiet mode suppresses stderr but writes JSONL", async () => {
  const ext = await freshExt();
  const dir = await newTmp();
  process.env.CACHE_FIX_OVERAGE_WARNING = "1";
  process.env.CACHE_FIX_OVERAGE_WARNING_QUIET = "1";
  process.env.CACHE_FIX_OVERAGE_WARNING_DIR = dir;
  const origWrite = process.stderr.write.bind(process.stderr);
  let stderrBytes = "";
  process.stderr.write = (chunk) => { stderrBytes += chunk; return true; };
  try {
    const ctx = { headers: mkHeaders(), meta: {}, event: null };
    await ext.default.onResponseStart(ctx);
    ctx.event = { type: "message_delta", usage: { output_tokens: 10 } };
    await ext.default.onStreamEvent(ctx);
    assert.equal(stderrBytes.includes("[overage-warning]"), false, "expected no stderr emission in quiet mode");
    const out = await readFile(join(dir, "overage-warnings.jsonl"), "utf8");
    assert.ok(out.includes("\"surpassed_threshold\":0.75"));
  } finally {
    process.stderr.write = origWrite;
    delete process.env.CACHE_FIX_OVERAGE_WARNING;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_QUIET;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 12. Disabled ---

test("12. when CACHE_FIX_OVERAGE_WARNING unset, extension is no-op", async () => {
  const ext = await freshExt();
  const dir = await newTmp();
  // Explicitly do NOT set CACHE_FIX_OVERAGE_WARNING.
  process.env.CACHE_FIX_OVERAGE_WARNING_DIR = dir;
  try {
    const ctx = { headers: mkHeaders(), meta: {}, event: null };
    await ext.default.onResponseStart(ctx);
    ctx.event = { type: "message_delta", usage: { output_tokens: 10 } };
    await ext.default.onStreamEvent(ctx);
    let stat = false;
    try {
      await readFile(join(dir, "overage-warnings.jsonl"), "utf8");
      stat = true;
    } catch {}
    assert.equal(stat, false, "expected no JSONL file written when extension disabled");
  } finally {
    delete process.env.CACHE_FIX_OVERAGE_WARNING_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 13. Header absence ---

test("13. allowed_warning without surpassed-threshold header does not fire", () => {
  const headers = mkHeaders({ surpassed: "" });
  const result = parseTriggerFromHeaders(headers);
  assert.equal(result.eligible, false, "missing surpassed-threshold gates the trigger off");
});

// --- 14. Concurrency: 50 parallel writes ---

test("14. 50 parallel appendFile writes produce 50 well-formed JSON lines", async () => {
  const dir = await newTmp();
  try {
    const records = Array.from({ length: 50 }, (_, i) =>
      formatJsonlRecord({
        ts: `2026-04-25T10:00:${String(i).padStart(2, "0")}Z`,
        trigger: { status: "allowed_warning", surpassed_threshold: 0.75, overage_status: "allowed", upgrade_paths: [] },
        snapshot: { q5h_pct: 78 + i % 20, q7d_pct: 82, q5h_resets_at: 1700000000 + i },
        projection: null,
      }),
    );
    await Promise.all(records.map((r) => writeRecord(r, dir)));
    const text = await readFile(join(dir, "overage-warnings.jsonl"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 50, "expected exactly 50 lines from 50 parallel writes");
    // Every line must parse as valid JSON.
    for (const line of lines) {
      JSON.parse(line);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Bonus: stderr line format sanity ---

test("formatStderrLine contains expected segments", () => {
  const line = formatStderrLine({
    ts: "2026-04-25T18:42:11Z",
    trigger: { status: "allowed_warning", surpassed_threshold: 0.75, overage_status: "allowed", upgrade_paths: ["upgrade_plan", "overage"] },
    snapshot: { q5h_pct: 78, q7d_pct: 82, q5h_resets_at: 1700000000 },
    projection: { min_to_100: 22, tokens_per_min: 14500, cost_per_hr_usd_coarse: 4.10, window_samples: 47, window_minutes: 14 },
  });
  assert.ok(line.startsWith("[overage-warning]"));
  assert.ok(line.includes("Q5h=78%"));
  assert.ok(line.includes("Q7d=82%"));
  assert.ok(line.includes("surpassed 0.75"));
  assert.ok(line.includes("~22 min"));
  assert.ok(line.includes("$4.10/hr"));
  assert.ok(line.includes("(coarse)"));
  assert.ok(line.includes("upgrade_plan, overage"));
});

test("formatStderrLine warm-up fallback when projection null", () => {
  const line = formatStderrLine({
    ts: "2026-04-25T18:42:11Z",
    trigger: { status: "allowed_warning", surpassed_threshold: 0.75, overage_status: "allowed", upgrade_paths: ["overage"] },
    snapshot: { q5h_pct: 78, q7d_pct: 82, q5h_resets_at: 1700000000 },
    projection: null,
  });
  assert.ok(line.includes("projection unavailable"));
  assert.ok(line.includes("warming up"));
});

// --- Bonus: dedupKey shape ---

test("dedupKey produces stable string for same inputs", () => {
  assert.equal(dedupKey(0.75, 1700000000), dedupKey(0.75, 1700000000));
  assert.notEqual(dedupKey(0.75, 1700000000), dedupKey(0.90, 1700000000));
  assert.notEqual(dedupKey(0.75, 1700000000), dedupKey(0.75, 1700001000));
});

// --- Bonus: window management ---

test("recordSample respects WINDOW_MS cutoff", () => {
  const state = { window: [] };
  const now = 10_000_000;
  recordSample(state, { t: now - 20 * 60_000, q5h: 0.5 }); // older than 15 min
  recordSample(state, { t: now - 10 * 60_000, q5h: 0.6 });
  recordSample(state, { t: now, q5h: 0.7 });
  assert.equal(state.window.length, 2, "old sample beyond 15min window dropped");
});

// --- Lifecycle correctness (covers Codex review blockers) ---

async function runResponse(ext, headers, { input = 100, cache_creation = 50, cache_read = 1000, output = 200 } = {}) {
  const ctx = { headers, meta: {}, event: null };
  await ext.default.onResponseStart(ctx);
  ctx.event = {
    type: "message_start",
    message: {
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cache_creation,
        cache_read_input_tokens: cache_read,
      },
    },
  };
  await ext.default.onStreamEvent(ctx);
  ctx.event = { type: "message_delta", usage: { output_tokens: output } };
  await ext.default.onStreamEvent(ctx);
  return ctx;
}

test("L1. non-trigger responses warm the rolling window", async () => {
  process.env.CACHE_FIX_OVERAGE_WARNING = "1";
  process.env.CACHE_FIX_OVERAGE_WARNING_QUIET = "1";
  const ext = await freshExt();
  const dir = await newTmp();
  process.env.CACHE_FIX_OVERAGE_WARNING_DIR = dir;
  try {
    // Three non-eligible responses (status=allowed) that nevertheless carry q5h
    // headers — these MUST still warm the window per the directive.
    const cool = mkHeaders({ status: "allowed", surpassed: "" });
    await runResponse(ext, cool);
    await runResponse(ext, cool);
    await runResponse(ext, cool);

    // Now an eligible response — projection should already be past warm-up
    // because the prior three calls warmed the window.
    const hot = mkHeaders();
    await runResponse(ext, hot);

    const text = await readFile(join(dir, "overage-warnings.jsonl"), "utf8");
    const record = JSON.parse(text.trim().split("\n")[0]);
    assert.ok(record.projection.window_samples >= 3, `expected ≥3 samples in window, got ${record.projection.window_samples}`);
  } finally {
    delete process.env.CACHE_FIX_OVERAGE_WARNING;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_QUIET;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("L2. multiple message_delta events in one response emit once", async () => {
  process.env.CACHE_FIX_OVERAGE_WARNING = "1";
  process.env.CACHE_FIX_OVERAGE_WARNING_QUIET = "1";
  const dir = await newTmp();
  process.env.CACHE_FIX_OVERAGE_WARNING_DIR = dir;
  const ext = await freshExt();
  try {
    const ctx = { headers: mkHeaders(), meta: {}, event: null };
    await ext.default.onResponseStart(ctx);
    ctx.event = {
      type: "message_start",
      message: { usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 1000 } },
    };
    await ext.default.onStreamEvent(ctx);
    // Three message_delta events in same response — only the first should emit.
    for (const out of [100, 50, 25]) {
      ctx.event = { type: "message_delta", usage: { output_tokens: out } };
      await ext.default.onStreamEvent(ctx);
    }
    const text = await readFile(join(dir, "overage-warnings.jsonl"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "expected exactly one emission across multiple message_delta events");
  } finally {
    delete process.env.CACHE_FIX_OVERAGE_WARNING;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_QUIET;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("L3. interleaved responses don't leak output_tokens between samples", async () => {
  process.env.CACHE_FIX_OVERAGE_WARNING = "1";
  process.env.CACHE_FIX_OVERAGE_WARNING_QUIET = "1";
  const ext = await freshExt();
  try {
    // Response A: no quota header at all → no sample created, no _overageSample.
    const noHdr = {};
    const ctxA = { headers: noHdr, meta: {}, event: null };
    await ext.default.onResponseStart(ctxA);
    ctxA.event = {
      type: "message_start",
      message: { usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    };
    await ext.default.onStreamEvent(ctxA);
    assert.equal(ctxA.meta._overageSample, undefined, "no sample expected without quota header");

    // Response B: WITH quota header → sample pushed and handle stored.
    const ctxB = { headers: mkHeaders({ status: "allowed", surpassed: "" }), meta: {}, event: null };
    await ext.default.onResponseStart(ctxB);
    ctxB.event = {
      type: "message_start",
      message: { usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    };
    await ext.default.onStreamEvent(ctxB);
    const bSample = ctxB.meta._overageSample;
    assert.ok(bSample, "response B should own a sample");

    // Response A's message_delta arrives after B's sample is in the window.
    // It MUST NOT mutate B's sample (the prior bug would have done exactly that).
    ctxA.event = { type: "message_delta", usage: { output_tokens: 9999 } };
    await ext.default.onStreamEvent(ctxA);
    assert.equal(bSample.output, 0, "response A's output_tokens must not leak into response B's sample");

    // Response B's own message_delta — this DOES mutate B's sample.
    ctxB.event = { type: "message_delta", usage: { output_tokens: 250 } };
    await ext.default.onStreamEvent(ctxB);
    assert.equal(bSample.output, 250, "response B's own output_tokens land on its own sample");
  } finally {
    delete process.env.CACHE_FIX_OVERAGE_WARNING;
    delete process.env.CACHE_FIX_OVERAGE_WARNING_QUIET;
  }
});
