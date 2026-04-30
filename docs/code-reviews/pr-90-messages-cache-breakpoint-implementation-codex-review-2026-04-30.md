# Review: messages[0] cache breakpoint #3 injection implementation

Date: 2026-04-30
Reviewed: `27aa7af` (`proxy/extensions/messages-cache-breakpoint.mjs`, `proxy/extensions.json`, `test/proxy-messages-cache-breakpoint.test.mjs`, docs)
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- The activation pattern matches the approved directive: `proxy/extensions.json` registers `messages-cache-breakpoint` as `enabled: true` at order `410`, while `onRequest` still gates mutation on `CACHE_FIX_INJECT_MESSAGES_BREAKPOINT=1`.
- The new extension sits in the correct pipeline slot between `cache-control-normalize` (`400`) and `ttl-management` (`500`), which preserves the normalized marker baseline the directive required.
- `countAllCacheControlMarkers` walks both `body.system[]` and every `body.messages[*].content[]` block, and the tests exercise the 0, 3, 4, and 5-marker cases plus the post-injection `+1` invariant.
- Boundary detection takes the LAST auto-injected block, not the first. The implementation scans the full array, updates `lastIdx` on every auto-injected match, and the interleaving / hooks-ordering tests cover the load-bearing cases.
- Block classification keeps the approved fail-open posture: any unrecognized block falls back to `user`, which preserves under-detection rather than risking injection into user content.
- Injection preserves the target block payload by spreading the original block and appending only `cache_control`, and the already-marked boundary path cleanly skips without overwrite.
- The five required `skip_reason` literals are consistent across code, tests, and the implementation docs: `boundary_not_found`, `boundary_already_marked`, `no_existing_markers`, `at_marker_limit`, and `unexpected_role_or_shape`.
- The hooks-taxonomy correction from directive review #1 carried through correctly. Hooks are classified first, the signature remains narrow, and the required tests (`5a`, `11`, `11a`, `11b`) are present.
- `CACHE_FIX_DUMP_MESSAGES_HEAD` is read-only and runs before injection. The dump path writes structural JSONL from the pre-mutation body, and the tests verify both no-mutation behavior and the no-file path when unset.
- Telemetry shape matches the directive surface on `ctx.meta.messagesBreakpointStats`, and the extension emits a stderr summary line on both injection and skip paths whenever injection is enabled.
- The tests document at least five real-traffic baseline fixtures; this implementation includes seven such fixtures, satisfying the reviewer checklist requirement with synthetic cases clearly separated.
- No new top-level dependencies were added, and `npm test` passes cleanly for the full suite (`637` passing, `0` failing).

## Blockers

None.

## What Needs Attention

None.

## Recommendations

- Keep the real-traffic fixture corpus current if Claude Code changes the exact hook / MCP / skills wrappers. The implementation is deliberately narrow, so fixture drift is the earliest signal that the classifier needs adjustment.

## Bottom Line

Approve for implementation stage. The implementation adheres to the approved directive on activation, ordering, marker counting, boundary detection, fail-open classification, read-only diagnostics, telemetry, and test coverage, with no dependency drift and a clean full-suite run. This is ready for final lead review from the Codex side.
