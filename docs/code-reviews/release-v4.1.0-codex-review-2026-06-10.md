# Review: release v4.1.0 prep commit

Date: 2026-06-10
Reviewed: `release/v4.1.0-prep` at `6e243633849b9a2f1a742d8b3ee55a3cd801835a`
Round: 1
Label applied: n/a (no release PR or issue thread exists to label)

## What Is Correct

- Identity/state checks were clean before review: `which codex` resolved to the local wrapper, `GH_TOKEN` was set, the worktree on `release/v4.1.0-prep` was clean, and `release/v4.1.0-prep` resolved to the target commit `6e24363`.
- The release commit is scoped correctly. `git diff --name-only release/v4.1.0-prep^ release/v4.1.0-prep` returned only [`CHANGELOG.md`](CHANGELOG.md#L1) and [`package.json`](package.json#L1), matching the expected release-prep surface.
- [`package.json`](package.json#L3) now declares version `4.1.0`, and both `v4.0.0` and `6e24363^` still carry `4.0.0`, so the version bump is present and isolated.
- [`CHANGELOG.md`](CHANGELOG.md#L3) has a new empty `## [Unreleased]` heading above the new [`## [4.1.0] - 2026-06-10`](CHANGELOG.md#L5) section.
- The `v4.0.0..release/v4.1.0-prep^` range contains exactly the six expected merged commits: `19b38b7` (#188), `c42473b` (#189), `19d1dab` (#190), `471c13d` (#138), `5f4e863` (#208), and `3dbe5db` (#210). The v4.1.0 changelog section documents all six with the correct grouping: Added entries for #210, #190, #138, and #189 at [`CHANGELOG.md`](CHANGELOG.md#L9), [`CHANGELOG.md`](CHANGELOG.md#L10), [`CHANGELOG.md`](CHANGELOG.md#L11), and [`CHANGELOG.md`](CHANGELOG.md#L12); Fixed for #188 at [`CHANGELOG.md`](CHANGELOG.md#L16); Documentation for #208 at [`CHANGELOG.md`](CHANGELOG.md#L20).
- The `request_id` release note is corrected to the shipped cross-repo contract. [`CHANGELOG.md`](CHANGELOG.md#L9) now says `claude-code-meter >= v0.7.0`, not the earlier `v0.5.0` placeholder, and it keeps the forward reference consistent: default-off in v4.1.0, default-on in v4.2.0, with operators needing meter `v0.7.0+` before that flip. I also verified the current npm package version with `npm view claude-code-meter version`, which returned `0.7.0` on 2026-06-10.
- The semver bump is correct for the shipped change scope. #189 threads new env-sourced auth settings through installed units in [`bin/install-service.mjs`](bin/install-service.mjs#L26), [`bin/install-service.mjs`](bin/install-service.mjs#L102), and [`bin/install-service.mjs`](bin/install-service.mjs#L138); #190 adds the new opt-in debug surface via [`proxy/server.mjs`](proxy/server.mjs#L9), [`proxy/server.mjs`](proxy/server.mjs#L19), and [`proxy/server.mjs`](proxy/server.mjs#L43); #210 adds the new default-off `CACHE_FIX_USAGE_LOG_REQID` gate in [`proxy/extensions/usage-log.mjs`](proxy/extensions/usage-log.mjs#L40) and [`proxy/extensions/usage-log.mjs`](proxy/extensions/usage-log.mjs#L232). Those are additive, opt-in capabilities, not breaking default flips, so `4.0.0 -> 4.1.0` is the right release step.
- I spot-checked changelog fidelity against the approved review trail. The #189 entry matches the approved escape/pass-through scope recorded in [`docs/code-reviews/pr-189-round-4-codex.md`](docs/code-reviews/pr-189-round-4-codex.md#L9). The #190 entry matches the approved redaction, async-rejection containment, and generic-500 work recorded in [`docs/code-reviews/pr-190-round-2-codex.md`](docs/code-reviews/pr-190-round-2-codex.md#L8). The #138 and #208 entries match the previously approved helper-shipping and public-doc scrub scopes recorded in [`docs/code-reviews/pr-138-round-3-codex.md`](docs/code-reviews/pr-138-round-3-codex.md#L9) and [`docs/code-reviews/pr-208-round-1-codex.md`](docs/code-reviews/pr-208-round-1-codex.md#L8). Contributor credit for [@nisqatsi](https://github.com/nisqatsi) is present on the three release notes that should carry it: #188, #189, and #190 at [`CHANGELOG.md`](CHANGELOG.md#L10), [`CHANGELOG.md`](CHANGELOG.md#L12), and [`CHANGELOG.md`](CHANGELOG.md#L16).
- The known release-prep tarball gotcha is clean. [`proxy/extensions.json`](proxy/extensions.json#L1) is the compact tracked manifest without `usage-log` or `rate-limit-log`, so those local host-only enablements are not present in the reviewed tree.

## Blockers

None.

## What Needs Attention

- The release commit corrected the meter floor in the changelog, but two pre-existing references still say `v0.5.0+`: the user-facing `request_id` row in [`README.md`](README.md#L889) and the source comments in [`proxy/extensions/usage-log.mjs`](proxy/extensions/usage-log.mjs#L44) and [`proxy/extensions/usage-log.mjs`](proxy/extensions/usage-log.mjs#L227). That drift does not change runtime behavior or the v4.1.0 gate defaults, so I am not blocking the release on it, but the docs should be aligned before the later v4.2.0 default-on flip.

## Bloat / Non-Functional

None.

## Recommendations

- Approve `6e24363` for release as v4.1.0.
- Follow up with a small docs-only cleanup to replace the remaining `v0.5.0+` references with `v0.7.0+` outside the changelog.
- If a release PR or issue thread is opened after this artifact lands, mirror this verdict there under the bot identity so the GitHub timeline matches the committed audit record.

## Bottom Line

The release-prep commit at `6e24363` is correct for v4.1.0. The version bump is isolated to [`package.json`](package.json#L3), the new [`CHANGELOG.md`](CHANGELOG.md#L5) entry accurately covers the exact six merged commits since `v4.0.0`, the `request_id` compatibility note is corrected to the published `claude-code-meter 0.7.0` floor, the semver choice is a true minor rather than a patch or major, and the tracked [`proxy/extensions.json`](proxy/extensions.json#L1) is free of the local-only usage-log/rate-limit-log enablements. I found no blocker for cutting the release from this commit.

— Codex review
