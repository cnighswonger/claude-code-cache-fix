import {
  writeFileSync,
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

function resolveSessionId(headers) {
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
  const fallback_pct = get("anthropic-ratelimit-unified-fallback-percentage");
  const representative = get("anthropic-ratelimit-unified-representative-claim");
  const surpassed = get("anthropic-ratelimit-unified-7d-surpassed-threshold");

  if (!q5h_reset && !q7d_reset) return null;

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
  for (const name of entries) {
    const p = join(sessionsDir, name);
    try {
      const st = statSync(p);
      if (st.mtimeMs < cutoffMs) {
        try {
          unlinkSync(p);
        } catch {}
      }
    } catch {}
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

  async onResponseStart(ctx) {
    if (!ctx.headers) return;

    const quota = parseHeaders(ctx.headers);
    if (!quota) return;

    ctx.meta._quotaData = quota;
    ctx.meta._sessionId = resolveSessionId(ctx.headers);
  },

  async onStreamEvent(ctx) {
    const { event, telemetry } = ctx;
    if (!event || !telemetry) return;

    if (event.type === "message_start" && event.message?.usage) {
      const usage = event.message.usage;
      ctx.meta.cacheStats = {
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheCreation: usage.cache_creation_input_tokens || 0,
        inputTokens: usage.input_tokens || 0,
      };
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
  },
};
