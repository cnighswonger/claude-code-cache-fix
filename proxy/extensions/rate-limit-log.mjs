// rate-limit-log — append per-event record to ~/.claude/usage-log/rate-limit-events.jsonl
// when an upstream response looks like a burst/concurrency rate-limit hit.
//
// See docs/directives/proxy-rate-limit-logging.md for the full design.
//
// Activation: enabled:false in the export default. Users opt in via
//   "rate-limit-log": { "enabled": true, "order": 660 }
// in proxy/extensions.json. No env-var enable flag.
//
// STATUS (2026-05-07): SCAFFOLD ONLY. The detection predicate is the
// conservative v0 (status === 429). It will be tightened to match the actual
// burst-limit body/header signature once we have a captured 429 response on
// disk. The brief tracking that work is at:
//   ~/git_repos/claude/docs/issues/cache-fix-rate-limit-logging-2026-05-07.md
// Until then the v0 predicate over-triggers (catches classic RPM/TPM 429s
// alongside the burst-limit), which is preferred over missing events.

import { mkdir, appendFile } from "node:fs/promises";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".claude", "usage-log");
const LOG_PATH = join(LOG_DIR, "rate-limit-events.jsonl");
const QUOTA_ACCOUNT_PATH = join(homedir(), ".claude", "quota-status", "account.json");
const QUOTA_SESSIONS_DIR = join(homedir(), ".claude", "quota-status", "sessions");

const BODY_EXCERPT_MAX = 256;
const ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000;

// --- Detection predicate (v0, conservative) ---
//
// TODO(captured-429): tighten this to match the actual burst-limit signature.
// Candidates to check once a real response is on disk:
//   - response_status (429? always? sometimes 5xx?)
//   - body.error.type === "rate_limit_error" or similar
//   - body.error.message includes "Server is temporarily limiting requests"
//   - distinguishing response header (anthropic-error-type, etc.)
// Until then, every 429 is captured. Better to over-log + filter than miss.
export function isRateLimitResponse(ctx) {
  if (!ctx || typeof ctx.status !== "number") return false;
  return ctx.status === 429;
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

export function countActiveSessions(now = Date.now(), sessionsDir = QUOTA_SESSIONS_DIR) {
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

export function readQ5hPctAtEvent(accountPath = QUOTA_ACCOUNT_PATH) {
  try {
    const data = JSON.parse(readFileSync(accountPath, "utf8"));
    return data?.five_hour?.pct ?? null;
  } catch {
    return null;
  }
}

export function buildRecord({ ctx, now = new Date() }) {
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
  };
}

// --- I/O ---

async function appendJsonl(record, path = LOG_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
}

// Test helper: write to a caller-supplied path (bypasses default LOG_PATH).
export async function writeRecord(record, path) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
}

export { LOG_PATH };

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
