Verdict: APPROVE_WITH_NITS

# Review: PR #213 — image-retry circuit breaker directive

Date: 2026-06-11
Reviewed: `docs/directives/proxy-image-retry-circuit-breaker.md` at `559f40d`
Round: 1
Label applied: `reviewed-by-codex-agent`, `approved-by-codex-agent`

## What Is Correct

- The directive's core load-bearing claims now survive contact with the codebase. `proxy/pipeline.mjs:85-99` does propagate `{ skip: true, ... }` from `onRequest`, and `proxy/server.mjs:88-94` already writes string bodies verbatim while `JSON.stringify`ing object bodies, so the "no `server.mjs` modification needed" simplification is correct.
- The hook contract is pinned correctly to `onRequest` plus `onResponse`, and the failure-recording path is correctly anchored to the non-streaming JSON branch in `proxy/server.mjs:162-187`, which is where the canonical 400 error envelope reaches extensions.
- The synthesized SSE sequence in `docs/directives/proxy-image-retry-circuit-breaker.md:52-71` is structurally complete for the proxy's current stream consumer: it includes the required `index` fields on `content_block_*`, includes `usage` on `message_start` and `message_delta`, and matches the telemetry extraction points in `proxy/stream.mjs:15-29`.
- The meter-pipeline framing is now correct. `proxy/extensions/usage-log.mjs:273-319` and `proxy/extensions/cache-telemetry.mjs:190-272` are `onStreamEvent` consumers only, so a pre-forward short-circuit produces no `~/.claude/usage.jsonl` row and no cache-telemetry write. The directive now states that accurately.
- The state-map mechanics are adequately specified for v1: bounded map, LRU at cap, lazy expiry on lookup, and a throttled sweep modeled on `proxy/extensions/cache-telemetry.mjs:132-156`. The sliding-window decision is also now explicit.
- Naming and placement match repo convention: flat `proxy/` helper placement, no new `proxy/lib/`, and order `370` after `image-strip` / `microcompact-stability` / `thinking-display` in the existing registry.

## What Needs Attention

1. `docs/directives/proxy-image-retry-circuit-breaker.md:73` and `:185` correctly say `[DONE]` is omitted by default and only added if sim validation proves upstream emits it, but the unit-test bullet at `:197` still hard-codes `message_stop -> [DONE]`. That leaves the directive internally inconsistent on a wire-fidelity detail the sim gate is supposed to settle.
2. The sessionless-path spec is still internally inconsistent. The detection rule says unresolved sessions bucket to `"unknown"` (`docs/directives/proxy-image-retry-circuit-breaker.md:103`), and the implementation choice says a breaker fire is any recorded failure in that session whose `imageHashes` intersect the current request (`:176-177`). Under that rule, sessionless requests are not isolated merely because their `requestSignature`s differ. The test-plan bullet at `:204` should not claim isolation from other sessionless requests of different signatures unless the matching rule changes.
3. The review checklist carries one stale contract detail: `docs/directives/proxy-image-retry-circuit-breaker.md:233` still says `onRequest` returns `{skip: true, status, headers, body, stream}`, but the directive text at `:37` and `:75` explicitly removed the `stream` field and relies on the existing string-body passthrough instead.

## Precision / Tightenings

- Citation accuracy is good overall, but `docs/directives/proxy-image-retry-circuit-breaker.md:117` points to `proxy/extensions/rate-limit-log.mjs:60-65` as the inline-predicate precedent. The actual predicate function is `proxy/extensions/rate-limit-log.mjs:68-74`; the cited range is nearby commentary, not the function itself.
- `docs/directives/proxy-image-retry-circuit-breaker.md:29` uses `prefix-diff` as the activation-model precedent. That is directionally fine for "`enabled: true` plus runtime env gate", but `proxy/extensions/prefix-diff.mjs:30` demonstrates a boolean gate, not the full `on/off/dry-run` tri-state. Tighten the wording so the citation is doing only the work it actually supports.
- The ~500 LOC budget is aggressive once the replay fixture, JSONL writer, and SSE builder land, but it is not obviously impossible. Treat it as a soft review guardrail, not a reason to compress the implementation at the expense of test clarity.

## Bloat / Non-Functional

None.

## Recommendations

1. Align the SSE test-plan bullet with the actual `[DONE]` policy: make the unit test assert the event sequence through `message_stop`, and leave sentinel presence to sim validation / captured-wire comparison.
2. Fix the sessionless bullet before implementation starts so the tests do not encode behavior the matching rule does not provide. Either keep the current `"unknown"` sharing model and document the cross-sessionless risk explicitly, or add a narrower no-session matching rule and state it directly.
3. Sweep the stale `stream` checklist item and the `rate-limit-log` line citation in the next directive touch so the implementation PR is not working against leftover round-2 wording.
4. Carry the `needs-sim-validation` gate forward on the implementation PR. The directive is ready to proceed, but real harness acceptance of the synthesized SSE payload remains the only load-bearing behavior that unit tests cannot prove.

## Bottom Line

This directive is ready to proceed. The major architectural and code-contract risks Fable raised are fixed, and the current text matches the proxy's actual hook surface, skip semantics, and meter behavior. The remaining issues are specification drift inside the directive itself: one stale `[DONE]` test bullet, one stale `stream` checklist item, and one sessionless-path test claim that does not match the stated matching rule. None of those justify another directive round, but they should be corrected before the implementation PR turns them into test or behavior churn.

— Codex review
