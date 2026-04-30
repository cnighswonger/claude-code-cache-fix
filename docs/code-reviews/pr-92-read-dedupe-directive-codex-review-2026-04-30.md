# Review: read-dedupe directive

Date: 2026-04-30
Reviewed: `docs/directives/proxy-read-dedupe.md`
Label applied: `changes-requested`

## What Is Correct

- The extension belongs before `cache-control-normalize`; mutating message content first lets downstream cache-marker placement and sticky-hash logic see the final bytes ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:37), [proxy/extensions/microcompact-stability.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/microcompact-stability.mjs:4)).
- The activation model is coherent with this repo’s loader: `enabled: true` in `extensions.json` plus a runtime `CACHE_FIX_READ_DEDUPE=1` gate is the pattern that actually works under [proxy/pipeline.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/pipeline.mjs:10).
- The base detection key shape is directionally right. Including `file_path`, `content`, `offset`, and `limit` avoids the obvious false-positive classes, and null-byte separators are sufficient to prevent concatenation boundary collisions.
- Keeping cross-session dedupe and soft-dedupe out of scope is the right v1 cut. Both would introduce new state/semantics without first proving this simpler in-request transform is worth the trade.

## Blockers

- The “byte-stable across requests” guarantee is not true with the current “keep the LAST occurrence” contract. The directive says every older duplicate points at the most recent keeper and that the pointer is stable across requests ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:98), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:105), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:108)). Those claims conflict. If a file is read again on a later turn, the keeper changes to the new last occurrence, so every previously replaced pointer for that key must change from `tool_use_id=<old>` / `turn <old>` to `tool_use_id=<new>` / `turn <new>`. That means the rewritten historical bytes churn again on each later duplicate, so the replacement contract is deterministic per request state but not byte-stable across turns.
- The prefix-cache resolution depends on that false stability claim and is therefore incorrect as written. The directive states dedupe causes a one-time cache miss and then subsequent turns benefit from a stable smaller prefix ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:124), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:128), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:129)). Anthropic prompt caching requires an exact prefix match up to the cache breakpoint, so if those earlier pointer bytes are rewritten whenever a newer duplicate arrives, the historical prefix misses again, not just once. The spec needs either a genuinely stable pointer target or a revised cache-impact section that admits repeated misses while duplicate reads continue to accumulate.
- The content-key contract does not match the documented content-shape handling. The directive promises dedupe only when “byte-identical content has appeared before,” but for array content it hashes only concatenated text while explicitly preserving non-text array items such as images ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:21), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:83), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:114)). Two tool results with the same concatenated text but different array structure or different non-text items would collide and be deduped even though their payloads are not byte-identical. The spec needs to either hash a canonical representation of the full `tool_result.content` shape or narrow v1 to string / single-text-item content and skip mixed arrays.

## What Needs Attention

- The turn-number derivation is probably fine for well-formed Anthropic message histories, but `Math.floor(msg_idx / 2) + 1` bakes in strict user/assistant alternation instead of deriving from actual user-turn count. Counting preceding user messages would be more robust and easier to defend in tests ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:106)).
- The test plan currently asserts pointer stability only for identical input snapshots ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:271)). Once the replacement contract is revised, add a turn-growth test that simulates a third duplicate arriving later and proves whether historical pointers stay frozen or intentionally churn.
- Test 16 should be inverted into a guard-path expectation unless mixed-array dedupe becomes part of the key contract. Right now it encodes the same ambiguity the directive needs to resolve ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:266)).

## Recommendations

- Redefine the replacement target so old pointers do not change when a newer duplicate appears. The cleanest options are: point to the first kept occurrence for the key, or point to a stable content descriptor that does not depend on “latest turn” metadata.
- Rewrite the prefix-cache section after choosing that replacement target. If the design still intentionally rewrites prior pointers on later turns, say explicitly that cache misses can recur until duplicate reading stops.
- Tighten the v1 content contract. Either hash a canonical serialization of the full `tool_result.content` payload, or skip array/mixed content entirely and document that narrower scope.
- Extend the test plan with one cache-behavior regression and one mixed-content false-positive regression before implementation starts.

## Bottom Line

Revise before approval. The directive’s scope, pipeline slot, activation model, and high-level goal are sound, but the current replacement contract is not actually byte-stable across turns, and the cache-impact reasoning depends on that incorrect premise. In addition, the array-content keying rule can dedupe non-identical payloads. Those need to be resolved in the directive before implementation should begin.
