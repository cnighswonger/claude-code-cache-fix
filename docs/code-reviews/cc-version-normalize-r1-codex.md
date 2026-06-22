# Review: cc-version-normalize

Date: 2026-06-22
Reviewed: PR #239 (`feature/cc-version-normalize`) at `e6e8fc105d25c5717d370912db1661ea9cee63f6`
Round: 1
Label applied: changes-requested

## What Is Correct

The extension implements the issue #238 shape: one new request-side extension, default-off behavior via `CACHE_FIX_NORMALIZE_CC_VERSION`, `strip` and `pin:<value>` modes, runtime gating while remaining enabled in `proxy/extensions.json`, and order 90 before `fingerprint-strip` at order 100.

The `fingerprint-strip` interaction is correctly reasoned and tested for the common path. `test/proxy-cc-version-normalize.test.mjs:249` and `test/proxy-cc-version-normalize.test.mjs:262` run `cc-version-normalize` and then `fingerprint-strip` on the same body, and assert that `fingerprint-strip` does not re-add a suffix after normalization. `proxy/extensions/fingerprint-strip.mjs:59` to `proxy/extensions/fingerprint-strip.mjs:60` confirms the 3-segment guard that makes that work.

Pin validation is tight enough for the header grammar. `proxy/extensions/cc-version-normalize.mjs:41` to `proxy/extensions/cc-version-normalize.mjs:44` allows only ASCII alnum, dot, and hyphen with a 64-character cap, so semicolon separators, equals, whitespace, quotes, control characters, and escape-like punctuation cannot enter the billing-header text through `pin:<value>`. The malformed pin tests cover semicolon, equals, whitespace, and empty values.

The first-fire banner latch is acceptable for this feature. Issue #238 asks for a boot/first-fire stderr line, and a process-wide first-fire message avoids per-request stderr noise while still proving active operation. The test seam `__resetFirstFireForTests` is small and reasonable.

Public-repo hygiene looks clean. I did not find operator home paths, hostnames, or private identifiers in the new source or test file.

## Blockers

1. `rewriteCcVersion` can mutate embedded `cc_version=` text inside another field value, not just the `cc_version` assignment. The comment at `proxy/extensions/cc-version-normalize.mjs:62` to `proxy/extensions/cc-version-normalize.mjs:65` says the match is anchored so adjacent fields cannot fire, but the actual regex at `proxy/extensions/cc-version-normalize.mjs:76` is `/cc_version=([^;\s]+)/g`; it has no field-boundary requirement. In a billing-header block like `other=prefix_cc_version=2.1.185.hash; cc_version=2.1.185.ok;`, strip mode rewrites both occurrences, corrupting `other` as well as the real field. The directive scope is a single non-sensitive field; this needs a delimiter-aware match or field parser, with a regression test for embedded `cc_version=` in another field value.

2. The fail-open path is not atomic if iteration throws after an earlier block has already been rewritten. `proxy/extensions/cc-version-normalize.mjs:128` to `proxy/extensions/cc-version-normalize.mjs:139` mutates `body.system[i]` inside the loop, while `proxy/extensions/cc-version-normalize.mjs:140` to `proxy/extensions/cc-version-normalize.mjs:150` catches later errors and logs that the body is being left intact. If an unexpected system shape throws during a subsequent element access, the function returns with earlier rewrites still applied. The issue contract and source comments both say rewrite errors should leave the original body intact. Plan all replacements first, then apply them only after the scan succeeds, and add a test where iteration throws after a first candidate block.

## What Needs Attention

The whitespace divergence from `fingerprint-strip` is defensible but should be made explicit in tests or comments. `fingerprint-strip` uses `cc_version=([^;]+)` at `proxy/extensions/fingerprint-strip.mjs:55`; this extension uses `[^;\s]+`. Given the billing header uses semicolon-separated fields and realistic `cc_version` values have no spaces, stopping at whitespace is not a problem for valid traffic. It is still a behavior difference, so a small test for `cc_version=2.1.185.hash other=stuff` or a comment that malformed whitespace terminates the value would make the choice auditable.

The suite does not exercise multiple billing-header blocks. The loop is intended to rewrite all qualifying system blocks, but current integration coverage only rewrites one billing block after skipping a non-billing block. Add one test with two billing-header blocks to lock down the all-blocks behavior.

Order 90 is okay relative to registered extensions. The only nearby registered mutator before it is `ttl-tier-detect` at 75, and `fingerprint-strip` at 100 is the important dependency. I did notice an unregistered `output-efficiency-rewrite.mjs` also declares order 90, but it is not in the committed `extensions.json`, so it does not create a runtime ordering conflict for this PR.

## Bloat / Non-Functional

None. The implementation is small and directly scoped to the directive. The exported pure helpers are justified by the test surface.

## Recommendations

Use a delimiter-preserving rewrite such as a field-boundary regex (`(^|[;\s])cc_version=...`) or, preferably, split the billing-header assignment list on semicolons and rewrite only fields whose trimmed key is exactly `cc_version`. Preserve the global/multiple-occurrence behavior if the same field appears more than once, but do not match substrings inside another field value.

Make fail-open atomic by collecting `{ index, nextBlock }` replacements in a temporary array inside the `try`, then applying them after the scan completes. That keeps the current in-place body contract for successful rewrites while making the catch path truthfully no-op.

## Bottom Line

Revise before merge. The main feature and test direction are good, but the current rewrite regex can touch more than the intended field and the fail-open guarantee is incomplete under the explicit error path this PR set out to defend.

— Codex review
