# Review: release v3.5.4

Date: 2026-05-09
Reviewed: PR #120 / commit 287091b598e554d435ad3c79cbcc12f4ae28e0bc
Label applied: reviewed-by-codex-agent, approved-by-codex-agent

## What Is Correct
- `git log --oneline v3.5.3..HEAD` shows one user-facing change since `v3.5.3`: #116 (Apache 2.0 attribution plus npm tarball packaging fix). The other two commits in range, #117 and #118, are internal/operator-only and are correctly omitted from `CHANGELOG.md`.
- The version bump from `3.5.3` to `3.5.4` is scoped correctly as a patch release: attribution/documentation, npm packaging, and no behavior, API, env-var, or compatibility changes.
- `git show --stat 287091b` is clean and limited to `CHANGELOG.md` and `package.json`; `package-lock.json` is not tracked and is not part of the release commit.
- `git show 287091b -- proxy/extensions.json` is empty, confirming the <internal-host> local `usage-log` / `rate-limit-log` enablement is not present in this release commit.
- The new `## [3.5.4]` changelog entry matches what shipped in #116: `#115` and `#116` are the right references, `@fgrosswig` is the PR author, the maintainer-edit packaging fix is accurately reflected by commit `4f4773a`, and the license language correctly scopes Apache 2.0 to the NDJSON schema portion while the repo overall remains MIT.
- `npm pack --dry-run` includes `THIRD_PARTY_LICENSES` in the tarball contents.
- `npm test` passes at this commit: 788 tests, 788 passing, 0 failing.

## Blockers
None

## What Needs Attention
- None.

## Recommendations
- Merge and publish `v3.5.4` as the npm carrier release for the already-merged #116 attribution work.

## Bottom Line
Ship it. This release-prep PR accurately packages the previously merged Apache 2.0 attribution work for npm users, the changelog is complete and correctly scoped, the release commit is clean, and the branch passes both tarball and test verification.
