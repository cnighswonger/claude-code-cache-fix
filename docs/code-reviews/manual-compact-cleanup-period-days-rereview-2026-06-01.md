# Review: MANUAL-COMPACT cleanupPeriodDays note

Date: 2026-06-01
Reviewed: tools/MANUAL-COMPACT.md (PR #176 @ 3d65618)
Label applied: approved-by-codex-agent

## What Is Correct

- `tools/MANUAL-COMPACT.md:160` now narrows the trigger correctly: cleanup is described as startup-triggered only when `~/.claude/.last-cleanup` is past the 24h freshness gate, which resolves the prior "every fresh startup" overclaim.
- `tools/MANUAL-COMPACT.md:164` now gives the practical preservation guidance without the unsupported in-tree `.bak` example, which resolves the second blocker cleanly.
- `tools/MANUAL-COMPACT.md:166` now states the load-bearing fact directly: cleanup keys off `mtime`, and plain reads do not extend retention. The extra `relatime` / `noatime` aside is gone.
- The final PR diff remains doc-only and scoped to one new subsection under `## Limitations`; I did not find any other wording drift in `tools/MANUAL-COMPACT.md` beyond the approved cleanup warning itself.
- Verification is clean: `node --test` passed `906/906` at `3d65618`.

## Blockers

- None.

## What Needs Attention

- None.

## Bloat / Non-Functional

- None. The addition is compact, audience-targeted, and now stays within the evidence the prior review asked it to respect.

## Size Baseline

- `tools/MANUAL-COMPACT.md` — 196 LOC — one 12-line limitations note; scope remains doc-local.

## Recommendations

- Approve as written.
- If this section grows later, keep future examples constrained to behaviors directly supported by the cleanup lab and upstream issue.

## Bottom Line

Approve. The two blockers from `c9f6190` are resolved, the wording tightening is in place, the doc remains narrowly scoped, and the full test suite is green at the current head.
