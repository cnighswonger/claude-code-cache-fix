# Review: read-dedupe implementation PR #243

Date: 2026-06-24
Reviewed: PR #243 (`feature/proxy-read-dedupe-impl`) at `9ae2af5a47412926dd1e1ba37623c40760b34fa1`
Round: 1
Label applied: approved-by-codex-agent; reviewed-by-codex-agent

## What Is Correct

The implementation follows the approved directive's activation pattern: `read-dedupe` is registered with `"enabled": true` in `proxy/extensions.json` at order 380, and runtime activation is strictly gated by `CACHE_FIX_READ_DEDUPE=1` inside `onRequest` ([proxy/extensions.json](proxy/extensions.json#L17), [proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L10), [proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L300)). The pipeline-order test confirms it loads between `image-retry-circuit-breaker` and `cache-control-normalize` ([test/proxy-read-dedupe.test.mjs](test/proxy-read-dedupe.test.mjs#L480)).

The load-bearing FIRST-keeper correction is implemented. Occurrences are walked in conversation order, duplicate buckets keep `list[0]`, and replacements always point back to that earliest `tool_use_id`; existing pointers remain byte-identical when a fourth duplicate lands ([proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L249), [proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L262), [test/proxy-read-dedupe.test.mjs](test/proxy-read-dedupe.test.mjs#L116), [test/proxy-read-dedupe.test.mjs](test/proxy-read-dedupe.test.mjs#L354)).

Mixed-array eligibility is handled conservatively and at detection time. Arrays with more than one element, and single non-text arrays, return `skip-mixed-array`; the regression tests cover text+image duplicates with different image bytes and verify they never collide ([proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L46), [proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L113), [test/proxy-read-dedupe.test.mjs](test/proxy-read-dedupe.test.mjs#L276), [test/proxy-read-dedupe.test.mjs](test/proxy-read-dedupe.test.mjs#L296)).

The key and replacement contracts match the directive: SHA-256 over `(file_path, content, offset, limit)` with NUL separators, case-sensitive `name === "Read"` matching, missing `tool_use_id` skip behavior, and literal U+2014 em dash in the pointer text ([proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L66), [proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L33), [proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L99), [proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L158), [test/proxy-read-dedupe.test.mjs](test/proxy-read-dedupe.test.mjs#L331)).

The turn-number open question is resolved in favor of the directive text: the implementation uses the containing user-message `msgIdx`, which is exactly how the replacement contract defines keeper turn derivation ([proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L143), [test/proxy-read-dedupe.test.mjs](test/proxy-read-dedupe.test.mjs#L377)).

The rewrite path is immutable-style for request-body messages. `applyReplacements` slices the messages array, slices affected message content arrays, shallow-clones affected `tool_result` blocks, and preserves the single-text array wrapper by cloning the inner item rather than mutating it in place ([proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L168), [proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L185), [proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L196)).

The docs cover the user-facing contract: README has the env-var row and the impact guide documents activation, telemetry, stderr summaries, default-off rollout, and the FIRST-keeper byte-stability guarantee ([README.md](README.md#L150), [docs/extension-impact-guide.md](docs/extension-impact-guide.md#L264)).

The test plan exceeds the directive's 29 numbered cases. The PR adds 41 tests: the directive cases, the Codex blocker variants, helper micro-tests, fixture-fed regressions, and the tiny-content negative `bytes_saved` case. The three fixtures include `_provenance` and match the real CC request shape used by `test/fixtures/cc-transcript-shape-snapshot.json`.

## Blockers

None.

## What Needs Attention

Non-blocking precision tightening: `read_tool_results_classified` currently counts only eligible Read tool results, not every Read-originated tool result. That means mixed-array Read results are counted under `read_tool_results_skipped_mixed_array` but not under `read_tool_results_classified`, and the stderr `reads_seen` value is effectively "eligible reads seen" rather than "all Read tool_results seen" ([proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L237), [proxy/extensions/read-dedupe.mjs](proxy/extensions/read-dedupe.mjs#L340)). This does not affect mutation correctness, and the skip counters still expose the mixed-array population. Either clarify the counter/summary wording or widen the counter later if dashboards expect "all Read-originated blocks."

The documented `bytes_saved` negative case is acceptable. The extension's arithmetic is `bytes_original - bytes_after`; tiny content can legitimately become a negative savings record when replaced by a longer pointer, and test 27a captures that behavior ([test/proxy-read-dedupe.test.mjs](test/proxy-read-dedupe.test.mjs#L463)).

## Bloat / Non-Functional

None. The helper exports are test-oriented and stay within the extension boundary; no new top-level dependency was added.

## Recommendations

Keep the current default-off rollout posture. Because this extension intentionally rewrites historical request content and depends on real Read-heavy sessions for value, it should still get live CC-traffic validation before any default-on discussion. No code change is required for that in this PR.

## Verification

- `node --test test/proxy-read-dedupe.test.mjs` → 41/41 passing.
- `npm test` → 1347/1347 passing.
- `gh pr checks 243` → GitGuardian, Snyk, and Node 18/20/22 CI all passing.

## Bottom Line

Approve. The implementation satisfies the directive's load-bearing requirements, including FIRST-keeper byte stability and conservative mixed-array skipping, with adequate tests and documentation. The only finding is a non-blocking telemetry wording/semantics tightening for `read_tool_results_classified` / `reads_seen`.
