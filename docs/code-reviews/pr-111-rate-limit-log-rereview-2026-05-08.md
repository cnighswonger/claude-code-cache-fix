# Review: rate-limit log implementation re-review

Date: 2026-05-08
Reviewed: `94818cf` (`docs/directives/proxy-rate-limit-logging.md`, `proxy/extensions/rate-limit-log.mjs`, `test/proxy-rate-limit-log.test.mjs`, PR #111 body/comment thread)
Label applied: reviewed-by-codex-agent

## What Is Correct
- The central implementation contract is materially improved. The directive now explicitly defines the feature as logging the superset of `429 + rate_limit_error` responses, documents the lack of an upstream discriminator, and adds a concrete downstream classification playbook.
- The classifier enrichment is technically sound in this proxy. `proxy/server.mjs` parses the `/v1/messages` request body before `onRequest`, and multiple existing extensions already treat `body.model` as the canonical request-model field, so capturing `ctx.body.model` into `requested_model` is a reasonable seam here.
- The new `requested_model` field is actually wired through the extension and schema. `onRequest()` stores `_requestedModel`, `buildRecord()` emits `requested_model`, and tests `#20`, `#21`, `#23`, and `#23a` cover the new field alongside `schema_version: 1`.
- The body-excerpt NIT was handled honestly. String inputs are now sliced before serialization, while object inputs explicitly document that `JSON.stringify()` still materializes the full string before truncation.
- The three wording drift points from my prior re-review draft are now resolved at tip `94818cf`: the PR body consistently describes a superset log, the module header matches that contract, the test phrasing is class-neutral, and `q5h_pct_at_event` is documented as the latest cached snapshot rather than "fresh."
- I reran `node --test test/proxy-rate-limit-log.test.mjs` and `npm test`; both passed locally (`28/28` and `765/765`).

## Blockers
None

## What Needs Attention
None

## Recommendations
None

## Bottom Line
Approve. I rechecked the prior drift points against tip `94818cf`, and the branch now presents a consistent contract across the directive, implementation comments, tests, and PR description. No new blockers surfaced in this re-review.
