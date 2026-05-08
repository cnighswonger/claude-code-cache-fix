// rate-limit-log — append per-event record to ~/.claude/usage-log/rate-limit-events.jsonl
// when an upstream response looks like a burst/concurrency rate-limit hit.
//
// See docs/directives/proxy-rate-limit-logging.md for the full design.
//
// Activation: enabled:false in the export default. Users opt in via
//   "rate-limit-log": { "enabled": true, "order": 660 }
// in proxy/extensions.json. No env-var enable flag.
//
// Detection signature is grounded in 88 captured 429 responses from the
// 2026-05-08 00:06-00:21 UTC burst (15 min window, single account, full HTTP
// fidelity via tee between cache-fix-proxy and llm-relay). Brief at
//   ~/git_repos/claude/docs/issues/cache-fix-429-burst-data-2026-05-08.md
// Across all 88: status === 429, content-type: application/json (no SSE),
// body.type === "error", body.error.type === "rate_limit_error",
// x-should-retry: "true". No Retry-After. No anthropic-ratelimit-* headers.
// Anthropic's `error.message` is literally "Error" — no class hint.

import { mkdir, appendFile } from "node:fs/promises";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// Paths resolved per call so tests can swap $HOME between cases. The
// homedir() call is essentially free.
function paths() {
  const home = homedir();
  return {
    logPath: join(home, ".claude", "usage-log", "rate-limit-events.jsonl"),
    accountPath: join(home, ".claude", "quota-status", "account.json"),
    sessionsDir: join(home, ".claude", "quota-status", "sessions"),
  };
}

const BODY_EXCERPT_MAX = 256;
const ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000;

// --- Detection predicate ---
//
// Grounded in the 2026-05-08 88-event burst capture: every burst-limit 429
// has body shape {"type":"error","error":{"type":"rate_limit_error",...}}.
// We require both the HTTP status AND the body shape — status alone would
// also catch classic RPM/TPM 429s, which may have a different error.type
// (we don't have a captured non-burst 429 to compare yet, but the brief flags
// this as the desired distinction).
//
// Header-only signals (x-should-retry: "true") are reported in the record but
// not used as detection gates — Anthropic could change those independently of
// the body, and the body schema is the canonical contract.
export function isRateLimitResponse(ctx) {
  if (!ctx || typeof ctx.status !== "number") return false;
  if (ctx.status !== 429) return false;
  const body = ctx.body;
  if (!body || typeof body !== "object") return false;
  return body.type === "error" && body.error?.type === "rate_limit_error";
}

// --- Field extractors (test seams) ---

export function estimateRequestSizeTokens(body) {
  if (!body || typeof body !== "object") return 0;
  let chars = 0;
  if (typeof body.system === "string") chars += body.system.length;
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block && typeof block.text === "string") chars += block.text.length;
    }
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (typeof msg?.content === "string") {
        chars += msg.content.length;
      } else if (Array.isArray(msg?.content)) {
        for (const block of msg.content) {
          if (typeof block?.text === "string") chars += block.text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

export function bodyExcerpt(body) {
  if (body === undefined || body === null) return "";
  let s;
  try {
    s = typeof body === "string" ? body : JSON.stringify(body);
  } catch {
    s = String(body);
  }
  return s.slice(0, BODY_EXCERPT_MAX);
}

export function isPeakHourOldSchedule(now = new Date()) {
  const day = now.getUTCDay(); // 0 = Sun, 1..5 = Mon..Fri, 6 = Sat
  const hour = now.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 13 && hour < 19;
}

export function countActiveSessions(now = Date.now(), sessionsDir = paths().sessionsDir) {
  let entries;
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return 0;
  }
  let count = 0;
  const cutoff = now - ACTIVE_SESSION_WINDOW_MS;
  for (const name of entries) {
    try {
      const st = statSync(join(sessionsDir, name));
      if (st.mtimeMs >= cutoff) count++;
    } catch {}
  }
  return count;
}

export function readQ5hPctAtEvent(accountPath = paths().accountPath) {
  try {
    const data = JSON.parse(readFileSync(accountPath, "utf8"));
    return data?.five_hour?.pct ?? null;
  } catch {
    return null;
  }
}

export function buildRecord({ ctx, now = new Date() }) {
  // Anthropic's error responses carry the request id in TWO places: the
  // `request-id` response header and the body's `request_id` field. Prefer
  // body (canonical), fall back to header.
  const headerReqId = ctx?.headers?.["request-id"] || null;
  const bodyReqId = (ctx?.body && typeof ctx.body === "object")
    ? (ctx.body.request_id || null)
    : null;
  const xShouldRetry = ctx?.headers?.["x-should-retry"] || null;

  return {
    ts: now.toISOString(),
    type: "rate_limit",
    session_id: ctx?.meta?._sessionId ?? null,
    request_path: ctx?.meta?._requestPath || "/v1/messages",
    request_size_tokens: ctx?.meta?._requestSizeTokens ?? 0,
    response_status: ctx?.status ?? null,
    response_body_excerpt: bodyExcerpt(ctx?.body),
    concurrent_sessions_estimate: countActiveSessions(now.getTime()),
    q5h_pct_at_event: readQ5hPctAtEvent(),
    peak_hour_old_schedule: isPeakHourOldSchedule(now),
    upstream_request_id: bodyReqId || headerReqId,
    x_should_retry: xShouldRetry,
  };
}

// --- I/O ---

async function appendJsonl(record, path = paths().logPath) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
}

// Test helper: write to a caller-supplied path (bypasses default).
export async function writeRecord(record, path) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
}

// Exported so tests / external diagnostics can resolve the current path.
export function getLogPath() {
  return paths().logPath;
}

// --- Extension contract ---

export default {
  name: "rate-limit-log",
  description: "Append rate-limit incident records to ~/.claude/usage-log/rate-limit-events.jsonl (opt-in)",
  enabled: false,
  order: 660,

  async onRequest(ctx) {
    if (!ctx || !ctx.body) return;
    try {
      ctx.meta = ctx.meta || {};
      ctx.meta._requestSizeTokens = estimateRequestSizeTokens(ctx.body);
      // Future-proof: when the proxy gains other paths beyond /v1/messages,
      // pass the path through ctx so we can record it. Until then default in
      // buildRecord. We don't have ctx.path today, so this is a no-op.
    } catch {
      // Fail-open: never throw to the pipeline.
    }
  },

  async onResponse(ctx) {
    if (!isRateLimitResponse(ctx)) return;
    try {
      const record = buildRecord({ ctx });
      await appendJsonl(record);
    } catch {
      // Fail-open: never throw to the pipeline.
    }
  },
};
