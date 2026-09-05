# Review: PR #359 WORKAROUND_CATALOG.md seed

Date: 2026-09-05
Reviewed: PR #359 (`WORKAROUND_CATALOG.md`) at `fe5dafc0612ede38f905717d2dd92a6d2e6d97d6`; content fix reviewed at `753796b41a4095d9a56edb3aae099870cb2a04ad`
Round: 2
Label applied: approved-by-codex-agent, reviewed-by-codex-agent

## What Is Correct

- [Measured] The commissioned content fix is docs-only: `git diff --stat origin/main...753796b41a4095d9a56edb3aae099870cb2a04ad` shows only `WORKAROUND_CATALOG.md` plus the round-1 review artifact. The current PR head adds this round-2 review artifact only. I did not run `uv run pytest -q` because no code or tests are touched.
- [Measured] CI is not fully green on the current head: `gh pr view 359 --repo cnighswonger/claude-code-cache-fix --json statusCheckRollup` reports success for `test (18)`, `test (20)`, GitGuardian, and `security/snyk (cnighswonger)`, but failure for `test (22)`. `gh run view 33971559885 --log-failed` shows the failing test is `held port (CACHE_FIX_HOLD_PORT)` / `refuses nothing when the proxy under it dies`, with `1945` passing tests and `1` failure. I attempted `gh run rerun 33971559885 --failed`, but GitHub returned `Resource not accessible by integration`.
- [Read] The CC#62272 entry no longer presents the wrong `99999` signed-int32 result or the impossible `~ -8.7e9 ms` value as authoritative. Instead, it retracts the signed-int32-overflow hypothesis and states the community-reported symptom set with the mechanism unresolved (`WORKAROUND_CATALOG.md:80-99`). That resolves the round-1 arithmetic blocker.
- [Measured] The CC#59628 status is now accurate. The catalog says closed 2026-07-08 as `not_planned` (`WORKAROUND_CATALOG.md:56`), and `gh issue view 59628 --repo anthropics/claude-code --json state,stateReason,closedAt` reports `CLOSED`, `NOT_PLANNED`, `2026-07-08T10:47:18Z`.
- [Measured] The CC#62272 status is now accurate. The catalog says closed 2026-08-19 as duplicate of #41458 (`WORKAROUND_CATALOG.md:78`), and `gh issue view 62272 --repo anthropics/claude-code --json state,stateReason,closedAt` reports `CLOSED`, `DUPLICATE`, `2026-08-19T20:52:54Z`. The referenced canonical tracker #41458 is currently open.
- [Measured] Link/status spot-checks for #59844, #59628, #63147, #62272, #41458, and #59248 all resolve through `gh issue view`. #59844, #63147, #41458, and #59248 are open, matching or not contradicting the catalog text.
- [Read] I did not find leaked origin secrets, internal hostnames, absolute client paths, API keys, or client-identifying filesystem paths in the catalog. The filesystem paths in the reviewed text are generic `~/.claude/...` and per-project `.claude/settings.json` references.

## Blockers

None.

## What Needs Attention

- [Measured] The current PR head has a failing Node 22 CI job in `held port (CACHE_FIX_HOLD_PORT)`. Because this PR changes documentation only and the failing test is outside the changed surface, I am not treating it as a PR blocker, but the merge gate should require a green rerun before merge.
- [Read] Minor non-blocking polish: the CC#62272 downgrade row labels its depth as `settings.json`, but the knob is an `npm install -g @anthropic-ai/claude-code@2.1.251` downgrade/pin command (`WORKAROUND_CATALOG.md:96`). The mitigation is understandable and this does not affect the resolved round-1 blockers, but a later cleanup could choose a more accurate depth label or add a package/version-pin surface to the legend.

## Bloat / Non-Functional

None. The PR adds one documentation file and review artifacts. It introduces no production code, tests, new exports, env vars, on-disk runtime paths, schema contract, wire contract, shared abstraction, or security-relevant runtime behavior.

## Recommendations

1. Keep the CC#62272 entry in its current mechanism-unresolved form unless the upstream thread produces binary-backed evidence for a specific cleanup mechanism.
2. Rerun the failed Node 22 CI job before merge; the bot token could not trigger the rerun.
3. Consider tightening the CC#62272 downgrade row's depth label in a follow-up so the table taxonomy stays exact.

## Bottom Line

Approve. Both round-1 blockers are resolved: the bad int32 arithmetic is gone rather than restated, and the two issue-status rows now match GitHub. I found no new blocking claim, stale link, obvious leak, or docs-only regression. The current head's Node 22 CI failure should still be rerun to green before merge.

— Codex, cross-LLM review, round 2
