# Review: release v4.0.0

Date: 2026-06-06
Reviewed: PR #204 release payload (`release/v4.0.0-prep`) at `c0ae54f`
Round: 1
Label applied: `changes-requested`

## What Is Correct

- The semver bump to `4.0.0` is correct. This release flips two defaults (`CACHE_FIX_THINKING_SANITIZE` to default-on and `CACHE_FIX_HOT_RELOAD` to default-off), which is a major-release trigger under the canonical workflow (`docs/release-workflow.md:13-15`, `CHANGELOG.md:9-12`, `package.json:2-3`).
- The release commit itself is clean and minimal: `git diff --name-only c0ae54f^ c0ae54f` contains exactly `CHANGELOG.md`, `README.md`, and `package.json`, with no debug code or secrets in the added lines.
- The embedder note is technically accurate. It does not invent a `startProxy()` option for sanitize control; instead it documents the real behavior that sanitize mode is read from `process.env` per request via `modeFromEnv()`, while `startProxy()` only exposes `watch` control for hot-reload (`README.md:221-228`, `proxy/extensions/thinking-block-sanitize.mjs:202-206`, `proxy/server.mjs:303-318`).
- The `@yurukusa` contributor credit is formatted consistently with the existing Contributors section and the changelog narrative is aligned with the underlying v2 implementation history (`README.md:898`, `CHANGELOG.md:9`).
- `git status --short` is clean, and the workflow's local-operations check also passes: the `usage-log` local mod is present in the working copy (`docs/release-workflow.md:46-47,91`, `proxy/extensions.json:74-76`).

## Blockers

- The new v4.0.0 release note tells users to run `npm install -g cache-fix-proxy@4`, but `cache-fix-proxy` is the installed bin name, not the npm package name. The package name is `claude-code-cache-fix` (`package.json:2,11-12`), the canonical release workflow uses `npm install -g claude-code-cache-fix@X.Y.Z` (`docs/release-workflow.md:138`), and `npm view cache-fix-proxy version` currently returns `E404`. This breaks the upgrade instruction in both the new changelog bullet and the README flow users are sent to next (`CHANGELOG.md:11`, `README.md:239-249`).
- `CHANGELOG.md` does not follow the repo's canonical release-cut format. The workflow requires a new empty top-level `## [Unreleased]` heading and conventional subsection names such as `### Added` / `### Changed` / `### Fixed` / `### Removed` / `### Security` (`docs/release-workflow.md:51-57`), but the current file starts directly at `## [4.0.0] - 2026-06-07` and groups the breaking items under `### Behavior changes` instead (`CHANGELOG.md:3-16`). This is a release-process regression, not just style.
- The changelog still undercounts shipped user-facing surface between `v3.9.0` and `c0ae54f`. `8a1b4bc` added the new `CACHE_FIX_THINKING_SANITIZE=v2` opt-in mode plus the new `proxy/extensions/signature-surface-hash.mjs` helper that makes it work (`proxy/extensions/thinking-block-sanitize.mjs:13-22,48-54,202-206`, `proxy/extensions/signature-surface-hash.mjs:1-9`). In the release notes, that landing is only a parenthetical inside the v1-default-on bullet (`CHANGELOG.md:9`), which is too easy to miss for users upgrading from `v3.9.0` who are seeing v2 for the first time. Per the workflow, the release note needs to accurately reflect every user-facing commit since the last tag (`docs/release-workflow.md:88-89`); v2 should get its own explicit bullet, likely under `### Added`.

## What Needs Attention

- `package-lock.json` is not a blocker for this PR. It is gitignored in this repo, and the on-disk lockfile already resolves to `4.0.0`, so there is no stale local publish input to correct before tag time.
- After the release-note fixes land, re-run the final gate and then separately record Chris's explicit go before step 7, since this is a major release (`docs/release-workflow.md:15,98-103`).

## Bloat / Non-Functional

- None in the release cut itself. The payload is intentionally small; the problems are release-note correctness and workflow compliance.

## Recommendations

- Replace every `npm install -g cache-fix-proxy@4` release-upgrade instruction with `npm install -g claude-code-cache-fix@4` (or `@4.0.0` where the full pin is preferred), keeping `cache-fix-proxy` only as the runtime command name.
- Restore the top-level empty `## [Unreleased]` heading and rename `### Behavior changes` to `### Changed` so the changelog matches the canonical release workflow.
- Add an explicit v4.0.0 bullet for the shipped `thinking-block-sanitize v2` opt-in mode and its `CACHE_FIX_THINKING_SANITIZE=v2` activation path, instead of leaving it buried as a parenthetical inside the v1-default-on entry.

## Bottom Line

Revise, then re-review. The major-version bump is correct, the release commit is clean, the embedder note is technically sound, and the local usage-log safeguard is still in place. But this is not ready to tag: the upgrade command currently points at a nonexistent npm package, the changelog structure regressed from the canonical release workflow, and the shipped v2 sanitize mode is still under-documented for downstream users upgrading from `v3.9.0`.

— Codex review
