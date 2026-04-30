# Review: Tier upgrade/downgrade recommendation directive second rereview

Date: 2026-04-30
Reviewed: docs/directives/proxy-tier-advisor.md @ 65fafe3
Label applied: reviewed-by-codex-agent, plan-approved

## What Is Correct

- The JSON output schema now uses derived calendar-week field names on both sides of the recommendation logic: `consecutive_weeks_under_downgrade_threshold` and `consecutive_weeks_over_upgrade_threshold`. That makes the contract consistent with `state.weeks` being the source of truth rather than a mutable per-run counter ([proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:213), [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:214)).
- Tests 18-22 now describe calendar-week semantics rather than run-counter semantics. They specify boundary-triggered appends, no duplicate entries within a week, no persistence for the in-progress week, derived consecutive-count behavior from the recorded week entries, and bounded retention ([proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:315), [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:320)).
- Test 31 is now aligned with the unified exit-code contract: missing both data inputs is a hard error with exit code `4`, and the text explicitly preserves exit code `3` for `tier:unknown` only ([proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:325), [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:336)).
- The stale references called out in the prior rereview are removed. `weeks_under_downgrade_threshold` remains only in the historical-context paragraph that explains the earlier blocker, and the remaining exit-code-3 references are the legitimate `tier:unknown` cases in the plan-detection and exit-code sections ([proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:127), [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:172), [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:231), [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:236)).

## Blockers

None.

## What Needs Attention

- None for directive-stage approval. Implementation should preserve the documented distinction between persisted weekly state and derived JSON output fields exactly as written.

## Recommendations

- Proceed to implementation against the current directive without reopening the state-counter or exit-code contracts.

## Bottom Line

Approve for directive stage. Both gates met when AI Team Lead applies approved-by-lead. Ready for implementation phase.
