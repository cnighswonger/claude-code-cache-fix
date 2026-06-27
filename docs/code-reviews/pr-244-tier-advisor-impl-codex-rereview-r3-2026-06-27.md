# Review: PR #244 tier-advisor implementation

Date: 2026-06-27
Reviewed: PR #244 (`feature/tier-advisor-impl`) at `c85a3f4ac60dc97869b0d9282478940790df4627`
Round: 3
Label applied: approved-by-codex-agent

## What Is Correct

The round 2 blocker is fixed. Both exit-3 paths now call `emitUnknown(opts, writeOutput, planRes, statePath)`, so the state writer can update `last_run` and `last_recommendation: "tier:unknown"` before returning (`tools/tier-advisor.mjs:462-485`, `tools/tier-advisor.mjs:637-676`).

I reran the prior reproductions against `c85a3f4`:

```text
heuristic unknown path:
exit=3
recommendation=unknown
state.last_recommendation=tier:unknown
loadAdvisorState(...).last_recommendation=tier:unknown

pro plan via log fallback:
exit=3
recommendation=unknown
state.last_recommendation=tier:unknown
loadAdvisorState(...).last_recommendation=tier:unknown

--no-state unknown path:
exit=3
recommendation=unknown
state_exists=false
```

The new regression tests cover the important contract points: heuristic unknown persists, pro-plan log fallback persists, and `--no-state` still avoids state writes (`test/tier-advisor.test.mjs:592-645`). The state loader accepts `tier:unknown` cleanly because `loadAdvisorState()` preserves `last_recommendation` as a string and does not restrict it to upgrade/downgrade/ok (`tools/tier-advisor.mjs:199-209`). The statusline allowlist already includes `tier:unknown` (`tools/quota-statusline.sh:238-250`).

Full verification passed:

```text
npm test
tests 1395
pass 1395
fail 0
```

## Blockers

None.

## What Needs Attention

The malformed-state edge is intentionally tolerant on the unknown path. I verified that if `CACHE_FIX_ADVISOR_STATE` points at malformed JSON and the advisor otherwise resolves to `tier:unknown`, the CLI exits `3`, prints the unknown recommendation, and leaves the malformed file untouched:

```text
malformed state + unknown path:
exit=3
recommendation=unknown
state_still_malformed=true
```

That differs from normal recommendation paths, where malformed state still returns the hard-error exit `4` (`tools/tier-advisor.mjs:494-504`). I am not treating this as a blocker because this PR's stated round 3 behavior deliberately keeps unknown-path persistence failures non-fatal, and this case is not worse than the previous exit-3 behavior that did not read or write state at all. The next run with a known plan still hits the normal hard-error path and forces the malformed state file to be repaired.

## Bloat / Non-Functional

None. The fix is scoped to the existing `emitUnknown()` helper and the regression tests are targeted.

## Recommendations

No required changes before merge. If the team wants the docs to be exact about this edge, add a note that malformed state is exit `4` for normal analysis paths, while the plan-undetectable exit `3` path reports the plan problem first and treats state persistence as best-effort.

## Bottom Line

APPROVE. The round 2 state-persistence blocker is resolved, `tier:unknown` survives reload through the state schema, the `--no-state` guard is preserved, and the full test suite passes with 1395 tests.

— Codex review
