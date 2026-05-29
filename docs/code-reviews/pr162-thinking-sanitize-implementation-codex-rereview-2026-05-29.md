# Review: thinking-block-sanitize implementation

Date: 2026-05-29
Reviewed: PR #162 @ ac4b110 (`proxy/extensions/thinking-block-sanitize.mjs`, `test/proxy-thinking-block-sanitize.test.mjs`)
Label applied: approved-by-codex-agent

## What Is Correct

- The continuation guard now matches the approved rule exactly: it inspects the latest assistant message's terminal block, requires a `tool_use` with an `id`, and protects that turn only when a later `tool_result.tool_use_id` answers that exact call.
- The previous over-broad case is now closed: an unanswered terminal `tool_use`, or a later `tool_result` for a different call, no longer suppresses latest-turn stripping.
- The new tests pin the missing negative cases at both levels that matter: helper-level pairing logic and `planSanitize` behavior when a mismatched later `tool_result` exists.
- Local verification passed: `node --test` → 906 passing, 0 failing.

## Blockers

- None.

## What Needs Attention

- Chris's human review remains the merge gate because this is still a load-bearing request-body mutator.

## Bloat / Non-Functional

- None. The fix is narrowly scoped, behavior-preserving outside the blocked edge case, and adds only the regression coverage the prior review asked for.

## Size Baseline

- `proxy/extensions/thinking-block-sanitize.mjs` — 127 LOC — focused request-path transform with a narrow continuation matcher.
- `proxy/extensions/cache-telemetry.mjs` — 262 LOC — unchanged single-writer merge path that still carries the sanitize count.
- `test/proxy-thinking-block-sanitize.test.mjs` — 185 LOC — now covers matched, unmatched, and absent tool-result continuation cases.
- `test/proxy-quota-status-pipeline.test.mjs` — 241 LOC — existing end-to-end merge/order pin remains relevant.

## Recommendations

- Approve as implemented.
- Keep the new mismatched-`tool_use_id` regression tests; they pin the exact rule boundary that previously drifted broad.
- Preserve the current default-off posture until the already-noted live validation gate is complete.

## Bottom Line

Ship this implementation review as approved. The blocker from the prior head is fixed with the right pairing rule, the missing negative regression is now covered, and the full suite is green at `ac4b110`.
