# Review: auto-1m-guard directive refresh

Date: 2026-06-03
Reviewed: PR #185 directive (`docs/directives/proxy-auto-1m-guard.md`) at `dd571a0` (refresh against prior approval at `0f65e38`)
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- `git diff --name-only 0f65e38 dd571a0` is limited to the directive plus Codex's existing review artifact, so there is no scope expansion beyond the already approved directive surface.
- Commit `a0ab6b5` substantively closes the two round-1 clarification asks: the directive now explicitly blesses whitespace normalization for strip mode (`docs/directives/proxy-auto-1m-guard.md:130-134`), makes the cache-telemetry handoff shape explicit as a flat `ctx.meta._auto1mGuard` object whose `auto_1m_*` keys spread top-level into session JSON (`docs/directives/proxy-auto-1m-guard.md:98-123`), points implementation at the existing case-insensitive `anthropic-beta` reader pattern (`docs/directives/proxy-auto-1m-guard.md:149`), and adds the duplicate-token defensive test case (`docs/directives/proxy-auto-1m-guard.md:168`).
- Commit `dd571a0` is a real binary re-verification, not a scope rewrite. The directive now states upfront that the binary walk was rechecked against both CC `v2.1.148` and `v2.1.161`, includes the short-name translation table, and preserves the same wire-shape conclusion: the proxy-visible signal is still the `anthropic-beta` token `context-1m-2025-08-07`, not `req.body.model` (`docs/directives/proxy-auto-1m-guard.md:3,9-17,62-67`).
- The rest of the directive remains internally aligned on the points that mattered for the prior approval: warn/strip/off scope is unchanged, the out-of-scope cuts are still disciplined, and the NFR/load-bearing classification still matches the repo rule for billing-relevant outbound wire changes (`docs/directives/proxy-auto-1m-guard.md:75-96,136-151,178-184`; `CLAUDE.md:86-94`).

## Blockers

None.

## What Needs Attention

- Scrub the last stale shorthand references on the next directive touch so the whole document speaks with one voice. The detailed handoff contract now correctly specifies flat `auto_1m_*` keys inside `ctx.meta._auto1mGuard`, but the mode table and part of the test matrix still use the old `_auto1mGuard.detected/action` shorthand; likewise, the dedicated whitespace section blesses rejoining with canonical `, ` while the earlier strip sentence still says `,` (`docs/directives/proxy-auto-1m-guard.md:82-83,96,100-123,132-134,159-160`). I do not consider that enough ambiguity to reopen directive stage, but it is worth cleaning up.

## Bloat / Non-Functional

None. The follow-up commits stay tightly scoped to contract clarification and evidence refresh without widening the implementation surface or adding speculative machinery.

## Size Baseline

- `docs/directives/proxy-auto-1m-guard.md` — 199 LOC — still compact for a load-bearing directive; the added lines are targeted clarification and re-verification evidence rather than new feature scope.
- `docs/code-reviews/pr-185-auto-1m-guard-directive-codex-review-2026-06-03.md` — 47 LOC — prior approval artifact retained as the round-1 record this refresh builds on.

## Recommendations

- Refresh `reviewed-by-codex-agent` and `plan-approved` at `dd571a0`, and post a fresh formal approval so the gate is bound to the current head.
- During implementation, follow the dedicated handoff and whitespace-contract sections rather than the stale summary/test shorthand, then scrub those leftover lines in the next directive/docs pass.

## Bottom Line

Approve the current head. Both follow-up commits are present as described, the scope remains the same directive already approved at `0f65e38`, and the only remaining issue is minor wording drift in older summary/test lines, not a directive-stage design blocker.

— Codex review
