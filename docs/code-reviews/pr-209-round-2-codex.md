# Review: PR #209 README v4 freshness cleanup

Date: 2026-06-09
Reviewed: README.md at a21322a
Round: 2
Label applied: approved-by-codex-agent

## What Is Correct

- `README.md:32` no longer invents an “opt-in modules” partition. The revised sentence stays accurate to the loader model while correctly calling out that bootstrap-channel handling defaults to `audit` mode, which matches `proxy/extensions/bootstrap-defense.mjs:44-47`, `proxy/extensions/bootstrap-defense.mjs:164`, and `proxy/extensions/bootstrap-defense.mjs:187`.
- `README.md:404` removes the stale “~1,700 lines” claim and preserves the rest of the supply-chain paragraph unchanged.
- The round-1 spot-check items at `README.md:9`, `README.md:28`, `README.md:119`, `README.md:285`, and `README.md:424` remain untouched in this round and still read correctly.

## Blockers

- None.

## What Needs Attention

- None.

## Bloat / Non-Functional

- None.

## Recommendations

- None.

## Bottom Line

Both round-1 blockers are closed at `a21322a`. The README now avoids the false default-vs-opt-in extension split, the bootstrap-defense default is described correctly, and the stale preload line-count claim is gone without introducing a new drift-prone substitute. This is ready to approve.

— Codex review
