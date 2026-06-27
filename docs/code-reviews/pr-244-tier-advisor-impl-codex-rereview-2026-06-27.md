# Review: PR #244 tier-advisor implementation

Date: 2026-06-27
Reviewed: PR #244 (`feature/tier-advisor-impl`) at `21a1d48e91bed2eaf55e2527fc76bcb738399587`
Round: 2
Label applied: changes-requested

## What Is Correct

The round 1 fallback blocker is fixed for the high-burn cases that failed previously. In the stale `account.json` path, the advisor now exits `1`, reports `burn_rate_source: "log"`, sets `current_q7d_pct` from the weighted log sum (`98.0392156862745` in my reproduction), projects above the upgrade threshold, and recommends `upgrade`. In the missing `account.json` path, the same high-burn fixture also exits `1`, reports `burn_rate_source: "log"`, sets `current_q7d_pct` from the log, and recommends `upgrade`.

Actual round 1 reproduction rerun against this HEAD:

```text
stale account.json + high usage.jsonl:
exit=1
current_q7d_pct=98.0392156862745
burn_rate_source=log
projected_q7d_at_reset=114.37901568682078
recommendation=upgrade

missing account.json + high usage.jsonl:
exit=1
current_q7d_pct=98.0392156862745
burn_rate_source=log
projected_q7d_at_reset=99.51359014876492
recommendation=upgrade
```

The single-source state persistence path is also fixed for fallback runs that cross a week boundary. A stale-header/log-fallback run wrote a completed `weeks[]` entry with `q7d_actual_at_reset: 98.0392156862745`, `under_downgrade: false`, and `tier_assumed: "max-5x"` rather than carrying the stale header's `5%` value into state (`tools/tier-advisor.mjs:519-528`).

The round 1 attention items are addressed coherently. `parseArgs` no longer has `opts.week` or `--week` parsing (`tools/tier-advisor.mjs:57-74`), the help text only lists shipped flags (`tools/tier-advisor.mjs:661-666`), and the docs now say historical-week analysis is deferred (`docs/tier-advisor.md:49-59`). The `recentQ5hBudgetTokens()` stub is now documented honestly in code and docs (`tools/tier-advisor.mjs:310-318`, `docs/tier-advisor.md:140-147`). The stray FIRST-keeper phrase is gone from `docs/monitoring.md:23-27`.

Targeted edge cases requested in this round:

```text
fallback state persistence after boundary:
exit=1
state.last_recommendation=tier:upgrade
state.weeks[0].q7d_actual_at_reset=98.0392156862745

missing account.json + zero-entry usage.jsonl:
exit=0
current_q7d_pct=0
burn_rate_source=log
recommendation=ok
state.last_recommendation=tier:ok

missing account.json + high usage.jsonl + CACHE_FIX_ADVISOR_PLAN=pro:
exit=3
recommendation=unknown
state_exists=no
```

Verification passed:

```text
npm test
tests 1392
pass 1392
fail 0
```

## Blockers

1. `tier:unknown` / `pro` recommendations return before state persistence, so the documented statusline integration cannot display them.

   `tools/tier-advisor.mjs:462-465` and `tools/tier-advisor.mjs:484-485` call `emitUnknown()` before the state load/persist block at `tools/tier-advisor.mjs:494-579`. That means an advisor run that exits `3` never writes `last_recommendation: "tier:unknown"`. The statusline only reads persisted state (`tools/quota-statusline.sh:238-250`), and the docs promise that it appends `tier:upgrade` / `tier:downgrade` / `tier:unknown` from `~/.claude/tier-advisor-state.json` after the advisor runs (`docs/tier-advisor.md:74-78`).

   I reproduced this with missing `account.json`, high `usage.jsonl`, and `CACHE_FIX_ADVISOR_PLAN=pro`: the CLI correctly returned exit `3` with JSON `recommendation: "unknown"`, but no state file was written. The same early-return behavior also applies to `planRes.plan === "unknown"`, and the current test only checks stdout/exit for that case (`test/tier-advisor.test.mjs:569-582`), not state persistence.

   Fix options: either persist `last_run` and `last_recommendation: "tier:unknown"` for exit-3 runs when `--no-state` is not set, or explicitly remove `tier:unknown` from the statusline/docs contract. Given the existing statusline allowlist includes `tier:unknown`, persisting the state is the smaller behavioral fix.

## What Needs Attention

None beyond the blocker above.

## Bloat / Non-Functional

None. The fallback fix stays local to the advisor math/state path, and the new regression coverage is targeted.

## Recommendations

Add regression coverage for both unknown exits: no plan override plus available inputs, and `CACHE_FIX_ADVISOR_PLAN=pro`. The assertions should cover exit `3`, JSON `recommendation: "unknown"`, and the persisted state behavior chosen by the contract. If the intended behavior is to suppress statusline `tier:unknown`, update `tools/quota-statusline.sh` and `docs/tier-advisor.md` together so the CLI and prompt contracts do not diverge.

## Bottom Line

REQUEST_CHANGES. The original fallback math bug is fixed and the requested tests pass, but the newly checked fallback/pro/unknown path exposes a state-persistence gap: `tier:unknown` is documented and wired into the statusline reader, yet exit-3 runs never write the state needed for the statusline to show it.

— Codex review
