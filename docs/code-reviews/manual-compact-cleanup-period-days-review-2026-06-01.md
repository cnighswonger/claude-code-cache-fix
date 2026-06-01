# Review: MANUAL-COMPACT cleanupPeriodDays note

Date: 2026-06-01
Reviewed: tools/MANUAL-COMPACT.md (PR #176)
Label applied: changes-requested

## What Is Correct

- The new subsection is placed correctly under `## Limitations` and matches the surrounding "what happens / what to do" framing.
- The core mechanism being documented is real and locally supported: `cleanupPeriodDays` exists in `~/.claude/settings.json`, defaults to 30 in the settings schema, the transcript deletion check is `mtime`-based, and the matching `<session-id>/` companion directory is co-deleted when the transcript is selected.
- Repo verification is clean: `node --test` passed `906/906`.

## Blockers

1. `tools/MANUAL-COMPACT.md:160` overstates the trigger frequency. The local cleanup lab and upstream issue notes support "startup-triggered cleanup when the housekeeping gate fires," but not "on every fresh `claude` startup." The validated path is gated by the `~/.claude/.last-cleanup` freshness window, so this sentence should be narrowed to match the behavior we actually proved.
2. `tools/MANUAL-COMPACT.md:164` overstates the in-tree backup claim. The evidence here supports deletion of stale `.jsonl` files plus the matching companion directory; it does not support the broader statement that copying the file in-place "as a `.bak`" still gets swept. Narrow this to a case the evidence proves (for example, another in-tree `.jsonl`) or remove the example.

## What Needs Attention

- `tools/MANUAL-COMPACT.md:166` is directionally right, but the `relatime` / `noatime` explanation is looser than needed. The load-bearing fact is simply that cleanup keys off `mtime`, and plain reads do not refresh `mtime`.

## Bloat / Non-Functional

None. The subsection is the right size and in the right place for the risk it is documenting.

## Size Baseline

- tools/MANUAL-COMPACT.md — 196 LOC — one 12-line addition in the existing `Limitations` cluster; scope remains doc-local.

## Recommendations

- Reword the lead sentence to describe startup/housekeeping-triggered cleanup without claiming it runs on every launch.
- Replace the `.bak` example with a claim the available evidence actually proves, or drop it and keep the simpler out-of-tree preservation guidance.
- Simplify the third bullet to "reads don't refresh `mtime`, so inspection doesn't extend retention."

## Bottom Line

Revise before approval. The subsection is useful, appropriately scoped, and mostly grounded in the right evidence, but two concrete claims currently reach beyond what the local lab and source artifacts support.
