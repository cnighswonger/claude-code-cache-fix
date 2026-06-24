# Review: Tier advisor directive round 4

Date: 2026-06-24
Reviewed: `docs/directives/proxy-tier-advisor.md` at `85b54d2`
Round: 4
Label applied: `reviewed-by-codex-agent`, `approved-by-codex-agent`

## What Is Correct

- The new unified-header note correctly adopts Proxy Builder's 2026-06-24 recommendation: always-present unified headers enrich the rev-3 projection path, while conditional headers are observed when present and are not required for a recommendation. This resolves the 2026-06-05 refresh's faulty replacement posture.
- The always-present vs conditional split is consistent with the empirical record in the PR thread and the current repo surface. `anthropic-ratelimit-unified-7d-utilization` and `anthropic-ratelimit-unified-7d-reset` remain projection inputs, while `anthropic-ratelimit-unified-7d-surpassed-threshold` and `anthropic-ratelimit-unified-upgrade-paths` are conditional enrichment signals already represented by the `overage-warning` path (`proxy/extensions/overage-warning.mjs:82`, `proxy/extensions/overage-warning.mjs:84`).
- The directive no longer treats `anthropic-ratelimit-unified-5h-surpassed-threshold` as a weekly tier-decision trigger. That matches the round-3 refresh finding: 5h is a short-horizon pressure signal, not a replacement for the Q7d weekly projection.
- The load-bearing classification is now correct under the review rubric: the advisor consumes a shared quota snapshot abstraction, writes persisted `tier-advisor-state.json`, and changes visible statusline behavior. The implementation PR procedure now explicitly requires Lead approval, Codex approval, and Chris human review before merge.
- The two new reviewer checklist items are testable. One checks process follow-through for load-bearing review, and the other checks implementation behavior: additive unified-header enrichment, graceful projection-only fallback when enrichment is absent, and preservation of the rev-3 projection foundation.
- Rev-3's approved core contracts are untouched in this delta: the single burn-rate rule, calendar-week state semantics, and single exit-code contract still read as they did at the round-3 approval.

## Blockers

None.

## What Needs Attention

- Non-blocking implementation note: the PR discussion and new text use the newer `~/.claude/quota-status/account.json` wording, while older surrounding directive text and current checked-in files still contain `~/.claude/quota-status.json` references. I am not reopening that as a round-4 documentary blocker because the 2026-06-24 PR thread explicitly establishes the `account.json` evidence base. The implementation PR should still pin the actual supported quota snapshot path/schema in code and docs so users do not get two conflicting file contracts.

## Bloat / Non-Functional

None. The refresh is documentary and adds two narrow sections plus two checklist items; it does not expand implementation scope.

## Recommendations

- Proceed to implementation against rev-3 plus the additive unified-header enrichment note.
- In the implementation PR, include explicit tests or fixtures for missing conditional headers so the advisor demonstrably falls back to projection-only instead of depending on `upgrade-paths` or `surpassed-threshold`.
- Keep the 5h threshold out of tier-decision logic unless a later empirical overage-window study proves it adds weekly-tier signal.

## Bottom Line

Approve round 4. The 2026-06-24 directive refresh faithfully codifies the enrichment-not-replacement posture, corrects the load-bearing classification, and does not regress the rev-3 contracts previously approved at directive stage. Implementation may proceed, with Chris human review required on the implementation PR.
