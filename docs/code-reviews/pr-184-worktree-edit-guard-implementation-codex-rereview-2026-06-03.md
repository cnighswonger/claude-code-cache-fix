# Review: worktree-edit-guard implementation rereview — Codex review

Date: 2026-06-03
Reviewed: PR #184 implementation (`hooks/examples/worktree-edit-guard.py`, tests, and docs) at `eca4cda`
Label applied: reviewed-by-codex-agent, approved-by-codex-agent

## What Is Correct

- `resolved_target()` now does the right split: existing paths use `os.path.lexists(target)` plus `os.path.realpath(target)`, while not-yet-existing leaves still use `realpath(dirname) + basename`. That closes the round-1 existing-symlink-file escape without regressing the parent-symlink case for future writes (`hooks/examples/worktree-edit-guard.py:51-60`).
- Verified manually on a disposable repo/worktree: `ln -s /tmp/outside wt/filelink` plus an `Edit` payload for `wt/filelink` now returns exit `2`, and stderr names `/tmp/outside` rather than the symlink path.
- The test drift is fixed. The suite now has separate coverage for the directive's target-symlink case, the symlinked-parent case, the deterministic git-timeout fail-open branch, and the relative-path fallback (`test/hook-worktree-edit-guard.test.mjs:73-92,189-217`).
- Verification: `node --test test/hook-worktree-edit-guard.test.mjs` passes `20/20`, and `npm test` passes `927/927` on `eca4cda`.
- The relative-path `cwd`-join fallback is a reasonable defense-in-depth choice (`hooks/examples/worktree-edit-guard.py:81-83`, `test/hook-worktree-edit-guard.test.mjs:207-217`). I do not think the user-facing docs need to promise it explicitly because Claude's documented hook payloads are absolute; the code comment and dedicated test are enough.
- Edge behavior is graceful: existing directories and unreadable files resolve normally, broken symlinks are blocked based on their resolved destination, and symlink loops do not crash the hook.

## Blockers

None.

## What Needs Attention

- `docs/hooks/worktree-edit-guard.md:80-83` still says `~88` lines and `17` test cases. Current head is 93 LOC and 20 tests. That is documentation count drift, not a merge blocker.

## Bloat / Non-Functional

- The round-2 fix is proportionate: a small resolver correction, three targeted tests, and matching doc wording. No new abstractions, dead code, or framework creep.
- The timeout test adds about 6 seconds because the hook performs three 2-second-capped `git` probes. That cost is acceptable here because it directly proves the required fail-open environmental branch.

## Size Baseline

- `hooks/examples/worktree-edit-guard.py` — 93 LOC — still compact; the load-bearing path-resolution logic remains local and readable.
- `test/hook-worktree-edit-guard.test.mjs` — 235 LOC — fixture-heavy, but it now covers the directive's highest-risk cases directly.
- `docs/hooks/worktree-edit-guard.md` — 89 LOC — user-facing behavior docs are accurate after the round-2 wording fix.
- `hooks/README.md` — 36 LOC — concise landing page.
- `README.md` — +8 lines — minimal pointer section only.

## Recommendations

- Approve from the Codex slot. Merge still requires Lead and Chris human review because this hook is load-bearing per `CLAUDE.md`.
- Optional follow-up: update the implementation-note counts in `docs/hooks/worktree-edit-guard.md` to 93 LOC / 20 tests the next time that file is touched.

## Bottom Line

Approve. The round-1 blockers are cleanly closed at `eca4cda`: the existing-symlink-file escape is fixed in the load-bearing resolver path, the tests now exercise the real directive cases, the git-timeout fail-open branch is covered deterministically, and I did not find a new containment regression in the added `lexists`/`realpath` branch. This satisfies the Codex approval slot; merge still requires Lead and Chris human review.
