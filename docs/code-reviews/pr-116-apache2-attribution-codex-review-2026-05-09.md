# Review: Apache 2.0 attribution for dashboard NDJSON schema

Date: 2026-05-09
Reviewed: `THIRD_PARTY_LICENSES`, `tools/usage-to-dashboard-ndjson.mjs`, `package.json`
Label applied: `approved-by-codex-agent`

## What Is Correct

- The packaging blocker is fixed. `npm pack --dry-run` on head `4f4773a` now includes both `LICENSE` and `THIRD_PARTY_LICENSES`, so the npm artifact carries the added third-party notice instead of leaving it only in the GitHub repo.
- The attribution target is real and relevant. `tools/usage-to-dashboard-ndjson.mjs` intentionally emits the upstream dashboard's proxy NDJSON shape, including the `proxy-YYYY-MM-DD.ndjson` naming convention, `cache_health` labels, and the expected request/response/usage record structure.
- The source link in `THIRD_PARTY_LICENSES` is valid: `https://github.com/fgrosswig/claude-usage-dashboard`.
- The mixed-license posture is acceptable. Keeping this repository under MIT while documenting the borrowed schema portion as Apache 2.0 is a standard compatible redistribution pattern.
- The per-file header change is license-chain clean. Removing the explicit "MIT licensed" sentence from `tools/usage-to-dashboard-ndjson.mjs` does not change the governing repo-level MIT license, and the new Apache-origin note usefully clarifies the borrowed schema portion.
- Upstream does not appear to publish a top-level `NOTICE` file to preserve verbatim; I found `LICENSE` but no root `NOTICE` artifact in `fgrosswig/claude-usage-dashboard`.
- Local verification passed: `npm test` reports `788` passing tests, and PR #116 is currently `CLEAN` with passing visible checks.

## Blockers

None.

## What Needs Attention

- The `THIRD_PARTY_LICENSES` scope sentence slightly overstates the borrow by naming `cost_factor methodology`. The current translator file does not emit or document a `cost_factor` field, while the rest of the listed schema elements are directly reflected in the implementation. This is not blocking because it does not create a compliance gap, but the wording could be narrowed later if the team wants the notice to describe only the fields and conventions presently carried over.

## Recommendations

- Approve and merge as docs/attribution-only.
- If the team wants maximum precision, trim `cost_factor methodology` from the notice text in a follow-up unless or until this translator begins emitting that concept explicitly.

## Bottom Line

This PR now satisfies the stated packaging goal for npm redistribution, keeps the MIT + Apache 2.0 relationship understandable for downstream consumers, and does not leave any remaining compliance or implementation blocker that I could confirm. Approved.
