# Review: PR #325 v4.4.0-beta.0 release artifacts

Date: 2026-08-07
Reviewed: PR #325 at `4076938` against `origin/main` `8d6fa93`
Round: 1
Label applied: `changes-requested`

## What Is Correct

The release PR is correctly scoped to release artifacts: `CHANGELOG.md`, `README.md`, `package.json`, and `docs/releases/v4.4.0-beta-promote-criteria.md`. There are no source-code changes in the PR diff.

The semver bump is valid for a prerelease: `4.3.0` -> `4.4.0-beta.0`. I found no tracked lockfile, and the new version string is consistent across `package.json`, the changelog heading, and the promote-criteria title. Remaining `4.3.0` strings outside the release note are historical directive/docs references, not stale package version constants.

Spot checks on `deferred-tool-rewrite` and `usage-log` match the merged code. `proxy/extensions/deferred-tool-rewrite.mjs` is runtime-gated by `CACHE_FIX_TOOL_REWRITE=1`, holds known `tools[]` entries byte-stable, suppresses tool-addition announcements for unsupported models, and only uses the beta path for allowlisted/overridden models. `proxy/extensions/usage-log.mjs` emits `ttl_tier` and `duration_ms` only when `CACHE_FIX_USAGE_LOG_EXTENDED === "on"`, with schema guards and default-off behavior intact.

Contributor credit is mostly aligned with the release range. The new README entries cover the human authors/contributors I saw in `git log v4.3.0..origin/main`, and the markdown uses `@VictorSun92`, not the distinct `@Victor-Sun` account.

The promote criteria are mostly falsifiable. Criterion 2 explicitly avoids treating a silent `output-guard` as proof by requiring one deliberate synthetic fire before the zero-fire window. Criterion 1 similarly uses `bytesTransferred` monotonicity to distinguish uptime from a silent respawn. Those clauses succeed at making a non-firing instrument observable.

## Blockers

1. `CHANGELOG.md:35` describes `output-guard` as a response-path/upstream-response guard, but the implementation is a request-body guard before forwarding upstream. The changelog says it asks whether "what we are about to send" is still "the response the upstream sent", validates the "outbound response", and restores the original on violation. The merged code does not inspect upstream responses at all: `proxy/extensions/output-guard-stash.mjs:20` to `proxy/extensions/output-guard-stash.mjs:25` stashes the pre-mutation request body on `onRequest`, and `proxy/extensions/output-guard.mjs:147` to `proxy/extensions/output-guard.mjs:178` validates `ctx.body` on `onRequest` and restores the original client body. This is a material release-note accuracy bug because operators will believe response corruption is covered when the shipped guard only covers request-body mutations before Anthropic receives them.

2. `CHANGELOG.md:35` also claims `output-guard` had "first 243 live firings", while `CHANGELOG.md:25` says none of the beta features has executed against live traffic anywhere during the development window. Given the commissioning context that the dogfood host stayed on v4.3.0 and no beta feature has live-traffic evidence, the 243-live-firings sentence is inconsistent with the release's own beta warning and should be removed or rewritten to a true pre-release/test/prototype provenance claim.

3. The changelog omits a user-visible fix merged after v4.3.0: `0ed2ab5` / PR #257, `fix(launcher): exclude localhost from proxy in --remote-control`. That commit fixes a v4.3.0 `--remote-control` regression where local HTTP/SSE MCP servers on `127.0.0.1` were routed through the cache-fix proxy and 404ed. This is release-note material for users of the v4.3.0 headline feature and should appear in the v4.4.0-beta.0 section or be explicitly accounted for if intentionally excluded.

## What Needs Attention

The `deferred-tool-rewrite` changelog paragraph is directionally correct but compressed enough to over-read. The implementation does not always "announce mid-session additions through the beta channel"; unsupported models intentionally pass through the changed `tools[]` and pay the cache bust. The top-level "no new env vars means no wire change" sentence and the merged code's runtime gate make this non-blocking, but the bullet would be more precise if it named the allowlist/suppression behavior.

The changelog leaves detailed entries under `[Unreleased]` while also saying this release promotes them. That may be intentional for this PR's editorial shape, but it is unusual release hygiene: after cutting a release, readers generally expect `[Unreleased]` to contain only future changes.

## Bloat / Non-Functional

None.

## Recommendations

Rewrite the `output-guard` bullet to say request path / outgoing request body / original client body, not response path / upstream response. Delete or qualify the "243 live firings" claim unless there is a true non-dogfood provenance that can coexist with the beta warning.

Add PR #257 to the `Fixed` section. Consider also deciding whether the pricing refresh in PR #259 needs a short mention because it affects `session-budget-breaker`'s dollar ceiling by adding current model prices, including models previously priced at zero.

## Verification

Inspected `gh pr diff 325 --repo cnighswonger/claude-code-cache-fix`.

Compared `git log v4.3.0..origin/main` against the changelog's PR list and contributor additions.

Ran targeted tests from an extracted archive of PR head `4076938`: `node --test test/deferred-tool-rewrite.test.mjs test/output-guard.test.mjs test/proxy-usage-log.test.mjs` passed 118/118.

## Bottom Line

Request changes. The release shape is close, but the `output-guard` release note currently describes the wrong traffic direction and claims live firings that contradict the beta evidence statement. The omitted `--remote-control` localhost fix also leaves a v4.3.0 regression fix out of the release notes.

— Codex, cross-LLM review, round 1
