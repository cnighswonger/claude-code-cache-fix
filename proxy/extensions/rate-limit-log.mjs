// rate-limit-log — append per-event record to ~/.claude/usage-log/rate-limit-events.jsonl
// when an upstream response carries the canonical Anthropic rate-limit error
// envelope. This is a SUPERSET of burst/concurrency events: the same
// envelope is returned for RPM/ITPM/OTPM and auto-mode classifier overflow.
// Splitting the classes is a post-analysis problem on the JSONL stream.
//
// See docs/directives/proxy-rate-limit-logging.md for the full design and
// the post-analysis playbook.
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
//
// SCOPE NOTE: this extension logs ALL `rate_limit_error` 429s. Per
// Anthropic's public docs, that error type is shared across the
// burst/concurrency limiter, classic RPM/ITPM/OTPM limiters, and (per
// Lead's 2026-05-08 follow-up) auto-mode classifier traffic on Opus 4.7.
// The response itself carries no signal that distinguishes those classes —
// `error.message` is literally "Error". Splitting burst-vs-RPM/TPM and
// classifier-vs-main-inference happens in post-analysis, using the
// recorded `requested_model`, `request_path`, inter-arrival timing, and
// `request_size_tokens` fields on each row. Do NOT treat this file as
// burst-limit-only evidence; it's a superset.

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
// Matches the canonical Anthropic rate-limit error envelope:
//   { "type": "error", "error": { "type": "rate_limit_error", ... } } at 429
//
// Per Anthropic's public docs and the 2026-05-08 capture, this envelope is
// returned for every flavor of 429 — burst/concurrency, RPM, ITPM, OTPM,
// and auto-mode classifier overflow. The response itself carries no
// discriminator. Distinguishing the classes is a post-analysis problem
// over the JSONL using inter-arrival timing, `requested_model`, and
// `request_size_tokens`. See directive for the analysis playbook.
//
// Header signals (x-should-retry, request-id) are recorded in the row but
// NOT used as detection gates — Anthropic could change them independently
// of the body, and the body schema is the canonical contract.
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

// Bounds the persisted excerpt length, NOT the temporary serialization
// allocation. JSON.stringify still materializes the full body string before
// the slice. In practice this is fine — Anthropic's 429 bodies are ~120
// bytes per the 2026-05-08 capture, and the proxy already buffers the full
// body upstream of this extension (server.mjs:79-82). For string inputs the
// length is capped pre-stringify, so a hostile pre-rendered string can't
// blow up here. If a future call site ever passes a giant pre-built object
// graph, the upstream-buffering and per-extension try/catch isolate the
// allocation cost from the rest of the pipeline.
export function bodyExcerpt(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body.slice(0, BODY_EXCERPT_MAX);
  let s;
  try {
    s = JSON.stringify(body);
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
    schema_version: 1,
    ts: now.toISOString(),
    type: "rate_limit",
    session_id: ctx?.meta?._sessionId ?? null,
    requested_model: ctx?.meta?._requestedModel ?? null,
    request_path: ctx?.meta?._requestPath || "/v1/messages",
    request_size_tokens: ctx?.meta?._requestSizeTokens ?? 0,
    response_status: ctx?.status ?? null,
    response_body_excerpt: bodyExcerpt(ctx?.body),
    concurrent_sessions_estimate: countActiveSessions(now.getTime()),
    q5h_pct_at_event: readQ5hPctAtEvent(),
    peak_hour_old_schedule: isPeakHourOldSchedule(now),
    upstream_request_id: bodyReqId || headerReqId,
    x_should_retry: xShouldRetry,
    // Stable id of the underlying TCP socket that carried this request,
    // assigned in proxy/upstream.mjs via WeakMap<Socket, id>. Persists across
    // keep-alive reuse, recycles on socket close. Null if upstream errored
    // before a socket was assigned. Populated by server.mjs after
    // forwardRequest resolves. Use for H3-vs-H4 verification per Lead's
    // 2026-05-08 brief: if 429s cluster on one connection id, the limiter
    // is per-connection (H3); if they spread across many, client-side
    // queue saturation (H4) is more likely.
    upstream_connection_id: ctx?.meta?._upstreamConnectionId ?? null,
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
      // Capture the requested model so post-analysis can distinguish
      // auto-mode classifier traffic (Opus 4.7) from main-inference (any
      // model). Per Lead's 2026-05-08 finding, CC's auto-mode safety
      // classifier runs a separate Opus-4-7 API call before each Edit, and
      // those classifier calls share the same account-wide concurrency
      // limiter — so the rate-limit JSONL is naturally a mix of both
      // traffic types. requested_model + request_size_tokens together let
      // post-analysis split them.
      if (typeof ctx.body.model === "string") {
        ctx.meta._requestedModel = ctx.body.model;
      }
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
