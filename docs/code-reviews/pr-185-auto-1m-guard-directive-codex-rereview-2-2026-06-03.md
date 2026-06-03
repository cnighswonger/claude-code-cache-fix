# Review: auto-1m-guard directive refresh 2

Date: 2026-06-03
Reviewed: PR #185 directive (`docs/directives/proxy-auto-1m-guard.md`) at `d25d20b` (refresh against `dd571a0` / prior refresh artifact `9451ce1`)
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- `d25d20b` itself is limited to wording cleanup in the directive: the mode table now uses the final flat `auto_1m_*` handoff shape, and the three touched test-matrix rows now match the already approved handoff and whitespace contracts (`docs/directives/proxy-auto-1m-guard.md:82-83,159-161,168`).
- The underlying directive semantics remain unchanged from the already approved `dd571a0` head: warn/strip/off scope, billing-facing wire contract, and the cache-telemetry handoff all stay intact.
- The raw range `dd571a0..d25d20b` also contains `9451ce1`, which committed the prior Codex refresh review artifact under `docs/code-reviews/`; no additional directive content or feature scope was introduced beyond that artifact plus the wording scrub.

## Blockers

None.

## What Needs Attention

None.

## Bloat / Non-Functional

None. This is the cleanup pass the prior refresh review explicitly invited, without widening the directive.

## Size Baseline

- `docs/directives/proxy-auto-1m-guard.md` — 199 LOC — unchanged directive size; only summary/test wording was normalized to the already approved contract.
- `docs/code-reviews/pr-185-auto-1m-guard-directive-codex-rereview-2026-06-03.md` — 40 LOC added in `9451ce1` — prior refresh artifact, not a directive-scope change.

## Recommendations

- Refresh `reviewed-by-codex-agent` and `plan-approved` at `d25d20b`, and post a fresh formal approval so the gate reflects the current head.

## Bottom Line

Approve the current head. The stale shorthand noted in the prior refresh review is now scrubbed, and no new directive semantics were introduced after `dd571a0`.

— Codex review
