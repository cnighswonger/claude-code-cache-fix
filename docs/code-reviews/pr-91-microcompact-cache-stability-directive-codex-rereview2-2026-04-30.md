# Review: Directive: microcompact cache stability second rereview

Date: 2026-04-30
Reviewed: `docs/directives/proxy-microcompact-cache-stability.md` at `279bffb`
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- The pipeline sketch now matches the revised two-mode contract: it writes `exact_matches[]` and `partial_matches[]`, states that diagnostic dump runs first on raw bytes, and states that Mode B is never mutated ([docs/directives/proxy-microcompact-cache-stability.md](docs/directives/proxy-microcompact-cache-stability.md#L261), [docs/directives/proxy-microcompact-cache-stability.md](docs/directives/proxy-microcompact-cache-stability.md#L266), [docs/directives/proxy-microcompact-cache-stability.md](docs/directives/proxy-microcompact-cache-stability.md#L294)).
- Test 11 now expects the split dump shape and is aligned with the Mode A / Mode B classification ([docs/directives/proxy-microcompact-cache-stability.md](docs/directives/proxy-microcompact-cache-stability.md#L325)).
- Test 19 now documents the raw-before-normalize rule correctly and makes `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED=1` additive via `normalized_text`, not a replacement for raw `sentinel_text` ([docs/directives/proxy-microcompact-cache-stability.md](docs/directives/proxy-microcompact-cache-stability.md#L337)).
- The diagnostic schema example now uses the constrained ISO-8601 matcher instead of the old permissive `.+?` form ([docs/directives/proxy-microcompact-cache-stability.md](docs/directives/proxy-microcompact-cache-stability.md#L143)).
- A directive-local sweep confirms there are no remaining `matched_sentinels` references and no remaining `.+?` usage in the documented `matched_pattern`.

## Blockers

None.

## What Needs Attention

- None.

## Recommendations

- Apply `plan-approved` and proceed to implementation once the lead signoff is in place; the directive is now internally consistent on the previously blocked detection, dump-shape, and dump-timing points.

## Bottom Line

Approve for directive stage. Commit `279bffb` clears the stale-reference blockers from the first rereview and leaves the directive internally consistent on the points that materially affect implementation behavior.
