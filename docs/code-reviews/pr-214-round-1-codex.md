Verdict: REQUEST_CHANGES

# PR #214 round-1 review — `directive/jsonl-session-mirror` (HEAD `c5a55f1`)

## What Is Correct

- The round-3 rewrite materially improves the directive. The hook surface now matches the real pipeline and stream code: `onRequest` / `onResponseStart` / `onStreamEvent` / `onResponse` only, with streaming traffic handled on the stream path rather than a nonexistent end hook (`proxy/pipeline.mjs:85-141`, `proxy/stream.mjs:63`, `proxy/server.mjs:160-188`).
- The transcript-envelope section is now on the right shape: nested `message`, camelCase `sessionId` / `requestId`, synthetic `uuid` / `parentUuid`, and the user-record caveats are spelled out instead of hand-waved (`docs/directives/proxy-jsonl-session-mirror.md:47-97`).
- The stage-vs-write intent is now correct in principle: pending user/tool-result records live on `ctx.meta`, and the session map is meant to advance only after the write succeeds, which is the right way to avoid the silent data-loss path Fable found in round 2 (`docs/directives/proxy-jsonl-session-mirror.md:107-131`).
- The citation work is largely clean. `resolveSessionId()` / `sessionFilename()` / the `ctx.meta` stash pattern and the 5 MB rotation precedent all match the cited code (`proxy/extensions/cache-telemetry.mjs:44-72`, `proxy/extensions/cache-telemetry.mjs:170-179`, `proxy/extensions/bootstrap-defense.mjs:20-25`).
- Scope and NFR honesty are improved. The LRU handle cache is out of scope, the LOC budget is restated to 450-550, and `needs-sim-validation` is now a mandatory gate instead of an advisory footnote (`docs/directives/proxy-jsonl-session-mirror.md:28-33`, `docs/directives/proxy-jsonl-session-mirror.md:169-193`, `docs/directives/proxy-jsonl-session-mirror.md:257`).

## Blockers

### 1. The directive still omits the required `Load-bearing?` declaration, so the mandatory human-review gate is missing

`docs/directives/proxy-jsonl-session-mirror.md:26-33` has a `## Non-Functional Requirements` section, but it never states `Load-bearing? Yes/No`. That is not optional in this repo: `CLAUDE.md:86-94` requires every directive to include the field and says load-bearing work requires Chris's human review before merge.

This directive is load-bearing by the repo's own rubric. It introduces a new shared proxy extension, a new persisted mirror-file contract explicitly intended to interoperate with CC transcript readers, and new config/env surfaces. That is at least a schema/shared-abstraction change even before considering the plaintext-on-disk security posture. The field has to be present and it has to say `Yes`, with the human-review requirement stated explicitly.

### 2. `mirroredMessageCount` is defined as a user-message count but compared against raw `messages[]` indices, so the round-3 NB1 fix is still wrong as written

The spec says:

- `mirroredMessageCount` is "the count of user-role messages" already written (`docs/directives/proxy-jsonl-session-mirror.md:103-105`)
- new records mirror only entries whose index in the current request's `messages` array is `>= mirroredMessageCount` (`docs/directives/proxy-jsonl-session-mirror.md:105-112`)

Those are different coordinate systems once assistant turns are interleaved. Walk the normal 3-turn history:

- Request 1: `[u1]` -> `mirroredMessageCount = 1`
- Request 2: `[u1, a1, u2]` -> only `u2` stages, so `mirroredMessageCount = 2`
- Request 3: `[u1, a1, u2, a2, u3]` -> the rule "user entries whose raw array index is >= 2" stages both `u2` (index 2) and `u3` (index 4)

That yields 4 user records after 3 turns, not the 3 claimed by the acceptance fixture at `docs/directives/proxy-jsonl-session-mirror.md:127-132`. On longer sessions it still re-stages old user turns and drifts back toward quadratic growth.

If the intended coordinate is the filtered user-only ordinal, the directive needs to say exactly that, and the state variable should be described in the same coordinate system all the way through. As written, the algorithm is still wrong on a literal reading.

## What Needs Attention

- The test plan still carries a stale hash-based unit assertion: "same user message hashed twice mirrors once" (`docs/directives/proxy-jsonl-session-mirror.md:197-199`). That conflicts with the new position-based design and with the later repeated-`"yes"` fixture that correctly expects two distinct records (`docs/directives/proxy-jsonl-session-mirror.md:203-204`).
- The retention section should explicitly say whether the last file for an inactive session is swept after `RETENTION_DAYS`, not just rotated files (`docs/directives/proxy-jsonl-session-mirror.md:146-161`). The current wording strongly implies "rotated files only," which leaves the final inactive-session file ambiguous.
- The per-request accumulator is request-scoped, which fixes cross-request leakage, but the directive never states the memory tradeoff plainly: one full in-flight assistant message is buffered per concurrent request (`docs/directives/proxy-jsonl-session-mirror.md:97`, `docs/directives/proxy-jsonl-session-mirror.md:175-176`). That is probably acceptable here, but it should be acknowledged.

## Precision / Tightenings

- `docs/directives/proxy-jsonl-session-mirror.md:9` still says "directive — round 2" even though `c5a55f1` is the round-3 push described in the PR thread.
- The directive should call this a `schema-change` explicitly in the reviewer metadata/gates, not just `needs-sim-validation`. The mirror file shape and new config/env surface are both contract-bearing in this repo's labeling model (`CLAUDE.md:58-60`).
- If the implementation is meant to append staged user records and the assistant record in a single buffered file write at `message_stop`, say that explicitly. Right now the prose mixes "one buffered write" with "flush the staged user records first, then the assistant record," which leaves the batching boundary fuzzy (`docs/directives/proxy-jsonl-session-mirror.md:39-43`, `docs/directives/proxy-jsonl-session-mirror.md:114-117`).

## Bloat / Non-Functional

- No new bloat finding. Compared with round 1, the scope is materially tighter and the 450-550 LOC budget is honest.
- The non-functional gap is process, not size: the NFR checklist is still incomplete until the required `Load-bearing?` line is added.

## Recommendations

1. Add an explicit NFR line: `Load-bearing? Yes.` State why, and state that the implementation PR requires Chris human review before merge per `CLAUDE.md:86-94`.
2. Rewrite the dedup section to use one coordinate system end to end. The cleanest wording is "filter to user-role messages first, then stage positions from `mirroredUserMessageCount` onward," or rename the state to something like `mirroredUserOrdinalHighWater` so the implementation cannot confuse user ordinals with raw array indices.
3. Fix the stale unit-test bullet, the round metadata, and the retention wording in the same pass so the directive is internally consistent before implementation starts.

## Bottom Line

Round 3 is close, and it genuinely clears most of the substantive technical risk Fable identified. But it is not approvable yet. The directive still misses the repo-required `Load-bearing?` declaration and its `mirroredMessageCount` algorithm is still incorrect as written because it mixes user-count state with raw `messages[]` indices. Those are both cheap fixes, but they are still load-bearing fixes. REQUEST_CHANGES.

— Codex review
