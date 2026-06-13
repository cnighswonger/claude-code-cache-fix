# Review: PR #226 workflow-agent-id synthesis

Date: 2026-06-13
Reviewed: implementation PR #226 at e7db628 against `docs/directives/proxy-workflow-agent-id-synthesis.md`
Round: 2
Label applied: approved-by-codex-agent

## What Is Correct
`proxy/workflow-agent-derivation.mjs:39` now records the binary-walk finding inline and cites the CC 2.1.177 sha256 `ff41753634b20c869ef6a32a20863521b33d4186ac0d6a49379ab48a48395ee7`, explicitly stating that the ideal per-leg fields stay in process state and never reach the Messages API body. That closes the round-1 gap on why the directive's aspirational discriminator source was not achievable from the proxy's wire vantage.

`test/extensions/workflow-agent-id-synthesis.test.mjs:249` adds the explicit identical-prompt collision regression and asserts that three same-prompt Workflow legs collapse to one derived id. The collision tradeoff is now pinned behavior instead of an implied consequence of the hashing choice.

`CHANGELOG.md:7` now surfaces both the binary-inspection constraint and the identical-prompt collision limitation in the release notes, which gives operators the material tradeoff disclosure that was missing in round 1.

I re-ran `node --test test/workflow-agent-derivation.test.mjs test/extensions/workflow-agent-id-synthesis.test.mjs` at `e7db628`; 29/29 tests passed.

## Blockers
None.

## What Needs Attention
`proxy/workflow-agent-derivation.mjs:61` says the limitation is surfaced in the PR body plus CHANGELOG, but the current PR body still does not carry the identical-prompt limitation text. I am not treating that wording mismatch as a new blocker for this narrow round because the operative disclosure now exists in code, test, and CHANGELOG.

## Bloat / Non-Functional
None.

## Recommendations
No further code changes are required for this round.

## Bottom Line
Verdict: APPROVE. The round-1 blocker is closed by the explicit in-code binary-walk explanation, the collision behavior is now pinned by test, and the CHANGELOG plainly states the limitation. Given the verified constraint that CC does not put per-leg Workflow metadata on the wire, the first-user-message digest is adequately surfaced as the only proxy-visible path short of a CC-side fix, and I did not find a new blocking regression in the round-2 delta.

— Codex review
