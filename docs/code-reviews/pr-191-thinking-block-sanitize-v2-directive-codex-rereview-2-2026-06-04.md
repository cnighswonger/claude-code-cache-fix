# Review: PR #191 thinking-block-sanitize v2 directive rereview 2

Date: 2026-06-04
Reviewed: PR #191 directive (`docs/directives/proxy-thinking-block-sanitize-v2.md`) at `017616c` (refresh against prior approval at `c1e37fb`)
Label applied: `changes-requested`

## What Is Correct

- The rereview diff is tightly scoped. `git diff c1e37fb 017616c -- docs/directives/proxy-thinking-block-sanitize-v2.md` adds exactly two clarifying notes and does not otherwise widen directive scope.
- The first new note is directionally right about extension ordering: `cache-telemetry` is order 600 and sets `ctx.meta._sessionId` in `onRequest`, so a v2 hook at order 550 cannot rely on that field already being populated (`proxy/extensions/cache-telemetry.mjs:160-173`; `proxy/extensions/session-health.mjs:88-106`).
- The second new note is directionally right that `sort-stabilization` already makes `body.tools` order deterministic before v2 fires by sorting tool definitions alphabetically by name at order 200 (`proxy/extensions/sort-stabilization.mjs:34-36,60-61`).

## Blockers

- `docs/directives/proxy-thinking-block-sanitize-v2.md:177` states that `resolveSessionId(ctx.headers)` is "already exported from `cache-telemetry.mjs:173`". Current HEAD does not export `resolveSessionId`; it is a private helper defined at `proxy/extensions/cache-telemetry.mjs:59-67` and only used internally at line 173. The trailing parenthetical acknowledges that an export may need to be added in implementation, but the lead sentence is still factually wrong for the branch being approved.
- `docs/directives/proxy-thinking-block-sanitize-v2.md:74` says `tool-input-normalize` at order 280 "normalizes inner-schema field ordering within each tool object." Current HEAD does not do that. `tool-input-normalize` reorders `assistant` `tool_use.input` keys inside `body.messages` to match schema order; it does not rewrite tool-definition objects or nested schema ordering in `body.tools` (`proxy/extensions/tool-input-normalize.mjs:1-55,60-68`). That makes the new rationale note materially inaccurate as written.

## What Needs Attention

- None beyond the two factual corrections above. The rest of the directive remains aligned with the previously approved scope.

## Bloat / Non-Functional

- None. The issue here is accuracy, not scope or over-engineering.

## Size Baseline

- `docs/directives/proxy-thinking-block-sanitize-v2.md` — 215 LOC — implementation-ready directive; this rereview only concerns the two newly added clarifying notes.
- `proxy/extensions/thinking-block-sanitize.mjs` — 130 LOC — existing extension the directive extends in place.
- `proxy/extensions/cache-telemetry.mjs` — 267 LOC — current single-writer seam and the source of the session-id/export mismatch.
- `proxy/extensions/session-health.mjs` — 152 LOC — valid precedent for the ordering constraint discussion.
- `proxy/extensions/sort-stabilization.mjs` — 64 LOC — confirms the tool-array sort guarantee.
- `proxy/extensions/tool-input-normalize.mjs` — 73 LOC — confirms the second note currently overstates what is normalized.

## Recommendations

- Revise the new session-id note so it describes the current code accurately: either say v2 should import/export `resolveSessionId` as part of the implementation PR, or first land the export and then reference it as existing.
- Revise the new upstream-normalization note so it credits only verified current guarantees. `sort-stabilization` can stay; `tool-input-normalize` should not be described as normalizing tool-definition schema order unless the code actually does that.

## Bottom Line

Do not refresh directive-stage approval at `017616c` yet. The diff is scope-neutral, but both newly added clarifying notes contain factual mismatches against current HEAD, so the directive should be corrected before Codex re-approves it.

— Codex review
