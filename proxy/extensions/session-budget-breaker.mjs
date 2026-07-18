// session-budget-breaker — opt-in hard per-session spend ceiling.
//
// Once a CC session's cumulative token consumption (or its consumption rate)
// crosses an operator-configured limit, further /v1/messages for that session
// are short-circuited locally at onRequest, so they never reach Anthropic and
// cannot consume credits, trigger auto-purchase, or (for direct API-key users)
// keep billing the card. Circuit breaker, not a precise meter.
//
// Directive: docs/directives/proxy-subagent-budget-circuit-breaker.md (refs
// anthropics/claude-code#68285). Load-bearing: blocks live credential-bearing
// traffic on a spend condition.
//
// FAIL-OPEN ALWAYS. A block requires the gate `on` AND a numerically-confident
// per-session tally at/over an explicitly-configured ceiling. Every other path —
// gate off, no ceiling set, missing/unparseable usage, missing session key,
// first request, any throw — FORWARDS. See the fail-open table in the directive.
//
// Levers (all per-session; at least one must be set to ever fire):
//   CACHE_FIX_SESSION_BUDGET_TOKENS       int  cumulative input+cache_creation
//   CACHE_FIX_SESSION_BUDGET_RATE_TPM     int  tokens/min over the sliding window
//   CACHE_FIX_SESSION_BUDGET_RATE_WINDOW_MS int window for the rate lever (60000)
//   (CACHE_FIX_SESSION_BUDGET_COST_USD — cost lever — is stubbed; wired next.)
// Gate: CACHE_FIX_SESSION_BUDGET = off (default) / on / dry-run.

import { appendFileSync, statSync, renameSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeHome } from "../claude-home.mjs";
import { resolveSessionId } from "./cache-telemetry.mjs";
import { buildSkipResult } from "../synth-response.mjs";

// --- Cost pricing (tools/rates.json; values are $ per MILLION tokens) ---
// Loaded once, lazily. rates.json is Anthropic API list pricing. The cost lever
// is a best-effort DOLLAR estimate: input tokens priced at the model's `input`
// rate, cache_creation at `cache_write_1h` (the proxy can't see which cache tier
// the API applied, so it uses the higher 1h write rate — a deliberate slight
// OVER-estimate, safer for a spend cap than under-billing). Unknown model →
// null (cost lever unavailable for that request; token/rate levers unaffected).
const __dirname = dirname(fileURLToPath(import.meta.url));
let _rates = null; // { model: {input, cache_write_1h, ...} } | {} on load failure
function loadRates() {
  if (_rates !== null) return _rates;
  try {
    const p = join(__dirname, "..", "..", "tools", "rates.json");
    _rates = JSON.parse(readFileSync(p, "utf8")).models || {};
  } catch { _rates = {}; }
  return _rates;
}
const _unknownModelNoted = new Set();
// Returns estimated USD for (inputTok, cacheCreationTok) at model's rates, or
// null if the model is unknown (fail-open — caller must not block on cost then).
function costOf(model, inputTok, cacheCreationTok) {
  if (typeof model !== "string" || !model) return null;
  const r = loadRates()[model];
  if (!r) {
    if (!_unknownModelNoted.has(model)) {
      _unknownModelNoted.add(model);
      process.stderr.write(`[session-budget-breaker] cost lever: model "${model}" not in ` +
        `tools/rates.json — cost not counted for it (token/rate levers still apply; ` +
        `set CACHE_FIX_SESSION_BUDGET_TOKENS for a hard cap). Update rates.json to enable cost.\n`);
    }
    return null;
  }
  const inRate = typeof r.input === "number" ? r.input : 0;
  const ccRate = typeof r.cache_write_1h === "number" ? r.cache_write_1h : inRate;
  return (inputTok * inRate + cacheCreationTok * ccRate) / 1_000_000;
}

// --- Gate + config (read live per call: tests and operators flip at runtime) ---

function gate() {
  const v = process.env.CACHE_FIX_SESSION_BUDGET;
  return v === "on" || v === "dry-run" ? v : "off"; // anything else = off
}
function tokenLimit() {
  const n = parseInt(process.env.CACHE_FIX_SESSION_BUDGET_TOKENS, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function rateLimitTpm() {
  const n = parseInt(process.env.CACHE_FIX_SESSION_BUDGET_RATE_TPM, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function costLimitUsd() {
  const n = parseFloat(process.env.CACHE_FIX_SESSION_BUDGET_COST_USD);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function rateWindowMs() {
  const n = parseInt(process.env.CACHE_FIX_SESSION_BUDGET_RATE_WINDOW_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : 60000;
}
function maxEntries() {
  const n = parseInt(process.env.CACHE_FIX_SESSION_BUDGET_MAX_ENTRIES, 10);
  return Number.isFinite(n) && n > 0 ? n : 4096;
}
function anyLimitSet() {
  return tokenLimit() !== null || rateLimitTpm() !== null || costLimitUsd() !== null;
}

// --- Per-session tally state (in-memory, LRU-bounded) ---
// Map<sessionId, { tokens, events: [{t, tokens}], last }>. `events` is the
// sliding window for the rate lever. Map insertion order = LRU; we re-insert on
// touch and evict oldest past maxEntries().
const _tallies = new Map();
let _armedNoteEmitted = false;

function touch(sid) {
  let e = _tallies.get(sid);
  if (e) {
    _tallies.delete(sid); // move to newest
  } else {
    e = { tokens: 0, costUsd: 0, events: [], last: 0 };
  }
  _tallies.set(sid, e);
  while (_tallies.size > maxEntries()) {
    const oldest = _tallies.keys().next().value;
    _tallies.delete(oldest);
  }
  return e;
}

function pruneWindow(e, now) {
  const cutoff = now - rateWindowMs();
  while (e.events.length && e.events[0].t < cutoff) e.events.shift();
}

function windowTokens(e, now) {
  pruneWindow(e, now);
  let sum = 0;
  for (const ev of e.events) sum += ev.tokens;
  return sum;
}
// tokens/min over the window (window may be shorter than 60s early on; we
// annualize to per-minute so the threshold is a stable "tokens per minute").
function rateTpm(e, now) {
  pruneWindow(e, now);
  if (!e.events.length) return 0;
  const spanMs = Math.max(1000, now - e.events[0].t); // floor 1s to avoid div blow-up
  const sum = windowTokens(e, now);
  return (sum / spanMs) * 60000;
}

// --- Event log (fires only; PII-safe: no bodies/creds) ---

function eventLogPath() {
  return process.env.CACHE_FIX_SESSION_BUDGET_EVENT_LOG ||
    join(claudeHome(), "session-budget-events.jsonl");
}
const MAX_LOG_BYTES = 5 * 1024 * 1024;
function rotateIfNeeded(path) {
  try {
    const st = statSync(path);
    if (st.size >= MAX_LOG_BYTES) renameSync(path, path + ".1");
  } catch {}
}
function logEvent(rec) {
  try {
    const path = eventLogPath();
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, JSON.stringify(rec) + "\n");
  } catch {}
}

function shortCircuitText(lever, limit, observed) {
  return `[cache-fix-proxy] Session ${lever} ceiling reached (${lever}=${limit}, observed=${observed}). ` +
    `This request was stopped locally to prevent further spend — it never reached Anthropic, so no ` +
    `credits were consumed and no auto-purchase can be triggered by it. Raise or clear the ceiling ` +
    `(CACHE_FIX_SESSION_BUDGET_*) to resume. (See CC#68285.)`;
}

// --- Decision: is this session confidently over a ceiling? Returns null (forward)
// or { lever, limit, observed }. Pure over the tally + env; no side effects. ---

function overCeiling(e, now) {
  const tl = tokenLimit();
  if (tl !== null && e.tokens >= tl) return { lever: "TOKENS", limit: tl, observed: e.tokens };
  const cl = costLimitUsd();
  if (cl !== null && e.costUsd >= cl) {
    return { lever: "COST_USD", limit: cl, observed: Math.round(e.costUsd * 10000) / 10000 };
  }
  const rl = rateLimitTpm();
  if (rl !== null) {
    const r = Math.round(rateTpm(e, now));
    if (r >= rl) return { lever: "RATE_TPM", limit: rl, observed: r };
  }
  return null;
}

// Extract the cost-bearing input token split from a usage block. cache_read is
// cheap and output is not an input cost; the tally tracks input + cache_creation
// (priced separately for the cost lever). Returns { input, cacheCreation, total }
// or null if the field we key on is unparseable (fail-open — don't update).
function usageInputTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inp = usage.input_tokens;
  const cc = usage.cache_creation_input_tokens;
  const i = typeof inp === "number" ? inp : (typeof inp === "string" ? parseInt(inp, 10) : NaN);
  const c = typeof cc === "number" ? cc : (typeof cc === "string" ? parseInt(cc, 10) : 0);
  if (!Number.isFinite(i)) return null;
  const cacheCreation = Number.isFinite(c) ? c : 0;
  return { input: i, cacheCreation, total: i + cacheCreation };
}

export default {
  name: "session-budget-breaker",

  // Block BEFORE forwarding when confidently over ceiling. Fail-open otherwise.
  async onRequest(ctx) {
    if (gate() === "off") return;
    if (!anyLimitSet()) {
      if (!_armedNoteEmitted) {
        _armedNoteEmitted = true;
        process.stderr.write("[session-budget-breaker] gate on but no ceiling set " +
          "(CACHE_FIX_SESSION_BUDGET_TOKENS / _RATE_TPM) — inert.\n");
      }
      return;
    }
    let sid;
    try { sid = resolveSessionId(ctx.headers); } catch { return; } // fail-open
    if (!sid) return; // no session key → forward
    const e = _tallies.get(sid);
    if (!e) return; // no tally yet (first request) → forward
    const now = Date.now();
    const hit = overCeiling(e, now);
    if (!hit) return; // under all ceilings → forward

    const dry = gate() === "dry-run";
    const requestId = (ctx.headers && (ctx.headers["request-id"] || ctx.headers["x-request-id"])) || null;
    logEvent({
      ts: new Date(now).toISOString(),
      event: "session_budget_block",
      would_block: dry,
      sid,
      lever: hit.lever,
      limit: hit.limit,
      observed: hit.observed,
      cumulative_tokens: e.tokens,
      cumulative_cost_usd: Math.round(e.costUsd * 10000) / 10000,
      request_id: requestId, // nullable: local block has no upstream request-id
    });
    if (dry) return; // dry-run: log what we WOULD block, then forward
    const text = shortCircuitText(hit.lever, hit.limit, hit.observed);
    return buildSkipResult(ctx.body, text);
  },

  // Learn cost from the response usage; update the per-session tally.
  async onStreamEvent(ctx) {
    try {
      if (gate() === "off" || !anyLimitSet()) return;
      const ev = ctx.event;
      // message_start carries the input/cache_creation counts for the turn.
      if (!ev || ev.type !== "message_start") return;
      const usage = ev.message && ev.message.usage;
      const split = usageInputTokens(usage);
      if (split === null) return; // unparseable/missing → don't update (fail-open)
      let sid;
      try { sid = resolveSessionId(ctx.headers); } catch { return; }
      if (!sid) return;
      const now = Date.now();
      const e = touch(sid);
      e.tokens += split.total;
      // Cost: price input + cache_creation at this turn's model rates. Unknown
      // model → costOf returns null → cost simply not accrued (fail-open); the
      // token/rate tally is unaffected so those levers still work.
      const model = ev.message && ev.message.model;
      const cost = costOf(model, split.input, split.cacheCreation);
      if (cost !== null) e.costUsd += cost;
      e.events.push({ t: now, tokens: split.total });
      e.last = now;
      pruneWindow(e, now);
    } catch { /* fail-open: never let accounting throw affect the request */ }
  },

  // Test seam.
  __testOnly: {
    reset() { _tallies.clear(); _armedNoteEmitted = false; _unknownModelNoted.clear(); },
    tally(sid) { return _tallies.get(sid); },
    rateTpm(sid) { const e = _tallies.get(sid); return e ? rateTpm(e, Date.now()) : 0; },
    costUsd(sid) { const e = _tallies.get(sid); return e ? e.costUsd : 0; },
    usageInputTokens,
    costOf,
  },
};
