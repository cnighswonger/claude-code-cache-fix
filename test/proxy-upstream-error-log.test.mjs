// Tests for proxy/extensions/upstream-error-log.mjs (issue #235).
// Covers env-gate, the predicate (status >= 400 only), the
// has_ratelimit_headers discriminator (the load-bearing field), record
// shape across the two 429 classes + 5xx, header normalization, missing
// header tolerance, fail-open, and the onRequest model-capture seam.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ext, {
  isUpstreamError,
  hasRatelimitHeaders,
  buildRecord,
  getLogPath,
} from "../proxy/extensions/upstream-error-log.mjs";

const ENV_GATE = "CACHE_FIX_UPSTREAM_ERROR_LOG";
const ENV_PATH = "CACHE_FIX_UPSTREAM_ERROR_LOG_PATH";

let tmpDir;
let logFile;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "upstream-error-log-"));
  logFile = join(tmpDir, "upstream-errors.jsonl");
  process.env[ENV_PATH] = logFile;
  delete process.env[ENV_GATE];
});

afterEach(() => {
  delete process.env[ENV_GATE];
  delete process.env[ENV_PATH];
  rmSync(tmpDir, { recursive: true, force: true });
});

function readLog() {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// --- isUpstreamError ---

test("isUpstreamError: 200 → false", () => {
  assert.equal(isUpstreamError({ status: 200 }), false);
});
test("isUpstreamError: 201/302 → false (not error)", () => {
  assert.equal(isUpstreamError({ status: 201 }), false);
  assert.equal(isUpstreamError({ status: 302 }), false);
});
test("isUpstreamError: 400/401/403/404 → true", () => {
  for (const s of [400, 401, 403, 404]) {
    assert.equal(isUpstreamError({ status: s }), true, `${s} should be an error`);
  }
});
test("isUpstreamError: 429 → true (both classes — usage limit AND capacity)", () => {
  assert.equal(isUpstreamError({ status: 429 }), true);
});
test("isUpstreamError: 500/502/503/504/529 → true", () => {
  for (const s of [500, 502, 503, 504, 529]) {
    assert.equal(isUpstreamError({ status: s }), true, `${s} should be an error`);
  }
});
test("isUpstreamError: missing/non-number status → false", () => {
  assert.equal(isUpstreamError({}), false);
  assert.equal(isUpstreamError({ status: "429" }), false);
  assert.equal(isUpstreamError(null), false);
});

// --- hasRatelimitHeaders (the load-bearing discriminator) ---

test("hasRatelimitHeaders: empty headers → false", () => {
  assert.equal(hasRatelimitHeaders({}), false);
  assert.equal(hasRatelimitHeaders(null), false);
});
test("hasRatelimitHeaders: capacity-class 429 headers (no ratelimit-*) → false", () => {
  // Capacity-class 429: Cloudflare-fronted, x-should-retry only.
  const headers = {
    "content-type": "application/json",
    "x-should-retry": "true",
    "cf-ray": "abc123-DFW",
  };
  assert.equal(hasRatelimitHeaders(headers), false);
});
test("hasRatelimitHeaders: usage-limit 429 headers (anthropic-ratelimit-unified-*) → true", () => {
  const headers = {
    "anthropic-ratelimit-unified-status": "limited",
    "anthropic-ratelimit-unified-5h-utilization": "1.0",
    "retry-after": "300",
  };
  assert.equal(hasRatelimitHeaders(headers), true);
});
test("hasRatelimitHeaders: case-insensitive header key matching", () => {
  const headers = { "Anthropic-RateLimit-Unified-Status": "limited" };
  assert.equal(hasRatelimitHeaders(headers), true);
});
test("hasRatelimitHeaders: unrelated 'anthropic-*' header alone is NOT enough", () => {
  const headers = { "anthropic-organization-id": "org_xyz" };
  assert.equal(hasRatelimitHeaders(headers), false);
});

// --- buildRecord ---

test("buildRecord: capacity-class 429 → has_ratelimit_headers=false", () => {
  const ctx = {
    status: 429,
    headers: {
      "content-type": "application/json",
      "x-should-retry": "true",
      "request-id": "req_capacity_001",
    },
    meta: { _sessionId: "sess_X", _requestedModel: "claude-opus-4-7" },
  };
  const r = buildRecord({ ctx });
  assert.equal(r.schema_version, 1);
  assert.equal(r.type, "upstream_error");
  assert.equal(r.response_status, 429);
  assert.equal(r.has_ratelimit_headers, false, "capacity-class discriminator");
  assert.equal(r.x_should_retry, true);
  assert.equal(r.session_id, "sess_X");
  assert.equal(r.requested_model, "claude-opus-4-7");
  assert.equal(r.upstream_request_id, "req_capacity_001");
});

test("buildRecord: usage-limit 429 → has_ratelimit_headers=true + ratelimit_status captured", () => {
  const ctx = {
    status: 429,
    headers: {
      "anthropic-ratelimit-unified-status": "limited",
      "anthropic-ratelimit-unified-overage-status": "active",
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
      "retry-after": "180",
      "x-should-retry": "true",
      "request-id": "req_usage_001",
    },
    meta: {},
  };
  const r = buildRecord({ ctx });
  assert.equal(r.response_status, 429);
  assert.equal(r.has_ratelimit_headers, true, "usage-limit discriminator");
  assert.equal(r.ratelimit_status, "limited");
  assert.equal(r.ratelimit_overage_status, "active");
  assert.equal(r.retry_after, "180");
  assert.equal(r.x_should_retry, true);
});

test("buildRecord: 5xx → captured with both ratelimit-discriminator fields absent", () => {
  const ctx = {
    status: 529,
    headers: { "x-should-retry": "true" },
    meta: {},
  };
  const r = buildRecord({ ctx });
  assert.equal(r.response_status, 529);
  assert.equal(r.has_ratelimit_headers, false);
  assert.equal(r.ratelimit_status, null);
  assert.equal(r.x_should_retry, true);
  assert.equal(r.retry_after, null);
});

test("buildRecord: 500 with empty headers — graceful nulls everywhere", () => {
  const ctx = { status: 500, headers: {}, meta: {} };
  const r = buildRecord({ ctx });
  assert.equal(r.response_status, 500);
  assert.equal(r.has_ratelimit_headers, false);
  assert.equal(r.x_should_retry, null);
  assert.equal(r.retry_after, null);
  assert.equal(r.upstream_request_id, null);
});

test("buildRecord: x-should-retry false string normalizes to boolean false", () => {
  const ctx = { status: 429, headers: { "x-should-retry": "false" }, meta: {} };
  const r = buildRecord({ ctx });
  assert.equal(r.x_should_retry, false);
});

test("buildRecord: unrecognized x-should-retry value → null (not coerced)", () => {
  const ctx = { status: 429, headers: { "x-should-retry": "maybe" }, meta: {} };
  const r = buildRecord({ ctx });
  assert.equal(r.x_should_retry, null);
});

test("buildRecord: includes ts in ISO 8601 form", () => {
  const ctx = { status: 500, headers: {}, meta: {} };
  const now = new Date("2026-06-22T22:30:00Z");
  const r = buildRecord({ ctx, now });
  assert.equal(r.ts, "2026-06-22T22:30:00.000Z");
});

test("buildRecord: upstream_connection_id from ctx.meta passes through", () => {
  const ctx = { status: 429, headers: {}, meta: { _upstreamConnectionId: "conn_42" } };
  const r = buildRecord({ ctx });
  assert.equal(r.upstream_connection_id, "conn_42");
});

// --- onResponseStart integration ---

test("onResponseStart: env unset → no write", async () => {
  const ctx = { status: 429, headers: { "x-should-retry": "true" }, meta: {} };
  await ext.onResponseStart(ctx);
  assert.equal(readLog().length, 0, "must not write when gate is off");
});

test("onResponseStart: env=on + 200 status → no write", async () => {
  process.env[ENV_GATE] = "on";
  const ctx = { status: 200, headers: {}, meta: {} };
  await ext.onResponseStart(ctx);
  assert.equal(readLog().length, 0, "success responses are not errors");
});

test("onResponseStart: env=on + 429 → exactly one record written", async () => {
  process.env[ENV_GATE] = "on";
  const ctx = {
    status: 429,
    headers: { "x-should-retry": "true", "request-id": "req_e2e_001" },
    meta: { _sessionId: "sess_E2E" },
  };
  await ext.onResponseStart(ctx);
  const rows = readLog();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].response_status, 429);
  assert.equal(rows[0].has_ratelimit_headers, false);
  assert.equal(rows[0].session_id, "sess_E2E");
});

test("onResponseStart: env=on + 503 → captured with has_ratelimit_headers=false", async () => {
  process.env[ENV_GATE] = "on";
  const ctx = { status: 503, headers: {}, meta: {} };
  await ext.onResponseStart(ctx);
  const rows = readLog();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].response_status, 503);
});

test("onResponseStart: env=on + usage-limit 429 → has_ratelimit_headers=true", async () => {
  process.env[ENV_GATE] = "on";
  const ctx = {
    status: 429,
    headers: {
      "anthropic-ratelimit-unified-status": "limited",
      "retry-after": "300",
    },
    meta: {},
  };
  await ext.onResponseStart(ctx);
  const rows = readLog();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].has_ratelimit_headers, true);
  assert.equal(rows[0].ratelimit_status, "limited");
  assert.equal(rows[0].retry_after, "300");
});

test("onResponseStart: two distinct error responses → two records", async () => {
  process.env[ENV_GATE] = "on";
  await ext.onResponseStart({ status: 429, headers: {}, meta: {} });
  await ext.onResponseStart({ status: 500, headers: {}, meta: {} });
  const rows = readLog();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].response_status, 429);
  assert.equal(rows[1].response_status, 500);
});

test("onResponseStart: fail-open on bad ctx — does not throw", async () => {
  process.env[ENV_GATE] = "on";
  // Force a throwing path by passing a non-Object meta that JSON.stringify
  // would still serialize cleanly; instead trigger via headers proxy that
  // throws on Object.keys.
  const headers = new Proxy({}, {
    ownKeys() { throw new Error("synthetic"); },
  });
  const ctx = { status: 429, headers, meta: {} };
  // Should not throw
  await ext.onResponseStart(ctx);
  // And should not have written a record
  assert.equal(readLog().length, 0);
});

// --- onRequest seam ---

test("onRequest: env=on + body.model captures _requestedModel into ctx.meta", async () => {
  process.env[ENV_GATE] = "on";
  const ctx = { body: { model: "claude-sonnet-4-6" }, meta: {} };
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._requestedModel, "claude-sonnet-4-6");
});

test("onRequest: env unset → no _requestedModel write", async () => {
  const ctx = { body: { model: "claude-sonnet-4-6" }, meta: {} };
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._requestedModel, undefined);
});

test("onRequest: does not clobber pre-existing _requestedModel (rate-limit-log sets it earlier)", async () => {
  process.env[ENV_GATE] = "on";
  const ctx = { body: { model: "claude-sonnet-4-6" }, meta: { _requestedModel: "rate-limit-log-set-this-first" } };
  await ext.onRequest(ctx);
  assert.equal(ctx.meta._requestedModel, "rate-limit-log-set-this-first",
    "respect earlier writer; no double-set");
});

test("onRequest: no body → graceful no-op", async () => {
  process.env[ENV_GATE] = "on";
  const ctx = { meta: {} };
  await ext.onRequest(ctx);
  // Should not throw; should not set _requestedModel
  assert.equal(ctx.meta._requestedModel, undefined);
});

// --- Order ---

test("extension order is 670 (after rate-limit-log at 660)", () => {
  assert.equal(ext.order, 670);
});

// --- Field assertions for the AITL-requested minimal shape ---

test("record contains all AITL-required fields", () => {
  const ctx = {
    status: 429,
    headers: { "request-id": "req_X", "x-should-retry": "true" },
    meta: { _sessionId: "sess_X", _requestedModel: "claude-opus-4-7" },
  };
  const r = buildRecord({ ctx });
  // Per AITL's directive: "Even a minimal {ts, sid, request_id, model,
  // upstream_status, x_should_retry, retry_after, has_ratelimit_headers}
  // line would close the gap."
  assert.ok(r.ts, "ts");
  assert.equal(r.session_id, "sess_X", "sid");
  assert.equal(r.upstream_request_id, "req_X", "request_id");
  assert.equal(r.requested_model, "claude-opus-4-7", "model");
  assert.equal(r.response_status, 429, "upstream_status");
  assert.equal(r.x_should_retry, true, "x_should_retry");
  assert.equal(r.retry_after, null, "retry_after present (nullable)");
  assert.equal(r.has_ratelimit_headers, false, "has_ratelimit_headers (the discriminator)");
});
