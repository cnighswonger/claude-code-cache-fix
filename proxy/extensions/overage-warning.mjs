// overage-warning — emit a one-time warning per Q5h-window threshold
// crossing when Anthropic's response headers indicate the user is
// approaching or has crossed the overage threshold.
//
// Advisory only. No request mutation. Two outputs:
//   1. stderr line prefixed `[overage-warning]` for proxy journals/logs
//   2. structured JSON record appended to `~/.claude/overage-warnings.jsonl`
//
// Activation: `enabled: true` in extensions.json (this extension is
// always loaded), gated at runtime by `CACHE_FIX_OVERAGE_WARNING=1`.
// Matches the prefix-diff pattern (env-var-only opt-in).
//
// See `docs/directives/proxy-overage-cost-warning.md` for the full design.

import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import { WEIGHTED_TOKEN_COST_USD_COARSE } from "../rates.mjs";
import { claudeHome } from "../claude-home.mjs";

// Env-gated runtime flags read on each call. Reading at module load would
// freeze the values and make per-test isolation impossible. The check is
// cheap (one process.env lookup per invocation when disabled).
function isEnabled() {
  return process.env.CACHE_FIX_OVERAGE_WARNING === "1";
}
function isQuiet() {
  return process.env.CACHE_FIX_OVERAGE_WARNING_QUIET === "1";
}
function isDebug() {
  return process.env.CACHE_FIX_DEBUG === "1";
}

function debug(msg) {
  if (isDebug()) process.stderr.write(`[overage-warning] DEBUG: ${msg}\n`);
}

// --- Module-scope state ---
//
// Sliding window of (timestamp, q5h_util, input_tokens, cache_creation_tokens,
// cache_read_tokens, output_tokens) samples. Used to compute burn rate.
//
// Cross-response dedup: per Q5h window (keyed by q5h_resets_at), the set
// of thresholds we've already warned at. Window expires when q5h_resets_at
// changes (new window = new dedup state). A reply with no 5h header (accounts
// without a 5h limit) is sampled and keyed on its 7d window instead.

const WINDOW_MS = 15 * 60 * 1000;
const WINDOW_MAX_SAMPLES = 60;
const WARM_UP_MIN_SAMPLES = 3;

// One sample list per source window, so a reply from an account without a 5h
// limit never costs a 5h account its samples (5h and 7d utilisations are not
// comparable, and one slope never spans both).
const _windows = { "5h": [], "7d": [] }; // { t, q5h, input, cache_creation, cache_read, output }
let _dedupWindowResetsAt = 0;
let _dedupThresholds = new Set();

function resetState() {
  for (const w of Object.values(_windows)) w.length = 0;
  _dedupWindowResetsAt = 0;
  _dedupThresholds = new Set();
}

// --- Pure functions (test seam) ---

export function parseTriggerFromHeaders(headers) {
  if (!headers || typeof headers !== "object") return { eligible: false };
  const get = (k) => headers[k] || "";
  const num = (k) => {
    const v = get(k);
    if (!v) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const intOf = (k) => {
    const v = get(k);
    if (!v) return 0;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  };

  const status =
    get("anthropic-ratelimit-unified-status") ||
    get("anthropic-ratelimit-unified-5h-status");
  const surpassed = num("anthropic-ratelimit-unified-7d-surpassed-threshold");
  const overage_status = get("anthropic-ratelimit-unified-overage-status") || "unknown";
  const upgrade_paths_raw = get("anthropic-ratelimit-unified-upgrade-paths");
  const q5h_util = num("anthropic-ratelimit-unified-5h-utilization");
  const q7d_util = num("anthropic-ratelimit-unified-7d-utilization");
  const q5h_resets_at = intOf("anthropic-ratelimit-unified-5h-reset");

  // Trigger gates: status is allowed_warning or throttled, surpassed-threshold
  // header is present and non-empty.
  const isWarn = status === "allowed_warning" || status === "throttled";
  if (!isWarn) return { eligible: false };
  if (surpassed === null) return { eligible: false };

  const upgrade_paths = upgrade_paths_raw
    ? upgrade_paths_raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    eligible: true,
    trigger: {
      status,
      surpassed_threshold: surpassed,
      overage_status,
      upgrade_paths,
    },
    snapshot: {
      q5h_pct: q5h_util !== null ? Math.round(q5h_util * 100) : null,
      q7d_pct: q7d_util !== null ? Math.round(q7d_util * 100) : null,
      q5h_resets_at: q5h_resets_at || null,
    },
    raw: {
      q5h_util,
      q5h_resets_at,
      window_resets_at: q5h_resets_at || intOf("anthropic-ratelimit-unified-7d-reset"),
    },
  };
}

export function dedupKey(threshold, q5h_resets_at) {
  return `${threshold}@${q5h_resets_at}`;
}

// Compute burn-rate projection from samples. Returns:
//   { min_to_100, tokens_per_min, cost_per_hr_usd_coarse, window_samples,
//     window_minutes }
// All projection fields are `null` when fewer than WARM_UP_MIN_SAMPLES
// samples exist OR utilization is non-increasing across the window.
export function computeProjection(samples, now = Date.now()) {
  // Drop expired samples (caller may have already done this; defensive).
  const fresh = samples.filter((s) => now - s.t <= WINDOW_MS);

  if (fresh.length < WARM_UP_MIN_SAMPLES) {
    return {
      min_to_100: null,
      tokens_per_min: null,
      cost_per_hr_usd_coarse: null,
      window_samples: fresh.length,
      window_minutes: 0,
    };
  }

  const oldest = fresh[0];
  const newest = fresh[fresh.length - 1];
  const windowMin = (newest.t - oldest.t) / 60_000;

  if (windowMin <= 0) {
    return {
      min_to_100: null,
      tokens_per_min: null,
      cost_per_hr_usd_coarse: null,
      window_samples: fresh.length,
      window_minutes: 0,
    };
  }

  const deltaUtil = newest.q5h - oldest.q5h;
  const utilPerMin = deltaUtil / windowMin;

  let min_to_100 = null;
  if (utilPerMin > 0) {
    min_to_100 = Math.max(0, Math.round((1 - newest.q5h) / utilPerMin));
  }

  // Sum of all relevant tokens across the window. Each sample carries the
  // per-call token deltas as pushed by recordSample (caller responsibility).
  const totalTokens = fresh.reduce(
    (acc, s) =>
      acc + (s.input || 0) + (s.cache_creation || 0) + (s.cache_read || 0) + (s.output || 0),
    0,
  );
  const tokens_per_min = totalTokens / windowMin;
  const cost_per_hr_usd_coarse =
    utilPerMin > 0
      ? +(tokens_per_min * 60 * WEIGHTED_TOKEN_COST_USD_COARSE).toFixed(2)
      : null;

  return {
    min_to_100,
    tokens_per_min: Math.round(tokens_per_min),
    cost_per_hr_usd_coarse,
    window_samples: fresh.length,
    window_minutes: +windowMin.toFixed(1),
  };
}

export function formatStderrLine({ ts, trigger, snapshot, projection }) {
  const upgrade = trigger.upgrade_paths.length
    ? trigger.upgrade_paths.join(", ")
    : "(none)";
  const seg = (name, pct) => (pct === null ? "" : `${name}=${pct}% `);
  const head = `[overage-warning] ${ts} ${seg("Q5h", snapshot.q5h_pct)}${seg("Q7d", snapshot.q7d_pct)}(surpassed ${trigger.surpassed_threshold})`;
  if (projection && projection.min_to_100 !== null && projection.cost_per_hr_usd_coarse !== null) {
    return `${head} — projected 100% in ~${projection.min_to_100} min, estimated continued burn ≈ $${projection.cost_per_hr_usd_coarse.toFixed(2)}/hr at API rates (coarse). Upgrade paths: ${upgrade}.`;
  }
  return `${head} — projection unavailable (warming up). Upgrade paths: ${upgrade}.`;
}

export function formatJsonlRecord({ ts, trigger, snapshot, projection }) {
  return {
    ts,
    trigger: {
      status: trigger.status,
      surpassed_threshold: trigger.surpassed_threshold,
      overage_status: trigger.overage_status,
      upgrade_paths: trigger.upgrade_paths,
    },
    snapshot: {
      q5h_pct: snapshot.q5h_pct,
      q7d_pct: snapshot.q7d_pct,
      q5h_resets_at: snapshot.q5h_resets_at,
    },
    projection: projection || {
      min_to_100: null,
      tokens_per_min: null,
      cost_per_hr_usd_coarse: null,
      window_samples: 0,
      window_minutes: 0,
    },
  };
}

// --- Window management ---

export function recordSample(state, sample) {
  state.window.push(sample);
  const cutoff = sample.t - WINDOW_MS;
  while (state.window.length && state.window[0].t < cutoff) state.window.shift();
  while (state.window.length > WINDOW_MAX_SAMPLES) state.window.shift();
}

// --- Dedup helpers operating on module state ---

function checkAndMarkDedup(threshold, q5h_resets_at) {
  // New Q5h window resets the dedup set.
  if (q5h_resets_at !== _dedupWindowResetsAt) {
    _dedupWindowResetsAt = q5h_resets_at;
    _dedupThresholds = new Set();
  }
  const key = dedupKey(threshold, q5h_resets_at);
  if (_dedupThresholds.has(key)) return false;
  _dedupThresholds.add(key);
  return true;
}

// --- I/O ---

async function appendJsonl(record, dir) {
  const outDir = dir || (process.env.CACHE_FIX_OVERAGE_WARNING_DIR || claudeHome());
  const outPath = join(outDir, "overage-warnings.jsonl");
  await mkdir(outDir, { recursive: true });
  await appendFile(outPath, JSON.stringify(record) + "\n");
}

// Test helper: write a record using a caller-supplied directory. Bypasses
// env-var lookup so tests do not race on a shared env. Pure side effect.
export async function writeRecord(record, dir) {
  await appendJsonl(record, dir);
}

// Test helper: drain in-memory state. For deterministic tests.
export function _resetForTest() {
  resetState();
}

// --- Extension contract ---

export default {
  name: "overage-warning",
  description:
    "Emit one-time warning per Q5h-window threshold crossing when overage headers indicate trouble",
  enabled: true,
  order: 610,

  async onResponseStart(ctx) {
    if (!isEnabled()) return;
    if (!ctx || !ctx.headers) return;

    try {
      ctx.meta = ctx.meta || {};

      // Always capture quota state if the headers carry it, regardless of
      // whether THIS response's status crosses a warning threshold. Future
      // responses need warm samples to project from.
      for (const w of ["5h", "7d"]) {
        const util = parseFloat(ctx.headers[`anthropic-ratelimit-unified-${w}-utilization`]);
        if (Number.isFinite(util)) {
          ctx.meta._overageQuota = { util, w };
          break;
        }
      }

      // Trigger eligibility latch — only set when this response is the one
      // that crossed a threshold. Keeps emission gate separate from sampling.
      const result = parseTriggerFromHeaders(ctx.headers);
      if (!result.eligible) return;
      ctx.meta._overageWarning = {
        eligible: true,
        emitted: false,
        trigger: result.trigger,
        snapshot: result.snapshot,
        raw: result.raw,
      };
    } catch (err) {
      debug(`onResponseStart unexpected: ${err?.message ?? err}`);
    }
  },

  async onStreamEvent(ctx) {
    if (!isEnabled()) return;
    if (!ctx || !ctx.event) return;

    try {
      // Sample collection — happens on every response that has a quota
      // reading, regardless of whether this response is the one that emits.
      if (ctx.event.type === "message_start" && ctx.event.message?.usage) {
        const u = ctx.event.message.usage;
        const quota = ctx.meta?._overageQuota;
        if (quota) {
          const sample = {
            t: Date.now(),
            q5h: quota.util, // utilisation of window `w`: the 7d one when the reply has no 5h header
            input: u.input_tokens || 0,
            cache_creation: u.cache_creation_input_tokens || 0,
            cache_read: u.cache_read_input_tokens || 0,
            output: 0,
          };
          recordSample({ window: _windows[quota.w] }, sample);
          // Hand the response its own sample reference. message_delta updates
          // THIS sample only — never the window's last sample, which could
          // belong to a different response under interleaving.
          ctx.meta._overageSample = sample;
        }
      }

      if (ctx.event.type === "message_delta") {
        // Update THIS response's sample with output tokens. The sample
        // reference is response-local (set by message_start), so a response
        // that never sampled cannot leak output tokens into another response.
        const ownSample = ctx.meta?._overageSample;
        if (ownSample && ctx.event.usage?.output_tokens) {
          ownSample.output += ctx.event.usage.output_tokens;
        }

        // Emission gate.
        const w = ctx.meta?._overageWarning;
        if (!w || !w.eligible || w.emitted) return;

        const allowed = checkAndMarkDedup(
          w.trigger.surpassed_threshold,
          w.raw.window_resets_at,
        );
        if (!allowed) {
          w.emitted = true;
          return;
        }

        const ts = new Date().toISOString();
        const projection = computeProjection(_windows[ctx.meta?._overageQuota?.w ?? "5h"], Date.now());
        const projectionForOutput =
          projection.window_samples >= WARM_UP_MIN_SAMPLES &&
          projection.min_to_100 !== null
            ? projection
            : null;

        const record = formatJsonlRecord({
          ts,
          trigger: w.trigger,
          snapshot: w.snapshot,
          projection: projectionForOutput || projection,
        });

        if (!isQuiet()) {
          process.stderr.write(formatStderrLine({
            ts,
            trigger: w.trigger,
            snapshot: w.snapshot,
            projection: projectionForOutput,
          }) + "\n");
        }

        await appendJsonl(record);
        w.emitted = true;
      }
    } catch (err) {
      debug(`onStreamEvent unexpected: ${err?.message ?? err}`);
    }
  },
};
