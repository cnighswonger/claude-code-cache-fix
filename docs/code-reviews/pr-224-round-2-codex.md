# Review: PR #224 statusline served-model divergence directive

Date: 2026-06-13
Reviewed: `docs/directives/proxy-statusline-served-model-divergence.md` at `b51d690`
Round: 2
Label applied: `changes-requested`

## What Is Correct

| Check | Result | Evidence |
|---|---|---|
| B1 rehydration guard, restart + `/model` change | Confirmed | Rehydration now requires persisted `requested_model === ctx.telemetry.requestedModel`, so `A(sticky) -> restart -> B` seeds a fresh `B` pair with no inherited sticky. The negative-path regression case is also named in the test plan. (`docs/directives/proxy-statusline-served-model-divergence.md:60`, `docs/directives/proxy-statusline-served-model-divergence.md:109`, `docs/directives/proxy-statusline-served-model-divergence.md:172`) |
| B1 rehydration guard, restart with same requested model | Confirmed | The same-model restart path still rehydrates the active pair from disk and preserves sticky across restart. (`docs/directives/proxy-statusline-served-model-divergence.md:109`, `docs/directives/proxy-statusline-served-model-divergence.md:171`) |
| B2 `[1m]` contract | Confirmed | The directive is now consistent that `[1m]` renders on the requested side only: functional requirements, short-label section, reader rules, test plan, and checklist all match. (`docs/directives/proxy-statusline-served-model-divergence.md:43`, `docs/directives/proxy-statusline-served-model-divergence.md:95`, `docs/directives/proxy-statusline-served-model-divergence.md:146`, `docs/directives/proxy-statusline-served-model-divergence.md:177`, `docs/directives/proxy-statusline-served-model-divergence.md:222`) |
| LRU -> TTL terminology | Confirmed | The implementation section and reviewer checklist now describe `sweepStaleSessions` as TTL/time-based stale-session sweeping rather than LRU. I did not find any remaining implementation-contract use of LRU. (`docs/directives/proxy-statusline-served-model-divergence.md:111`, `docs/directives/proxy-statusline-served-model-divergence.md:216`) |
| Named existing statusline test file | Confirmed | The directive now points directly to `test/quota-statusline-smoke.test.mjs`. (`docs/directives/proxy-statusline-served-model-divergence.md:177`) |

## Blockers

- `docs/directives/proxy-statusline-served-model-divergence.md:61` still says "Clearing sticky requires a new session" but then immediately specifies a same-session recovery path: delete the per-session JSON file and restart the proxy, or wait for the stale-session sweep to drop the in-memory entry. The out-of-scope section repeats the "requires a new session" contract at `docs/directives/proxy-statusline-served-model-divergence.md:237`. Those statements cannot all be true at once. Either same-session clear is possible after persisted-state removal plus in-memory eviction, or it is not. This is still a contradictory operator-facing recovery contract on a load-bearing directive, so I cannot approve it yet.

## What Needs Attention

None beyond the blocker above in this narrow re-verification pass.

## Bloat / Non-Functional

None in the reviewed delta.

## Recommendations

- Pick one authoritative sticky-clear contract and restate it consistently in the heuristic, checklist, and out-of-scope sections.
- If the intended contract is "file deletion alone is insufficient, but file deletion plus in-memory-state eviction clears sticky," then remove the phrase "requires a new session" everywhere.
- If the intended contract is truly "only a new session clears sticky," then remove the restart / sweep clearing path from the heuristic and explain why the same-session map/file reset path is not supported.

## Bottom Line

The r3 update does close the original B1 rehydration bug and the `[1m]` / TTL wording issues, but it still leaves one blocking contradiction in the operator recovery contract for clearing sticky state. Resolve that contract mismatch and this should be ready for approval on the next pass.

— Codex review
