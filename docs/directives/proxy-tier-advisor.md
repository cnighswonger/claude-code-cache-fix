# Directive: tier upgrade/downgrade recommendation (`tier-advisor`)

**Issue:** #63
**Branch:** `directive/tier-advisor`
**Stage:** directive
**Milestone:** v3.4.0 (P2)

## Goal

Project the user's 7-day quota (Q7d) burn rate forward to the weekly reset and surface a tier-change recommendation when the trajectory crosses a meaningful threshold:

- **Upgrade (5x → 20x)** when projected Q7d at reset > 80% — the $100/mo step buys a measured 4.4× headroom and avoids overage pricing ($0.01+/call).
- **Downgrade (20x → 5x)** when projected Q7d at reset < 20% across 2+ consecutive weeks — the headroom is unused; downgrading saves $100/mo.

Recommendation surfaces in two places initially: a CLI tool (`tools/tier-advisor.mjs`) for ad-hoc analysis, and a one-line addition to `quota-statusline.sh` so it's visible in the user's status bar without running any command.

## Why

The proxy already emits Q5h and Q7d utilization with reset timestamps to `quota-status.json` (via the `cache-telemetry` extension). The community has the data to make tier decisions but no tooling that does the math; users either over-provision (paying for capacity they never touch) or under-provision (hitting overage and getting silently throttled).

Empirical baseline from our 5x vs 20x analysis (2,197 requests):

| Plan | Q5h budget per 1% | Q5h budget per 100% |
|------|-------------------|---------------------|
| 5x | ~2.04M tokens | ~204M tokens |
| 20x | ~8.92M tokens | ~892M tokens |
| Multiplier | **4.4×** measured (vs 4× advertised) |

That's the basis for the upgrade/downgrade thresholds. The recommendation isn't a sales pitch; it's the calculated answer to "given how I actually use Claude Code, am I on the right tier?"

## Source of truth

This directive operationalizes issue #63 (originally drafted by AI Team Lead 2026-04). The issue body has the projection formula and threshold logic; this directive resolves the implementation-shape question (status bar vs proxy extension vs CLI tool — answer: CLI tool + statusline integration), pins the data sources, and adds noise-rejection logic so the recommendation doesn't oscillate week-to-week.

Key references:
- Issue #63 — projection formula, tier comparison numbers.
- `proxy/extensions/cache-telemetry.mjs` — writes `quota-status.json` (fields the advisor reads).
- `tools/quota-analysis.mjs` — existing usage.jsonl analyzer; reuse its log-reading helpers.
- `tools/quota-statusline.sh` — existing statusline integration point.
- Memory `feedback_warmer_cron_on_max.md` — the cost-of-cold-starts framing that informs upgrade ROI.

## Scope (v3.4.0)

In scope:

1. New CLI tool `tools/tier-advisor.mjs` — analyzes `usage.jsonl` history + current `quota-status.json` and prints a recommendation to stdout. Exits 0 always (advisory; non-blocking).
2. New env vars (advisor-only; no proxy behavior change):
   - `CACHE_FIX_ADVISOR_USAGE_LOG=<path>` (default `~/.claude/usage.jsonl`)
   - `CACHE_FIX_ADVISOR_QUOTA_STATUS=<path>` (default `~/.claude/quota-status.json`)
   - `CACHE_FIX_ADVISOR_UPGRADE_THRESHOLD=<pct>` (default 80)
   - `CACHE_FIX_ADVISOR_DOWNGRADE_THRESHOLD=<pct>` (default 20)
   - `CACHE_FIX_ADVISOR_DOWNGRADE_WEEKS=<n>` (default 2 — consecutive weeks under threshold required for downgrade)
3. Statusline integration — extend `tools/quota-statusline.sh` to read the advisor's last recommendation (cached in `~/.claude/tier-advisor-state.json`) and append a single token to the statusline output (e.g., `tier:upgrade`, `tier:downgrade`, or absent if no recommendation).
4. JSON output mode (`--json`) for machine consumption (other tools, dashboards).
5. Quiet mode (`--quiet`) — exit code only, no stdout.
6. Documentation: README env-var table, monitoring.md entry, brief tier-advisor section in docs/.

Out of scope (deferred):

- **Proxy extension that emits warnings on every request.** Considered and rejected. Tier decisions are a once-per-week question; per-request emission is noise. The CLI tool + cached statusline integration covers the use case at zero per-request overhead.
- **Auto-execution** (actually upgrading/downgrading via Anthropic's API). Not exposed publicly; requires browser-based account settings flow. Recommendation only.
- **Per-org tier recommendation** (different team members on different tiers). Single-account scope in v1.
- **Integration with llm-relay's plugin system** (issue #63 mentions this). Separate dependency; defer until that system lands.
- **Cost-of-overage projection.** A future companion to the upgrade case ("upgrade to avoid $X in overage charges"). Out of scope until we have overage pricing data.
- **Plan tiers other than 5x and 20x.** Pro / Max 1x not addressed; can extend with more tier rows in the comparison table when there's user demand.

## Activation

The advisor is a CLI tool, not a runtime extension. No `extensions.json` entry. No proxy behavior change.

The statusline integration is opt-in via the user's existing statusline configuration — they choose whether to wire `quota-statusline.sh` into their shell prompt or terminal. We don't auto-install anything.

The tool itself runs whenever the user invokes it. If they want it on a cron, that's a user-side decision — we document the pattern but don't ship a cron.

## Recommendation logic

### Inputs

The tool reads:
- `quota-status.json` — current Q5h/Q7d utilization, reset timestamps, current plan if available.
- `usage.jsonl` — historical per-call data going back as far as the log retains.
- `~/.claude/tier-advisor-state.json` — prior advisor runs (created on first run).

### Burn rate calculation

Compute current week's burn rate from the lower of:
- (a) Q7d %  ÷ hours since weekly reset, OR
- (b) sum of usage.jsonl tokens this week ÷ hours since reset, normalized to %.

Use (a) when available (it's the source of truth from Anthropic's headers); fall back to (b) when `quota-status.json` is missing or stale (>24h old).

### Projection

```
hours_until_reset = (reset_timestamp - now) / 3600
projected_Q7d = current_Q7d_pct + (burn_rate_per_hour × hours_until_reset)
```

Cap projection at 200% — beyond that, the user is in overage anyway and the recommendation is unambiguously "upgrade now."

### Decision matrix

| Projected Q7d at reset | Recommendation |
|------------------------|----------------|
| ≥ 80% | **Upgrade** (`tier:upgrade`) |
| 20% – 80% | No recommendation (`tier:ok`) |
| < 20% AND prior 1 week also < 20% (2+ consecutive) | **Downgrade** (`tier:downgrade`) |
| < 20% but prior week ≥ 20% | No recommendation yet (`tier:ok`) — single-week dip |

### Noise rejection

Single-week dips don't trigger downgrade — that's the 2-consecutive-week requirement. Single-week spikes DO trigger upgrade (going over capacity once is enough to recommend; the cost asymmetry favors avoiding overage). Configurable via `CACHE_FIX_ADVISOR_DOWNGRADE_WEEKS`.

### State persistence

Maintain `~/.claude/tier-advisor-state.json` across runs:

```json
{
  "last_run": "2026-04-30T18:00:00Z",
  "last_recommendation": "tier:upgrade",
  "weeks_under_downgrade_threshold": 0,
  "weeks_over_upgrade_threshold": 1,
  "history": [
    { "week_ending": "2026-04-27T00:00:00Z", "q7d_actual": 22, "tier_assumed": "max-5x" },
    { "week_ending": "2026-04-20T00:00:00Z", "q7d_actual": 18, "tier_assumed": "max-5x" }
  ]
}
```

The `history` array is bounded to the last 8 weeks (rolling). The `weeks_under_downgrade_threshold` counter is what enforces the 2-consecutive-week requirement.

### Plan detection

Knowing the user's current plan is essential to making the recommendation correct (you can't recommend "upgrade to 20x" if they're already on 20x).

Detection order:
1. **Explicit override**: `CACHE_FIX_ADVISOR_PLAN=max-5x|max-20x|pro` set → use that.
2. **From quota-status.json**: if Anthropic's headers expose plan info, parse it. (Currently they don't expose tier directly; this is forward-looking.)
3. **Heuristic from Q5h budget**: if recent windows show Q5h budget consistent with 5x (~204M tokens/100%), assume 5x; if consistent with 20x (~892M/100%), assume 20x. Documented as imprecise but workable.
4. **Fallback**: if undetectable, output `tier:unknown` and recommend the user set `CACHE_FIX_ADVISOR_PLAN`.

## Output formats

### Default (human-readable)

```
$ tools/tier-advisor.mjs

Tier Advisor — 2026-04-30 18:00 UTC

Current plan: Max 5x (detected from Q5h budget)
This week:    Q7d 67% with 28 hours until reset
Burn rate:    +1.4%/hour (last 24h average)
Projected:    Q7d ~106% at reset

Recommendation: UPGRADE to Max 20x

Why: at current burn, you'll cross 100% Q7d before the weekly reset and
land in overage pricing ($0.01+/call). The 5x → 20x step costs $100/mo
and buys 4.4× headroom (measured across 2,197 requests).

State saved to ~/.claude/tier-advisor-state.json
```

### --json mode

```json
{
  "ts": "2026-04-30T18:00:00Z",
  "current_plan": "max-5x",
  "current_plan_source": "heuristic",
  "current_q7d_pct": 67,
  "hours_since_reset": 140,
  "hours_until_reset": 28,
  "burn_rate_per_hour": 1.4,
  "burn_rate_window_hours": 24,
  "projected_q7d_at_reset": 106,
  "recommendation": "upgrade",
  "recommendation_target_plan": "max-20x",
  "weeks_under_downgrade_threshold": 0,
  "weeks_over_upgrade_threshold": 1
}
```

### --quiet mode

No stdout. Exit code:
- 0 = no recommendation
- 1 = recommend upgrade
- 2 = recommend downgrade
- 3 = error (can't read inputs, plan undetectable, etc.)

### Statusline integration

`quota-statusline.sh` reads `~/.claude/tier-advisor-state.json` and appends to its existing output:

```
Q5h:23% Q7d:67% tier:upgrade
```

The `tier:` token is omitted when `last_recommendation` is `tier:ok`. The statusline reads the cached recommendation; it does NOT invoke the advisor on every prompt render (would be expensive). User sets up cron / shell alias to refresh the cache as often as they want; default suggestion is once per hour.

## Implementation

### File map

| File | Change |
|------|--------|
| `tools/tier-advisor.mjs` | NEW — main CLI tool, ESM, no top-level deps beyond Node built-ins |
| `tools/quota-statusline.sh` | EXTEND — append `tier:` token from `tier-advisor-state.json` if present |
| `test/tier-advisor.test.mjs` | NEW — unit tests on burn rate calculation, projection, decision matrix, state persistence |
| `README.md` | EXTEND — env-var table addition; brief "Tier Advisor" section |
| `docs/monitoring.md` | EXTEND — env-var table rows |
| `docs/tier-advisor.md` | NEW — full reference + example workflows (cron setup, etc.) |

### Pure functions exposed for tests

```js
export {
  computeBurnRate,                  // (q7dPct, hoursSinceReset) → pctPerHour
  computeBurnRateFromUsageLog,      // (jsonlEntries, weekStart, hoursSinceReset, planTokens) → pctPerHour
  projectQ7dAtReset,                // (currentPct, burnRate, hoursUntilReset) → pct (capped 200)
  detectPlan,                       // (env, quotaStatus, recentBudgets) → "max-5x"|"max-20x"|"pro"|"unknown"
  decideRecommendation,             // (projectedPct, prevWeeksUnder, weeksUnderRequired) → "upgrade"|"downgrade"|"ok"
  loadAdvisorState,                 // (path) → state object | initial state
  persistAdvisorState,              // (path, state) → void
  formatHumanOutput,                // (analysis) → string
  formatJsonOutput,                 // (analysis) → object
};
```

### CLI args

| Flag | Effect |
|------|--------|
| `--json` | machine-readable output |
| `--quiet` | no stdout; exit code only |
| `--no-state` | don't read or write state file (one-shot analysis) |
| `--week N` | analyze week N weeks ago instead of current (testing/debugging) |
| `--plan max-5x\|max-20x\|pro` | override plan detection |
| `--help` | usage |

## Test plan

### Burn rate
1. `computeBurnRate(50, 100)` → 0.5 (50% over 100h = 0.5%/hr).
2. `computeBurnRate(0, 0)` → 0 (defensive: no time has elapsed).
3. `computeBurnRate(50, -5)` → 0 (defensive: negative hours, treat as no signal).
4. `computeBurnRateFromUsageLog([...], weekStart, 24, 204_000_000)` over a small fixture matches the expected % derived from token sum.

### Projection
5. `projectQ7dAtReset(50, 1, 30)` → 80 (50 + 1×30).
6. `projectQ7dAtReset(50, 5, 30)` → 200 (capped, raw would be 200).
7. `projectQ7dAtReset(50, 10, 30)` → 200 (cap).
8. `projectQ7dAtReset(50, 0, 30)` → 50 (no burn, stays put).

### Plan detection
9. `detectPlan({ CACHE_FIX_ADVISOR_PLAN: "max-20x" }, ...)` → `max-20x` (override wins).
10. Plan absent in quota-status, recent windows show ~200M Q5h budget → `max-5x`.
11. Plan absent, recent windows show ~890M Q5h budget → `max-20x`.
12. Plan absent, no recent budget data → `unknown`.

### Decision matrix
13. `decideRecommendation(85, 0, 2)` → `upgrade` (over threshold).
14. `decideRecommendation(50, 0, 2)` → `ok`.
15. `decideRecommendation(15, 0, 2)` → `ok` (under threshold but only 0 prior weeks).
16. `decideRecommendation(15, 1, 2)` → `downgrade` (under threshold and 1 prior week + this = 2).
17. `decideRecommendation(15, 1, 3)` → `ok` (need 3 weeks; only have 2).

### State persistence
18. First run with no state file → creates initial state with empty history.
19. Run after upgrade-recommendation → `weeks_over_upgrade_threshold` increments.
20. Run after under-threshold week → `weeks_under_downgrade_threshold` increments.
21. Run after over-threshold-then-under-threshold sequence → `weeks_under_downgrade_threshold` resets to 0 mid-sequence.
22. History rolls to last 8 weeks; older entries dropped.

### Output formats
23. Default human-readable output includes: current plan, burn rate, projection, recommendation, "Why" paragraph.
24. `--json` output is parseable JSON with the documented schema.
25. `--quiet` produces zero stdout bytes; exit code matches `recommendation` (0=ok, 1=upgrade, 2=downgrade, 3=error).
26. Statusline integration: with `last_recommendation: "upgrade"` in state, `quota-statusline.sh` output ends with `tier:upgrade`.
27. Statusline with `last_recommendation: "ok"` → no `tier:` token in output.

### CLI args
28. `--week 1` analyzes the week ending 7 days ago, not the current week.
29. `--plan max-20x` overrides detected plan even if `CACHE_FIX_ADVISOR_PLAN` is also set (CLI flag wins).
30. `--no-state` doesn't read or write the state file; same input twice produces same output (no week-counter drift).

### Edge cases
31. quota-status.json missing → use usage.jsonl path; if both missing, error and exit 3.
32. usage.jsonl present but contains no entries this week → can't compute burn rate; output `tier:ok` and note the missing data.
33. Reset timestamp in the past (somehow) → treat as "just reset"; burn rate computes from full week.
34. Plan unknown → recommendation is `tier:ok` but human output suggests setting `CACHE_FIX_ADVISOR_PLAN`.

## Reviewer checklist

- [ ] CLI tool is at `tools/tier-advisor.mjs`. No proxy extension (matches issue #63's preferred shape).
- [ ] No `extensions.json` change. No proxy runtime change.
- [ ] Plan detection has an explicit override (`CACHE_FIX_ADVISOR_PLAN`); heuristic is fallback only.
- [ ] Projection caps at 200%. Test 7 verifies.
- [ ] Downgrade requires N consecutive weeks (default 2, configurable). Test 16 verifies.
- [ ] Upgrade is single-event. Test 13 verifies.
- [ ] State file at `~/.claude/tier-advisor-state.json` with bounded 8-week history. Test 22 verifies.
- [ ] `--json` schema matches §--json mode documentation. Test 24 verifies.
- [ ] `--quiet` exit codes match the documented mapping. Test 25 verifies.
- [ ] `quota-statusline.sh` extension is a single-token append; gracefully handles missing state file. Test 26-27 verify.
- [ ] No new top-level npm dependencies. Node built-ins only.
- [ ] CI green on Node 18 / 20 / 22.
- [ ] README + monitoring.md + docs/tier-advisor.md all reflect the actual env vars and CLI flags.
- [ ] Empirical 4.4× multiplier from the 5x/20x analysis is cited, not hand-waved.

## Out of scope (explicit, deferred)

- Per-request proxy warnings (rejected as noise; once-a-week question).
- Auto-execution of tier change (requires browser flow; not API-exposable).
- Multi-tier comparison beyond max-5x and max-20x.
- llm-relay plugin integration (separate dependency).
- Cost-of-overage projection (future companion).
- Per-org / per-team tier recommendation.

— AI Team Lead
