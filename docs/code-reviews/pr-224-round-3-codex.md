# Review: PR #224 sticky-clear contract re-verification

Date: 2026-06-13
Reviewed: `docs/directives/proxy-statusline-served-model-divergence.md` at `58d41e4`
Round: 3
Verdict: REQUEST_CHANGES
Label applied: `changes-requested`

## What Is Correct

- The three operative sticky-clear sites now state the same contract: clearing sticky requires both persisted JSON removal and in-memory map eviction; file deletion alone is insufficient; restart, stale-session sweep, or a fresh session are all valid ways to lose the map entry. Verified at `docs/directives/proxy-statusline-served-model-divergence.md:61`, `docs/directives/proxy-statusline-served-model-divergence.md:228`, and `docs/directives/proxy-statusline-served-model-divergence.md:237`.
- I did not find a new semantic contradiction in the r4 rewrite of those three sites.

## Blockers

- The exact old phrase `requires a new session` still appears in sticky-clear context, so the round-4 rewrite does not yet satisfy the stated "dropped everywhere" requirement. It survives in the stage summary at `docs/directives/proxy-statusline-served-model-divergence.md:9` and again inside the heuristic-site parenthetical at `docs/directives/proxy-statusline-served-model-divergence.md:61`.

## What Needs Attention

- None beyond the blocker above.

## Bloat / Non-Functional

- None.

## Recommendations

- Remove or rephrase the historical quoted references at `docs/directives/proxy-statusline-served-model-divergence.md:9` and `docs/directives/proxy-statusline-served-model-divergence.md:61` so the old contract text no longer appears anywhere in sticky-clear-related prose.

## Bottom Line

The substantive contract contradiction is fixed, and the three operative sticky-clear sites now align. This round still cannot approve because the directive retains the exact superseded phrase in sticky-clear context, which fails the narrow round-3 acceptance check.

— Codex review
