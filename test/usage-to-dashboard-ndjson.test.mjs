// Regression tests for tools/usage-to-dashboard-ndjson.mjs.
//
// Closes #112: the translator was written for the preload-era usage.jsonl
// schema (`entry.timestamp`, `q5h_pct`/`q7d_pct` as int 0-100). The proxy
// usage-log extension (v3.2.0+) writes MeterRowSchema v:1 with three
// renames (`entry.ts`, `q5h`/`q7d` as float 0-1). The translator's entry
// guard `if (!entry.timestamp) return null` silently dropped every v:1 row
// → external dashboards reading the documented bridge got zero data from
// proxy-mode sessions.
//
// These tests pin the contract: both schemas produce non-null records with
// correct ts_start/ts_end mapping, reconstructed quota headers, and
// well-formed req_id.
//
// Schema source of truth: `proxy/extensions/usage-log.mjs:assembleRecord`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { translateRecord } from "../tools/usage-to-dashboard-ndjson.mjs";

// --- Fixtures ---

// Preload-era row (pre-v3.2.0 schema). Approximates what the original
// preload interceptor wrote to ~/.claude/usage.jsonl.
const PRELOAD_ROW = {
  timestamp: "2026-05-08T14:30:00.000Z",
  model: "claude-opus-4-7",
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 800,
  cache_creation_input_tokens: 200,
  ephemeral_1h_input_tokens: 200,
  ephemeral_5m_input_tokens: 0,
  q5h_pct: 42,        // int 0-100
  q7d_pct: 15,        // int 0-100
  peak_hour: false,
  // ttl_tier intentionally omitted — preload-era rows didn't always carry
  // it, and the proxy v:1 schema definitively doesn't (cache-telemetry
  // writes that data to the per-session quota-status file instead). Parity
  // test #16 depends on both fixtures sharing the same field set.
};

// MeterRowSchema v:1 row. Matches the actual output of
// proxy/extensions/usage-log.mjs as of v3.5.x (verified against
// assembleRecord field names).
const V1_ROW = {
  v: 1,
  ts: "2026-05-08T14:30:00.000Z",
  sid: "abcd1234",
  model: "claude-opus-4-7",
  speed: "standard",
  service_tier: "",
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 800,
  ephemeral_1h_input_tokens: 200,
  ephemeral_5m_input_tokens: 0,
  web_search_requests: 0,
  q5h: 0.42,          // float 0-1
  q7d: 0.15,          // float 0-1
  q5h_reset: 1776960600,
  q7d_reset: 1776970800,
  qstatus: "allowed",
  qoverage: "allowed",
  qclaim: "",
  qfallback_pct: 0,
  cache_hit_rate: 0.727,
  q5h_delta: 0,
  q7d_delta: 0,
};

// --- Entry guard ---

test("[#1] preload-era row → non-null record (entry.timestamp accepted)", () => {
  const rec = translateRecord(PRELOAD_ROW);
  assert.ok(rec, "preload-era row must translate to a non-null record");
});

test("[#2] v:1 row → non-null record (entry.ts accepted; #112 regression)", () => {
  const rec = translateRecord(V1_ROW);
  assert.ok(rec, "v:1 row must translate to a non-null record — silent drop is the #112 bug");
});

test("[#3] missing both timestamp forms → null", () => {
  assert.equal(translateRecord({ model: "claude-opus-4-7" }), null);
});

test("[#4] missing model → null", () => {
  assert.equal(translateRecord({ ts: "2026-05-08T14:30:00.000Z" }), null);
  assert.equal(translateRecord({ timestamp: "2026-05-08T14:30:00.000Z" }), null);
});

test("[#5] null/undefined entry → null (defensive)", () => {
  assert.equal(translateRecord(null), null);
  assert.equal(translateRecord(undefined), null);
  assert.equal(translateRecord({}), null);
});

// --- Timestamp mapping ---

test("[#6] preload-era: ts_start/ts_end mirror entry.timestamp", () => {
  const rec = translateRecord(PRELOAD_ROW);
  assert.equal(rec.ts_start, "2026-05-08T14:30:00.000Z");
  assert.equal(rec.ts_end, "2026-05-08T14:30:00.000Z");
});

test("[#7] v:1: ts_start/ts_end mirror entry.ts", () => {
  const rec = translateRecord(V1_ROW);
  assert.equal(rec.ts_start, "2026-05-08T14:30:00.000Z");
  assert.equal(rec.ts_end, "2026-05-08T14:30:00.000Z");
});

test("[#8] preload-era takes precedence when BOTH timestamp and ts are set (back-compat)", () => {
  // If a hypothetical hybrid row carried both, prefer entry.timestamp so
  // the v:1 fallback never silently overrides the legacy field.
  const hybrid = { ...V1_ROW, timestamp: "1999-12-31T23:59:59.000Z" };
  const rec = translateRecord(hybrid);
  assert.equal(rec.ts_start, "1999-12-31T23:59:59.000Z");
});

// --- Quota header reconstruction ---

test("[#9] preload-era: q5h_pct (int 0-100) → utilization string (divide by 100)", () => {
  const rec = translateRecord(PRELOAD_ROW);
  const h = rec.response_anthropic_headers;
  assert.equal(h["anthropic-ratelimit-unified-5h-utilization"], "0.42");
  assert.equal(h["anthropic-ratelimit-unified-7d-utilization"], "0.15");
});

test("[#10] v:1: q5h (float 0-1) → utilization string verbatim (no divide)", () => {
  const rec = translateRecord(V1_ROW);
  const h = rec.response_anthropic_headers;
  assert.equal(h["anthropic-ratelimit-unified-5h-utilization"], "0.42");
  assert.equal(h["anthropic-ratelimit-unified-7d-utilization"], "0.15");
});

test("[#11] missing quota fields → empty headers, not crash", () => {
  const minimal = { ts: V1_ROW.ts, model: V1_ROW.model };
  const rec = translateRecord(minimal);
  assert.deepEqual(rec.response_anthropic_headers, {});
});

test("[#12] q5h_pct takes precedence over q5h when BOTH set (back-compat)", () => {
  // The pct field is the legacy schema's authoritative value; if a row
  // carries both (e.g., a tool wrote both during a transition), preserve
  // legacy semantics.
  const both = { ...V1_ROW, q5h_pct: 99, q5h: 0.42 };
  const rec = translateRecord(both);
  assert.equal(rec.response_anthropic_headers["anthropic-ratelimit-unified-5h-utilization"], "0.99");
});

// --- req_id construction ---

test("[#13] preload-era: req_id derived from entry.timestamp digits + model suffix", () => {
  const rec = translateRecord(PRELOAD_ROW);
  // 2026-05-08T14:30:00.000Z → 202605081430000000 → 'ccf_202605081430000000_us-4-7'
  assert.match(rec.req_id, /^ccf_2026050814300000(00)?0_/);
  assert.match(rec.req_id, /us-4-7$/); // last 6 chars of "claude-opus-4-7"
});

test("[#14] v:1: req_id derived from entry.ts digits + model suffix", () => {
  const rec = translateRecord(V1_ROW);
  assert.match(rec.req_id, /^ccf_2026050814300000(00)?0_/);
  assert.match(rec.req_id, /us-4-7$/);
});

test("[#15] req_id is identical between preload and v:1 rows when ts and model match", () => {
  // The req_id is the dashboard's dedup key. A user upgrading from preload
  // to proxy mode shouldn't see duplicate-looking-but-distinct entries for
  // the same logical request — the deterministic-derivation guarantees it.
  const a = translateRecord(PRELOAD_ROW);
  const b = translateRecord(V1_ROW);
  assert.equal(a.req_id, b.req_id);
});

// --- End-to-end shape parity ---

test("[#16] preload and v:1 rows produce structurally equivalent NDJSON output", () => {
  // The translator's job is to make the bridge format-agnostic. For
  // identical underlying request-level data expressed in either schema,
  // the resulting record should match field-for-field (modulo source
  // schema name).
  const a = translateRecord(PRELOAD_ROW);
  const b = translateRecord(V1_ROW);
  // Compare every emitted field — if any drift, this catches it.
  assert.deepEqual(a, b);
});
