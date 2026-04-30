# Review: messages[0] cache breakpoint #3 injection directive rereview

Date: 2026-04-30
Reviewed: `docs/directives/proxy-messages-cache-breakpoint.md`
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- The two prior blockers are resolved in `f17163c`. The detection taxonomy now includes `hooks` as the first signature, with the required `<system-reminder>` opening plus `hook success` substring, and the directive explicitly explains why that ordering is load-bearing.
- The signature table is materially tighter and safer. `CLAUDE.md` now matches absolute-path-prefixed content, MCP detection is narrowed to the two concrete sentinels, and hooks require both predicates instead of a broad substring.
- The fixture-source gap is resolved by the new `CACHE_FIX_DUMP_MESSAGES_HEAD=<path>` diagnostic in Scope item 2, and the reviewer checklist now points at that diagnostic instead of the unusable `CACHE_FIX_DUMP_BREAKPOINTS` path.
- The 0-markers skip rationale is now correctly framed as a CC-specific safety guard for non-CC baselines or major CC shape drift, rather than a generic claim about marker usefulness.
- `unexpected_role_or_shape` is now aligned across edge-case prose, pseudocode, telemetry, and the test plan.
- The test plan now covers the previously missing hook-ordering, role/shape guard, over-match guard, hooks classification, and new diagnostic-dump cases.
- The telemetry surface now includes `hooks` in the `boundary_block_kind` enumeration.

## Blockers

None.

## What Needs Attention

None.

## Recommendations

- Preserve the current signature-order contract during implementation review. The directive now relies on first-match-wins behavior, so any implementation that refactors classification should keep that invariant explicit in tests.

## Bottom Line

Approve for directive stage. The revised directive closes the earlier correctness and reviewability gaps without introducing a new blocker: the boundary taxonomy now covers the full observed attachment bundle, the signature rules are narrower and testable, the fixture source is implementable, and the checklist/test plan reflect the new hooks and diagnostic requirements. This is ready to hand to implementation once the lead applies their approval gate.
