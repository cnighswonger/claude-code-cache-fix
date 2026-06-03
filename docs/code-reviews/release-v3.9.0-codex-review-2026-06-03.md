# Review: release v3.9.0

Date: 2026-06-03
Reviewed: PR #187 release payload (`release/v3.9.0`) at `5ada94c`
Label applied: `changes-requested`

## What Is Correct

- `git diff --name-only main...5ada94c` contains only `package.json` and `CHANGELOG.md`; the release payload itself is minimal and matches the expected "version bump + changelog promotion" shape. The only later branch delta is this review artifact, committed per workflow.
- The semver bump to `3.9.0` is correct for this release. The bundled scope is two backward-compatible, user-visible additions (`auto-1m-guard` and `worktree-edit-guard`) plus smaller fixes/docs updates, with no breaking default-behavior change (`package.json:3`, `CHANGELOG.md:7-45`).
- The `hooks/` allowlist change is correct and necessary. `npm pack --dry-run` on `5ada94c` produces `claude-code-cache-fix-3.9.0.tgz`, includes both `proxy/extensions/auto-1m-guard.mjs` and `hooks/examples/worktree-edit-guard.py`, includes `hooks/README.md`, and shows no `__pycache__`, `.pyc`, or other local build artifacts (`package.json:14-24`).
- The v3.9.0 changelog descriptions for both bundled features match the already-merged implementations and approved directives: `auto-1m-guard` is a header-based warn/strip proxy extension with the documented `off|warn|strip` modes and top-level `auto_1m_*` telemetry handoff, while `worktree-edit-guard` is the shipped `PreToolUse` hook example with strict realpath containment and the `exit 2` block contract (`CHANGELOG.md:11-27`).
- The binary-walk note is aligned with the directive and implementation comments: the sanitizer/gate/kill-switch translation table (`sL/kJ`, `W2/bZ`, `xKH/E9H`) and the "wire-visible signal is the `anthropic-beta` token, not `req.body.model`" conclusion are consistent with the merged directive and extension header comment (`CHANGELOG.md:15`, `docs/directives/proxy-auto-1m-guard.md:13-15`, `proxy/extensions/auto-1m-guard.mjs:5-12`).
- The symlink-escape note is accurate. The existing-target symlink bypass was caught in Codex review and fixed in `eca4cda` by switching `resolved_target()` to `os.path.lexists(target)` plus direct `realpath(target)` for existing targets, while preserving the parent-dir fallback for not-yet-existing paths (`CHANGELOG.md:25`, `hooks/examples/worktree-edit-guard.py:50-60`).
- Release-safety validation on the exact release commit passed locally: `npm test` completes `950/950`, and the packaged tarball contents are the expected runtime files for v3.9.0.
- `git log --oneline v3.8.0..HEAD` shows eight commits. The changelog covers the substantive user-facing landings in that range; the omitted `TRACKED_ISSUES.md` housekeeping commit is not release-note material.
- Merge safety is clean relative to upstream content: the branch is `0` behind `origin/main` and `1` ahead, and GitHub reports `mergeable: MERGEABLE` for PR #187. The current `mergeStateStatus: BLOCKED` is review-gate state, not a merge-conflict signal.

## Blockers

- `CHANGELOG.md:45` publishes an internal dashboard address (`http://192.168.1.201:8091/index.html`) in a public tracked file. Repo policy explicitly forbids literal IPs and internal service ports in tracked files, including `CHANGELOG.md` (`CLAUDE.md:102-120`). This needs to be replaced with a placeholder plus a pointer to internal deployment notes before the release can be approved.

## What Needs Attention

- After the blocker above is fixed, refresh PR metadata and re-run the review gate. No additional code/package changes are indicated from this review.

## Bloat / Non-Functional

- None in the release cut itself. The PR stays appropriately small; the only problem is release-note hygiene.

## Size Baseline

- `package.json` — 62 LOC — one-line semver bump; `files` allowlist now ships `hooks/`.
- `CHANGELOG.md` — 585 LOC — release promotion plus v3.9.0 notes.
- `proxy/extensions/auto-1m-guard.mjs` — 117 LOC — shipped proxy extension summarized by this release.
- `hooks/examples/worktree-edit-guard.py` — 93 LOC — shipped hook example summarized by this release.
- `test/proxy-auto-1m-guard.test.mjs` — 191 LOC — 23-case extension/helper suite contributing to the new 950 total.
- `test/hook-worktree-edit-guard.test.mjs` — 235 LOC — 20-case hook suite already approved in the implementation PR.

## Recommendations

- Remove the literal cc-triage dashboard URL from `CHANGELOG.md` and replace it with a generic reference such as "internal cc-triage dashboard (see internal deployment notes)."
- Keep the rest of the release cut unchanged. The version bump, tarball contents, test gate, and substantive changelog scope are already in good shape.
- After the scrub commit lands, re-request final release approvals.

## Bottom Line

Revise, then ship. The release mechanics are sound: `3.9.0` is the right semver bump, `npm test` passes `950/950` on the exact release commit, `npm pack --dry-run` ships the intended new hook and proxy artifacts, and the v3.9.0 notes otherwise match what landed between `v3.8.0` and `5ada94c`. The current blocker is the new changelog line that leaks an internal dashboard IP/port into a public repo file, which violates the repo's own release-hygiene rule and should not merge or tag as-is.
