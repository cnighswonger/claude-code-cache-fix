#!/usr/bin/env node
//
// tier-advisor — Max plan upgrade/downgrade recommendation tool.
//
// Reads the cache-fix proxy's persisted quota snapshot + the local usage
// log + the advisor's own historical state, projects this week's Q7d burn
// to the weekly reset, and emits a tier-change recommendation.
//
// Per directive `docs/directives/proxy-tier-advisor.md` (issue #63, PR #93).
//
// Single binary burn-rate rule (Codex r1 blocker fix): prefer the proxy's
// snapshot when fresh; fall back to a usage.jsonl token-sum when not.
// Never blend, never min/max.
//
// Calendar-week state (Codex r1 blocker fix #2): persist a bounded weeks[]
// array indexed by week-ending date. Multiple advisor runs within the same
// week do NOT add duplicate records and do NOT advance any counter.
//
// Single exit-code contract across default / --json / --quiet (Codex r1
// blocker fix #3): 0=ok, 1=upgrade, 2=downgrade, 3=tier:unknown, 4=hard error.
//
// Path pin (Codex r4 cross-cutting note): the snapshot lives at
// ~/.claude/quota-status/account.json — the post-v3.5.0 modern path.
// Older repo text still occasionally references ~/.claude/quota-status.json
// (the preload-era single-file path); the advisor consumes only the modern
// per-account JSON. CACHE_FIX_ADVISOR_QUOTA_STATUS overrides for tests.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Constants
// =============================================================================

// Empirical 4.4× multiplier from the 5x/20x analysis (2,197 requests).
// 100% Q5h budget per tier — also drives the plan-detection heuristic.
const PLAN_TOKENS = {
  "max-5x": 204_000_000,
  "max-20x": 892_000_000,
};

// Q7d projection cap — any projected pct beyond this is rounded to the cap
// for output stability. The recommendation is "upgrade now" either way.
const PROJECTION_CAP_PCT = 200;

const PRIMARY_FRESHNESS_HOURS = 24; // header-source mtime must be within this many hours
const STATE_WEEKS_BOUND = 8;        // rolling cap; older entries dropped
const HOURS_PER_WEEK = 7 * 24;

const EXIT = { ok: 0, upgrade: 1, downgrade: 2, unknown: 3, hardError: 4 };

// =============================================================================
// CLI arg parsing
// =============================================================================

export function parseArgs(argv) {
  const opts = {
    json: false,
    quiet: false,
    noState: false,
    planOverride: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--no-state") opts.noState = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--plan") opts.planOverride = argv[++i];
    else if (a.startsWith("--plan=")) opts.planOverride = a.slice(7);
  }
  return opts;
}

// =============================================================================
// Pure helpers (exported for unit tests)
// =============================================================================

export function computeBurnRate(q7dPct, hoursSinceReset) {
  if (!Number.isFinite(q7dPct) || !Number.isFinite(hoursSinceReset)) return 0;
  if (hoursSinceReset <= 0) return 0;
  return q7dPct / hoursSinceReset;
}

// Weighted-tokens sum over a usage.jsonl-shaped iterable, divided by
// plan_total_tokens, normalized to percent-per-hour. Weighting treats
// input + cache_creation as 1× and cache_read as 0.1× (matches the
// pricing-aware multiplier used elsewhere; rough but consistent).
export function computeBurnRateFromUsageLog(entries, weekStartTs, hoursSinceReset, planTokens) {
  if (!Array.isArray(entries) || !Number.isFinite(hoursSinceReset) || hoursSinceReset <= 0) return 0;
  if (!Number.isFinite(planTokens) || planTokens <= 0) return 0;
  let total = 0;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const ts = Date.parse(e.ts || e.timestamp || "");
    if (!Number.isFinite(ts) || ts < weekStartTs) continue;
    const u = e.usage || e;
    const inp = Number(u.input_tokens) || 0;
    const cc = Number(u.cache_creation_input_tokens) || 0;
    const cr = Number(u.cache_read_input_tokens) || 0;
    total += inp + cc + cr * 0.1;
  }
  const pct = (total / planTokens) * 100;
  return pct / hoursSinceReset;
}

// Single-source companion to computeBurnRateFromUsageLog: returns the
// week-to-date consumed percent from the SAME weighted token sum used
// for burn rate. Codex r1 blocker: the fallback path previously left
// currentPct null/stale while reporting log-derived burn, which would
// silently suppress an upgrade recommendation when account.json was
// absent or stale. Co-derived currentPct + burnRate keep the projection
// honest under the binary "primary header / fallback log" rule.
export function computeCurrentPctFromUsageLog(entries, weekStartTs, planTokens) {
  if (!Array.isArray(entries)) return 0;
  if (!Number.isFinite(planTokens) || planTokens <= 0) return 0;
  let total = 0;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const ts = Date.parse(e.ts || e.timestamp || "");
    if (!Number.isFinite(ts) || ts < weekStartTs) continue;
    const u = e.usage || e;
    const inp = Number(u.input_tokens) || 0;
    const cc = Number(u.cache_creation_input_tokens) || 0;
    const cr = Number(u.cache_read_input_tokens) || 0;
    total += inp + cc + cr * 0.1;
  }
  return (total / planTokens) * 100;
}

export function projectQ7dAtReset(currentPct, burnRatePerHour, hoursUntilReset) {
  if (!Number.isFinite(currentPct) || !Number.isFinite(burnRatePerHour) || !Number.isFinite(hoursUntilReset)) return 0;
  if (hoursUntilReset < 0) hoursUntilReset = 0;
  const raw = currentPct + burnRatePerHour * hoursUntilReset;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(raw, PROJECTION_CAP_PCT);
}

// Plan detection order:
//   1. CLI --plan override (highest priority)
//   2. Env CACHE_FIX_ADVISOR_PLAN
//   3. quota-status header (forward-looking; not currently emitted)
//   4. Heuristic from recent Q5h budgets in usage log
//   5. "unknown"
//
// Returns { plan: "max-5x"|"max-20x"|"pro"|"unknown", source: "..." }.
//
// Note: recentBudgets is the caller-computed median-or-similar of recent
// Q5h budgets in tokens; the helper just classifies. Passing null/0/NaN
// defaults to "unknown" via the heuristic branch.
export function detectPlan({ envValue, planOverride, recentBudgetTokens }) {
  if (planOverride) {
    const v = String(planOverride).toLowerCase();
    if (v === "max-5x" || v === "max-20x" || v === "pro") return { plan: v, source: "cli" };
  }
  if (envValue) {
    const v = String(envValue).toLowerCase();
    if (v === "max-5x" || v === "max-20x" || v === "pro") return { plan: v, source: "env" };
  }
  // Heuristic: bracket the empirical centers (204M for 5x, 892M for 20x)
  // with wide tolerance so noise doesn't flip the classification.
  if (Number.isFinite(recentBudgetTokens) && recentBudgetTokens > 0) {
    if (recentBudgetTokens >= 100_000_000 && recentBudgetTokens < 500_000_000) {
      return { plan: "max-5x", source: "heuristic" };
    }
    if (recentBudgetTokens >= 500_000_000 && recentBudgetTokens < 1_500_000_000) {
      return { plan: "max-20x", source: "heuristic" };
    }
  }
  return { plan: "unknown", source: "fallback" };
}

// Decision matrix per directive §Decision matrix:
//   projected >= 80% → "upgrade" (single-event)
//   projected <  20% AND prior consecutive weeks under-threshold count >= (weeksRequired - 1) → "downgrade"
//   otherwise → "ok"
//
// `priorWeeksUnder` is the count of CONSECUTIVE most-recent COMPLETED weeks
// already recorded under threshold in state.weeks. The current in-progress
// week's projection counts as one additional under-threshold observation
// when computing downgrade eligibility, but only IF it's under threshold.
export function decideRecommendation(projectedPct, priorWeeksUnder, weeksRequired,
  { upgradeThreshold = 80, downgradeThreshold = 20 } = {}) {
  if (projectedPct >= upgradeThreshold) return "upgrade";
  if (projectedPct < downgradeThreshold) {
    if (priorWeeksUnder + 1 >= weeksRequired) return "downgrade";
  }
  return "ok";
}

// State file I/O. Schema:
//   { last_run, last_recommendation, weeks: [{ week_ending, q7d_actual_at_reset, under_downgrade, tier_assumed }, ...] }
// `weeks` is bounded; oldest entries drop when exceeding STATE_WEEKS_BOUND.

const INITIAL_STATE = Object.freeze({ last_run: null, last_recommendation: null, weeks: [] });

export function loadAdvisorState(path) {
  if (!existsSync(path)) return { ...INITIAL_STATE, weeks: [] };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return {
      last_run: parsed.last_run || null,
      last_recommendation: parsed.last_recommendation || null,
      weeks: Array.isArray(parsed.weeks) ? parsed.weeks : [],
    };
  } catch (err) {
    const e = new Error(`malformed state file at ${path}: ${err.message}`);
    e.hardError = true;
    throw e;
  }
}

export function persistAdvisorState(path, state) {
  // Bound the weeks array to the most recent STATE_WEEKS_BOUND entries
  // (entries are kept in descending order: index 0 is most recent).
  const bounded = {
    ...state,
    weeks: (state.weeks || []).slice(0, STATE_WEEKS_BOUND),
  };
  writeFileSync(path, JSON.stringify(bounded, null, 2));
}

// Compute the week-ending boundary for a given timestamp. Anthropic's
// weekly quota resets on a fixed cadence; use the 7d-reset header value
// when available, falling back to "next Sunday 00:00 UTC". Returns an
// epoch-ms timestamp.
export function computeWeekEndingFromReset(resetTs) {
  if (Number.isFinite(resetTs) && resetTs > 0) return resetTs * 1000;
  // Fallback: next Sunday 00:00 UTC.
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun
  const daysUntilSun = (7 - day) % 7 || 7;
  const sun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilSun));
  return sun.getTime();
}

// Has the calendar-week reset boundary been crossed since lastRunTs?
// True iff there is at least one weekly-reset boundary in (lastRunTs, nowTs].
// Boundaries land at multiples of 7 days from a known reset epoch (the
// resetTs we observed); for the calendar-week check we use the simpler
// "lastRunTs and nowTs fall in different reset-anchored weeks" rule.
export function weekBoundaryCrossed(lastRunTs, nowTs, weekEndingTs) {
  if (!Number.isFinite(lastRunTs) || lastRunTs <= 0) return false;
  if (!Number.isFinite(nowTs) || !Number.isFinite(weekEndingTs)) return false;
  // The "just-completed week" is the one ending at weekEndingTs; if
  // lastRun was BEFORE weekEndingTs and now is AT-OR-AFTER, the boundary
  // crossed. Once a record is written for that week_ending, subsequent
  // calls don't re-write because the de-dupe check upstream sees the
  // matching week_ending already in state.weeks.
  return lastRunTs < weekEndingTs && nowTs >= weekEndingTs;
}

// Count consecutive most-recent weeks under threshold. State.weeks is
// expected in descending order (index 0 most recent).
export function countConsecutiveWeeksUnder(weeks) {
  let n = 0;
  for (const w of weeks || []) {
    if (w && w.under_downgrade === true) n++;
    else break;
  }
  return n;
}

export function countConsecutiveWeeksOver(weeks, downgradeThreshold = 20) {
  let n = 0;
  for (const w of weeks || []) {
    if (!w) break;
    if (typeof w.q7d_actual_at_reset === "number" && w.q7d_actual_at_reset >= downgradeThreshold) n++;
    else break;
  }
  return n;
}

// =============================================================================
// I/O wrappers
// =============================================================================

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readUsageLogEntriesSince(path, weekStartTs) {
  if (!existsSync(path)) return [];
  const out = [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e) continue;
    const ts = Date.parse(e.ts || e.timestamp || "");
    if (Number.isFinite(ts) && ts >= weekStartTs) out.push(e);
  }
  return out;
}

// Plan-heuristic input. v1 is intentionally stubbed: returns null so the
// detectPlan heuristic branch is skipped and detection falls back to CLI
// override / CACHE_FIX_ADVISOR_PLAN / "unknown". The practical path is the
// CLI/env override — documented in docs/tier-advisor.md and surfaced via
// exit code 3 with a "set CACHE_FIX_ADVISOR_PLAN" hint when neither is set.
// Sharpening the heuristic from real Q5h budget patterns is a follow-up.
function recentQ5hBudgetTokens(_quotaStatus, _usageLog) {
  return null;
}

// =============================================================================
// Output formatters
// =============================================================================

export function formatHumanOutput(a) {
  const lines = [];
  lines.push(`Tier Advisor — ${a.ts}`);
  lines.push("");
  const planLabel = a.current_plan === "unknown"
    ? "unknown (set CACHE_FIX_ADVISOR_PLAN to override)"
    : `${a.current_plan === "max-5x" ? "Max 5x" : a.current_plan === "max-20x" ? "Max 20x" : a.current_plan} (${a.current_plan_source})`;
  lines.push(`Current plan: ${planLabel}`);
  if (a.current_q7d_pct !== null) {
    const reset = Number.isFinite(a.hours_until_reset)
      ? `${a.hours_until_reset.toFixed(0)} hours until reset`
      : "(reset time unknown)";
    lines.push(`This week:    Q7d ${a.current_q7d_pct}% with ${reset}`);
  }
  if (a.burn_rate_per_hour !== null) {
    lines.push(`Burn rate:    +${a.burn_rate_per_hour.toFixed(2)}%/hour (source: ${a.burn_rate_source})`);
    lines.push(`Projected:    Q7d ~${a.projected_q7d_at_reset.toFixed(0)}% at reset`);
  }
  lines.push("");
  switch (a.recommendation) {
    case "upgrade":
      lines.push("Recommendation: UPGRADE to Max 20x");
      lines.push("");
      lines.push("Why: at current burn, you'll cross the upgrade threshold before the");
      lines.push("weekly reset and risk overage pricing. The 5x → 20x step costs $100/mo");
      lines.push("and buys 4.4× headroom (measured across 2,197 requests).");
      break;
    case "downgrade":
      lines.push("Recommendation: DOWNGRADE to Max 5x");
      lines.push("");
      lines.push(`Why: Q7d has been under ${a.downgrade_threshold}% for ${a.consecutive_weeks_under_downgrade_threshold} consecutive weeks.`);
      lines.push("The 20x headroom is unused; downgrading saves $100/mo.");
      break;
    case "unknown":
      lines.push("Recommendation: UNKNOWN (plan undetectable)");
      lines.push("");
      lines.push("Why: couldn't detect your plan from quota headers or usage history.");
      lines.push("Set CACHE_FIX_ADVISOR_PLAN=max-5x or max-20x and re-run.");
      break;
    default:
      lines.push("Recommendation: HOLD (no change needed)");
      break;
  }
  if (a.enrichment && a.enrichment.summary) {
    lines.push("");
    lines.push(a.enrichment.summary);
  }
  return lines.join("\n") + "\n";
}

export function formatJsonOutput(a) {
  return {
    ts: a.ts,
    current_plan: a.current_plan,
    current_plan_source: a.current_plan_source,
    current_q7d_pct: a.current_q7d_pct,
    hours_since_reset: a.hours_since_reset,
    hours_until_reset: a.hours_until_reset,
    burn_rate_per_hour: a.burn_rate_per_hour,
    burn_rate_source: a.burn_rate_source,
    burn_rate_window_hours: a.burn_rate_window_hours,
    projected_q7d_at_reset: a.projected_q7d_at_reset,
    recommendation: a.recommendation,
    recommendation_target_plan: a.recommendation_target_plan,
    consecutive_weeks_under_downgrade_threshold: a.consecutive_weeks_under_downgrade_threshold,
    consecutive_weeks_over_upgrade_threshold: a.consecutive_weeks_over_upgrade_threshold,
  };
}

// =============================================================================
// Main orchestrator
// =============================================================================

export async function runAdvisor({ argv = process.argv, env = process.env, now = Date.now(), writeOutput = true } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    if (writeOutput) process.stdout.write(usageText());
    return EXIT.ok;
  }

  const quotaPath = env.CACHE_FIX_ADVISOR_QUOTA_STATUS
    || join(homedir(), ".claude", "quota-status", "account.json");
  const usageLogPath = env.CACHE_FIX_ADVISOR_USAGE_LOG
    || join(homedir(), ".claude", "usage.jsonl");
  const statePath = env.CACHE_FIX_ADVISOR_STATE
    || join(homedir(), ".claude", "tier-advisor-state.json");
  const overagePath = env.CACHE_FIX_ADVISOR_OVERAGE_LOG
    || join(homedir(), ".claude", "overage-warnings.jsonl");

  const upgradeThreshold = Number.parseFloat(env.CACHE_FIX_ADVISOR_UPGRADE_THRESHOLD) || 80;
  const downgradeThreshold = Number.parseFloat(env.CACHE_FIX_ADVISOR_DOWNGRADE_THRESHOLD) || 20;
  const downgradeWeeks = Number.parseInt(env.CACHE_FIX_ADVISOR_DOWNGRADE_WEEKS, 10) || 2;

  const quotaStatus = readJsonSafe(quotaPath);
  const hasUsageLog = existsSync(usageLogPath);

  // Hard-error: both primary AND fallback inputs missing.
  if (!quotaStatus && !hasUsageLog) {
    return emitHardError(opts, writeOutput, "no quota-status.json snapshot and no usage.jsonl found");
  }

  const q7dPct = quotaStatus?.seven_day?.pct;
  const q7dResetTs = quotaStatus?.seven_day?.resets_at; // unix seconds
  const snapshotTs = quotaStatus?.timestamp ? Date.parse(quotaStatus.timestamp) : null;

  // Compute calendar-week anchor. weekEndingMs is when the just-completed
  // week ends (epoch ms). weekStartMs is one week earlier.
  const weekEndingMs = computeWeekEndingFromReset(q7dResetTs);
  const weekStartMs = weekEndingMs - HOURS_PER_WEEK * 3600 * 1000;
  const hoursUntilReset = (weekEndingMs - now) / 3600 / 1000;
  const hoursSinceReset = HOURS_PER_WEEK - hoursUntilReset;

  // Compute burn rate via the SINGLE binary rule.
  // Primary: snapshot Q7d / hours_since_reset, when snapshot mtime is fresh.
  // Fallback: usage.jsonl token sum over the week — derives BOTH currentPct
  // AND burnRate from the same sum so projection is honest. Codex r1 blocker
  // fix: previously this branch left currentPct as null/stale, so projection
  // collapsed to 0 and silently returned tier:ok under high burn.
  let burnRate = null;
  let burnRateSource = null;
  let burnRateWindowHours = null;
  let currentPctFromSource = typeof q7dPct === "number" ? q7dPct : null;

  const snapshotFresh = snapshotTs !== null
    && (now - snapshotTs) <= PRIMARY_FRESHNESS_HOURS * 3600 * 1000;
  if (typeof q7dPct === "number" && snapshotFresh && hoursSinceReset > 0) {
    burnRate = computeBurnRate(q7dPct, hoursSinceReset);
    burnRateSource = "header";
    burnRateWindowHours = Math.round(hoursSinceReset);
    currentPctFromSource = q7dPct;
  } else if (hasUsageLog) {
    // Plan detection happens first so we know which planTokens to use.
    // If plan is unknown, the log-fallback path can't normalize → exit 3.
    const planRes = detectPlan({
      envValue: env.CACHE_FIX_ADVISOR_PLAN,
      planOverride: opts.planOverride,
      recentBudgetTokens: recentQ5hBudgetTokens(quotaStatus, null),
    });
    if (planRes.plan === "unknown" || planRes.plan === "pro") {
      // pro tier is not a recommendation target; pro users shouldn't get
      // 5x/20x tier-advisor recommendations at all.
      return emitUnknown(opts, writeOutput, planRes, statePath);
    }
    const planTokens = PLAN_TOKENS[planRes.plan] || PLAN_TOKENS["max-5x"];
    const entries = readUsageLogEntriesSince(usageLogPath, weekStartMs);
    burnRate = computeBurnRateFromUsageLog(entries, weekStartMs, hoursSinceReset, planTokens);
    burnRateSource = "log";
    burnRateWindowHours = Math.round(hoursSinceReset);
    // Single-source rule: derive currentPct from the SAME log sum that
    // produced burnRate. Never blend with stale q7dPct from account.json.
    currentPctFromSource = computeCurrentPctFromUsageLog(entries, weekStartMs, planTokens);
  }

  // Plan detection (re-resolve if not already done — most paths skip the log-fallback).
  const planRes = detectPlan({
    envValue: env.CACHE_FIX_ADVISOR_PLAN,
    planOverride: opts.planOverride,
    recentBudgetTokens: recentQ5hBudgetTokens(quotaStatus, null),
  });

  if (planRes.plan === "unknown" || planRes.plan === "pro") {
    return emitUnknown(opts, writeOutput, planRes, statePath);
  }

  // Projection. Uses currentPctFromSource which is single-source: header q7dPct
  // when the snapshot was fresh, log-derived percent when the fallback fired.
  const projected = (burnRate !== null && typeof currentPctFromSource === "number")
    ? projectQ7dAtReset(currentPctFromSource, burnRate, hoursUntilReset)
    : (typeof currentPctFromSource === "number" ? currentPctFromSource : 0);

  // State load.
  let state = INITIAL_STATE;
  if (!opts.noState) {
    try {
      state = loadAdvisorState(statePath);
    } catch (err) {
      if (err.hardError) {
        return emitHardError(opts, writeOutput, err.message);
      }
      throw err;
    }
  }

  // Append weeks[] entry if calendar-week boundary crossed since last_run.
  // Append exactly once per crossing; same-week reruns are no-ops.
  // The just-completed week ends at the PREVIOUS weekEndingMs (because the
  // current weekEndingMs is the END of the IN-PROGRESS week per the reset
  // header). Compute the previous boundary: weekEndingMs - 7d.
  const justCompletedWeekEnding = weekEndingMs - HOURS_PER_WEEK * 3600 * 1000;
  const lastRunTs = state.last_run ? Date.parse(state.last_run) : 0;
  if (
    !opts.noState
    && weekBoundaryCrossed(lastRunTs, now, justCompletedWeekEnding)
    && !state.weeks.some((w) => w && Date.parse(w.week_ending) === justCompletedWeekEnding)
  ) {
    // Persist from the single source (header or log) that drove this run's
    // projection. Codex r1: never carry stale account.json q7dPct into the
    // weeks[] record when the run was a log-fallback.
    const observed = typeof currentPctFromSource === "number" ? currentPctFromSource : projected;
    state.weeks = [
      {
        week_ending: new Date(justCompletedWeekEnding).toISOString(),
        q7d_actual_at_reset: observed,
        under_downgrade: observed < downgradeThreshold,
        tier_assumed: planRes.plan,
      },
      ...state.weeks,
    ].slice(0, STATE_WEEKS_BOUND);
  }

  const consecutiveUnder = countConsecutiveWeeksUnder(state.weeks);
  const consecutiveOver = countConsecutiveWeeksOver(state.weeks, downgradeThreshold);

  const recommendation = decideRecommendation(projected, consecutiveUnder, downgradeWeeks, {
    upgradeThreshold, downgradeThreshold,
  });

  const targetPlan = recommendation === "upgrade"
    ? (planRes.plan === "max-5x" ? "max-20x" : null)
    : recommendation === "downgrade"
      ? (planRes.plan === "max-20x" ? "max-5x" : null)
      : null;

  // Load overage-warnings enrichment, optional.
  const enrichment = readEnrichment(overagePath, weekStartMs);

  const analysis = {
    ts: new Date(now).toISOString(),
    current_plan: planRes.plan,
    current_plan_source: planRes.source,
    current_q7d_pct: typeof currentPctFromSource === "number" ? currentPctFromSource : null,
    hours_since_reset: Number.isFinite(hoursSinceReset) ? Math.round(hoursSinceReset) : null,
    hours_until_reset: Number.isFinite(hoursUntilReset) ? hoursUntilReset : null,
    burn_rate_per_hour: burnRate,
    burn_rate_source: burnRateSource,
    burn_rate_window_hours: burnRateWindowHours,
    projected_q7d_at_reset: Number.isFinite(projected) ? projected : 0,
    recommendation,
    recommendation_target_plan: targetPlan,
    consecutive_weeks_under_downgrade_threshold: consecutiveUnder,
    consecutive_weeks_over_upgrade_threshold: consecutiveOver,
    downgrade_threshold: downgradeThreshold,
    upgrade_threshold: upgradeThreshold,
    enrichment,
  };

  // Persist state (last_run, last_recommendation; weeks[] already mutated above).
  if (!opts.noState) {
    state.last_run = analysis.ts;
    state.last_recommendation = `tier:${recommendation}`;
    try {
      persistAdvisorState(statePath, state);
    } catch (err) {
      // Persist failure is a hard error per the directive's exit-4 contract.
      return emitHardError(opts, writeOutput, `cannot write state file: ${err.message}`);
    }
  }

  // Output + exit.
  if (writeOutput && !opts.quiet) {
    if (opts.json) {
      process.stdout.write(JSON.stringify(formatJsonOutput(analysis), null, 2) + "\n");
    } else {
      process.stdout.write(formatHumanOutput(analysis));
    }
  }
  switch (recommendation) {
    case "upgrade":   return EXIT.upgrade;
    case "downgrade": return EXIT.downgrade;
    case "unknown":   return EXIT.unknown;
    default:          return EXIT.ok;
  }
}

function readEnrichment(overagePath, weekStartMs) {
  if (!existsSync(overagePath)) return { has_events: false };
  let raw;
  try { raw = readFileSync(overagePath, "utf8"); } catch { return { has_events: false }; }
  const surpassedHits = new Map(); // threshold → count
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e) continue;
    const ts = Date.parse(e.ts || e.timestamp || "");
    if (!Number.isFinite(ts) || ts < weekStartMs) continue;
    const surpassed = e?.trigger?.surpassed_threshold ?? e?.surpassed_threshold;
    if (typeof surpassed === "number") {
      surpassedHits.set(surpassed, (surpassedHits.get(surpassed) || 0) + 1);
    }
  }
  if (surpassedHits.size === 0) return { has_events: false };
  const parts = [];
  for (const [k, v] of [...surpassedHits.entries()].sort((a, b) => a[0] - b[0])) {
    parts.push(`crossed ${k} (${v}×)`);
  }
  return {
    has_events: true,
    summary: `Enrichment: in the last 7 days Anthropic flagged the account ${parts.join("; ")}.`,
  };
}

function emitHardError(opts, writeOutput, msg) {
  if (writeOutput && !opts.quiet) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: msg }, null, 2) + "\n");
    } else {
      process.stderr.write(`tier-advisor: hard error: ${msg}\n`);
    }
  }
  return EXIT.hardError;
}

function emitUnknown(opts, writeOutput, planRes, statePath) {
  const ts = new Date().toISOString();
  if (writeOutput && !opts.quiet) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        ts,
        current_plan: planRes.plan,
        current_plan_source: planRes.source,
        recommendation: "unknown",
        recommendation_target_plan: null,
      }, null, 2) + "\n");
    } else {
      process.stdout.write(`Tier Advisor — ${ts}\n\nCurrent plan: unknown (set CACHE_FIX_ADVISOR_PLAN to override)\n\nRecommendation: UNKNOWN (plan undetectable)\n\nSet CACHE_FIX_ADVISOR_PLAN=max-5x or max-20x and re-run.\n`);
    }
  }
  // Persist state so the statusline can display tier:unknown per the
  // documented contract (docs/tier-advisor.md statusline section +
  // tools/quota-statusline.sh allowlist). Codex r2 blocker: previously
  // emitUnknown returned without touching state, so an exit-3 run never
  // wrote last_recommendation:"tier:unknown" and the statusline stayed
  // empty even though the wiring was ready to display it.
  if (!opts.noState && statePath) {
    try {
      let state;
      try {
        state = loadAdvisorState(statePath);
      } catch (err) {
        if (err && err.hardError) return EXIT.unknown;
        throw err;
      }
      state.last_run = ts;
      state.last_recommendation = "tier:unknown";
      persistAdvisorState(statePath, state);
    } catch {
      // Persist failures on the unknown path are non-fatal: we already
      // have an exit-3 to report and a stdout message; not worth
      // upgrading to exit 4 just because the state file is unwritable.
    }
  }
  return EXIT.unknown;
}

function usageText() {
  return `tier-advisor — Max plan upgrade/downgrade recommendation

Usage:
  tier-advisor [options]

Options:
  --json                       machine-readable JSON output
  --quiet                      no stdout/stderr; exit code only
  --no-state                   don't read or write state file
  --plan max-5x|max-20x|pro    override plan detection
  --help                       this text

Exit codes:
  0  HOLD (no recommendation)
  1  UPGRADE recommended
  2  DOWNGRADE recommended
  3  plan undetectable (set CACHE_FIX_ADVISOR_PLAN and re-run)
  4  hard error

Env vars:
  CACHE_FIX_ADVISOR_PLAN                  explicit plan: max-5x | max-20x | pro
  CACHE_FIX_ADVISOR_QUOTA_STATUS          path to account.json (default ~/.claude/quota-status/account.json)
  CACHE_FIX_ADVISOR_USAGE_LOG             path to usage.jsonl (default ~/.claude/usage.jsonl)
  CACHE_FIX_ADVISOR_STATE                 path to state file (default ~/.claude/tier-advisor-state.json)
  CACHE_FIX_ADVISOR_OVERAGE_LOG           path to overage-warnings.jsonl (default ~/.claude/overage-warnings.jsonl)
  CACHE_FIX_ADVISOR_UPGRADE_THRESHOLD     percent (default 80)
  CACHE_FIX_ADVISOR_DOWNGRADE_THRESHOLD   percent (default 20)
  CACHE_FIX_ADVISOR_DOWNGRADE_WEEKS       integer (default 2)

See docs/tier-advisor.md and docs/directives/proxy-tier-advisor.md for details.
`;
}

// =============================================================================
// Entrypoint
// =============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  runAdvisor().then(
    (code) => process.exit(code),
    (err) => { process.stderr.write(`tier-advisor: ${err.stack || err}\n`); process.exit(EXIT.hardError); },
  );
}
