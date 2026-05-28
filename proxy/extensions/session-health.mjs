import { readFileSync } from "node:fs";
import { sessionFilename, sessionFilePath } from "./cache-telemetry.mjs";

// session-health — read-only early-warning for the CC thinking-desync wedge
// (anthropics/claude-code#63147). Long-running Opus 4.7 [1m] sessions grow
// their live context until CC's own history reconstruction desyncs a
// thinking-block signature, producing a permanent 400 on every subsequent
// turn. This extension OBSERVES (never mutates the body) and records the
// conditions that correlate with the trip, plus emits a one-time stderr warn
// so the operator can retire the session deliberately before it dies.
//
// It hands its computed fields to the existing per-session writer
// (cache-telemetry, order 600) via ctx.meta._sessionHealth; cache-telemetry
// merges them into the single per-session JSON write. This extension never
// writes that file itself (single-writer invariant).

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

const DEFAULT_WARN_TOKENS = 250_000;
const DEFAULT_HIGH_TOKENS = 340_000; // just under the observed ~382K trip

// --- Module-scope state ---
// Cross-request accumulators, seeded once-per-process from the prior persisted
// file so first_seen / max / count stay accurate across the proxy restarts
// that multi-week sessions inevitably span.
const sessionState = new Map(); // key -> { firstSeen, max, count }
// Sessions already given the one-time "high" stderr warn this process.
const warnedSessions = new Set();

function parseTokenEnv(raw, def) {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

// Exported for unit testing.
export function loadConfig(env = process.env) {
  return {
    warnTokens: parseTokenEnv(env.CACHE_FIX_THINKING_RISK_WARN_TOKENS, DEFAULT_WARN_TOKENS),
    highTokens: parseTokenEnv(env.CACHE_FIX_THINKING_RISK_HIGH_TOKENS, DEFAULT_HIGH_TOKENS),
    enabled: env.CACHE_FIX_THINKING_RISK !== "off",
  };
}

export function countThinkingBlocks(body) {
  if (!body || !Array.isArray(body.messages)) return 0;
  let n = 0;
  for (const msg of body.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && THINKING_TYPES.has(block.type)) n++;
    }
  }
  return n;
}

export function computeContextTokens(cacheStats) {
  if (!cacheStats) return 0;
  return (
    (cacheStats.inputTokens || 0) +
    (cacheStats.cacheRead || 0) +
    (cacheStats.cacheCreation || 0)
  );
}

export function computeRisk(contextTokens, { warnTokens, highTokens }) {
  if (contextTokens >= highTokens) return "high";
  if (contextTokens >= warnTokens) return "warn";
  return "ok";
}

function seedFromFile(rawSid, now) {
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(sessionFilePath(rawSid), "utf8"));
  } catch {}
  return {
    firstSeen: typeof prev?.first_seen === "string" ? prev.first_seen : now,
    max: Number.isFinite(prev?.thinking_block_max) ? prev.thinking_block_max : 0,
    count: Number.isFinite(prev?.request_count) ? prev.request_count : 0,
  };
}

export default {
  name: "session-health",
  description:
    "Observe per-session thinking-desync risk (context size + thinking-block count) and warn before the session reaches the danger zone. Read-only; never mutates the body.",
  order: 590, // after request-body mutators (so the count is the forwarded body), before the writer (cache-telemetry, 600)

  async onRequest(ctx) {
    // Count thinking blocks in the (near-final) forwarded body. Session id is
    // resolved by cache-telemetry's onRequest (order 600), which runs AFTER
    // this hook — so we don't read the session id here; we read it in
    // onStreamEvent, by which time it is set.
    ctx.meta._thinkingBlockCount = countThinkingBlocks(ctx.body);
  },

  async onStreamEvent(ctx) {
    const { event } = ctx;
    if (!event || event.type !== "message_delta") return;
    // Once per response, regardless of how many message_delta events arrive.
    if (ctx.meta._sessionHealthDone) return;
    ctx.meta._sessionHealthDone = true;

    const now = new Date().toISOString();
    const rawSid = ctx.meta._sessionId ?? null;
    const key = sessionFilename(rawSid);
    const thinkingBlockCount = ctx.meta._thinkingBlockCount || 0;
    const contextTokens = computeContextTokens(ctx.meta.cacheStats);

    let st = sessionState.get(key);
    if (!st) {
      st = seedFromFile(rawSid, now);
      sessionState.set(key, st);
    }
    st.count += 1;
    st.max = Math.max(st.max, thinkingBlockCount);

    const health = {
      context_tokens: contextTokens,
      thinking_block_count: thinkingBlockCount,
      thinking_block_max: st.max,
      first_seen: st.firstSeen,
      request_count: st.count,
    };

    const cfg = loadConfig();
    if (cfg.enabled) {
      const risk = computeRisk(contextTokens, cfg);
      health.thinking_desync_risk = risk;
      if (risk === "high" && !warnedSessions.has(key)) {
        warnedSessions.add(key);
        const sidLabel = rawSid || "unknown";
        process.stderr.write(
          `[session-health] session ${sidLabel} high thinking-desync risk: ` +
            `context_tokens=${contextTokens} (>= ${cfg.highTokens}), ` +
            `thinking_block_count=${thinkingBlockCount}. ` +
            `Consider retiring this session (write SESSION_STATE + /clear).\n`,
        );
      }
    }

    // Hand off to cache-telemetry (order 600) to persist in its single write.
    ctx.meta._sessionHealth = health;
  },

  // Test-only: reset module state between tests.
  __resetForTests() {
    sessionState.clear();
    warnedSessions.clear();
  },
};
