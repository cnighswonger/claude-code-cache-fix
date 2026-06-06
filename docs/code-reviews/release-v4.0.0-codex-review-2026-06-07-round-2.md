# Review: release v4.0.0

Date: 2026-06-06
Reviewed: PR #204 release payload (`release/v4.0.0-prep`) at `014c670`
Round: 2
Label applied: `approved-by-codex-agent`

## What Is Correct

- The release payload still has the correct major-version bump: `package.json` is `4.0.0`, the npm package name is `claude-code-cache-fix`, and `cache-fix-proxy` remains only the installed bin name (`package.json:2-3`, `package.json:11-12`).
- The install-command blocker is closed in every release-facing location reviewed. The v4.0.0 changelog now uses `npm install -g claude-code-cache-fix@4`, and the README upgrade flow uses the same package name in both Linux and macOS examples (`CHANGELOG.md:13`, `README.md:239-249`).
- The changelog structure now matches the canonical release workflow: empty `## [Unreleased]` at the top, followed by `## [4.0.0] - 2026-06-07`, with conventional `### Changed` and `### Added` sections (`CHANGELOG.md:3-18`, `docs/release-workflow.md:51-57`).
- The v2 sanitize landing is now explicit and discoverable instead of buried as a parenthetical. It has its own `### Added` bullet, including the `CACHE_FIX_THINKING_SANITIZE=v2` activation path and the new `proxy/extensions/signature-surface-hash.mjs` helper (`CHANGELOG.md:16-19`).
- The round-2 fixup is scoped correctly: `git diff --name-only c0ae54f..014c670` shows only `CHANGELOG.md` and `README.md`, and the branch remains the expected release surface plus the prior round-1 review artifact.
- Local verification is clean: `npm test` passed with `1004` tests and `0` failures.

## Blockers

- None.

## What Needs Attention

- None.

## Bloat / Non-Functional

- None.

## Recommendations

- Proceed with tag, npm publish, and GitHub Release when the release owner is ready.

## Bottom Line

Approve. The three round-1 blockers are closed exactly as requested: the install package name is corrected everywhere reviewed, the changelog is back in canonical release-workflow shape, and the shipped `thinking-block-sanitize` v2 surface now has a dedicated `### Added` entry. I did not find any new regressions in the round-2 delta, and the local test suite still passes.

— Codex review
