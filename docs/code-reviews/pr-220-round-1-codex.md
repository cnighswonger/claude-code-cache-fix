# Review: PR #220 `image-retry-circuit-breaker` implementation

Verdict: REQUEST_CHANGES

Date: 2026-06-11
Reviewed: `proxy/extensions/image-retry-circuit-breaker.mjs`, `proxy/image-hash.mjs`, `test/proxy-image-retry-circuit-breaker.test.mjs`, `test/proxy-image-hash.test.mjs`, `proxy/server.mjs`, `proxy/pipeline.mjs`, `proxy/stream.mjs`, `README.md`, and `CHANGELOG.md` at `3340a6e`
Round: 1
Label applied: `changes-requested`

## What Is Correct

- The skip-result contract is implemented the way the merged directive calls for: `onRequest` returns `{ skip, status, headers, body }`, the SSE path uses a string body with `content-type: text/event-stream`, the JSON path uses an object body with `content-type: application/json`, and `server.mjs`'s existing string-vs-object branch handles both without any core-server change (`proxy/extensions/image-retry-circuit-breaker.mjs:240-259`, `proxy/server.mjs:88-94`).
- The synthesized SSE sequence is structurally sound for the proxy's own consumer: six events in the expected order, no default `[DONE]` trailer, zeroed usage fields on `message_start`, `output_tokens` on `message_delta`, and request-model echoing in the synthesized envelope (`proxy/extensions/image-retry-circuit-breaker.mjs:204-237`, `proxy/stream.mjs:12-67`).
- The helper and detection core are otherwise aligned with the directive: decoded-byte SHA-256 hashing, any-hash overlap for multi-image matching, inline 400/`invalid_request_error` predicate, sliding cool-off refresh on breaker fire, LRU bump/eviction, lazy expiry, throttled sweep, and JSONL logging that stays off request bodies / auth headers (`proxy/image-hash.mjs:21-47`, `proxy/extensions/image-retry-circuit-breaker.mjs:118-188`, `proxy/extensions/image-retry-circuit-breaker.mjs:262-287`).
- Targeted tests pass locally: `node --test test/proxy-image-hash.test.mjs test/proxy-image-retry-circuit-breaker.test.mjs` (29/29 passing).

## Blockers

1. The sessionless bucket behavior does not match the merged directive or the README. The directive explicitly says that once session resolution fails, sessionless requests share the `"unknown"` bucket and are **not** isolated by `requestSignature`; any sessionless request whose image hashes overlap a recorded `"unknown"` failure inside the cool-off window should short-circuit (`docs/directives/proxy-image-retry-circuit-breaker.md:96-145`, `README.md:759-766`). The implementation still keys both lookup and insert by `makeKey(sessionId, requestSignature)` even when `sessionId === "unknown"` (`proxy/extensions/image-retry-circuit-breaker.mjs:80-82`, `proxy/extensions/image-retry-circuit-breaker.mjs:151-159`, `proxy/extensions/image-retry-circuit-breaker.mjs:304-320`, `proxy/extensions/image-retry-circuit-breaker.mjs:343-367`). In practice that means a sessionless retry with the same image hash but a different request signature forwards upstream instead of short-circuiting. The unit test named as cross-contamination does not verify the directive case; it uses an identical body, so the signatures still match and the stricter implementation passes unnoticed (`test/proxy-image-retry-circuit-breaker.test.mjs:251-266`). This needs to be made consistent before merge: either special-case the `"unknown"` bucket so it truly ignores `requestSignature`, or update the merged directive/docs and replace the test with one that proves the narrower signature-scoped behavior.

## What Needs Attention

- The per-session isolation test currently passes vacuously. It calls `onResponse()` with a fresh `ctxFor(...).meta` instead of the mutated `meta` object from the original `onRequest()`, so no failure is actually recorded before the second-session assertion runs (`test/proxy-image-retry-circuit-breaker.test.mjs:139-146`). The runtime code looks correct because session id is part of the key, but the test should reuse the original request context or assert that the first failure was recorded.

## Precision / Tightenings

- `requestSignatureOf()` is intentionally coarse: model, message count, role, and block types only (`proxy/extensions/image-retry-circuit-breaker.mjs:84-115`). That is enough for the target retry-storm case, but it also means same-session requests with the same image and the same structural shape, but different prompt text, collapse to one signature. If that broader matching is intentional, call it out explicitly in the sim-validation notes so a future maintainer does not assume the breaker is exact-body-scoped.
- The PII-discipline test is a reasonable smoke test, but it is not a field-whitelist test. Right now it proves "no obvious auth header names / demo image bytes leaked" rather than "only the intended keys are ever serialized" (`test/proxy-image-retry-circuit-breaker.test.mjs:360-373`). If this JSONL schema becomes a harder external contract, tighten that assertion later.

## Bloat / Non-Functional

- The implementation is materially above the directive's rough size target once tests/comments are counted, but I do not see actionable runtime bloat worth blocking on here. Most of the excess is coverage and explanatory commentary around the SSE synthesis and state-machine behavior, not unnecessary abstraction in the request path.

## Recommendations

1. Resolve the `"unknown"`-bucket contract one way or the other before merge. If the directive behavior is the intended one, the cleanest fix is to bypass `requestSignature` when `sessionId === "unknown"` so lookup/insert are hash-overlap-only inside that shared bucket.
2. Repair the session tests: reuse the original `reqCtx.meta` in the per-session-isolation case, and add a regression that uses the same image hash with a different sessionless request signature so the documented limitation is actually exercised.
3. Keep `needs-sim-validation` on the PR after the code/tests are corrected; use that pass to validate the regex breadth against real traffic and confirm the synthesized SSE tail matches what the harness already accepts.

## Bottom Line

The main implementation path is disciplined: the skip contract fits the existing server hook, the SSE/JSON synthesis is structurally credible, the logging follows repo precedent, and the targeted tests are otherwise strong. I am holding approval because the code, docs, and tests currently disagree on one of the directive's explicit detection rules: the `"unknown"` session bucket is still signature-scoped in code even though the merged directive and README say it is not.

— Codex review
