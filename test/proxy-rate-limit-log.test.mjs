// Tests for proxy/extensions/rate-limit-log.mjs.
//
// Detection predicate is grounded in the 2026-05-08 88-event burst capture —
// see docs/directives/proxy-rate-limit-logging.md. Fixture at
// test/fixtures/burst-limit-429.json (anonymized from the raw capture at
// ~/.local/share/cache-fix-rate-limit-capture/log.jsonl).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRateLimitResponse,
  estimateRequestSizeTokens,
  bodyExcerpt,
  isPeakHourOldSchedule,
  countActiveSessions,
  readQ5hPctAtEvent,
  buildRecord,
  writeRecord,
} from "../proxy/extensions/rate-limit-log.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Anonymized capture from the 2026-05-08 88-event burst.
const CAPTURED_429 = JSON.parse(readFileSync(join(__dirname, "fixtures", "burst-limit-429.json"), "utf8"));
const CAPTURED_429_BODY = JSON.parse(CAPTURED_429.body);

function makeCapturedCtx(overrides = {}) {
  return {
    status: CAPTURED_429.status,
    headers: { ...CAPTURED_429.headers },
    body: { ...CAPTURED_429_BODY },
    meta: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isRateLimitResponse — status + body-shape predicate, grounded in capture
// ---------------------------------------------------------------------------

test("[#1] isRateLimitResponse: real captured 429 fixture → true", () => {
  // Drives the actual response shape from the 2026-05-08 burst capture.
  assert.equal(isRateLimitResponse(makeCapturedCtx()), true);
});

test("[#2] isRateLimitResponse: 200 status → false", () => {
  assert.equal(isRateLimitResponse({ status: 200, body: {} }), false);
});

test("[#3] isRateLimitResponse: 500 status → false (predicate gates on 429 specifically)", () => {
  assert.equal(isRateLimitResponse({ status: 500, body: { type: "error", error: { type: "rate_limit_error" } } }), false);
});

test("[#4] isRateLimitResponse: undefined ctx → false (defensive)", () => {
  assert.equal(isRateLimitResponse(undefined), false);
  assert.equal(isRateLimitResponse(null), false);
  assert.equal(isRateLimitResponse({}), false);
});

test("[#5] isRateLimitResponse: 429 with non-rate_limit_error body → false", () => {
  // Status alone is not enough — the predicate also requires the canonical
  // rate_limit_error body shape. This is what distinguishes the rate-limit
  // class (any rate_limit_error 429: burst/RPM/TPM/classifier) from other
  // 429-shaped errors (auth quota, overloaded_error, etc.).
  assert.equal(
    isRateLimitResponse({ status: 429, body: { type: "error", error: { type: "overloaded_error" } } }),
    false,
  );
  assert.equal(
    isRateLimitResponse({ status: 429, body: { type: "error", error: { type: "invalid_request_error" } } }),
    false,
  );
});

test("[#5a] isRateLimitResponse: 429 with no body / non-object body → false", () => {
  assert.equal(isRateLimitResponse({ status: 429 }), false);
  assert.equal(isRateLimitResponse({ status: 429, body: null }), false);
  assert.equal(isRateLimitResponse({ status: 429, body: "Error" }), false);
});

// ---------------------------------------------------------------------------
// Field extractors
// ---------------------------------------------------------------------------

test("[#6] estimateRequestSizeTokens: chars / 4 across system + messages", () => {
  // 40 chars total → 10 tokens
  const body = {
    system: [{ text: "0123456789" }, { text: "0123456789" }],
    messages: [{ content: "0123456789" }, { content: [{ text: "0123456789" }] }],
  };
  assert.equal(estimateRequestSizeTokens(body), 10);
});

test("[#7] estimateRequestSizeTokens: empty body → 0", () => {
  assert.equal(estimateRequestSizeTokens({}), 0);
  assert.equal(estimateRequestSizeTokens(null), 0);
  assert.equal(estimateRequestSizeTokens(undefined), 0);
});

test("[#8] bodyExcerpt: bounded to 256 chars even for hostile body", () => {
  const huge = { error: { message: "x".repeat(10_000) } };
  const out = bodyExcerpt(huge);
  assert.equal(out.length, 256);
  // Front of the excerpt is the JSON-serialized prefix.
  assert.match(out, /^\{"error":/);
});

test("[#9] bodyExcerpt: handles non-JSON inputs without throwing", () => {
  assert.equal(bodyExcerpt("plain string"), "plain string");
  assert.equal(bodyExcerpt(null), "");
  assert.equal(bodyExcerpt(undefined), "");
});

test("[#10] isPeakHourOldSchedule: weekday 13:00–18:59 UTC → true", () => {
  // Wednesday 2026-05-06 14:30 UTC — inside the old peak window.
  assert.equal(isPeakHourOldSchedule(new Date(Date.UTC(2026, 4, 6, 14, 30))), true);
});

test("[#11] isPeakHourOldSchedule: weekday 12:59 UTC → false (just before peak)", () => {
  assert.equal(isPeakHourOldSchedule(new Date(Date.UTC(2026, 4, 6, 12, 59))), false);
});

test("[#12] isPeakHourOldSchedule: weekday 19:00 UTC → false (just after peak)", () => {
  assert.equal(isPeakHourOldSchedule(new Date(Date.UTC(2026, 4, 6, 19, 0))), false);
});

test("[#13] isPeakHourOldSchedule: Saturday 14:00 UTC → false (weekend)", () => {
  // Saturday 2026-05-09
  assert.equal(isPeakHourOldSchedule(new Date(Date.UTC(2026, 4, 9, 14, 0))), false);
});

test("[#14] isPeakHourOldSchedule: Sunday 14:00 UTC → false (weekend)", () => {
  // Sunday 2026-05-10
  assert.equal(isPeakHourOldSchedule(new Date(Date.UTC(2026, 4, 10, 14, 0))), false);
});

// ---------------------------------------------------------------------------
// countActiveSessions — touches the filesystem; uses tmpdir
// ---------------------------------------------------------------------------

test("[#15] countActiveSessions: counts files mtime within 5min window", () => {
  const dir = mkdtempSync(join(tmpdir(), "rll-sess-"));
  try {
    const now = Date.now();
    // Three "active" files
    for (let i = 0; i < 3; i++) {
      const p = join(dir, `active-${i}.json`);
      writeFileSync(p, "{}");
    }
    // One "stale" file: write then backdate mtime to 10 min ago
    const stale = join(dir, "stale.json");
    writeFileSync(stale, "{}");
    const tenMinAgo = (now - 10 * 60 * 1000) / 1000;
    utimesSync(stale, tenMinAgo, tenMinAgo);
    assert.equal(countActiveSessions(now, dir), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[#16] countActiveSessions: missing directory → 0 (no throw)", () => {
  const missing = join(tmpdir(), "rll-missing-" + Math.random().toString(36).slice(2));
  assert.equal(countActiveSessions(Date.now(), missing), 0);
});

// ---------------------------------------------------------------------------
// readQ5hPctAtEvent
// ---------------------------------------------------------------------------

test("[#17] readQ5hPctAtEvent: reads .five_hour.pct from account.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "rll-acct-"));
  try {
    const path = join(dir, "account.json");
    writeFileSync(path, JSON.stringify({ five_hour: { pct: 42 } }));
    assert.equal(readQ5hPctAtEvent(path), 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[#18] readQ5hPctAtEvent: missing file → null", () => {
  assert.equal(readQ5hPctAtEvent("/nonexistent/path/account.json"), null);
});

test("[#19] readQ5hPctAtEvent: malformed JSON → null", () => {
  const dir = mkdtempSync(join(tmpdir(), "rll-acct-"));
  try {
    const path = join(dir, "account.json");
    writeFileSync(path, "not json");
    assert.equal(readQ5hPctAtEvent(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildRecord — full row assembly
// ---------------------------------------------------------------------------

test("[#20] buildRecord: full happy path with all fields populated", () => {
  const ctx = {
    status: 429,
    body: { error: { type: "overloaded_error", message: "Server is temporarily limiting requests" } },
    meta: {
      _sessionId: "b16c607d-d484-4935-840e-e3f7ee78eb08",
      _requestSizeTokens: 50,
      _requestPath: "/v1/messages",
      _requestedModel: "claude-opus-4-7",
      _upstreamConnectionId: "cn-7",
    },
  };
  const now = new Date(Date.UTC(2026, 4, 7, 14, 30, 45, 123)); // Thu 14:30:45.123 UTC — peak
  const record = buildRecord({ ctx, now });
  assert.equal(record.schema_version, 1);
  assert.equal(record.ts, "2026-05-07T14:30:45.123Z");
  assert.equal(record.type, "rate_limit");
  assert.equal(record.session_id, "b16c607d-d484-4935-840e-e3f7ee78eb08");
  assert.equal(record.requested_model, "claude-opus-4-7");
  assert.equal(record.request_path, "/v1/messages");
  assert.equal(record.request_size_tokens, 50);
  assert.equal(record.response_status, 429);
  assert.match(record.response_body_excerpt, /Server is temporarily limiting requests/);
  assert.equal(record.peak_hour_old_schedule, true);
  assert.equal(record.upstream_connection_id, "cn-7");
  // concurrent_sessions_estimate and q5h_pct_at_event depend on host filesystem;
  // tested separately via countActiveSessions / readQ5hPctAtEvent.
  assert.equal(typeof record.concurrent_sessions_estimate, "number");
  // q5h_pct_at_event may be number or null depending on host state; both valid.
  assert.ok(record.q5h_pct_at_event === null || typeof record.q5h_pct_at_event === "number");
});

test("[#21] buildRecord: missing meta fields → null/zero defaults, no throw", () => {
  const ctx = { status: 429, body: { error: "x" }, meta: {} };
  const record = buildRecord({ ctx });
  assert.equal(record.schema_version, 1);
  assert.equal(record.session_id, null);
  assert.equal(record.requested_model, null);
  assert.equal(record.request_size_tokens, 0);
  assert.equal(record.request_path, "/v1/messages");
  assert.equal(record.upstream_connection_id, null);
});

// ---------------------------------------------------------------------------
// End-to-end: writeRecord round-trip
// ---------------------------------------------------------------------------

test("[#22] writeRecord: appends one JSON line per call, parsable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rll-out-"));
  try {
    const path = join(dir, "rate-limit-events.jsonl");
    await writeRecord({ a: 1 }, path);
    await writeRecord({ a: 2 }, path);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
    assert.deepEqual(JSON.parse(lines[1]), { a: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Extension-level integration: drive captured-shape 429 through onRequest +
// onResponse on a tmpdir-rooted HOME and verify one JSONL row lands.
// ---------------------------------------------------------------------------

import rateLimitLog from "../proxy/extensions/rate-limit-log.mjs";

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), "rll-home-"));
  mkdirSync(join(home, ".claude", "quota-status", "sessions"), { recursive: true });
  // Seed account.json so q5h_pct_at_event has a concrete value to assert on.
  writeFileSync(
    join(home, ".claude", "quota-status", "account.json"),
    JSON.stringify({ five_hour: { pct: 17 } }),
  );
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  return {
    home,
    logPath: join(home, ".claude", "usage-log", "rate-limit-events.jsonl"),
    cleanup: () => {
      process.env.HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("[#23] extension: captured-shape 429 → exactly one JSONL row written", async () => {
  const env = setupHome();
  try {
    const ctx = makeCapturedCtx({ meta: { _sessionId: "session-A", _requestPath: "/v1/messages" } });
    // Simulate the request-side hook so meta._requestSizeTokens AND
    // meta._requestedModel are populated.
    await rateLimitLog.onRequest({
      body: { model: "claude-opus-4-7", messages: [{ content: "x".repeat(40) }] },
      headers: {},
      meta: ctx.meta,
    });
    await rateLimitLog.onResponse(ctx);

    assert.ok(existsSync(env.logPath), "JSONL file must exist at ~/.claude/usage-log/rate-limit-events.jsonl");
    const lines = readFileSync(env.logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "exactly one row written");

    const row = JSON.parse(lines[0]);
    assert.equal(row.schema_version, 1);
    assert.equal(row.type, "rate_limit");
    assert.equal(row.response_status, 429);
    assert.equal(row.session_id, "session-A");
    assert.equal(row.requested_model, "claude-opus-4-7");
    assert.equal(row.request_size_tokens, 10);
    assert.match(row.response_body_excerpt, /"rate_limit_error"/);
    // Captured fields from the real response.
    assert.equal(row.x_should_retry, "true");
    assert.equal(row.upstream_request_id, CAPTURED_429_BODY.request_id);
    // q5h read from the seeded account.json
    assert.equal(row.q5h_pct_at_event, 17);
  } finally {
    env.cleanup();
  }
});

test("[#23b] extension: upstream_connection_id flows from meta to JSONL row (H3-vs-H4 verification)", async () => {
  // The end-to-end signal that lets post-analysis distinguish per-connection
  // limiting from client-side queue saturation: each row carries the stable
  // id of the upstream socket that produced the 429.
  const env = setupHome();
  try {
    // Two events on the same connection (cn-1) followed by one on a fresh
    // connection (cn-2). Models the H3 pattern: limiter clusters on a
    // specific connection.
    for (const [sid, connId] of [["session-A", "cn-1"], ["session-A", "cn-1"], ["session-B", "cn-2"]]) {
      await rateLimitLog.onResponse(makeCapturedCtx({
        meta: { _sessionId: sid, _upstreamConnectionId: connId },
      }));
    }
    const lines = readFileSync(env.logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    const rows = lines.map((l) => JSON.parse(l));
    assert.deepEqual(
      rows.map((r) => r.upstream_connection_id),
      ["cn-1", "cn-1", "cn-2"],
    );
    // Sanity for analysis: 2-of-3 events on cn-1 → that connection looks
    // hot. (The actual analysis lives downstream; this just proves the
    // signal is recorded.)
  } finally {
    env.cleanup();
  }
});

test("[#23a] extension: classifier (Opus 4.7) vs main-inference (other model) recorded distinctly", async () => {
  // Lead's 2026-05-08 finding: auto-mode runs a separate Opus-4-7 classifier
  // call per Edit. Both flavors hit /v1/messages and produce the same 429
  // body shape; requested_model is what lets post-analysis split them.
  const env = setupHome();
  try {
    // Classifier-shaped request (Opus 4.7)
    {
      const meta = { _sessionId: "session-classifier" };
      await rateLimitLog.onRequest({
        body: { model: "claude-opus-4-7", messages: [{ content: "small classifier prompt" }] },
        headers: {},
        meta,
      });
      await rateLimitLog.onResponse(makeCapturedCtx({ meta }));
    }
    // Main-inference-shaped request (Sonnet — still gated by Opus quota per Lead's note)
    {
      const meta = { _sessionId: "session-main" };
      await rateLimitLog.onRequest({
        body: { model: "claude-sonnet-4-6", messages: [{ content: "x".repeat(2000) }] },
        headers: {},
        meta,
      });
      await rateLimitLog.onResponse(makeCapturedCtx({ meta }));
    }
    const lines = readFileSync(env.logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    assert.equal(a.requested_model, "claude-opus-4-7");
    assert.equal(b.requested_model, "claude-sonnet-4-6");
    // Sonnet request should have a larger token estimate than the classifier one.
    assert.ok(b.request_size_tokens > a.request_size_tokens);
  } finally {
    env.cleanup();
  }
});

test("[#24] extension: 200 response writes zero rows", async () => {
  const env = setupHome();
  try {
    await rateLimitLog.onResponse({
      status: 200,
      headers: {},
      body: { type: "message", content: [{ type: "text", text: "hello" }] },
      meta: {},
    });
    assert.equal(existsSync(env.logPath), false, "no JSONL file should be written for 200 responses");
  } finally {
    env.cleanup();
  }
});

test("[#25] extension: 429 with non-rate_limit_error body writes zero rows (predicate gating)", async () => {
  const env = setupHome();
  try {
    await rateLimitLog.onResponse({
      status: 429,
      headers: {},
      body: { type: "error", error: { type: "overloaded_error", message: "..." } },
      meta: {},
    });
    assert.equal(existsSync(env.logPath), false, "429s with non-rate_limit_error body shapes should not be logged by this extension");
  } finally {
    env.cleanup();
  }
});

test("[#26] extension: two captured 429s in sequence write two JSONL rows", async () => {
  // Mirrors the burst capture (88 events in 15 min). Each one stands as its
  // own incident — append-only, no dedup.
  const env = setupHome();
  try {
    await rateLimitLog.onResponse(makeCapturedCtx({ meta: { _sessionId: "session-A" } }));
    await rateLimitLog.onResponse(makeCapturedCtx({ meta: { _sessionId: "session-B" } }));
    const lines = readFileSync(env.logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).session_id, "session-A");
    assert.equal(JSON.parse(lines[1]).session_id, "session-B");
  } finally {
    env.cleanup();
  }
});
