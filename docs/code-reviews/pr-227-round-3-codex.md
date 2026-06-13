# Review: PR #227 — model-id-sanitize directive

Date: 2026-06-13
Reviewed: `docs/directives/proxy-model-id-sanitize.md` at `a895be9`
Round: 3
Label applied: `approved-by-codex-agent`

Verdict: APPROVE

## What Is Correct

- The directive no longer uses "cheapest" as an implementation instruction. The live contract language now consistently describes the fallback as "oldest in-family" or availability-based, including the maintainability constraint, the family-fallback map, the mode summary, the composition section, the test plan, and the reviewer checklist (`docs/directives/proxy-model-id-sanitize.md:38`, `docs/directives/proxy-model-id-sanitize.md:78-88`, `docs/directives/proxy-model-id-sanitize.md:125`, `docs/directives/proxy-model-id-sanitize.md:170-175`, `docs/directives/proxy-model-id-sanitize.md:192-202`, `docs/directives/proxy-model-id-sanitize.md:224`).
- The implementation-contract field rename is complete at the directive sites that matter: the shared-helper shape and the family-map source-of-truth test both use `fallbackTarget`, and the old `cheapestTarget` name survives only as an explicit anti-pattern warning in the parenthetical at `docs/directives/proxy-model-id-sanitize.md:175`.
- The bad image-retry anchor is corrected. The directive now cites `image-retry-circuit-breaker.mjs:249-268` in the threat-model section, the block-mode mechanism section, and the reviewer checklist; I did not find any live `:236-265` citation left in the implementation contract (`docs/directives/proxy-model-id-sanitize.md:37`, `docs/directives/proxy-model-id-sanitize.md:107`, `docs/directives/proxy-model-id-sanitize.md:149`, `docs/directives/proxy-model-id-sanitize.md:226`).
- The document now speaks with one fallback rule end-to-end: exact canonical recovery first, otherwise oldest in-family fallback when the family is still available, and cross-family Sonnet fallback only for unavailable Fable/Mythos families (`docs/directives/proxy-model-id-sanitize.md:72-90`, `docs/directives/proxy-model-id-sanitize.md:125`, `docs/directives/proxy-model-id-sanitize.md:170-175`, `docs/directives/proxy-model-id-sanitize.md:192-202`).
- I did not find a new contradiction introduced by the round-3 cleanup. The remaining `cheapest` mentions are retrospective "not this" explanations rather than active policy text (`docs/directives/proxy-model-id-sanitize.md:78`, `docs/directives/proxy-model-id-sanitize.md:175`, `docs/directives/proxy-model-id-sanitize.md:224`).

## Blockers

None.

## What Needs Attention

None for this narrow round-3 verification.

## Bloat / Non-Functional

None. The cleanup is targeted and removes ambiguity without expanding scope.

## Recommendations

- Proceed. The directive is internally consistent on the fallback policy at this head.

## Bottom Line

Round 3 closes the remaining round-2 blocker. The directive no longer mixes a stale "cheapest" policy into the implementation contract, the helper/test field name is consistently `fallbackTarget`, the image-retry anchor is corrected to `:249-268`, and the end-to-end fallback rule is now coherent. This is ready for approval.

— Codex review
