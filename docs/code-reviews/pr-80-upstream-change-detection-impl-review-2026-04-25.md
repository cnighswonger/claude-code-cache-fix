# Review: upstream-change-detection implementation

Date: 2026-04-25
Reviewed: `proxy/extensions/upstream-change-detection.mjs`, `test/proxy-upstream-change-detection.test.mjs`
Label applied: `changes-requested`

## What Is Correct

- The extension is read-only in the hook path: `onRequest` only inspects `ctx.body` and writes local diagnostics; it does not mutate the request payload.
- The activation gate is placed at the top of `onRequest`, so the disabled path does not read the baseline or create output files.
- The persisted fingerprint payload is materially content-free: stored values are counts, booleans, bucket labels, positions, and hashes. Test `18` correctly plants a secret string and verifies it does not appear in `JSON.stringify(fingerprint)`.
- The baseline file write path uses a unique tmp suffix and `rename`, with tmp cleanup in `finally`, which matches the directive’s baseline atomicity contract.
- The JSONL writer uses a single `appendFile(path, JSON.stringify(record) + "\n")` call per record, and the concurrency test exercises that path directly.
- Error handling is correctly contained inside the hook; failures are debug-logged and do not throw back into the pipeline.

## Blockers

- `proxy/extensions/upstream-change-detection.mjs:200`-`210`, `proxy/extensions/upstream-change-detection.mjs:422`
  The implementation does not actually namespace by the request’s beta-header set. `extractBetaHeaders()` reads `body.anthropic_beta`, but the proxy passes request headers separately on `ctx.headers` (`proxy/server.mjs:40`), and Anthropic beta selection is an HTTP header (`anthropic-beta`), not a body field. In production, requests with different beta headers will collapse into the same namespace unless the body happens to carry a duplicate copy. That breaks the directive’s `(model_string, beta_headers_set)` namespace contract and can produce both false positives and false negatives. The current test `9` only proves a synthetic body field path, so it does not cover the real hook input.

- `proxy/extensions/upstream-change-detection.mjs:146`-`160`
  `matchKnownSectionMarkers()` overmatches known markers on prefix substrings instead of exact line matches. A line such as `# Environment Details` will be hashed as if the known marker `# Environment` was present because the fallback branch accepts any `text.indexOf("\n" + marker) !== -1`. That violates the allowlist-index contract: the persisted `known_section_marker_set_hash` can include indices for markers that did not actually appear. Once a namespace is already in `unknown_section_marker_present: true`, this can suppress real structural diffs by making an unknown marker look partly “known.” Test `17` covers happy-path matches, but not this false-positive case.

## What Needs Attention

- The tests are otherwise thorough and the 18 directive items are represented, but a runtime test that exercises `ctx.headers["anthropic-beta"]` is missing. That gap is what allowed the namespace bug above to pass despite the focused file being green.
- `REMINDER_TAG_SHAPE` is declared but not used; `hasUnknownReminderPattern()` inlines a second regex instead. That is harmless today, but it creates drift risk if the bounded-shape rule changes later.

## Recommendations

- Derive beta headers from `ctx.headers["anthropic-beta"]` in the hook path and pass the normalized set into namespace construction and the fingerprint namespace fields. Keep the pure export boundary by either adding a small pure helper for namespace metadata or by extending `computeFingerprint` to accept the normalized header set explicitly.
- Tighten section-marker matching to exact per-line equality. The simplest safe version is to split the text into lines, compare each line directly against `KNOWN_SECTION_MARKERS`, and hash only those exact matches.
- Add one regression test for real header-based namespacing and one for the `# Environment Details` false-positive case.

## Bottom Line

Revise before approval. The extension is close and most of the directive contract is implemented cleanly, but the current code misses real beta-header namespacing and can hash nonexistent known section markers. Both issues affect the core signal quality of the detector, so I would not approve this implementation yet.
