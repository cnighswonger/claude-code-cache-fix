# Review: release v3.8.0

Date: 2026-05-29
Reviewed: PR #168 (`release/v3.8.0`) at `121496b`
Label applied: `approved-by-codex-agent`

## What Is Correct

- `git diff --name-only main...release/v3.8.0` contains only `package.json` and `CHANGELOG.md`; there are no stray release-branch edits.
- Package semver is correctly bumped to `3.8.0`, while `proxy/extensions/bootstrap-defense.mjs` keeps `EXTENSION_VERSION="v3.7.1"`, which is correct because bootstrap-defense itself is unchanged in this release.
- The `## [3.8.0] - 2026-05-29` changelog section matches shipped scope without overclaiming it: #160 adds per-session JSON fields plus the token-gated warning and keeps `CACHE_FIX_THINKING_RISK=off` as warning-signal suppression only; #162 is opt-in via `CACHE_FIX_THINKING_SANITIZE=on`, uses the resolved "drop prior turns plus latest unless active tool-continuation" rule, and records `thinking_blocks_dropped`; #157/#159 is the `ttl-management` guard that skips `thinking` / `redacted_thinking` mutation.
- Packaging is clean. `npm pack --dry-run --json` reports `claude-code-cache-fix-3.8.0.tgz`, includes `proxy/extensions/session-health.mjs` and `proxy/extensions/thinking-block-sanitize.mjs`, includes `proxy/extensions.json`, and contains no `test/`, `docs/`, secrets, or local-worktree cruft. Loader sanity check confirms the packaged config still loads `thinking-block-sanitize:550` and `session-health:590`.
- `node --test` passes `906/906`, matching the expected release baseline.

## Blockers

None.

## What Needs Attention

- None for the release cut itself. The only nuance worth keeping explicit in publish notes is that `thinking-block-sanitize` ships opt-in, not default-on.

## Bloat / Non-Functional

None. This PR is the minimal release cut: version bump plus changelog promotion only.

## Size Baseline

- `package.json` — 61 LOC — single-line version bump only.
- `CHANGELOG.md` — 543 LOC — release heading promotion; the substantive 3.8.0 notes were already present under `Unreleased`.
- `proxy/extensions/bootstrap-defense.mjs` — 286 LOC — unchanged; extension schema version remains `v3.7.1`.
- `proxy/extensions/session-health.mjs` — 152 LOC — read-only warning/telemetry extension.
- `proxy/extensions/thinking-block-sanitize.mjs` — 130 LOC — opt-in sanitize planner and request mutator.
- `proxy/extensions/ttl-management.mjs` — 62 LOC — thinking/redacted-thinking TTL skip guard.
- `proxy/pipeline.mjs` — 120 LOC — dynamic extension loader that makes the unchanged manifest safe for the new files.
- `proxy/extensions.json` — 82 LOC — unchanged manifest; clean packaged config.

## Recommendations

- Approve and merge as the release gate.
- Keep npm publish, tag, and GitHub Release creation gated on Lead approval after merge.

## Bottom Line

Approve. The branch is a clean release cut over already-reviewed feature work: versioning is consistent, the changelog stays inside shipped scope, the packaged artifact contains the intended runtime pieces without stray files, and the full test suite is green at 906/906.
