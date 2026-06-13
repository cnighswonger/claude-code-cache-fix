import {
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";

// Paths are resolved per call (not cached at module load) so tests can swap
// $HOME between cases. The homedir() call is essentially free.
function paths() {
  const home = homedir();
  const quotaDir = join(home, ".claude", "quota-status");
  return {
    quotaDir,
    accountPath: join(quotaDir, "account.json"),
    sessionsDir: join(quotaDir, "sessions"),
    legacyPath: join(home, ".claude", "quota-status.json"),
  };
}

const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SWEEP_THROTTLE_MS = 60_000;
const DEFAULT_TTL_DAYS = 7;

// --- Module-scope state ---
let legacyCleanupDone = false;
let lastSweepMs = 0;

// Per-pair model-divergence state for issue #223 / directive
// proxy-statusline-served-model-divergence. Key: `${sessionFilename}|${requestedModel}`.
// Entries hydrate from the per-session JSON on map-miss when the persisted
// requested_model matches the current turn's requested model; otherwise treated
// as fresh. Cleared by the same time-based stale-session sweep as the disk files.
const divergenceState = new Map();
const SAME_FAMILY_STICKY_THRESHOLD = 3;

// Family classification re-exported from the shared `proxy/model-families.mjs`
// helper so this file and `proxy/extensions/model-id-sanitize.mjs` both consume
// the same source of truth on family rosters. See `model-families.mjs` for the
// substring-match semantics and the "oldest in-family" fallback rationale.
//
// Cross-family swap latches sticky immediately in the served-model divergence
// detector below; same-family swap latches after SAME_FAMILY_STICKY_THRESHOLD
// consecutive divergent turns at the same (requestedModel, servedTarget).
// Unknown models fall through to "unknown" and are treated as same-family for
// the counter (conservative).
export { modelFamily } from "../model-families.mjs";
import { modelFamily } from "../model-families.mjs";

// Read the persisted per-session JSON's divergence fields, guarded on
// requested_model equality. Returns the seed shape for divergenceState, or
// null if the file doesn't exist, is unparseable, or has a mismatched
// requested_model. Never throws.
function rehydrateDivergencePair(rawSid, currentRequestedModel) {
  try {
    const raw = readFileSync(sessionFilePath(rawSid), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.requested_model !== currentRequestedModel) return null;
    return {
      servedTarget: typeof parsed.served_model === "string" ? parsed.served_model : null,
      divergentTurnCounter: 0,
      sticky: parsed.model_divergence_sticky === true,
      firstSeenIso: typeof parsed.model_divergence_first_seen === "string"
        ? parsed.model_divergence_first_seen
        : null,
    };
  } catch {
    return null;
  }
}

// Run the family-aware sticky heuristic and return the spread object the
// per-session JSON writer should include, or null when both requested ===
// served AND no prior sticky exists for this pair (caller spreads no-op).
//
// Mutates divergenceState as a side effect — the map is authoritative for
// in-process state. Idempotent on the same turn (returns the same shape if
// called multiple times for the same event).
export function runDivergenceDetector(rawSid, requestedModel, servedModel, nowIso) {
  if (!requestedModel || !servedModel) return null;

  const sessionKey = sessionFilename(rawSid);
  const pairKey = `${sessionKey}|${requestedModel}`;
  let entry = divergenceState.get(pairKey);
  if (!entry) {
    entry = rehydrateDivergencePair(rawSid, requestedModel) || {
      servedTarget: null,
      divergentTurnCounter: 0,
      sticky: false,
      firstSeenIso: null,
    };
    divergenceState.set(pairKey, entry);
  }

  const matched = requestedModel === servedModel;
  if (matched) {
    entry.divergentTurnCounter = 0;
    entry.servedTarget = null;
    if (!entry.sticky) {
      return null;
    }
    return {
      requested_model: requestedModel,
      served_model: servedModel,
      model_divergence_recent: false,
      model_divergence_sticky: true,
      model_divergence_first_seen: entry.firstSeenIso,
    };
  }

  const reqFamily = modelFamily(requestedModel);
  const servFamily = modelFamily(servedModel);
  const crossFamily = reqFamily !== servFamily && reqFamily !== "unknown" && servFamily !== "unknown";

  if (entry.servedTarget !== servedModel) {
    entry.servedTarget = servedModel;
    entry.divergentTurnCounter = 1;
  } else {
    entry.divergentTurnCounter += 1;
  }

  if (!entry.sticky) {
    if (crossFamily || entry.divergentTurnCounter >= SAME_FAMILY_STICKY_THRESHOLD) {
      entry.sticky = true;
      entry.firstSeenIso = nowIso;
    }
  }

  return {
    requested_model: requestedModel,
    served_model: servedModel,
    model_divergence_recent: true,
    model_divergence_sticky: entry.sticky,
    model_divergence_first_seen: entry.firstSeenIso,
  };
}

// Per directive `proxy-quota-status-per-session.md` — derive a filesystem-safe
// filename from a raw session id. Both writer (this extension) and readers
// (tools/quota-statusline.sh, etc.) must apply the same rule.
//
// Rules:
//   - null/undefined/empty/whitespace → "unknown"
//   - matches /^[A-Za-z0-9_-]{1,128}$/ → raw passthrough
//   - else → "inv-" + sha256(raw)[:16]
//
// Exported for unit testing and for the directive's writer/reader contract.
export function sessionFilename(rawId) {
  if (rawId === null || rawId === undefined) return "unknown";
  const s = String(rawId).trim();
  if (s.length === 0) return "unknown";
  if (SAFE_NAME_RE.test(s)) return s;
  return "inv-" + createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// Full path to the per-session file for a raw session id. Exported so sibling
// extensions (e.g. session-health) can READ the prior state this writer wrote,
// using the identical filename rule — reuse, not duplicate.
export function sessionFilePath(rawId) {
  return join(paths().sessionsDir, `${sessionFilename(rawId)}.json`);
}

// Exported so sibling extensions can read the canonical session id from
// REQUEST headers at their own onRequest time — they can't rely on
// ctx.meta._sessionId being set, because this writer's onRequest is the
// thing that populates it (and runs at order 600, after most extensions).
// thinking-block-sanitize v2 (order 550) uses this for the same reason.
export function resolveSessionId(headers) {
  if (!headers) return null;
  const sid =
    headers["x-claude-code-session-id"] ||
    headers["x-session-id"] ||
    headers["x-anthropic-session-id"] ||
    null;
  return sid || null;
}

function parseHeaders(headers) {
  const get = (key) => headers[key] || "";
  const num = (key) => parseFloat(get(key)) || 0;

  const q5h_util = num("anthropic-ratelimit-unified-5h-utilization");
  const q7d_util = num("anthropic-ratelimit-unified-7d-utilization");
  const q5h_reset = parseInt(get("anthropic-ratelimit-unified-5h-reset")) || 0;
  const q7d_reset = parseInt(get("anthropic-ratelimit-unified-7d-reset")) || 0;
  const status = get("anthropic-ratelimit-unified-status") || get("anthropic-ratelimit-unified-5h-status");
  const overage_status = get("anthropic-ratelimit-unified-overage-status");
  const overage_util = num("anthropic-ratelimit-unified-overage-utilization");
  const overage_reset = parseInt(get("anthropic-ratelimit-unified-overage-reset")) || 0;
  const unified_reset = parseInt(get("anthropic-ratelimit-unified-reset")) || 0;
  const fallback_pct = get("anthropic-ratelimit-unified-fallback-percentage");
  const representative = get("anthropic-ratelimit-unified-representative-claim");
  const surpassed = get("anthropic-ratelimit-unified-7d-surpassed-threshold");

  // Accept any reset timestamp — accounts without 5h/7d quota windows (overage
  // billing) return anthropic-ratelimit-unified-reset and/or
  // anthropic-ratelimit-unified-overage-reset instead.
  if (!q5h_reset && !q7d_reset && !unified_reset && !overage_reset) return null;

  const now = new Date();
  const hour = now.getUTCHours();
  const day = now.getUTCDay();
  const peak = day >= 1 && day <= 5 && hour >= 13 && hour < 19;

  const allHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith("anthropic-") || k === "cf-ray" || k === "request-id") {
      allHeaders[k] = v;
    }
  }

  return {
    five_hour: { utilization: q5h_util, pct: Math.round(q5h_util * 100), resets_at: q5h_reset },
    seven_day: { utilization: q7d_util, pct: Math.round(q7d_util * 100), resets_at: q7d_reset },
    status: status || "unknown",
    overage_status: overage_status || "unknown",
    peak_hour: peak,
    all_headers: allHeaders,
  };
}

function atomicWrite(finalPath, content) {
  const tmp = `${finalPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content);
  renameSync(tmp, finalPath);
}

function cleanupLegacyOnce() {
  if (legacyCleanupDone) return;
  legacyCleanupDone = true;
  try {
    unlinkSync(paths().legacyPath);
  } catch {}
}

function sweepStaleSessions(ttlDays) {
  const now = Date.now();
  if (now - lastSweepMs < SWEEP_THROTTLE_MS) return;
  lastSweepMs = now;

  const cutoffMs = now - ttlDays * 86_400_000;
  const { sessionsDir } = paths();
  let entries;
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return;
  }
  const survivingSessionFiles = new Set();
  for (const name of entries) {
    const p = join(sessionsDir, name);
    try {
      const st = statSync(p);
      if (st.mtimeMs < cutoffMs) {
        try {
          unlinkSync(p);
        } catch {}
      } else if (name.endsWith(".json")) {
        survivingSessionFiles.add(name.slice(0, -".json".length));
      }
    } catch {}
  }

  // Evict divergence-map entries whose session file got swept (or never
  // existed). Keys are `${sessionFilename}|${requestedModel}`; the session
  // segment is the prefix before the first `|`.
  for (const key of divergenceState.keys()) {
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    const sessionPart = key.slice(0, sep);
    if (!survivingSessionFiles.has(sessionPart)) {
      divergenceState.delete(key);
    }
  }
}

function getTtlDays() {
  const raw = process.env.CACHE_FIX_QUOTA_STATUS_TTL_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_TTL_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_DAYS;
}

export default {
  name: "cache-telemetry",
  description: "Extract cache stats from response stream, persist quota state to ~/.claude/quota-status/{account.json,sessions/<filename>.json}",
  order: 600,

  async onRequest(ctx) {
    // Session-id headers (x-claude-code-session-id, etc.) live on the
    // REQUEST, not the response — Anthropic doesn't echo them back. So we
    // capture them here, in the request-side hook, and stash on ctx.meta
    // for onStreamEvent to use when it writes the per-session file. The
    // proxy server passes the same `meta` object through onRequest →
    // onResponseStart → onStreamEvent, so this works end-to-end.
    if (!ctx.headers) return;
    ctx.meta._sessionId = resolveSessionId(ctx.headers);
  },

  async onResponseStart(ctx) {
    if (!ctx.headers) return;

    const quota = parseHeaders(ctx.headers);
    if (!quota) return;

    ctx.meta._quotaData = quota;
  },

  async onStreamEvent(ctx) {
    const { event, telemetry } = ctx;
    if (!event || !telemetry) return;

    // Capture the served model regardless of whether usage is present, so
    // cancelled / usage-less responses still record the divergence signal.
    if (event.type === "message_start") {
      if (typeof event.message?.model === "string") {
        ctx.meta._servedModel = event.message.model;
      }
      if (event.message?.usage) {
        const usage = event.message.usage;
        ctx.meta.cacheStats = {
          cacheRead: usage.cache_read_input_tokens || 0,
          cacheCreation: usage.cache_creation_input_tokens || 0,
          inputTokens: usage.input_tokens || 0,
        };
      }
    }

    if (event.type === "message_delta" && event.usage) {
      if (!ctx.meta.cacheStats) ctx.meta.cacheStats = {};
      ctx.meta.cacheStats.outputTokens = event.usage.output_tokens || 0;

      const stats = ctx.meta.cacheStats;
      const quota = ctx.meta._quotaData;
      if (!quota) return;

      const cr = stats.cacheRead || 0;
      const cc = stats.cacheCreation || 0;
      const total = cr + cc;
      const hitRate = total > 0 ? ((cr / total) * 100).toFixed(1) : "N/A";

      const ephemeral1h = cc;
      const ephemeral5m = 0;

      const ttl = cr > 0 ? "1h" : (cc > 0 ? "5m" : "unknown");

      const timestamp = new Date().toISOString();
      const rawSid = ctx.meta._sessionId;
      const filename = sessionFilename(rawSid);

      // Run the served-model divergence detector (issue #223 / directive
      // proxy-statusline-served-model-divergence). Self-contained try so a
      // bad model string or rehydration disk-read failure can't break the
      // writer.
      //
      // Once-per-response guard: `message_delta` can fire multiple times
      // per response (streamed delta segments). The directive's heuristic
      // counts TURNS, not deltas — without this guard, a single divergent
      // response that emits 3 deltas would latch sticky on the third
      // delta. Mirrors the `_sessionHealthDone` pattern at
      // session-health.mjs:101-103. (Closes Codex r1 #225 blocker 1.)
      try {
        if (!ctx.meta._modelDivergenceDone) {
          ctx.meta._modelDivergenceDone = true;
          const requestedModel = ctx.telemetry?.requestedModel;
          const servedModel = ctx.meta._servedModel;
          const div = runDivergenceDetector(rawSid, requestedModel, servedModel, timestamp);
          if (div) {
            ctx.meta._modelDivergence = div;
          }
        }
      } catch {}

      const accountPayload = JSON.stringify({ ...quota, timestamp }, null, 2);
      const sessionPayload = JSON.stringify(
        {
          cache: {
            ttl_tier: ttl,
            cache_creation: cc,
            cache_read: cr,
            ephemeral_1h: ephemeral1h,
            ephemeral_5m: ephemeral5m,
            hit_rate: hitRate,
            timestamp,
          },
          // Additive session-health fields (session-health extension, order
          // 590, stashes these before this writer runs). Optional — absent if
          // that extension is disabled or produced nothing this request.
          ...(ctx.meta._sessionHealth || {}),
          // Additive thinking-block-sanitize drop count (order 550). On by
          // default since v4.0.0; present (possibly with thinking_blocks_dropped:0)
          // whenever sanitize ran. Absent when CACHE_FIX_THINKING_SANITIZE=off
          // or when the extension returned early before reaching the planner
          // (e.g., body.messages not an array).
          ...(ctx.meta._thinkingSanitize || {}),
          // Additive thinking-block-sanitize v2 fields (order 550, opt-in via
          // CACHE_FIX_THINKING_SANITIZE=v2). Optional — absent unless v2 is
          // enabled. Keys: thinking_blocks_dropped_v2 / tools_hash_baseline.
          ...(ctx.meta._thinkingSanitizeV2 || {}),
          // Additive auto-1m-guard annotation (order 520). Optional — absent
          // unless the outbound request carried context-1m-2025-08-07 and the
          // mode wasn't off. Keys: auto_1m_detected / auto_1m_action /
          // auto_1m_advice.
          ...(ctx.meta._auto1mGuard || {}),
          // Additive model-id-sanitize annotation (issue #227, order 50).
          // Optional — absent unless `body.model` was malformed in this
          // session. Keys: model_id_malformed / model_id_malformed_first_seen
          // / model_id_corrections_count / model_id_malformed_last_value_hex.
          ...(ctx.meta._modelIdSanitize?.spread || {}),
          // Additive served-model divergence fields (issue #223). Optional —
          // absent unless this turn diverged OR the (session, requestedModel)
          // pair has latched sticky. Keys: requested_model / served_model /
          // model_divergence_recent / model_divergence_sticky /
          // model_divergence_first_seen.
          ...(ctx.meta._modelDivergence || {}),
          timestamp,
          session_id: rawSid,
        },
        null,
        2,
      );

      try {
        cleanupLegacyOnce();
        const { sessionsDir, accountPath } = paths();
        mkdirSync(sessionsDir, { recursive: true });
        atomicWrite(accountPath, accountPayload);
        atomicWrite(join(sessionsDir, `${filename}.json`), sessionPayload);
        sweepStaleSessions(getTtlDays());
      } catch {}
    }
  },

  // Test-only: reset module state between tests.
  __resetForTests() {
    legacyCleanupDone = false;
    lastSweepMs = 0;
    divergenceState.clear();
  },
};
