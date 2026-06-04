# Review: PR #191 thinking-block-sanitize v2 directive rereview

Date: 2026-06-04
Reviewed: PR #191 directive (`docs/directives/proxy-thinking-block-sanitize-v2.md`) at `c1e37fb` (refresh against prior changes-requested at `9ce72ec`)
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- The rereviewed diff is tightly scoped. `git diff --name-only 9ce72ec c1e37fb` is limited to the directive plus Codex's prior review artifact, so there is no scope expansion beyond the round-1 feedback surface.
- The `## Non-functional requirements` section now satisfies the repo rubric from `CLAUDE.md`: it covers size/complexity budget, threat model, maintainability constraints, performance/reliability, and an explicit `Load-bearing? Yes.` declaration with the Chris human-review gate for implementation (`CLAUDE.md:86-94`; `docs/directives/proxy-thinking-block-sanitize-v2.md:184-192`).
- The response-failure contract is now pinned in the acceptance criteria and test plan the way round 1 asked: `4xx AND 5xx` leave the baseline unchanged, with a dedicated `5xx-leaves-baseline-untouched` case instead of leaving 5xx behavior implicit (`docs/directives/proxy-thinking-block-sanitize-v2.md:128,156-157,211`).
- The accepted oscillation false-positive is now locked into the test history explicitly. The directive adds a named `Oscillation over-strip is deliberate` case covering `A -> B -> A`, rather than relying on prose alone (`docs/directives/proxy-thinking-block-sanitize-v2.md:39-43,120,158`).
- The AITL reference is no longer presented as a public-repo artifact. It now states that the handoff file lives in Chris's local `~/drafts/` working tree, explains that the integrated spec is reproduced in the directive itself, and adds the Codex consult branch/commit anchor (`docs/directives/proxy-thinking-block-sanitize-v2.md:3,5`).

## Blockers

None.

## What Needs Attention

- There is minor wording drift between `HTTP 200` in the formal predicate step and `HTTP 2xx` in the widened acceptance/test language (`docs/directives/proxy-thinking-block-sanitize-v2.md:54,128,157,211`). I do not consider that a directive-stage blocker here because the requested non-2xx guard is now explicit where implementation and tests will key off it, but implementation should keep those lines aligned.

## Bloat / Non-Functional

None. The changes are corrective and disciplined: they complete the repo-required NFR checklist, add the two missing failure/oscillation tests, and fix the dead-reference hygiene without widening the design.

## Size Baseline

- `docs/directives/proxy-thinking-block-sanitize-v2.md` — 214 LOC — implementation-ready directive; the rereview changes are targeted checklist/test/reference fixes.
- `proxy/extensions/thinking-block-sanitize.mjs` — 130 LOC — existing extension being extended in place by the directive.
- `proxy/extensions/cache-telemetry.mjs` — 267 LOC — existing single-writer seam still used for persisted baseline state.
- `proxy/extensions/session-health.mjs` — 152 LOC — still the right precedent for in-memory state seeded from per-session JSON.
- `test/proxy-thinking-block-sanitize.test.mjs` — 185 LOC — existing test surface that will absorb the added v2 cases.

## Recommendations

- Refresh the directive-stage gate at `c1e37fb`: formal `APPROVED` review plus `reviewed-by-codex-agent` and `plan-approved`, and remove `changes-requested`.
- Keep the implementation PR aligned with the strengthened NFR section, especially the privacy invariant and the load-bearing human-review requirement.

## Bottom Line

Approve the current head for directive stage. The blocker from round 1 is closed, the three non-blocking follow-ups are now materially present in the directive, and the document is back in shape for implementation handoff.

— Codex review
