# Review: PR #225 statusline served-model divergence indicator

Date: 2026-06-13
Reviewed: implementation PR #225 at 084b2de against `docs/directives/proxy-statusline-served-model-divergence.md` from 236c02d
Round: 1
Label applied: changes-requested

## What Is Correct
The implementation follows the directive on the main shape of the feature. `requestedModel` is read from `ctx.telemetry?.requestedModel` with no `server.mjs` change, the served-model stash is done at `message_start` outside the usage guard, and the rehydration guard correctly refuses to seed state when persisted `requested_model` differs from the current pair (`proxy/extensions/cache-telemetry.mjs:71`, `proxy/extensions/cache-telemetry.mjs:332`, `proxy/extensions/cache-telemetry.mjs:373`).

The per-session JSON addition uses the existing additive spread idiom (`proxy/extensions/cache-telemetry.mjs:396`, `proxy/extensions/cache-telemetry.mjs:417`), and the statusline render logic matches the directive's requested-side `[1m]` suffix, red recent state, black-on-yellow sticky state, matched-turn no-op, and single-quoted heredoc boundary (`tools/quota-statusline.sh:42`, `tools/quota-statusline.sh:207`, `tools/quota-statusline.sh:233`).

The state lifecycle pieces are also wired in: `__resetForTests()` clears the module-scope map and the stale-session sweep evicts map entries when their per-session files disappear (`proxy/extensions/cache-telemetry.mjs:253`, `proxy/extensions/cache-telemetry.mjs:284`, `proxy/extensions/cache-telemetry.mjs:437`). The shipped test suites are green locally:
`node --test test/proxy-cache-telemetry-model-divergence.test.mjs`,
`node --test test/proxy-cache-telemetry.test.mjs`,
`node --test test/quota-statusline-smoke.test.mjs`.

## Blockers
1. **The same-family sticky counter is counting `message_delta` events, not turns, so it can latch sticky inside a single response.** The directive's heuristic is "3 consecutive divergent turns at the same `(requestedModel, servedTarget)` pair," but `runDivergenceDetector()` increments `divergentTurnCounter` every time the `message_delta` branch runs (`proxy/extensions/cache-telemetry.mjs:132`, `proxy/extensions/cache-telemetry.mjs:346`). In this repo's actual stream lifecycle, `onStreamEvent` is called for every SSE `message_delta` (`proxy/stream.mjs:24`, `proxy/stream.mjs:63`), and the codebase already documents that multiple `message_delta` events can arrive in one response (`proxy/extensions/session-health.mjs:100`, `test/proxy-overage-warning.test.mjs:432`). With the current code, one same-family divergent response that emits three deltas will latch sticky on the third delta even though only one divergent turn occurred. That is a semantic mismatch with the directive, not just a test gap. The implementation needs a once-per-response guard around the divergence detector (or equivalent response-local dedupe) and a regression test that drives multiple `message_delta` events through one response.

## What Needs Attention
The detector is failure-isolated, but not in the exact place the directive describes. The merged directive says the comparison/map mutation would live inside the existing writer-side disk-write try, while the implementation uses its own sibling try earlier in the branch (`proxy/extensions/cache-telemetry.mjs:372`, `proxy/extensions/cache-telemetry.mjs:425`). That is behaviorally safe and I am not treating it as a separate blocker, but the code no longer matches the directive's placement claim verbatim.

## Bloat / Non-Functional
None.

## Recommendations
Add a response-local guard such as `ctx.meta._modelDivergenceDone` before invoking `runDivergenceDetector()`, mirroring the existing once-per-response pattern used by `session-health` for multi-`message_delta` streams (`proxy/extensions/session-health.mjs:101`).

Add a regression test that sends one `message_start` plus three `message_delta` events on the same `meta` object and asserts that an Opus 4.7 → Opus 4.8 response is still `sticky: false` after that single response. That is the case the current test plan misses.

If you keep the dedicated detector try/catch, update the PR description / follow-up docs to say "own try/catch at the `message_delta` site" instead of "inside the existing writer-side try" so the implementation and the directive wording converge again.

## Bottom Line
Verdict: REQUEST_CHANGES. Most of the directive landed correctly, including the rehydration guard, schema shape, render rules, and cleanup lifecycle. The remaining problem is load-bearing: same-family stickiness is currently counted per `message_delta`, not per turn/response, so a single streamed response can trip the three-turn latch. Fix that lifecycle bug and add the missing regression before this should be approved.

— Codex review
