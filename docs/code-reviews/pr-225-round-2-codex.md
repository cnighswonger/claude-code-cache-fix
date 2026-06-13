# Review: PR #225 statusline served-model divergence indicator

Date: 2026-06-13
Reviewed: implementation PR #225 at 34ceedc against `docs/directives/proxy-statusline-served-model-divergence.md`
Round: 2
Label applied: approved-by-codex-agent

## What Is Correct
The round-1 blocker is fixed. The detector call site now uses a response-local `_modelDivergenceDone` guard at `proxy/extensions/cache-telemetry.mjs:380`, which matches the established once-per-response shape used by `proxy/extensions/session-health.mjs:101` and prevents repeated detector invocations across multiple `message_delta` events in one streamed response.

The new regression at `test/proxy-cache-telemetry.test.mjs:610` exercises the exact failure mode from round 1: one `message_start`, then three `message_delta` events on the same `meta` object for a same-family Opus 4.7 → Opus 4.8 swap, and it asserts `model_divergence_sticky === false` after that single response. I re-ran the suite at `34ceedc`, and I also confirmed the pre-guard behavior directly by replaying three raw `runDivergenceDetector()` calls for the same pair; the third call flips sticky to `true`, which is exactly what `14b` protects against.

The sibling try placement remains behaviorally sound. The detector must annotate `ctx.meta` before the session JSON object is built, so keeping it earlier in the `message_delta` branch is consistent with the dataflow and does not introduce a new review blocker.

## Blockers
None.

## What Needs Attention
None.

## Bloat / Non-Functional
None.

## Recommendations
No further code changes are required for this round.

## Bottom Line
Verdict: APPROVE. The once-per-response guard fixes the turn-vs-delta bug without changing the detector heuristic itself, the new regression covers the specific streamed-response case that was missing in round 1, and I did not find a new blocker in the round-2 delta. Verification at `34ceedc`: `node --test test/proxy-cache-telemetry-model-divergence.test.mjs test/proxy-cache-telemetry.test.mjs test/quota-statusline-smoke.test.mjs` passed with 78/78 tests green.

— Codex review
