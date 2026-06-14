# Review: PR #230 — extract model-families helper

Date: 2026-06-14
Reviewed: implementation PR #230 at `28af31a` against `origin/main` `d9a4b9f`
Round: 1
Label applied: `approved-by-codex-agent`

Verdict: APPROVE

## What Is Correct

- The extraction preserves the family catalog and matching behavior. `MODEL_FAMILIES` contains the same seven substrings in the same order as the former inline map, and `modelFamily()` still lowercases the input, uses substring `includes` matching, and returns `"unknown"` for empty or non-string inputs (`proxy/model-families.mjs:16`, `proxy/model-families.mjs:32`).
- The dated point-release invariant is preserved. The helper still matches `claude-haiku-4-5-20251001` through the shorter `claude-haiku-4-5` root, which is now both documented and directly tested (`proxy/model-families.mjs:30`, `test/model-families.test.mjs:35`).
- The only in-repo runtime consumer remains the divergence detector, and its two call sites now resolve through the imported helper with no logic change to the surrounding heuristic (`proxy/extensions/cache-telemetry.mjs:54`, `proxy/extensions/cache-telemetry.mjs:118`).
- Back-compat is preserved. `cache-telemetry.mjs` re-exports `modelFamily`, and the new test covers that re-export explicitly so future external readers do not silently lose the old import path (`proxy/extensions/cache-telemetry.mjs:55`, `test/model-families.test.mjs:52`).
- The new coverage is appropriate for a pure refactor. `test/model-families.test.mjs` covers catalog shape, family coverage, canonical IDs, the dated point-release substring case, unmatched and non-string fallthrough, and the `cache-telemetry` re-export, while the divergence suite now imports the helper from the new source-of-truth location (`test/model-families.test.mjs:8`, `test/model-families.test.mjs:16`, `test/model-families.test.mjs:25`, `test/model-families.test.mjs:35`, `test/model-families.test.mjs:42`, `test/model-families.test.mjs:52`, `test/proxy-cache-telemetry-model-divergence.test.mjs:10`).
- The change is scoped exactly as described. The diff is limited to the new helper, the `cache-telemetry` import/re-export swap, the new helper-focused test file, and the divergence test import update. I did not find changes to `proxy/extensions.json`, env-var handling, module-scope state, or wire/schema behavior.

## Blockers

None.

## What Needs Attention

None for this refactor PR. I do not see a missing behavioral case that rises above the current helper-focused coverage.

## Bloat / Non-Functional

None. This is a targeted extraction that removes duplication potential without widening scope or adding indirection beyond the explicit helper boundary.

## Recommendations

- Proceed as-is.

## Bottom Line

This PR does what it claims: it lifts the model-family table and classifier into `proxy/model-families.mjs` without changing behavior, keeps the divergence detector on the same semantics, preserves the back-compat export from `cache-telemetry.mjs`, and adds focused tests around the new source of truth. I also reran `npm test -- --test test/model-families.test.mjs test/proxy-cache-telemetry-model-divergence.test.mjs test/proxy-cache-telemetry.test.mjs`, which passed 60/60 locally. This is ready for approval.

— Codex review
