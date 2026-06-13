# Review: PR #227 — model-id-sanitize directive

Date: 2026-06-13
Reviewed: `docs/directives/proxy-model-id-sanitize.md` at `83da7cf`
Round: 2
Label applied: `changes-requested`

Verdict: REQUEST_CHANGES

## What Is Correct

- The validator is now the right outbound-wire shape. I re-checked the round-1 sample IDs against `^claude-[a-z][a-z0-9]*(-[a-z0-9]+)+$`: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `claude-fable-5`, and `claude-mythos-2` all pass, while `opus`, `claude--oops`, uppercase forms, and `[1m]` suffixes fail as intended (`docs/directives/proxy-model-id-sanitize.md:48-56`).
- Strip-mode recovery order is now explicit and correctly ordered: exact canonical full-ID recovery first, family-root fallback second, and no-confidence fallthrough to block third, with `recovery` discriminator values on `ctx.meta._modelIdSanitize` (`docs/directives/proxy-model-id-sanitize.md:68-90`, `docs/directives/proxy-model-id-sanitize.md:222-223`).
- The block-mode section now drops the bad evidence and states the real limit of precedent: `image-retry-circuit-breaker` only proves skip-result/SSE passthrough for synthetic `200`s, so `400` behavior remains unproven and is correctly gated on `needs-sim-validation` for both `stream: true` and `stream: false` paths (`docs/directives/proxy-model-id-sanitize.md:107-117`, `docs/directives/proxy-model-id-sanitize.md:225`).
- The file-anchored implementation points requested in round 1 are corrected and match the repo: `proxy/extensions/cache-telemetry.mjs:392-427` is the per-session JSON build, `proxy/server.mjs:88-95` is the short-circuit write site, and `proxy/extensions/image-retry-circuit-breaker.mjs:249-268` is the existing synthetic-response precedent (`docs/directives/proxy-model-id-sanitize.md:149-153`, `docs/directives/proxy-model-id-sanitize.md:226`).
- The operator-tradeoff caveat for `strip` mode is now explicit, and the directive now includes a reviewer checklist that pins the load-bearing validation items and the Chris-review gate (`docs/directives/proxy-model-id-sanitize.md:90`, `docs/directives/proxy-model-id-sanitize.md:220-232`).

## Blockers

1. The round-2 rewrite did not replace the old "cheapest" policy everywhere, so the directive is still internally contradictory about the fallback rule implementation must encode. Section 2 correctly reframes the family fallback as "oldest in-family wire ID" (`docs/directives/proxy-model-id-sanitize.md:78-88`), and the reviewer checklist now requires that wording (`docs/directives/proxy-model-id-sanitize.md:224`). But several later implementation-contract points still instruct the opposite policy: the maintainability section says the map rotates the `"cheapest current variant"` (`docs/directives/proxy-model-id-sanitize.md:38`), the mode summary says `strip` rewrites to the `"cheapest safe variant"` (`docs/directives/proxy-model-id-sanitize.md:125`), the PR-225 composition section still defines the inverse map as a `"cheapest-fallback target"` and names the shared-helper field `cheapestTarget` (`docs/directives/proxy-model-id-sanitize.md:170`, `docs/directives/proxy-model-id-sanitize.md:175`), and the family-map test still requires a non-empty `cheapestTarget` (`docs/directives/proxy-model-id-sanitize.md:202`). This is no longer just cosmetic drift; it leaves two different implementation contracts in the same directive. Replace the remaining `cheapest*` language and field names with neutral or policy-accurate names so the document speaks with one rule end-to-end.

## What Needs Attention

- I did not find a new round-2 regression beyond the stale `cheapest` terminology cluster above. Once that contradiction is removed, the original round-1 blockers appear closed at this head.

## Bloat / Non-Functional

- None. The narrowed fixes are proportionate, and the shared-helper preservation note for substring matching is still the right guardrail (`docs/directives/proxy-model-id-sanitize.md:178`).

## Recommendations

- Rename the shared helper field to something policy-agnostic such as `fallbackTarget`, then update the mode summary, maintainability paragraph, composition section, and test-plan wording to match the approved "oldest in-family / availability fallback" rationale.
- Keep the reviewer checklist line at `docs/directives/proxy-model-id-sanitize.md:224` as the source-of-truth phrasing and make the earlier sections conform to it verbatim.

## Bottom Line

Round 2 fixes the substantive round-1 blockers on validator breadth, recovery precedence, block-mode honesty, sim-validation gating, and the key file anchors. I am still requesting changes because the directive now contains two incompatible fallback policies: the corrected "oldest in-family" rule and several stale "cheapest" implementation instructions. Clean up that contradiction and this should be ready for approval on the next pass.

— Codex review
