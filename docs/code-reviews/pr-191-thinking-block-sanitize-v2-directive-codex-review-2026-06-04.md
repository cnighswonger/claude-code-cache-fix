# Review: PR #191 thinking-block-sanitize v2 directive — Codex review

Date: 2026-06-04
Reviewed: `docs/directives/proxy-thinking-block-sanitize-v2.md`
Label applied: `changes-requested`

## What Is Correct

- The draft does accurately carry the core consult decisions from `a39f812` forward. The chosen predicate is the expected Option C single-baseline contract, and it now pins the parts that were blocking at consult stage: request-time disk seed, response-time persistence through `cache-telemetry`, fail-open/no-baseline behavior, and the explicit `"unknown"`-session no-op (`docs/directives/proxy-thinking-block-sanitize-v2.md:45-60,80-87`).
- The `redacted_thinking` scope decision is now explicit instead of implied. The draft states the v1 empirical scope versus v2 structural scope distinction clearly, and it intentionally widens mismatch stripping to both signed non-empty `thinking` and `redacted_thinking` (`docs/directives/proxy-thinking-block-sanitize-v2.md:15-21,53,105-106,201`).
- AITL's two refinements are integrated correctly. The helper signature is the forward-compatible `computeSignatureSurfaceHash({ tools, system?, anthropic_beta? })`, while v2 still hashes only `tools`; and baseline advancement is pinned to response success rather than request send (`docs/directives/proxy-thinking-block-sanitize-v2.md:49,54,64-69,86,110,127-128,202-203`).
- The directive also tightens the consult follow-through in the right places: recursive stable canonicalization, array-order preservation, split telemetry, single versioned env var, and an explicit statement of the accepted oscillation false-positive class (`docs/directives/proxy-thinking-block-sanitize-v2.md:37-43,70-77,89-112,120`).

## Blockers

- The `## Non-functional requirements` section does not yet satisfy this repo's required directive checklist. `CLAUDE.md` requires every directive NFR section to address size/complexity budget, threat model, maintainability constraints, performance/reliability, and an explicit `Load-bearing?` yes/no declaration with the human-review implication for load-bearing work (`CLAUDE.md:86-94`). This draft's NFR section currently covers performance, memory, disk, and fail-open behavior, but omits the size/complexity budget, threat-model/security line, maintainability constraints, and the explicit `Load-bearing? yes` declaration in the NFR section itself (`docs/directives/proxy-thinking-block-sanitize-v2.md:182-188`). Because this is a request-path mutator plus additive per-session schema state, that checklist needs to be complete before implementation approval.

## What Needs Attention

- The response-failure contract at the predicate level is `4xx/5xx -> baseline unchanged` (`docs/directives/proxy-thinking-block-sanitize-v2.md:54`), but the acceptance criteria and explicit race/failure tests only pin `4xx` (`docs/directives/proxy-thinking-block-sanitize-v2.md:128,156`). Add the 5xx variant so implementation and tests cannot silently narrow the intended behavior.
- The accepted false-positive class is now first-class in the prose (`A -> B -> A` / oscillation), but there is no explicit test for it. I would add one directive test that demonstrates the deliberate over-strip on reversion so the trade is locked in rather than left implicit (`docs/directives/proxy-thinking-block-sanitize-v2.md:39-43,120`).
- The reference to `aitl-reply-issue-171-spec-signoff.md` does not resolve on this branch. If the sign-off lives in an issue/PR comment or another branch artifact, point to that concrete location so later reviewers are not left with a dead citation (`docs/directives/proxy-thinking-block-sanitize-v2.md:5`).

## Bloat / Non-Functional

- The design itself is not bloated. It stays inside the consult's intended complexity envelope: one per-session baseline, one compare point, no per-turn attribution log, and no second file writer.
- The current problem is under-specification in the NFR section, not over-engineering in the directive body.
- `load-bearing: yes`, `schema-change`, and `needs-sim-validation` are the correct classifications for the behavior described here; the only missing piece is carrying the load-bearing declaration and Chris-review gate into the NFR checklist itself.

## Size Baseline

- `docs/directives/proxy-thinking-block-sanitize-v2.md` — 209 LOC — detailed and mostly implementation-ready directive; current gap is the repo-required NFR checklist, not core design content.
- `proxy/extensions/thinking-block-sanitize.mjs` — 130 LOC — existing request mutator that v2 extends in place.
- `proxy/extensions/cache-telemetry.mjs` — 267 LOC — existing single-writer seam that the directive correctly reuses.
- `proxy/extensions/session-health.mjs` — 152 LOC — right precedent for in-memory state seeded from persisted per-session JSON.
- `test/proxy-thinking-block-sanitize.test.mjs` — 185 LOC — existing focused test surface to absorb the v2 predicate and restart/failure additions.

## Recommendations

- Expand `## Non-functional requirements` to match the repo standard verbatim in substance: add a small size/complexity budget, a threat-model/privacy line that forbids logging or persisting request/thinking content beyond counts and the hash baseline, maintainability constraints that justify any helper/module split, and an explicit `Load-bearing? yes` sentence with the Chris-review requirement.
- Add one acceptance/test item for `5xx` leaving the baseline unchanged and one test for the intentional `A -> B -> A` oscillation over-strip case.
- Replace the unresolved AITL artifact reference with a concrete branch/commit/issue-comment citation.

## Bottom Line

Revise before approval. The important design work is in good shape: the draft reflects the prior Codex consult, it incorporates AITL's two refinements correctly, and the directive-stage decisions that mattered are now explicit. I am still requesting changes because the NFR section does not yet meet this repo's required checklist for a load-bearing request mutator with additive persisted state, and that should be fixed before the directive is promoted to implementation.

— Codex review
