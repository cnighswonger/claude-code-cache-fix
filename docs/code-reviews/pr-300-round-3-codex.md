Codex review:

# Review: PR #300

Date: 2026-08-04
Reviewed: `AGENTS.md` at `0e8ac7e9840a1da9fadd364cba1908276d4a987f`
Round: 3
Label applied: changes-requested

## What Is Correct
- Measured: the two numeric repairs called out in the dispatch are materially better than the prior wording and mostly survive direct verification. `AGENTS.md:171-178` now names `node v24.11.1` instead of the unartifacted "thirteen runs," `package.json:25-27` declares `engines: >=18`, and `.github/workflows/test.yml:12-15` confirms the CI matrix is `18/20/22`.
- Read: the corrected node-20 mechanism is now aligned with the merged test file rather than with the earlier stale diagnosis. `test/proxy-forward-ca.test.mjs:105-109` documents that `tls.getCACertificates` arrives in `v22.15`, and the current suite gates positive-control rows on that capability instead of assuming lower runtimes can establish the same premise.
- Measured: the formal-review count in `AGENTS.md:264-265` is right as far as it goes. `gh api repos/cnighswonger/claude-code-cache-fix/pulls/283/reviews --paginate` returns `3` reviews, and the same call for `pulls/296/reviews` returns `7`, for `10` total formal reviews across the two PRs.
- Measured: PR #300 itself is green and thread-clean on this head. `gh pr checks 300 --repo cnighswonger/claude-code-cache-fix` reports `test (18)`, `test (20)`, `test (22)`, GitGuardian, and Snyk all passing at `0e8ac7e`, and `gh api graphql ... reviewThreads ...` returned no open review threads.
- Read: the document is not mush. After three tightening rounds, the added sections still read as rules with concrete examples rather than as qualification piled on qualification; I did not find a section that has become unreadable through over-hedging.

## Blockers
- Measured + Read: `AGENTS.md:264-266` still overclaims the very review history it cites. The sentence says the `10 formal reviews across #283 and #296` were "by three parties, each round finding shapes the last missed." The same `gh api .../pulls/<N>/reviews` artifacts named in the sentence show only **two** formal reviewers across those reviews: `vsits-codex-review-agent[bot]` and `cnighswonger`. They also show that not every round "found shapes the last missed": three of the ten reviews are empty-bodied approvals, and the clean approval rounds on `#283` and `#296` are explicitly reporting no blockers. The `10` and `(3 + 7)` counts are now correct; the rest of the sentence is not. In a rule about countable claims, that remains merge-blocking.

## What Needs Attention
- Read: I did not find another section that should be removed entirely. The CI rule, runtime rule, oracle rule, README-history rule, and expectation-source rule are all directionally sound for this repo. My remaining concern is accuracy of the review-history example, not that the guidance itself is bad.

## Bloat / Non-Functional
- Measured: none in this round. Since `db9477f`, the production delta is a wording-only correction inside one document, and the added review artifact files are required by repo policy rather than by product surface.

## Recommendations
- Measured + Read: tighten `AGENTS.md:264-266` to the claims the cited artifacts actually support. For example: keep `10 formal reviews across #283 and #296 (3 + 7)` and drop or restate the rest as something observable, such as "across two formal reviewers, with multiple later rounds still uncovering new defects."
- Read: keep the narrower corrected mechanism in `AGENTS.md:173-178`. That paragraph is stronger now because it points at runtime capability and CI coverage rather than at a private run count or an abandoned root-cause guess.

## Bottom Line
Revise once more. The round-3 self-audit did fix two real problems: the review-count sentence is now partially countable, and the node-20 paragraph now points at the right class of mechanism. But one sentence still turns a correct numeric count into two unsupported claims about who reviewed and what every round did. Because this PR is codifying how to write review evidence, it should not merge with that overclaim still in place. — Codex review
