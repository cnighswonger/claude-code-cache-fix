# Review: manual-compact hotfix

Date: 2026-05-29
Reviewed: PR #169 (`fix/manual-compact-opus-relax-truncation`) at `2e39d1f` (docs-only re-confirm against prior approval at `677d094`)
Label applied: `approved-by-codex-agent`

## What Is Correct

- `git diff --name-only 677d094 2e39d1f` contains only `CHANGELOG.md` and `tools/MANUAL-COMPACT.md`, and `git diff 677d094 2e39d1f -- tools/manual-compact.sh` is empty, so the executable tool remains exactly the version already approved at `677d094`.
- The new troubleshooting note is accurate and closes the exact non-blocking operator gap from the prior review: it explains that the stderr-swallowed summarizer path can surface an oversized-input rejection as empty summary output, and it gives the two right mitigations (`MANUAL_COMPACT_MODEL='claude-opus-4-7[1m]'` or lowering the extraction caps) (`tools/MANUAL-COMPACT.md:162-167`).
- The changelog entry reads correctly for a shipped `tools/` change: it captures the Opus default, the `MANUAL_COMPACT_MODEL` override, the relaxed truncation caps, and the new troubleshooting note in one concise user-facing line (`CHANGELOG.md:3-7`).
- Local sanity check remains clean: `bash -n tools/manual-compact.sh` passes at `2e39d1f`.

## Blockers

None.

## What Needs Attention

- None. The only post-approval changes are the two doc updates requested by the earlier reviews, and both are now in place.

## Bloat / Non-Functional

None. The follow-up is tightly scoped to operator guidance and release-note hygiene, with no scope creep beyond the two non-blocking caveats already raised.

## Size Baseline

- `tools/manual-compact.sh` — 220 LOC — unchanged executable path from the previously approved head.
- `tools/MANUAL-COMPACT.md` — 184 LOC — operator guide with the new troubleshooting note added.
- `CHANGELOG.md` — 91 LOC — release notes with one new `[Unreleased]` changed entry.

## Recommendations

- Re-approve PR #169 at `2e39d1f` as a docs-only follow-up on top of the already-approved implementation.
- Refresh `approved-by-codex-agent` so the marker matches the current approved head.

## Bottom Line

Approve the current head. The executable script is unchanged from the earlier approved commit, and the two docs-only follow-ups accurately fold in the exact caveats raised by the prior Codex and code-agent reviews.
