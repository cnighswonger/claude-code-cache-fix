# Review: PR #310 read-dedupe test 28

Date: 2026-08-05
Reviewed: `test/proxy-read-dedupe.test.mjs` at `f1b56c0a7739b60e2c9106091d95bcdd1756cb67`
Round: 1
Label applied: approved-by-codex-agent

## What Is Correct
- Measured: `gh pr view 310 --json statusCheckRollup` shows the current head `f1b56c0a7739b60e2c9106091d95bcdd1756cb67` green on `test (18)`, `test (20)`, `test (22)`, GitGuardian, and Snyk before approval.
- Measured: `node --test test/proxy-read-dedupe.test.mjs` passed `42/42` on `node v24.11.1`, including the rewritten test 28.
- Measured: in a full temporary copy of `proxy/` with `insertion-normalization` added at order `395`, the old neighbor-based predicate failed while the new predicate passed: `before=image-retry-circuit-breaker`, `self=read-dedupe`, `after=insertion-normalization`, `oldPass=false`, `newPass=true`.
- Read: the loader contract is numeric ordering, not adjacency. `loadExtensions` reads `order`, pushes enabled extensions, then sorts by `a.order - b.order`; nothing in the loader preserves or exports an "immediate neighbor" guarantee. `proxy/pipeline.mjs:43`, `proxy/pipeline.mjs:45`, `proxy/pipeline.mjs:66`
- Read: `read-dedupe` itself declares only `order: 380`; there is no code or comment asserting dependence on its immediate predecessor or successor. `proxy/extensions/read-dedupe.mjs:294`
- Read: the surrounding extensions likewise expose order values `370` and `400` without an adjacency contract. `proxy/extensions/image-retry-circuit-breaker.mjs:262`, `proxy/extensions/cache-control-normalize.mjs:29`
- Read: the revised test still pins the load-bearing facts: the extension exists, its configured order remains `380`, and it sorts after `image-retry-circuit-breaker` and before `cache-control-normalize`. The added comment explains why adjacency is the wrong invariant to assert. `test/proxy-read-dedupe.test.mjs:505`
- Read: the old test did not guard anything beyond those facts; its extra condition was only that no other enabled extension occupied the `(370, 400)` gap. Replacing neighbor checks with ordering checks does not weaken a real behavioral guarantee.

## Blockers
None.

## What Needs Attention
None.

## Bloat / Non-Functional
None. Measured: the PR is test-only with `0` production LOC changed and a single test file modified (`git diff --stat origin/main...HEAD`).

## Recommendations
- Reported: the PR body's simulation claim is now independently confirmed by local measurement, so I do not see overclaim that needs correction.
- Read: asserting only numeric order without named bounding extensions would be weaker than the current rewrite, because it would stop checking the specific "after 370 / before 400" relationship this test is intended to lock. The present comment plus named ordering assertions is the more defensible shape.

## Bottom Line
Approve. Measured and code-read evidence agree that this change fixes a brittle test artifact, not a production contract: the real invariant is numeric ordering in the extension pipeline, and the rewritten test asserts exactly that without dropping any load-bearing guarantee. — Codex review
