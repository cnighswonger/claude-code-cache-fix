// Tests for proxy/extensions/rate-limit-log.mjs.
//
// Scaffolded ahead of a captured 429 response — the detection predicate is
// the conservative v0 (status === 429). t.todo markers below indicate
// assertions that need to be tightened against real captured bytes once
// AI Team Lead's interim socat/tee tee surfaces the actual upstream shape.
// See docs/directives/proxy-rate-limit-logging.md for the full design.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// ---------------------------------------------------------------------------
// isRateLimitResponse — v0 predicate (status === 429)
// ---------------------------------------------------------------------------

test("[#1] isRateLimitResponse: 429 status → true", () => {
  assert.equal(isRateLimitResponse({ status: 429 }), true);
});

test("[#2] isRateLimitResponse: 200 status → false", () => {
  assert.equal(isRateLimitResponse({ status: 200 }), false);
});

test("[#3] isRateLimitResponse: 500 status → false (v0 only fires on 429)", () => {
  // TODO(captured-429): if the burst-limit ever surfaces as 5xx with a
  // distinguishing body shape, broaden this predicate. Until we have a real
  // capture, 5xx stays out of scope.
  assert.equal(isRateLimitResponse({ status: 500 }), false);
});

test("[#4] isRateLimitResponse: undefined ctx → false (defensive)", () => {
  assert.equal(isRateLimitResponse(undefined), false);
  assert.equal(isRateLimitResponse(null), false);
  assert.equal(isRateLimitResponse({}), false);
});

test.todo(
  "[#5] isRateLimitResponse: tighten to match captured 429 body/header signature — distinguish burst-limit from RPM/TPM 429",
);

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
    },
  };
  const now = new Date(Date.UTC(2026, 4, 7, 14, 30, 45, 123)); // Thu 14:30:45.123 UTC — peak
  const record = buildRecord({ ctx, now });
  assert.equal(record.ts, "2026-05-07T14:30:45.123Z");
  assert.equal(record.type, "rate_limit");
  assert.equal(record.session_id, "b16c607d-d484-4935-840e-e3f7ee78eb08");
  assert.equal(record.request_path, "/v1/messages");
  assert.equal(record.request_size_tokens, 50);
  assert.equal(record.response_status, 429);
  assert.match(record.response_body_excerpt, /Server is temporarily limiting requests/);
  assert.equal(record.peak_hour_old_schedule, true);
  // concurrent_sessions_estimate and q5h_pct_at_event depend on host filesystem;
  // tested separately via countActiveSessions / readQ5hPctAtEvent.
  assert.equal(typeof record.concurrent_sessions_estimate, "number");
  // q5h_pct_at_event may be number or null depending on host state; both valid.
  assert.ok(record.q5h_pct_at_event === null || typeof record.q5h_pct_at_event === "number");
});

test("[#21] buildRecord: missing meta fields → null/zero defaults, no throw", () => {
  const ctx = { status: 429, body: { error: "x" }, meta: {} };
  const record = buildRecord({ ctx });
  assert.equal(record.session_id, null);
  assert.equal(record.request_size_tokens, 0);
  assert.equal(record.request_path, "/v1/messages");
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
// Pipeline-level integration deferred to a follow-up PR after captured-429
// fixture lands. The follow-up will:
//   - drive a synthetic 429 (matching captured shape) through runOnRequest +
//     runOnResponse and assert a row appears at the configured log path
//   - drive a 200 SSE response and assert NO row appears
//   - if the captured response turns out to be SSE-shaped, add an
//     onStreamEvent detection branch + corresponding pipeline test
// ---------------------------------------------------------------------------

test.todo("[#23] pipeline: 429 response writes one JSONL row to ~/.claude/usage-log/rate-limit-events.jsonl");
test.todo("[#24] pipeline: 200 response writes zero rows");
test.todo("[#25] pipeline: SSE-shaped 429 (if upstream uses that path) writes one row via onStreamEvent");
