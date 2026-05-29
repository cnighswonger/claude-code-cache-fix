# Review: thinking-block-sanitize implementation

Date: 2026-05-29
Reviewed: PR #162 @ b6ccd64 (`proxy/extensions/thinking-block-sanitize.mjs`, `proxy/extensions/cache-telemetry.mjs`, tests)
Label applied: changes-requested

## What Is Correct

- Opt-in gating is implemented at the request boundary: default off is a true no-op, and opt-in on emits counts only.
- `planSanitize` is pure and deterministic: it preserves message/block order, performs no nondeterministic rewrites, and returns the original `messages` array when nothing changes.
- Empty assistant messages are dropped rather than replaced with synthetic placeholder text, and the drop count is merged through the existing single writer in `cache-telemetry`.
- Ordering is correct for the sibling telemetry flow: sanitize runs before `session-health`, and the pipeline test pins that `thinking_block_count` reflects the forwarded body.
- Local verification passed: `node --test` → 904 passing, 0 failing.

## Blockers

- `isActiveToolContinuation` protects the latest assistant turn whenever **any** later message contains **any** `tool_result`, but the approved rule is narrower: protect only when the latest turn's terminal `tool_use` is the one answered by the following `tool_result`. The current implementation never checks `tool_use_id`; it just scans for the presence of a later `tool_result` anywhere. [`proxy/extensions/thinking-block-sanitize.mjs:35`](../../proxy/extensions/thinking-block-sanitize.mjs), [`proxy/extensions/thinking-block-sanitize.mjs:46`](../../proxy/extensions/thinking-block-sanitize.mjs)

  Concrete repro: latest assistant ends with `tool_use id="t1"`, later user message contains `tool_result tool_use_id="other"`. `isActiveToolContinuation(...)` currently returns `true`, so sanitize leaves the latest omitted thinking intact even though the approved rule says that turn is not the protected continuation case. That over-protection can leave the exact latest-turn omitted thinking in place that this mitigation is supposed to strip, so it is a correctness issue, not just a missing edge test.

  The tests cover only "some later tool_result exists" and "no later tool_result exists"; they do not pin the required negative case where a later `tool_result` exists but does **not** answer the terminal `tool_use`. [`test/proxy-thinking-block-sanitize.test.mjs:28`](../../test/proxy-thinking-block-sanitize.test.mjs), [`test/proxy-thinking-block-sanitize.test.mjs:64`](../../test/proxy-thinking-block-sanitize.test.mjs)

## What Needs Attention

- None beyond the blocker above.

## Bloat / Non-Functional

- None. The implementation stays within the directive's size budget, keeps the transform deterministic, and records counts only.

## Size Baseline

- `proxy/extensions/thinking-block-sanitize.mjs` — 121 LOC — focused request-path transform with three small helpers.
- `proxy/extensions/cache-telemetry.mjs` — +3 LOC — additive single-writer merge only.
- `test/proxy-thinking-block-sanitize.test.mjs` — 166 LOC — good happy-path coverage, missing the mismatched-`tool_result` guard.
- `test/proxy-quota-status-pipeline.test.mjs` — +29 LOC — end-to-end merge/order pin.

## Recommendations

- Match the latest message's terminal `tool_use.id` against later `tool_result.tool_use_id` blocks instead of treating any later `tool_result` as proof of continuation.
- Add a regression test where a later `tool_result` exists but targets a different `tool_use_id`; expected result is `false`, and the latest completed/non-matching turn should be stripped.
- Re-run `node --test` after tightening the matcher and keep the pipeline merge pin in place.

## Bottom Line

Revise before approval. The opt-in gating, deterministic rewrite, empty-message handling, telemetry merge, and content-free logging are otherwise solid, but the continuation guard is broader than the approved rule and can suppress the very latest-turn stripping this mitigation is supposed to perform.
