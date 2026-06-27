# Tier Advisor — Max 5x / 20x upgrade-downgrade recommendation

`tools/tier-advisor.mjs` projects this week's Q7d quota burn forward to the weekly reset and recommends whether to upgrade (5x → 20x), downgrade (20x → 5x), or hold. Designed to be invoked on a cron / shell alias; emits a token to the cache-fix statusline so users see the live recommendation in their shell prompt without running anything.

Per directive [`docs/directives/proxy-tier-advisor.md`](directives/proxy-tier-advisor.md) (PR #93, issue #63). Codex r3-approved at directive stage with 2026-06-24 additive enrichment refresh.

## What it does

The advisor reads three inputs:

- **`~/.claude/quota-status/account.json`** — written by the `cache-telemetry` extension on every API call. Contains `seven_day.pct` (current Q7d utilization), `seven_day.resets_at` (next weekly reset, unix epoch seconds), and a `timestamp` (when the snapshot was last refreshed).
- **`~/.claude/usage.jsonl`** — per-API-call usage log. Used as a fallback burn-rate source when `account.json` is stale or missing.
- **`~/.claude/tier-advisor-state.json`** — the advisor's own state. Tracks `last_run`, `last_recommendation`, and a bounded 8-entry `weeks[]` array of completed-week observations.

It computes:

- **Burn rate** — `current_q7d_pct / hours_since_weekly_reset` when the `account.json` snapshot is fresh (within 24h). Otherwise, sums the weighted token count from `usage.jsonl` since the start of the week, divides by the plan's 100% budget (204M for 5x, 892M for 20x — empirical 4.4× multiplier), and normalizes per hour. **Never blends sources** — the rule is binary primary-or-fallback, recorded in the output as `burn_rate_source: "header"|"log"`.
- **Single-source `current_q7d_pct`** — when the log fallback fires, the same weighted token sum drives `current_q7d_pct` as well as `burn_rate_per_hour`. The advisor never combines a stale/missing `account.json` percent with log-derived burn (Codex r1 blocker fix).
- **Projection** — `current_q7d_pct + burn_rate × hours_until_reset`, capped at 200%.
- **Recommendation** — `upgrade` if projected ≥ upgrade threshold (default 80%). `downgrade` if projected < downgrade threshold (default 20%) AND the most recent N completed weeks (default 2) were also under threshold. Otherwise `ok`.

Upgrade is single-event (one spike is enough). Downgrade requires sustained under-utilization across multiple weeks — Codex blocker fix #2 from the directive review.

## Quick start

```bash
# One-shot human-readable analysis on the current state.
node tools/tier-advisor.mjs

# Machine-readable JSON for downstream tooling.
node tools/tier-advisor.mjs --json

# Exit-code-only mode (for cron / shell aliases).
node tools/tier-advisor.mjs --quiet; echo "advisor said $?"
```

## Exit codes (uniform across default / `--json` / `--quiet`)

| Code | Meaning |
|------|---------|
| `0` | HOLD — no recommendation; current tier is appropriate |
| `1` | UPGRADE recommended |
| `2` | DOWNGRADE recommended |
| `3` | plan undetectable — set `CACHE_FIX_ADVISOR_PLAN` and re-run |
| `4` | hard error (no inputs, malformed state file, etc.) |

Codes 1, 2, 3 are NOT errors in the shell sense — they signal the recommendation. Shell scripts that want "tool ran successfully regardless" check `$? -lt 4`. Scripts that want "no action needed" check `$? -eq 0`.

## CLI flags

| Flag | Effect |
|------|--------|
| `--json` | machine-readable output (JSON) |
| `--quiet` | no stdout/stderr; exit code only |
| `--no-state` | don't read or write the state file (one-shot analysis) |
| `--plan max-5x\|max-20x\|pro` | override plan detection (highest priority) |
| `--help` | usage |

Historical-week analysis (`--week N`) is not in v1; the advisor only inspects the in-progress week. See the follow-up issue tracked from PR #244 for the design.

## Env vars

| Variable | Default | Effect |
|---|---|---|
| `CACHE_FIX_ADVISOR_PLAN` | unset | Plan override: `max-5x` / `max-20x` / `pro`. |
| `CACHE_FIX_ADVISOR_QUOTA_STATUS` | `~/.claude/quota-status/account.json` | Path to the proxy's snapshot. |
| `CACHE_FIX_ADVISOR_USAGE_LOG` | `~/.claude/usage.jsonl` | Path to the per-call usage log. |
| `CACHE_FIX_ADVISOR_STATE` | `~/.claude/tier-advisor-state.json` | Path to the advisor's persisted state file. |
| `CACHE_FIX_ADVISOR_OVERAGE_LOG` | `~/.claude/overage-warnings.jsonl` | Path to overage events (optional enrichment). |
| `CACHE_FIX_ADVISOR_UPGRADE_THRESHOLD` | `80` | Projection % that triggers upgrade. |
| `CACHE_FIX_ADVISOR_DOWNGRADE_THRESHOLD` | `20` | Projection % that triggers downgrade (combined with `DOWNGRADE_WEEKS`). |
| `CACHE_FIX_ADVISOR_DOWNGRADE_WEEKS` | `2` | Consecutive completed weeks under threshold required before downgrading. |

## Statusline integration

`tools/quota-statusline.sh` reads `~/.claude/tier-advisor-state.json` after the advisor runs and appends a single `tier:upgrade` / `tier:downgrade` / `tier:unknown` token to the statusline output. When the recommendation is `tier:ok`, no token is appended (statusline stays uncluttered).

The statusline does NOT invoke the advisor on every prompt render — that would be expensive and pointless (tier decisions are weekly, not per-keystroke). The user sets up a cron / shell alias to refresh the advisor's state file at whatever cadence makes sense (once per hour is a reasonable default).

## Cron-based refresh

```cron
# crontab -e (user-level)
# Refresh the tier-advisor cache once per hour (top of the hour).
17 * * * * /usr/bin/env node $HOME/path/to/claude-code-cache-fix/tools/tier-advisor.mjs --quiet
```

That's it. The advisor self-manages its state file. The statusline picks up the next render after each refresh.

If you want the advisor to alert you on a status change, wrap it in a script that captures the exit code and pipes to your notification system:

```bash
#!/bin/bash
prev=$(jq -r '.last_recommendation // ""' ~/.claude/tier-advisor-state.json 2>/dev/null)
node tools/tier-advisor.mjs --quiet
curr=$(jq -r '.last_recommendation // ""' ~/.claude/tier-advisor-state.json)
if [ "$prev" != "$curr" ]; then
  notify-send "tier-advisor: $prev → $curr"
fi
```

## State file shape

```jsonc
{
  "last_run": "2026-04-30T18:00:00Z",
  "last_recommendation": "tier:upgrade",
  "weeks": [
    // index 0 is most recent; bounded to 8 entries.
    { "week_ending": "2026-04-27T00:00:00Z", "q7d_actual_at_reset": 22, "under_downgrade": true,  "tier_assumed": "max-5x" },
    { "week_ending": "2026-04-20T00:00:00Z", "q7d_actual_at_reset": 18, "under_downgrade": true,  "tier_assumed": "max-5x" },
    { "week_ending": "2026-04-13T00:00:00Z", "q7d_actual_at_reset": 67, "under_downgrade": false, "tier_assumed": "max-5x" }
  ]
}
```

A new `weeks[]` entry is appended exactly once when a calendar-week reset boundary crosses (detected by comparing `last_run` to `now` against the `7d-reset` timestamp from `account.json`). Multiple advisor runs within the same week do NOT append duplicate records — that's the Codex blocker fix #2 from the directive review: "consecutive weeks" means calendar weeks, not advisor invocations.

## JSON output schema

```json
{
  "ts": "2026-04-30T18:00:00Z",
  "current_plan": "max-5x",
  "current_plan_source": "cli" | "env" | "heuristic" | "fallback",
  "current_q7d_pct": 67,
  "hours_since_reset": 140,
  "hours_until_reset": 28,
  "burn_rate_per_hour": 1.4,
  "burn_rate_source": "header" | "log",
  "burn_rate_window_hours": 24,
  "projected_q7d_at_reset": 106,
  "recommendation": "upgrade" | "downgrade" | "ok" | "unknown",
  "recommendation_target_plan": "max-20x" | "max-5x" | null,
  "consecutive_weeks_under_downgrade_threshold": 0,
  "consecutive_weeks_over_upgrade_threshold": 1
}
```

## Plan detection

In order of priority:

1. **`--plan` CLI flag** (highest priority).
2. **`CACHE_FIX_ADVISOR_PLAN` env var**.
3. **Heuristic from recent Q5h budgets** — **not implemented in v1**. The hook in the code (`recentQ5hBudgetTokens()`) returns `null`, so detection skips straight to the fallback. The CLI override + env-var path is the supported way to pin a plan; sharpening the heuristic is a follow-up.
4. **Fallback `tier:unknown`** with exit code `3` — the recommendation tells you to set `CACHE_FIX_ADVISOR_PLAN`.

## Optional enrichment

When `~/.claude/overage-warnings.jsonl` exists (written by the `overage-warning` extension when the account crosses Anthropic's `surpassed-threshold` markers), the advisor reads it for historical context and includes a one-line "Enrichment:" note in the recommendation rationale. The enrichment file is **optional**; the advisor degrades gracefully to projection-only when it's absent. This was the additive-not-replacement posture codified in the 2026-06-24 directive refresh (Codex r4-approved).

## When the recommendation is wrong

- **Recommendation contradicts your gut:** check `current_plan_source` in the JSON output. If it's `fallback` or `heuristic`, set `CACHE_FIX_ADVISOR_PLAN` explicitly and re-run.
- **Same recommendation every hour but no change:** that's correct — the state is sticky across same-week runs. Wait for the calendar-week boundary to cross.
- **Recommendation is `tier:unknown`:** set `CACHE_FIX_ADVISOR_PLAN=max-5x` (or `max-20x`) and re-run.
- **Hard error exit 4:** the proxy isn't writing `account.json` (proxy down? cache-telemetry extension disabled?). Verify with `ls ~/.claude/quota-status/account.json`.

## Out of scope (deferred)

- Auto-execution of tier change (requires browser flow; not API-exposable).
- Multi-tier comparison beyond max-5x and max-20x.
- Cost-of-overage projection (future companion).
- Per-org / per-team tier recommendation.

See the [directive](directives/proxy-tier-advisor.md) for the full design rationale and the 45-test reviewer checklist.
