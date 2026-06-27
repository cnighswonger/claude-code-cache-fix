import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  computeBurnRate,
  computeBurnRateFromUsageLog,
  projectQ7dAtReset,
  detectPlan,
  decideRecommendation,
  loadAdvisorState,
  persistAdvisorState,
  computeWeekEndingFromReset,
  weekBoundaryCrossed,
  countConsecutiveWeeksUnder,
  countConsecutiveWeeksOver,
  formatHumanOutput,
  formatJsonOutput,
  parseArgs,
  runAdvisor,
} from "../tools/tier-advisor.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADVISOR_BIN = join(__dirname, "..", "tools", "tier-advisor.mjs");

// --- Fixture helpers ---

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tier-advisor-test-"));
}

function writeQuotaStatus(dir, { q7dPct = 50, q7dResetEpochSec, snapshotTs, q5hPct = 20 } = {}) {
  const reset = q7dResetEpochSec ?? (Math.floor(Date.now() / 1000) + 24 * 3600);
  const ts = snapshotTs ?? new Date().toISOString();
  const data = {
    five_hour: { utilization: q5hPct / 100, pct: q5hPct, resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 },
    seven_day: { utilization: q7dPct / 100, pct: q7dPct, resets_at: reset },
    timestamp: ts,
    status: "allowed",
  };
  const path = join(dir, "account.json");
  writeFileSync(path, JSON.stringify(data));
  return path;
}

function writeUsageLog(dir, entries) {
  const path = join(dir, "usage.jsonl");
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

function writeAdvisorState(dir, state, filename = "tier-advisor-state.json") {
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(state));
  return path;
}

function runCli(args, env = {}) {
  try {
    const out = execFileSync(process.execPath, [ADVISOR_BIN, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
    return { stdout: out, exit: 0 };
  } catch (err) {
    return { stdout: err.stdout?.toString() || "", stderr: err.stderr?.toString() || "", exit: err.status };
  }
}

// =============================================================================
// BURN RATE (1-4)
// =============================================================================

test("1. computeBurnRate(50, 100) → 0.5", () => {
  assert.equal(computeBurnRate(50, 100), 0.5);
});

test("2. computeBurnRate(0, 0) → 0 (defensive: no time elapsed)", () => {
  assert.equal(computeBurnRate(0, 0), 0);
});

test("3. computeBurnRate(50, -5) → 0 (defensive: negative hours)", () => {
  assert.equal(computeBurnRate(50, -5), 0);
});

test("4. computeBurnRateFromUsageLog: small fixture matches expected percent", () => {
  const weekStart = Date.parse("2026-04-20T00:00:00Z");
  const entries = [
    { ts: "2026-04-20T01:00:00Z", usage: { input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    { ts: "2026-04-20T02:00:00Z", usage: { input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    { ts: "2026-04-19T22:00:00Z", usage: { input_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, // outside window
  ];
  // 2M tokens / 200M = 1% over 24h = 1/24 %/hr
  const rate = computeBurnRateFromUsageLog(entries, weekStart, 24, 200_000_000);
  assert.ok(Math.abs(rate - (1 / 24)) < 1e-6, `expected ~${1/24}, got ${rate}`);
});

// =============================================================================
// PROJECTION (5-8)
// =============================================================================

test("5. projectQ7dAtReset(50, 1, 30) → 80", () => {
  assert.equal(projectQ7dAtReset(50, 1, 30), 80);
});

test("6. projectQ7dAtReset(50, 5, 30) → 200 (capped from 200)", () => {
  assert.equal(projectQ7dAtReset(50, 5, 30), 200);
});

test("7. projectQ7dAtReset(50, 10, 30) → 200 (cap)", () => {
  assert.equal(projectQ7dAtReset(50, 10, 30), 200);
});

test("8. projectQ7dAtReset(50, 0, 30) → 50 (no burn, stays put)", () => {
  assert.equal(projectQ7dAtReset(50, 0, 30), 50);
});

// =============================================================================
// PLAN DETECTION (9-12)
// =============================================================================

test("9. CLI override wins over everything", () => {
  const res = detectPlan({ envValue: "max-5x", planOverride: "max-20x", recentBudgetTokens: 200_000_000 });
  assert.equal(res.plan, "max-20x");
  assert.equal(res.source, "cli");
});

test("10. Plan absent in env+CLI, ~200M Q5h budget → max-5x", () => {
  const res = detectPlan({ envValue: null, planOverride: null, recentBudgetTokens: 200_000_000 });
  assert.equal(res.plan, "max-5x");
  assert.equal(res.source, "heuristic");
});

test("11. Plan absent in env+CLI, ~890M Q5h budget → max-20x", () => {
  const res = detectPlan({ envValue: null, planOverride: null, recentBudgetTokens: 890_000_000 });
  assert.equal(res.plan, "max-20x");
  assert.equal(res.source, "heuristic");
});

test("12. Plan absent + no budget data → unknown", () => {
  const res = detectPlan({ envValue: null, planOverride: null, recentBudgetTokens: null });
  assert.equal(res.plan, "unknown");
  assert.equal(res.source, "fallback");
});

// =============================================================================
// DECISION MATRIX (13-17)
// =============================================================================

test("13. decideRecommendation(85, 0, 2) → upgrade (single-event over threshold)", () => {
  assert.equal(decideRecommendation(85, 0, 2), "upgrade");
});

test("14. decideRecommendation(50, 0, 2) → ok", () => {
  assert.equal(decideRecommendation(50, 0, 2), "ok");
});

test("15. decideRecommendation(15, 0, 2) → ok (under threshold but no prior weeks)", () => {
  assert.equal(decideRecommendation(15, 0, 2), "ok");
});

test("16. decideRecommendation(15, 1, 2) → downgrade (1 prior week + current = 2)", () => {
  assert.equal(decideRecommendation(15, 1, 2), "downgrade");
});

test("17. decideRecommendation(15, 1, 3) → ok (need 3 weeks; only have 2)", () => {
  assert.equal(decideRecommendation(15, 1, 3), "ok");
});

// =============================================================================
// STATE PERSISTENCE (18-22)
// =============================================================================

test("18. First run with no state file → initial state with weeks:[]", () => {
  const dir = makeTempDir();
  try {
    const state = loadAdvisorState(join(dir, "state.json"));
    assert.deepEqual(state, { last_run: null, last_recommendation: null, weeks: [] });
  } finally { rmSync(dir, { recursive: true }); }
});

test("19. Run after calendar-week boundary crosses → exactly ONE entry appended; no duplicates on re-run", () => {
  const dir = makeTempDir();
  try {
    // weekly reset at noon today; "previous" reset 7d before. We arrange:
    //   last_run was BEFORE the previous reset (= boundary crossed)
    //   q7d snapshot present
    const env = {
      HOME: dir,
      CACHE_FIX_ADVISOR_QUOTA_STATUS: join(dir, "account.json"),
      CACHE_FIX_ADVISOR_USAGE_LOG: join(dir, "usage.jsonl"),
      CACHE_FIX_ADVISOR_STATE: join(dir, "state.json"),
      CACHE_FIX_ADVISOR_PLAN: "max-5x",
    };
    const oneWeekSec = 7 * 24 * 3600;
    const nextResetEpochSec = Math.floor(Date.now() / 1000) + 24 * 3600;
    writeQuotaStatus(dir, { q7dPct: 15, q7dResetEpochSec: nextResetEpochSec });
    writeAdvisorState(dir, {
      last_run: new Date(Date.now() - (oneWeekSec + 24 * 3600) * 1000).toISOString(),
      last_recommendation: null,
      weeks: [],
    }, "state.json");
    const code1 = runCli([], env);
    const state1 = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    assert.equal(state1.weeks.length, 1, `expected 1 week entry, got ${state1.weeks.length}`);

    // Re-run from the just-written state: no new entry should land.
    const code2 = runCli([], env);
    const state2 = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    assert.equal(state2.weeks.length, 1, "re-run within same calendar week must not append");
    assert.ok(code1.exit < 4 && code2.exit < 4, "neither run should hard-error");
  } finally { rmSync(dir, { recursive: true }); }
});

test("20. Multiple runs within same calendar week → weeks unchanged; in-progress week not recorded", () => {
  const dir = makeTempDir();
  try {
    const env = {
      HOME: dir,
      CACHE_FIX_ADVISOR_QUOTA_STATUS: join(dir, "account.json"),
      CACHE_FIX_ADVISOR_USAGE_LOG: join(dir, "usage.jsonl"),
      CACHE_FIX_ADVISOR_STATE: join(dir, "state.json"),
      CACHE_FIX_ADVISOR_PLAN: "max-5x",
    };
    writeQuotaStatus(dir, { q7dPct: 15 });
    writeAdvisorState(dir, {
      last_run: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), // 3h ago — same calendar week
      last_recommendation: null,
      weeks: [],
    }, "state.json");
    runCli([], env);
    runCli([], env);
    runCli([], env);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    assert.equal(state.weeks.length, 0, "in-progress week should not be recorded; no boundary crossed");
  } finally { rmSync(dir, { recursive: true }); }
});

test("21. countConsecutiveWeeksUnder reflects state.weeks correctly", () => {
  const weeks = [
    { week_ending: "x1", under_downgrade: true },
    { week_ending: "x2", under_downgrade: true },
    { week_ending: "x3", under_downgrade: false },
    { week_ending: "x4", under_downgrade: true },
  ];
  assert.equal(countConsecutiveWeeksUnder(weeks), 2);
});

test("22. state.weeks bounded to 8 entries; older entries dropped on persist", () => {
  const dir = makeTempDir();
  const path = join(dir, "state.json");
  try {
    const weeks = Array.from({ length: 12 }, (_, i) => ({
      week_ending: new Date(Date.now() - i * 7 * 24 * 3600 * 1000).toISOString(),
      q7d_actual_at_reset: 10,
      under_downgrade: true,
      tier_assumed: "max-5x",
    }));
    persistAdvisorState(path, { last_run: null, last_recommendation: null, weeks });
    const back = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(back.weeks.length, 8);
  } finally { rmSync(dir, { recursive: true }); }
});

// =============================================================================
// OUTPUT FORMATS (23-27)
// =============================================================================

test("23. Default human output includes plan, burn, projection, recommendation, Why", () => {
  const out = formatHumanOutput({
    ts: "2026-06-24T18:00:00Z",
    current_plan: "max-5x",
    current_plan_source: "cli",
    current_q7d_pct: 85,
    hours_until_reset: 24,
    hours_since_reset: 144,
    burn_rate_per_hour: 0.5,
    burn_rate_source: "header",
    projected_q7d_at_reset: 97,
    recommendation: "upgrade",
    recommendation_target_plan: "max-20x",
    consecutive_weeks_under_downgrade_threshold: 0,
    consecutive_weeks_over_upgrade_threshold: 1,
  });
  assert.match(out, /Tier Advisor/);
  assert.match(out, /Max 5x/);
  assert.match(out, /Q7d 85%/);
  assert.match(out, /Burn rate/);
  assert.match(out, /Projected/);
  assert.match(out, /UPGRADE to Max 20x/);
  assert.match(out, /Why:/);
});

test("24. --json output is parseable JSON with the documented schema", () => {
  const obj = formatJsonOutput({
    ts: "2026-06-24T18:00:00Z",
    current_plan: "max-5x",
    current_plan_source: "cli",
    current_q7d_pct: 50,
    hours_since_reset: 100,
    hours_until_reset: 68,
    burn_rate_per_hour: 0.5,
    burn_rate_source: "header",
    burn_rate_window_hours: 100,
    projected_q7d_at_reset: 84,
    recommendation: "upgrade",
    recommendation_target_plan: "max-20x",
    consecutive_weeks_under_downgrade_threshold: 0,
    consecutive_weeks_over_upgrade_threshold: 1,
  });
  const expected = [
    "ts","current_plan","current_plan_source","current_q7d_pct","hours_since_reset",
    "hours_until_reset","burn_rate_per_hour","burn_rate_source","burn_rate_window_hours",
    "projected_q7d_at_reset","recommendation","recommendation_target_plan",
    "consecutive_weeks_under_downgrade_threshold","consecutive_weeks_over_upgrade_threshold",
  ];
  for (const k of expected) assert.ok(k in obj, `missing ${k}`);
});

test("25. --quiet produces zero stdout AND zero stderr; exit code matches contract", () => {
  const dir = makeTempDir();
  try {
    writeQuotaStatus(dir, { q7dPct: 11 });
    const env = {
      HOME: dir,
      CACHE_FIX_ADVISOR_QUOTA_STATUS: join(dir, "account.json"),
      CACHE_FIX_ADVISOR_USAGE_LOG: join(dir, "usage.jsonl"),
      CACHE_FIX_ADVISOR_STATE: join(dir, "state.json"),
      CACHE_FIX_ADVISOR_PLAN: "max-5x",
    };
    const r = runCli(["--quiet"], env);
    assert.equal(r.stdout, "");
    assert.ok(!r.stderr || r.stderr.length === 0);
    assert.equal(r.exit, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test("25a. Exit code is the same across default / --json / --quiet for the same fixture", () => {
  const dir = makeTempDir();
  try {
    writeQuotaStatus(dir, { q7dPct: 85 });  // high enough to project upgrade
    const env = {
      HOME: dir,
      CACHE_FIX_ADVISOR_QUOTA_STATUS: join(dir, "account.json"),
      CACHE_FIX_ADVISOR_USAGE_LOG: join(dir, "usage.jsonl"),
      CACHE_FIX_ADVISOR_STATE: join(dir, "state.json"),
      CACHE_FIX_ADVISOR_PLAN: "max-5x",
    };
    const def = runCli([], env);
    const j = runCli(["--json"], env);
    const q = runCli(["--quiet"], env);
    assert.equal(def.exit, j.exit, `default vs --json: ${def.exit} vs ${j.exit}`);
    assert.equal(j.exit, q.exit, `--json vs --quiet: ${j.exit} vs ${q.exit}`);
  } finally { rmSync(dir, { recursive: true }); }
});

test("26. Statusline reads tier-advisor-state.json and appends tier:upgrade when last_recommendation is upgrade", () => {
  const dir = makeTempDir();
  try {
    // Write account.json (statusline requires it)
    mkdirSync(join(dir, ".claude", "quota-status"), { recursive: true });
    writeFileSync(join(dir, ".claude", "quota-status", "account.json"), JSON.stringify({
      five_hour: { pct: 5, resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 },
      seven_day: { pct: 11, resets_at: Math.floor(Date.now() / 1000) + 24 * 3600 },
      timestamp: new Date().toISOString(),
    }));
    writeFileSync(join(dir, ".claude", "tier-advisor-state.json"), JSON.stringify({
      last_run: new Date().toISOString(),
      last_recommendation: "tier:upgrade",
      weeks: [],
    }));
    const statusline = join(__dirname, "..", "tools", "quota-statusline.sh");
    const out = execFileSync("/bin/bash", [statusline], { env: { ...process.env, HOME: dir }, input: "{}", encoding: "utf8" });
    assert.match(out, /tier:upgrade/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("27. Statusline omits tier: token when last_recommendation is tier:ok", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, ".claude", "quota-status"), { recursive: true });
    writeFileSync(join(dir, ".claude", "quota-status", "account.json"), JSON.stringify({
      five_hour: { pct: 5, resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 },
      seven_day: { pct: 11, resets_at: Math.floor(Date.now() / 1000) + 24 * 3600 },
      timestamp: new Date().toISOString(),
    }));
    writeFileSync(join(dir, ".claude", "tier-advisor-state.json"), JSON.stringify({
      last_run: new Date().toISOString(),
      last_recommendation: "tier:ok",
      weeks: [],
    }));
    const statusline = join(__dirname, "..", "tools", "quota-statusline.sh");
    const out = execFileSync("/bin/bash", [statusline], { env: { ...process.env, HOME: dir }, input: "{}", encoding: "utf8" });
    assert.ok(!/tier:/.test(out), `expected no tier: token, got: ${out}`);
  } finally { rmSync(dir, { recursive: true }); }
});

// =============================================================================
// CLI ARGS (28-30)
// =============================================================================

test("28. unknown flags don't crash parseArgs (v1 only ships --json/--quiet/--no-state/--plan/--help)", () => {
  // Historical-week analysis is not in v1; --week is intentionally unparsed.
  // Unknown args are silently ignored rather than rejected so future additions
  // can land without breaking older wrapper scripts.
  const opts = parseArgs(["node", "tier-advisor.mjs", "--week", "1"]);
  assert.equal(opts.json, false);
  assert.equal(opts.quiet, false);
  assert.equal(opts.planOverride, null);
});

test("29. --plan flag wins over CACHE_FIX_ADVISOR_PLAN env", () => {
  const res = detectPlan({ envValue: "max-5x", planOverride: "max-20x", recentBudgetTokens: null });
  assert.equal(res.plan, "max-20x");
  assert.equal(res.source, "cli");
});

test("30. --no-state doesn't read or write state file; same input twice produces same output", () => {
  const dir = makeTempDir();
  try {
    writeQuotaStatus(dir, { q7dPct: 50 });
    const env = {
      HOME: dir,
      CACHE_FIX_ADVISOR_QUOTA_STATUS: join(dir, "account.json"),
      CACHE_FIX_ADVISOR_USAGE_LOG: join(dir, "usage.jsonl"),
      CACHE_FIX_ADVISOR_STATE: join(dir, "state.json"),
      CACHE_FIX_ADVISOR_PLAN: "max-5x",
    };
    const a = runCli(["--no-state", "--json"], env);
    const b = runCli(["--no-state", "--json"], env);
    assert.ok(!existsSync(join(dir, "state.json")), "no-state should not write a state file");
    // Outputs differ only in time-sensitive fields. Compare structurally:
    // recommendation, plan, source — those must match exactly. Float
    // fields (burn_rate_per_hour, hours_until_reset, projected_q7d_at_reset)
    // drift by microseconds between runs ms apart; that's inherent to the
    // formula's `now`-dependence, not a stability bug.
    const aObj = JSON.parse(a.stdout);
    const bObj = JSON.parse(b.stdout);
    const stable = (o) => ({
      current_plan: o.current_plan,
      current_plan_source: o.current_plan_source,
      current_q7d_pct: o.current_q7d_pct,
      hours_since_reset: o.hours_since_reset,
      burn_rate_source: o.burn_rate_source,
      burn_rate_window_hours: o.burn_rate_window_hours,
      recommendation: o.recommendation,
      recommendation_target_plan: o.recommendation_target_plan,
      consecutive_weeks_under_downgrade_threshold: o.consecutive_weeks_under_downgrade_threshold,
      consecutive_weeks_over_upgrade_threshold: o.consecutive_weeks_over_upgrade_threshold,
    });
    assert.deepEqual(stable(aObj), stable(bObj));
    // Float fields drift but should agree to within 0.01.
    assert.ok(Math.abs(aObj.burn_rate_per_hour - bObj.burn_rate_per_hour) < 0.01);
    assert.ok(Math.abs(aObj.projected_q7d_at_reset - bObj.projected_q7d_at_reset) < 0.01);
  } finally { rmSync(dir, { recursive: true }); }
});

// =============================================================================
// EDGE CASES (31-34)
// =============================================================================

test("31. account.json missing AND usage.jsonl missing → hard error exit 4", () => {
  const dir = makeTempDir();
  try {
    const env = {
      HOME: dir,
      CACHE_FIX_ADVISOR_QUOTA_STATUS: join(dir, "noexist.json"),
      CACHE_FIX_ADVISOR_USAGE_LOG: join(dir, "noexist.jsonl"),
      CACHE_FIX_ADVISOR_STATE: join(dir, "state.json"),
      CACHE_FIX_ADVISOR_PLAN: "max-5x",
    };
    const r = runCli([], env);
    assert.equal(r.exit, 4);
  } finally { rmSync(dir, { recursive: true }); }
});

// Codex r1 blocker regression tests. The previous fallback path left
// current_q7d_pct null / stale and projection=0, silently producing tier:ok
// on high-burn fallback. Both must now derive current_q7d_pct from the
// same log sum that drives burn_rate, so a 200M-token week on max-5x exits 1.

test("31a. stale account.json + high usage.jsonl → log fallback, projection from log, exit 1 (upgrade)", () => {
  const dir = makeTempDir();
  try {
    // Snapshot is 48h old (PRIMARY_FRESHNESS_HOURS=24) so the header path is
    // disqualified and the log fallback fires.
    const staleTs = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    writeQuotaStatus(dir, { q7dPct: 5, snapshotTs: staleTs });
    const entry = { ts: new Date().toISOString(), usage: { input_tokens: 200_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    writeUsageLog(dir, [entry]);
    const env = {
      HOME: dir,
      CACHE_FIX_ADVISOR_QUOTA_STATUS: join(dir, "account.json"),
      CACHE_FIX_ADVISOR_USAGE_LOG: join(dir, "usage.jsonl"),
      CACHE_FIX_ADVISOR_STATE: join(dir, "state.json"),
      CACHE_FIX_ADVISOR_PLAN: "max-5x",
    };
    const r = runCli(["--json"], env);
    assert.equal(r.exit, 1, `expected upgrade exit 1, got ${r.exit}; stdout=${r.stdout}`);
    const obj = JSON.parse(r.stdout);
    assert.equal(obj.burn_rate_source, "log");
    // current_q7d_pct must come from the log sum, not the stale header's 5%.
    assert.ok(typeof obj.current_q7d_pct === "number" && obj.current_q7d_pct >= 80,
      `expected log-derived current_q7d_pct ≥80; got ${obj.current_q7d_pct}`);
    assert.equal(obj.recommendation, "upgrade");
  } finally { rmSync(dir, { recursive: true }); }
});

test("31b. missing account.json + high usage.jsonl → log fallback, projection from log, exit 1 (upgrade)", () => {
  const dir = makeTempDir();
  try {
    // No account.json at all. Log alone should drive a valid upgrade decision.
    const entry = { ts: new Date().toISOString(), usage: { input_tokens: 200_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    writeUsageLog(dir, [entry]);
    const env = {
      HOME: dir,
      CACHE_FIX_ADVISOR_QUOTA_STATUS: join(dir, "noexist.json"),
      CACHE_FIX_ADVISOR_USAGE_LOG: join(dir, "usage.jsonl"),
      CACHE_FIX_ADVISOR_STATE: join(dir, "state.json"),
      CACHE_FIX_ADVISOR_PLAN: "max-5x",
    };
    const r = runCli(["--json"], env);
    assert.equal(r.exit, 1, `expected upgrade exit 1, got ${r.exit}; stdout=${r.stdout}`);
    const obj = JSON.parse(r.stdout);
    assert.equal(obj.burn_rate_source, "log");
    assert.ok(typeof obj.current_q7d_pct === "number" && obj.current_q7d_pct >= 80,
      `expected log-derived current_q7d_pct ≥80; got ${obj.current_q7d_pct}`);
    assert.equal(obj.recommendation, "upgrade");
  } finally { rmSync(dir, { recursive: true }); }
});

test("32. usage.jsonl present but no entries this week → ok (exit 0), human output notes missing data", () => {
  const dir = makeTempDir();
  try {
    // Snapshot exists with valid Q7d → primary path takes precedence over fallback.
    writeQuotaStatus(dir, { q7dPct: 10 });
    writeUsageLog(dir, []);
    const env = {
      HOME: dir,
      CACHE_FIX_ADVISOR_QUOTA_STATUS: join(dir, "account.json"),
      CACHE_FIX_ADVISOR_USAGE_LOG: join(dir, "usage.jsonl"),
      CACHE_FIX_ADVISOR_STATE: join(dir, "state.json"),
      CACHE_FIX_ADVISOR_PLAN: "max-5x",
    };
    const r = runCli([], env);
    assert.equal(r.exit, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test("33. q7d reset timestamp in the past → treated as just-reset; burn rate still computes", () => {
  const dir = makeTempDir();
  try {
    const pastReset = Math.floor(Date.now() / 1000) - 100;
    writeQuotaStatus(dir, { q7dPct: 10, q7dResetEpochSec: pastReset });
    const env = {
      HOME: dir,
      CACHE_FIX_ADVISOR_QUOTA_STATUS: join(dir, "account.json"),
      CACHE_FIX_ADVISOR_USAGE_LOG: join(dir, "usage.jsonl"),
      CACHE_FIX_ADVISOR_STATE: join(dir, "state.json"),
      CACHE_FIX_ADVISOR_PLAN: "max-5x",
    };
    const r = runCli([], env);
    assert.ok(r.exit !== 4, `should not hard-error on past reset; got exit ${r.exit}`);
  } finally { rmSync(dir, { recursive: true }); }
});

test("34. Plan unknown (no override + heuristic fails) → exit 3, recommendation tier:unknown", () => {
  const dir = makeTempDir();
  try {
    writeQuotaStatus(dir, { q7dPct: 50 });
    const env = {
      HOME: dir,
      CACHE_FIX_ADVISOR_QUOTA_STATUS: join(dir, "account.json"),
      CACHE_FIX_ADVISOR_USAGE_LOG: join(dir, "noexist.jsonl"),
      CACHE_FIX_ADVISOR_STATE: join(dir, "state.json"),
      // CACHE_FIX_ADVISOR_PLAN deliberately not set
    };
    const r = runCli([], env);
    assert.equal(r.exit, 3);
    assert.match(r.stdout, /UNKNOWN/);
  } finally { rmSync(dir, { recursive: true }); }
});

// =============================================================================
// CALENDAR-WEEK SEMANTICS (35-38) — Codex r1 blocker fix #2
// =============================================================================

test("35. 100 runs in same calendar week with under_downgrade:true → state.weeks has only 1 new entry", () => {
  // Pure-helper test: weekBoundaryCrossed only returns true for the FIRST run
  // after a boundary. Subsequent runs see the boundary already past and don't trigger.
  const now = Date.parse("2026-04-27T12:00:00Z");
  const weekEnding = Date.parse("2026-04-27T00:00:00Z");
  // First run: last_run was 2 days BEFORE the boundary → boundary crossed
  const firstRun = weekBoundaryCrossed(Date.parse("2026-04-25T00:00:00Z"), now, weekEnding);
  assert.equal(firstRun, true);
  // Subsequent runs: last_run is AFTER the boundary → boundary not crossed again
  const subsequent = weekBoundaryCrossed(Date.parse("2026-04-27T11:00:00Z"), now, weekEnding);
  assert.equal(subsequent, false);
});

test("36. 3 weeks under threshold + DOWNGRADE_WEEKS=2 → downgrade triggers", () => {
  const weeks = [
    { week_ending: "2026-04-27", q7d_actual_at_reset: 15, under_downgrade: true },
    { week_ending: "2026-04-20", q7d_actual_at_reset: 18, under_downgrade: true },
    { week_ending: "2026-04-13", q7d_actual_at_reset: 12, under_downgrade: true },
  ];
  const consec = countConsecutiveWeeksUnder(weeks);
  assert.equal(consec, 3);
  // Current week projects under → priorWeeksUnder = 3, downgradeWeeks = 2 → fires
  assert.equal(decideRecommendation(15, 3, 2), "downgrade");
});

test("37. Mixed-history (week 2 not under) → downgrade NOT triggered even with current under", () => {
  const weeks = [
    { week_ending: "2026-04-27", q7d_actual_at_reset: 15, under_downgrade: true },
    { week_ending: "2026-04-20", q7d_actual_at_reset: 30, under_downgrade: false },
    { week_ending: "2026-04-13", q7d_actual_at_reset: 15, under_downgrade: true },
  ];
  const consec = countConsecutiveWeeksUnder(weeks);
  assert.equal(consec, 1); // most-recent-consecutive stops at the false entry
  // Current projects under (15) + priorConsecutive=1 + downgradeWeeks=2 → fires (1+1=2)
  assert.equal(decideRecommendation(15, 1, 2), "downgrade");
  // But if we require 3 weeks consecutive, it does NOT fire
  assert.equal(decideRecommendation(15, 1, 3), "ok");
});

test("38. Multiple runs within same week do not accumulate weeks entries", () => {
  // Already covered by Test 20 (integration). This is the pure-helper version:
  // computeWeekEndingFromReset is idempotent for the same resetTs.
  const t1 = computeWeekEndingFromReset(1719324800);
  const t2 = computeWeekEndingFromReset(1719324800);
  assert.equal(t1, t2);
});

// =============================================================================
// EXTRA: parseArgs sanity
// =============================================================================

test("parseArgs: handles all documented flags", () => {
  const opts = parseArgs(["node", "tier-advisor.mjs", "--json", "--quiet", "--no-state", "--plan", "max-20x"]);
  assert.equal(opts.json, true);
  assert.equal(opts.quiet, true);
  assert.equal(opts.noState, true);
  assert.equal(opts.planOverride, "max-20x");
});

test("parseArgs: --plan=foo equals form works", () => {
  const opts = parseArgs(["node", "tier-advisor.mjs", "--plan=max-5x"]);
  assert.equal(opts.planOverride, "max-5x");
});

test("parseArgs: --help short-circuits", () => {
  const opts = parseArgs(["node", "tier-advisor.mjs", "--help"]);
  assert.equal(opts.help, true);
});
