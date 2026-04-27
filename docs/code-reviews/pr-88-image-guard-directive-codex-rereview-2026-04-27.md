# Review: Image guard directive re-review

Date: 2026-04-27
Reviewed: `docs/directives/proxy-image-guard-pipeline.md`
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- Blocker 1 is resolved. Pass 3 is now specified as its own independent native-cap resize pass with one trigger and one target: `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1` + image long edge above native cap, resizing to 2576 px for `claude-opus-4-7*` and 1568 px otherwise. Pass 1 is separately pinned to strip-only behavior at the active rejection cap. The previously ambiguous `5000x5000` in a 5-image request case is now answered unambiguously: with `PRESERVE_DETAIL=1`, Pass 3 resizes it to 1568 px even though Pass 1's 8000 px cap would not have stripped it.
- Blocker 2 is resolved. The dead `CACHE_FIX_IMAGE_COUNT_MAX_OTHER` / default-600 branch is gone. The directive now defines a single default cap of 100 with a single override env var, `CACHE_FIX_IMAGE_COUNT_MAX`, and the hard-cap section, precedence matrix, reviewer checklist, and test plan all match that shape.
- The prior non-blocking notes are addressed. The earlier resize-quality overclaim is tightened to a documented blind-downscale-vs-client-controlled-resize distinction, and the `package.json` rationale now focuses on the optional install contract instead of npm-warning behavior.
- Execution order is consistent across the top-level pass list, the pipeline table, the prose sections, the pipeline sketch, and the reviewer checklist: `Pass 0 -> Pass 3 -> Pass 1 -> Pass 2 -> count cap`.
- The "Pass 3 runs even when Pass 1 would not have stripped" rule is now stated in prose and covered directly by test 16, with corroborating fallback coverage in tests 18 and 19.
- The single `CACHE_FIX_IMAGE_COUNT_MAX` override path is explicitly tested in test 21, and no live directive references to `CACHE_FIX_IMAGE_COUNT_MAX_OTHER` remain.

## Blockers

None

## What Needs Attention

- The directive still references prior issue-thread review states in the "Source of truth" section. That is not incorrect, but it is process metadata rather than implementation guidance. If this doc is meant to age well, those references should stay secondary to the behavioral spec.
- Pass 3 tests are intentionally conditional on `sharp` being importable in CI. That is acceptable for the directive, but implementation review should verify the non-`sharp` path still leaves enough exercised coverage to catch regressions in the lazy-import fallback behavior.

## Recommendations

- Proceed with implementation against this directive as written. The spec is now tight enough to hold the code to one behavior.
- Keep the README precedence matrix verbatim with the directive during implementation review; the current matrix is internally consistent and should remain the single external behavior table.
- During implementation review, pay particular attention to preserving the documented separation of concerns: Pass 3 resizes only, Pass 1 strips only, Pass 2 measures serialized body bytes only, and the count cap remains a final independent pass.

## Bottom Line

Approve for directive stage. The revision closes both prior blockers cleanly, addresses the two wording notes, and adds the exact missing test coverage for the above-native but below-rejection-cap case. I did not find a new contradiction or ambiguity that would justify holding the plan open.
