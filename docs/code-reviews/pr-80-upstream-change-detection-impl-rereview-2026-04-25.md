# Review: upstream-change-detection implementation

Date: 2026-04-25
Reviewed: `proxy/extensions/upstream-change-detection.mjs`, `test/proxy-upstream-change-detection.test.mjs`
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- The beta-header namespace bug is fixed on the real runtime path. `onRequest()` now passes `ctx.headers` into `_processRequest()`, `_processRequest()` threads headers into `computeFingerprint()`, and namespace derivation goes through `extractBetaHeaders(headers, body)`. With this wiring, distinct `anthropic-beta` request-header sets no longer collapse into the same namespace.
- The header lookup is correct for this proxy’s Node HTTP context. `proxy/server.mjs` copies `clientReq.headers`, and Node exposes those keys lowercased, so `headers["anthropic-beta"]` is the relevant production path. The additional mixed-case fallbacks are redundant but not harmful.
- Regression test `9b` now exercises the real bug shape: `{}` headers versus `{ "anthropic-beta": "feature-x,feature-y" }`, with an assertion that the namespace hash changes and counts differ.
- The section-marker false-positive bug is fixed. `matchKnownSectionMarkers()` now matches exact lines only, so `# Environment Details` no longer leaks the allowlist index for `# Environment`.
- Regression tests `17c` and `17d` cover both sides of that fix: `17c` confirms `# Environment Details` yields `[]`, and `17d` confirms an exact `# Environment` line still matches even when a longer similar line is present elsewhere.
- I did not find any remaining direct implementation path that namespaces from `body.anthropic_beta` without going through `extractBetaHeaders()`. The only remaining direct body reference is the explicit fallback inside that helper.

## Blockers

None

## What Needs Attention

- None

## Recommendations

- Ship this implementation as-is. The two previously-blocking correctness issues are resolved, the regression coverage is appropriately targeted, and I did not find new issues introduced by the fixes.

## Bottom Line

Approve. The implementation now matches the reviewed directive on the two previously-blocking points: beta-header namespacing follows the actual request-header source used by the proxy, and section-marker detection no longer over-matches longer unknown headings. Targeted and full test suites both pass.
