# Review: PR #228 model-id-sanitize round 2

Date: 2026-06-13
Reviewed: `proxy/extensions/model-id-sanitize.mjs`, `proxy/model-families.mjs`, `test/proxy-model-id-sanitize.test.mjs`, `test/model-families.test.mjs` at `7a0d850`
Round: 2
Label applied: approved-by-codex-agent

## What Is Correct
- `hexEscape()` now encodes to UTF-8 bytes first and emits one `\x??` per byte, which fixes the multi-byte code-point bug from round 1. The implementation is in `proxy/extensions/model-id-sanitize.mjs:51`, and the new assertions pin `😀 -> \xf0\x9f\x98\x80`, `é -> \xc3\xa9`, and ASCII behavior in `test/proxy-model-id-sanitize.test.mjs:370`.
- Session persistence now matches the directive's session-scoped contract. `_sessionState` retains `firstSeenIso`, `correctionsCount`, and `lastValueHex`, and `buildCleanTurnStash()` re-attaches the spread on later clean turns in the same session (`proxy/extensions/model-id-sanitize.mjs:90`, `proxy/extensions/model-id-sanitize.mjs:220`, `proxy/extensions/model-id-sanitize.mjs:295`). The new regression tests cover both malformed→clean persistence and cross-session isolation in `test/proxy-model-id-sanitize.test.mjs:384` and `test/proxy-model-id-sanitize.test.mjs:411`.
- `claude-opus-4-6` now classifies as `opus`, so the strip-mode family fallback target no longer comes back as `unknown`. The new entry is present in `proxy/model-families.mjs:45`, and the source-of-truth guard that checks every `FAMILY_ROOT_FALLBACKS.fallbackTarget` classifies into a real family is in `test/model-families.test.mjs:72`.
- The synthetic-throw failure-isolation coverage now exists and proves the catch path stays fail-open while emitting the expected stderr line. See the catch block in `proxy/extensions/model-id-sanitize.mjs:343` and the getter-throws regression in `test/proxy-model-id-sanitize.test.mjs:432`.
- No contradictions were introduced in the changed surface during this round-2 pass. The touched suites passed locally with `node --test test/proxy-model-id-sanitize.test.mjs` and `node --test test/model-families.test.mjs`.

## Blockers
None.

## What Needs Attention
None in the requested round-2 scope. A local full-suite spot check hit an unrelated environment failure in `test/install-service.test.mjs:802` because this workspace is missing the `hpagent` package imported by `proxy/upstream.mjs`; that is not attributable to the PR diff under review.

## Bloat / Non-Functional
None.

## Recommendations
- Preserve the new fallback-target classification guard in `test/model-families.test.mjs:72`; it is the load-bearing regression test for future family-table edits.

## Bottom Line
The three round-1 blockers and the synthetic-throw attention item are now closed on the code and test surface I re-verified. The PR is ready for approval.

— Codex review
