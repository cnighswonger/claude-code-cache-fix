import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

import ext, {
  generateSid,
  hashOrgId,
  extractMessageStartFields,
  extractMessageDeltaFields,
  parseQuotaHeaders,
  assembleRecord,
  computeDelta,
  writeRecord,
  _resetDeltaStateForTest,
} from "../proxy/extensions/usage-log.mjs";

async function newTmp() {
  return mkdtemp(join(tmpdir(), "usage-log-test-"));
}

async function freshExt() {
  const mod = await import(`../proxy/extensions/usage-log.mjs?t=${Date.now()}`);
  mod._resetDeltaStateForTest();
  return mod;
}

function mkHeaders(overrides = {}) {
  return {
    "anthropic-ratelimit-unified-5h-utilization": "0.5",
    "anthropic-ratelimit-unified-7d-utilization": "0.3",
    "anthropic-ratelimit-unified-5h-reset": "1700000000",
    "anthropic-ratelimit-unified-7d-reset": "1700100000",
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-overage-status": "allowed",
    "anthropic-ratelimit-unified-claim": "five_hour",
    "anthropic-ratelimit-unified-fallback-percentage": "0.5",
    ...overrides,
  };
}

function mkMessageStart(overrides = {}) {
  return {
    type: "message_start",
    message: {
      model: "claude-opus-4-7",
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 1000,
        speed: "standard",
        service_tier: "standard",
        cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 0 },
        server_tool_use: { web_search_requests: 0 },
        ...overrides.usage,
      },
      ...overrides.message,
    },
  };
}

// --- 1. Schema match ---

test("1. assembled record matches MeterRowSchema v:1 exactly", () => {
  const start = extractMessageStartFields(mkMessageStart());
  const delta = { output_tokens: 200 };
  const quota = parseQuotaHeaders(mkHeaders());
  const record = assembleRecord({
    start,
    delta,
    quota,
    sid: "abcdef01",
    prevQ5h: null,
    prevQ7d: null,
    now: new Date("2026-04-25T10:00:00Z"),
  });

  // v MUST be the literal number 1
  assert.equal(record.v, 1);

  // Required fields present
  for (const f of [
    "v", "ts", "sid", "model", "speed", "service_tier",
    "input_tokens", "output_tokens", "cache_creation_input_tokens",
    "cache_read_input_tokens", "ephemeral_1h_input_tokens",
    "ephemeral_5m_input_tokens", "web_search_requests",
    "q5h", "q7d", "q5h_reset", "q7d_reset",
    "qstatus", "qoverage", "qclaim", "qfallback_pct",
    "cache_hit_rate", "q5h_delta", "q7d_delta",
  ]) {
    assert.ok(f in record, `expected required field ${f}`);
  }

  // Type/regex constraints (subset)
  assert.match(record.sid, /^[0-9a-f]{8}$/);
  assert.match(record.model, /^[a-z0-9._-]+$/);
  assert.match(record.qstatus, /^[a-z_]*$/);
  assert.equal(typeof record.cache_hit_rate, "number");
  assert.ok(record.cache_hit_rate >= 0 && record.cache_hit_rate <= 1);
  assert.equal(typeof record.q5h, "number");
  assert.ok(record.q5h >= 0 && record.q5h <= 2);
});

// --- 2. Optional fields omitted when absent ---

test("2. optional fields absent when source data missing", () => {
  const start = extractMessageStartFields(mkMessageStart());
  const quota = parseQuotaHeaders({}); // no quota headers at all
  const record = assembleRecord({
    start,
    delta: { output_tokens: 100 },
    quota,
    sid: "abcdef01",
  });
  // org_id, qoverage_util, qrepresentative_claim, overage_disabled_reason,
  // requested_model, model_mismatch — none should be present.
  assert.equal("org_id" in record, false);
  assert.equal("qoverage_util" in record, false);
  assert.equal("qrepresentative_claim" in record, false);
  assert.equal("overage_disabled_reason" in record, false);
  assert.equal("requested_model" in record, false);
  assert.equal("model_mismatch" in record, false);
});

// --- 3. Required-with-default zero when source absent ---

test("3. web_search_requests / ephemeral split default to 0 when source absent", () => {
  // Construct a minimal message_start manually so cache_creation and
  // server_tool_use are truly absent (mkMessageStart's spread-merge would
  // preserve the defaults).
  const event = {
    type: "message_start",
    message: {
      model: "claude-opus-4-7",
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        speed: "standard",
        service_tier: "standard",
        // No cache_creation, no server_tool_use.
      },
    },
  };
  const start = extractMessageStartFields(event);
  const record = assembleRecord({
    start,
    delta: { output_tokens: 50 },
    quota: parseQuotaHeaders({}),
    sid: "abcdef01",
  });
  assert.equal(record.web_search_requests, 0);
  assert.equal(record.ephemeral_1h_input_tokens, 0);
  assert.equal(record.ephemeral_5m_input_tokens, 0);
});

// --- 4. message_start state capture ---

test("4. message_start populates ctx.meta._usageLog with full start fields", async () => {
  const mod = await freshExt();
  const ctx = {
    meta: {},
    event: mkMessageStart(),
    telemetry: {},
    responseHeaders: mkHeaders(),
  };
  await mod.default.onStreamEvent(ctx);
  assert.ok(ctx.meta._usageLog, "expected _usageLog to be set");
  assert.ok(ctx.meta._usageLog.start, "expected start fields");
  assert.equal(ctx.meta._usageLog.start.model, "claude-opus-4-7");
  assert.equal(ctx.meta._usageLog.start.speed, "standard");
  assert.equal(ctx.meta._usageLog.start.service_tier, "standard");
  assert.equal(ctx.meta._usageLog.start.input_tokens, 100);
  assert.equal(ctx.meta._usageLog.start.cache_creation_input_tokens, 50);
  assert.equal(ctx.meta._usageLog.start.cache_read_input_tokens, 1000);
  assert.equal(ctx.meta._usageLog.start.ephemeral_1h_input_tokens, 50);
});

// --- 5. message_delta finalization ---

test("5. message_delta reads ctx.meta._usageLog and emits final record", async () => {
  const mod = await freshExt();
  const dir = await newTmp();
  const path = join(dir, "usage.jsonl");
  process.env.CACHE_FIX_USAGE_LOG = path;
  try {
    const ctx = {
      meta: {},
      event: mkMessageStart(),
      telemetry: { requestedModel: "claude-opus-4-7" },
      responseHeaders: mkHeaders(),
    };
    await mod.default.onStreamEvent(ctx);
    ctx.event = { type: "message_delta", usage: { output_tokens: 200 } };
    await mod.default.onStreamEvent(ctx);
    const text = await readFile(path, "utf8");
    const record = JSON.parse(text.trim());
    assert.equal(record.v, 1);
    assert.equal(record.output_tokens, 200);
    assert.equal(record.model, "claude-opus-4-7");
    assert.equal(record.requested_model, "claude-opus-4-7");
    assert.equal(record.model_mismatch, undefined, "no mismatch when models match");
  } finally {
    delete process.env.CACHE_FIX_USAGE_LOG;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 6. Delta computation ---

test("6. q5h_delta computed correctly from previous reading", () => {
  assert.equal(computeDelta(0.6, 0.5), 0.1.toFixed ? 0.6 - 0.5 : null);
  // strict numeric check (allow tiny float drift)
  const d = computeDelta(0.6, 0.5);
  assert.ok(Math.abs(d - 0.1) < 1e-9);
});

// --- 7. First-call deltas zero ---

test("7. first call after module load → deltas are 0", () => {
  assert.equal(computeDelta(0.5, null), 0);
  assert.equal(computeDelta(0.5, undefined), 0);
});

// --- 8. Session ID stability ---

test("8. multiple calls within process see the same sid", async () => {
  const mod = await freshExt();
  const dir = await newTmp();
  const path = join(dir, "usage.jsonl");
  process.env.CACHE_FIX_USAGE_LOG = path;
  try {
    for (let i = 0; i < 3; i++) {
      const ctx = {
        meta: {},
        event: mkMessageStart(),
        telemetry: {},
        responseHeaders: mkHeaders(),
      };
      await mod.default.onStreamEvent(ctx);
      ctx.event = { type: "message_delta", usage: { output_tokens: 50 } };
      await mod.default.onStreamEvent(ctx);
    }
    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter(Boolean);
    const sids = new Set(lines.map((l) => JSON.parse(l).sid));
    assert.equal(sids.size, 1, "all records in one process should share the same sid");
  } finally {
    delete process.env.CACHE_FIX_USAGE_LOG;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 9. Session ID format ---

test("9. generateSid matches /^[0-9a-f]{8}$/", () => {
  for (let i = 0; i < 50; i++) {
    const sid = generateSid();
    assert.match(sid, /^[0-9a-f]{8}$/, `sid ${sid} must be 8 lowercase hex chars`);
  }
});

// --- 10. Cache hit rate ---

test("10. cache_hit_rate computed correctly; zero when total is zero", () => {
  // 80 read out of 100 total → 0.8
  const r1 = assembleRecord({
    start: { input_tokens: 10, cache_creation_input_tokens: 10, cache_read_input_tokens: 80 },
    delta: { output_tokens: 5 },
    quota: parseQuotaHeaders({}),
    sid: "abcdef01",
  });
  assert.ok(Math.abs(r1.cache_hit_rate - 0.8) < 1e-9);

  // total 0 → 0
  const r2 = assembleRecord({
    start: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    delta: { output_tokens: 0 },
    quota: parseQuotaHeaders({}),
    sid: "abcdef01",
  });
  assert.equal(r2.cache_hit_rate, 0);
});

// --- 11. org_id hashing bit-exact match with claude-meter ---

test("11. org_id hashing matches sha256(raw).digest('hex').slice(0, 16) bit-exactly", () => {
  const raw = "acct-abc123-deadbeef";
  const expected = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  assert.equal(hashOrgId(raw), expected);
  // Hashed value MUST NOT be the original
  assert.notEqual(hashOrgId(raw), raw);
  // Length is exactly 16 hex chars
  assert.match(hashOrgId(raw), /^[a-f0-9]{16}$/);
});

test("11b. assembled record stores hashed org_id, never raw", () => {
  const raw = "acct-secret-do-not-leak-XYZ";
  const headers = mkHeaders({ "anthropic-organization-id": raw });
  const record = assembleRecord({
    start: extractMessageStartFields(mkMessageStart()),
    delta: { output_tokens: 100 },
    quota: parseQuotaHeaders(headers),
    sid: "abcdef01",
  });
  assert.equal(record.org_id, hashOrgId(raw));
  // Raw value MUST NOT appear anywhere in the record
  assert.equal(JSON.stringify(record).includes(raw), false, "raw org_id must not leak into record");
});

// --- 12. Schema version ---

test("12. every record has v: 1 (literally the number 1)", () => {
  const record = assembleRecord({
    start: extractMessageStartFields(mkMessageStart()),
    delta: { output_tokens: 100 },
    quota: parseQuotaHeaders(mkHeaders()),
    sid: "abcdef01",
  });
  assert.equal(record.v, 1);
  // Must be number, not string
  assert.equal(typeof record.v, "number");
});

// --- 13. peak_hour absent ---

test("13. peak_hour is NOT in the emitted record", () => {
  const record = assembleRecord({
    start: extractMessageStartFields(mkMessageStart()),
    delta: { output_tokens: 100 },
    quota: parseQuotaHeaders(mkHeaders()),
    sid: "abcdef01",
  });
  assert.equal("peak_hour" in record, false, "peak_hour must not be in MeterRowSchema records");
});

// --- 14. Disabled extension (no per-call file mutation) ---

test("14. when extension is disabled (no message_start observed), nothing is emitted", async () => {
  const mod = await freshExt();
  const dir = await newTmp();
  const path = join(dir, "usage.jsonl");
  process.env.CACHE_FIX_USAGE_LOG = path;
  try {
    // Send only message_delta with no preceding message_start.
    const ctx = {
      meta: {},
      event: { type: "message_delta", usage: { output_tokens: 50 } },
      telemetry: {},
      responseHeaders: mkHeaders(),
    };
    await mod.default.onStreamEvent(ctx);
    let exists = false;
    try { await readFile(path, "utf8"); exists = true; } catch {}
    assert.equal(exists, false, "no file should be written when no start state was captured");
  } finally {
    delete process.env.CACHE_FIX_USAGE_LOG;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 15. Concurrency: 50 parallel writes ---

test("15. 50 parallel appendFile writes produce 50 well-formed JSON lines", async () => {
  const dir = await newTmp();
  const path = join(dir, "usage.jsonl");
  try {
    const records = Array.from({ length: 50 }, (_, i) => ({
      v: 1,
      ts: `2026-04-25T10:00:${String(i).padStart(2, "0")}Z`,
      sid: "abcdef01",
      model: "claude-opus-4-7",
      seq: i,
    }));
    await Promise.all(records.map((r) => writeRecord(r, path)));
    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 50, `expected 50 lines, got ${lines.length}`);
    for (const line of lines) {
      JSON.parse(line);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 16. Header absence resilience ---

test("16. record assembled with safe defaults when every quota header is absent", () => {
  const record = assembleRecord({
    start: extractMessageStartFields(mkMessageStart()),
    delta: { output_tokens: 50 },
    quota: parseQuotaHeaders({}),
    sid: "abcdef01",
  });
  assert.equal(record.q5h, 0);
  assert.equal(record.q7d, 0);
  assert.equal(record.q5h_reset, 0);
  assert.equal(record.q7d_reset, 0);
  assert.equal(record.qstatus, "");
  assert.equal(record.qoverage, "");
  assert.equal(record.qclaim, "");
  assert.equal(record.qfallback_pct, 0);
});

// --- Bonus tests ---

test("requested_model + model_mismatch when they differ", () => {
  const record = assembleRecord({
    start: extractMessageStartFields(mkMessageStart({ message: { model: "claude-opus-4-6" } })),
    delta: { output_tokens: 100 },
    quota: parseQuotaHeaders({}),
    sid: "abcdef01",
    requestedModel: "claude-opus-4-7",
  });
  assert.equal(record.requested_model, "claude-opus-4-7");
  assert.equal(record.model, "claude-opus-4-6");
  assert.equal(record.model_mismatch, true);
});

test("requested_model + no model_mismatch when they match", () => {
  const record = assembleRecord({
    start: extractMessageStartFields(mkMessageStart()),
    delta: { output_tokens: 100 },
    quota: parseQuotaHeaders({}),
    sid: "abcdef01",
    requestedModel: "claude-opus-4-7",
  });
  assert.equal(record.requested_model, "claude-opus-4-7");
  assert.equal("model_mismatch" in record, false);
});

test("optional qoverage_util present when header has it", () => {
  const record = assembleRecord({
    start: extractMessageStartFields(mkMessageStart()),
    delta: { output_tokens: 100 },
    quota: parseQuotaHeaders(mkHeaders({ "anthropic-ratelimit-unified-overage-utilization": "0.42" })),
    sid: "abcdef01",
  });
  assert.equal(record.qoverage_util, 0.42);
});

test("end-to-end: two responses → second has non-zero deltas", async () => {
  const mod = await freshExt();
  const dir = await newTmp();
  const path = join(dir, "usage.jsonl");
  process.env.CACHE_FIX_USAGE_LOG = path;
  try {
    // Response 1 — q5h=0.5
    let ctx = {
      meta: {},
      event: mkMessageStart(),
      telemetry: {},
      responseHeaders: mkHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.5" }),
    };
    await mod.default.onStreamEvent(ctx);
    ctx.event = { type: "message_delta", usage: { output_tokens: 100 } };
    await mod.default.onStreamEvent(ctx);

    // Response 2 — q5h=0.6
    ctx = {
      meta: {},
      event: mkMessageStart(),
      telemetry: {},
      responseHeaders: mkHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.6" }),
    };
    await mod.default.onStreamEvent(ctx);
    ctx.event = { type: "message_delta", usage: { output_tokens: 100 } };
    await mod.default.onStreamEvent(ctx);

    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    const r1 = JSON.parse(lines[0]);
    const r2 = JSON.parse(lines[1]);
    assert.equal(r1.q5h_delta, 0, "first record has zero delta");
    assert.ok(Math.abs(r2.q5h_delta - 0.1) < 1e-9, "second record has 0.1 delta");
  } finally {
    delete process.env.CACHE_FIX_USAGE_LOG;
    await rm(dir, { recursive: true, force: true });
  }
});
