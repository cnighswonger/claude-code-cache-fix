// upstream-error-log — append a structured record for every non-200 upstream
// response to ~/.claude/usage-log/upstream-errors.jsonl. Closes #235.
//
// Today the proxy's usage-log only records successful (200) responses — the
// NDJSON schema assumes upstream_status: 200 in usage-to-dashboard-ndjson.
// Non-200 responses (429 capacity throttling, 5xx, etc.) only leave an
// unstructured line in the debug log. That makes server-side throttling
// effectively invisible to any analysis built on the usage log.
//
// Two distinct 429 classes that look identical to a user:
//   1. Account/usage-limit 429 — carries `anthropic-ratelimit-unified-*`
//      headers, typically `retry-after`. The existing rate-limit-log
//      extension captures the canonical rate_limit_error body envelope.
//   2. Infrastructure/capacity 429 — Cloudflare-fronted, x-should-retry:
//      "true", NO anthropic-ratelimit-* headers, no retry-after. This is
//      the "Server is temporarily limiting requests (not your usage limit)"
//      case. rate-limit-log MISSES these because their body shape isn't the
//      canonical rate_limit_error envelope.
//
// `has_ratelimit_headers` is the discriminator: true → usage-limit class,
// false → capacity class. Post-analysis pivots on this field.
//
// This extension is a SUPERSET: it captures EVERY non-200 (429s of both
// classes plus 5xx). rate-limit-log remains its own narrower stream with
// the burst-specific context fields. The two files are independent.
//
// Hook choice: onResponseStart, not onResponse. onResponse only fires when
// the proxy successfully JSON-parses the response body (server.mjs:170).
// Many non-200 responses — especially origin-level errors from Cloudflare
// — return HTML or empty bodies that fail to parse, so onResponse would
// silently miss them. onResponseStart fires for every non-streaming
// response (and every SSE response too — we filter on status to skip
// successes).
//
// Activation: enabled:true in proxy/extensions.json + runtime env-gate
// `CACHE_FIX_UPSTREAM_ERROR_LOG=on`. Default OFF.

import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const ENV_VAR = "CACHE_FIX_UPSTREAM_ERROR_LOG";

function logPath() {
  return process.env.CACHE_FIX_UPSTREAM_ERROR_LOG_PATH ||
    join(homedir(), ".claude", "usage-log", "upstream-errors.jsonl");
}

// Detection predicate — every non-200 upstream response is in scope.
// Streaming SSE responses also pass through onResponseStart with the
// response status before the body is consumed, so the status check is
// load-bearing for those paths (a 200-status SSE response must NOT
// trigger this).
export function isUpstreamError(ctx) {
  if (!ctx || typeof ctx.status !== "number") return false;
  return ctx.status >= 400;
}

// Lookup is case-insensitive — Node's http parser lower-cases header names
// but we don't want a subtle break if that ever changes.
function headerLookup(headers, name) {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k];
  }
  return null;
}

// Detect whether the response carries any anthropic-ratelimit-* header.
// This is the load-bearing discriminator per AITL: with-headers → usage
// limit (account quota), without-headers → infrastructure/capacity event.
export function hasRatelimitHeaders(headers) {
  if (!headers) return false;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase().startsWith("anthropic-ratelimit-")) return true;
  }
  return false;
}

export function buildRecord({ ctx, now = new Date() }) {
  const headers = ctx?.headers || {};
  const status = ctx?.status ?? null;
  const upstreamMessage = headerLookup(headers, "x-upstream-message") || null;
  const xShouldRetry = headerLookup(headers, "x-should-retry");
  const retryAfter = headerLookup(headers, "retry-after");
  const requestId = headerLookup(headers, "request-id") || null;

  // x-should-retry comes through as the literal string "true"/"false";
  // normalize to a real boolean (nullable if absent).
  let xShouldRetryBool = null;
  if (xShouldRetry === "true" || xShouldRetry === true) xShouldRetryBool = true;
  else if (xShouldRetry === "false" || xShouldRetry === false) xShouldRetryBool = false;

  // Capture quota-status headers (parseQuotaHeaders would re-implement the
  // logic; for this stream we only need the discriminator + the two most
  // useful 429 context fields).
  const ratelimitHeaders = hasRatelimitHeaders(headers);
  const ratelimitStatus = headerLookup(headers, "anthropic-ratelimit-unified-status") || null;
  const ratelimitOverage = headerLookup(headers, "anthropic-ratelimit-unified-overage-status") || null;

  // Session correlation — same lookup paths used by rate-limit-log so the
  // two streams join cleanly.
  const sessionId = ctx?.meta?._sessionId ?? null;
  const requestedModel = ctx?.meta?._requestedModel ?? null;
  const requestPath = ctx?.meta?._requestPath || "/v1/messages";
  const upstreamConnectionId = ctx?.meta?._upstreamConnectionId ?? null;

  return {
    schema_version: 1,
    ts: now.toISOString(),
    type: "upstream_error",
    session_id: sessionId,
    requested_model: requestedModel,
    request_path: requestPath,
    response_status: status,
    upstream_message: upstreamMessage,
    has_ratelimit_headers: ratelimitHeaders,
    ratelimit_status: ratelimitStatus,
    ratelimit_overage_status: ratelimitOverage,
    x_should_retry: xShouldRetryBool,
    retry_after: retryAfter || null,
    upstream_request_id: requestId,
    upstream_connection_id: upstreamConnectionId,
  };
}

async function appendJsonl(record, path) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
}

// Test helper: write to a caller-supplied path (bypasses default).
export async function writeRecord(record, path) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
}

export function getLogPath() {
  return logPath();
}

export default {
  name: "upstream-error-log",
  description: "Append a structured record for every non-200 upstream response to ~/.claude/usage-log/upstream-errors.jsonl. Default OFF; opt-in via CACHE_FIX_UPSTREAM_ERROR_LOG=on. Closes #235.",
  // Order 670: after rate-limit-log (660). The two extensions are
  // independent (different streams) so the order isn't load-bearing —
  // pick a number after rate-limit-log so the field is visually grouped
  // with the other logging extensions in extensions.json.
  order: 670,

  async onRequest(ctx) {
    if (process.env[ENV_VAR] !== "on") return;
    try {
      // Capture the requested model from the outbound body so the response
      // record can correlate. Independent of rate-limit-log so this works
      // whether or not that extension is enabled. ctx.meta._sessionId is
      // set by cache-telemetry at order 600 (always-on); we rely on that
      // for session correlation.
      if (ctx && ctx.body && typeof ctx.body.model === "string") {
        ctx.meta = ctx.meta || {};
        if (!ctx.meta._requestedModel) {
          ctx.meta._requestedModel = ctx.body.model;
        }
      }
    } catch {
      // Fail-open: never throw to the pipeline.
    }
  },

  async onResponseStart(ctx) {
    if (process.env[ENV_VAR] !== "on") return;
    if (!isUpstreamError(ctx)) return;
    try {
      const record = buildRecord({ ctx });
      await appendJsonl(record, logPath());
    } catch {
      // Fail-open: never throw to the pipeline.
    }
  },
};
