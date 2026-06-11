# Review: PR #220 `image-retry-circuit-breaker` implementation

Verdict: APPROVE

Date: 2026-06-11
Reviewed: `proxy/extensions/image-retry-circuit-breaker.mjs`, `test/proxy-image-retry-circuit-breaker.test.mjs`, `docs/directives/proxy-image-retry-circuit-breaker.md`, and `README.md` at `7ce182c`
Round: 2
Intended labels: `reviewed-by-codex-agent`, `approved-by-codex-agent`

## Round-1 -> Round-2 Status

| Item | Status | Verification |
|---|---|---|
| Blocker — sessionless `"unknown"` bucket remained signature-scoped vs directive | ADDRESSED | `makeKey()` now collapses sessionless traffic to `unknown:_`, so both lookup and insert ignore `requestSignature` for the `"unknown"` bucket while named sessions remain `sessionId:requestSignature` keyed (`proxy/extensions/image-retry-circuit-breaker.mjs:80-90`, `proxy/extensions/image-retry-circuit-breaker.mjs:160-168`, `proxy/extensions/image-retry-circuit-breaker.mjs:327-339`, `proxy/extensions/image-retry-circuit-breaker.mjs:352-360`). That matches directive Detection logic #4 (`docs/directives/proxy-image-retry-circuit-breaker.md:98-105`) and the README statement (`README.md:766`). |
| Attention — per-session-isolation test passed vacuously | ADDRESSED | The test now reuses the mutated `reqCtx1.meta` on `onResponse()` and asserts one log line before checking the second session, proving the first failure actually landed (`test/proxy-image-retry-circuit-breaker.test.mjs:139-151`). |
| P1 — `requestSignatureOf()` is intentionally coarse | DEFERRAL APPROPRIATE | The directive explicitly frames any-hash matching as the chosen trade-off and leaves breadth confirmation to sim validation rather than tightening signature semantics in this PR (`docs/directives/proxy-image-retry-circuit-breaker.md:107-111`, `docs/directives/proxy-image-retry-circuit-breaker.md:183-190`). No new code in `7ce182c` widens that scope further. |
| P2 — PII discipline is smoke, not field-whitelist | DEFERRAL APPROPRIATE | This commit does not change the JSONL schema, and the existing in-tree smoke assertion remains proportionate until or unless the log format becomes an external contract (`proxy/extensions/image-retry-circuit-breaker.mjs:272-293`; `test/proxy-image-retry-circuit-breaker.test.mjs:489-498`). |
| New control — named-session contrast test | ADDRESSED | The new control test proves same-image / different-signature requests still forward for a real session id, locking in the intended contrast with the sessionless bypass (`test/proxy-image-retry-circuit-breaker.test.mjs:301-327`). |

## New Issues

None in the fix scope. The `makeKey()` change is internally consistent: request-path lookup, LRU bump, and failure recording all go through the same helper, and I did not find any other code path in this extension that assumes the key still embeds the signature for the `"unknown"` bucket.

## Bottom Line

The round-1 blocker is fixed, the vacuous session-isolation test is repaired, and the new sessionless plus named-session control tests now exercise the exact contrast the directive requires. Targeted verification passed locally with `node --test test/proxy-image-hash.test.mjs test/proxy-image-retry-circuit-breaker.test.mjs` (30/30 passing). Approval is appropriate at `7ce182c`, with `needs-sim-validation` still remaining the directive's separate merge gate before final merge.

— Codex review
