# Review: worktree-edit-guard directive

Date: 2026-06-03
Reviewed: PR #183 directive (`docs/directives/hook-worktree-edit-guard.md`) at `179cca9`
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- Blocker 1 is resolved. The directive now uses `exit 2` as the blocking contract in the scope, hook input/output contract, and test matrix, while `exit 1` is retained only as an explicit non-blocking warning about the old mistake (`docs/directives/hook-worktree-edit-guard.md:22-30,100-105,145-165`).
- Blocker 2 is resolved. The new tool-payload table correctly distinguishes `file_path` for `Edit` / `Write` / `MultiEdit` from `notebook_path` for `NotebookEdit`, and `MultiEdit` is now modeled as one top-level path plus an `edits` array rather than per-edit paths. The test matrix reflects the same shapes (`docs/directives/hook-worktree-edit-guard.md:60-71,155-160`).
- Blocker 3 is resolved. The worktree detection rule is now realpath equality between `git rev-parse --git-dir` and `git rev-parse --git-common-dir`, which is the right depth-stable distinction between a regular checkout and a linked worktree. I rechecked this both in this repo from `docs/` and in a disposable `git worktree add` fixture: nested-subdir regular checkout resolves both paths to the same `.git`, while the linked worktree resolves `--git-dir` under `.git/worktrees/...` and `--git-common-dir` to the main `.git`. The test plan now includes the nested-subdir non-worktree case (`docs/directives/hook-worktree-edit-guard.md:84-94,161-162`).
- Blocker 4 is resolved. The NFR section now marks the change `Load-bearing? Yes` and explicitly carries the Chris human-review gate required by `CLAUDE.md` for security-relevant changes (`docs/directives/hook-worktree-edit-guard.md:175-181`, `CLAUDE.md:86-94`).
- The new v2 additions are directionally right. The fail-open vs fail-closed split is sensible as written, the expanded test matrix covers the newly important escape and schema-drift cases, and the strict-containment section accurately warns that `--add-dir` / `permissions.additionalDirectories` remains intentionally incompatible with this hook (`docs/directives/hook-worktree-edit-guard.md:58,71,134-141,153-165`).

## Blockers

None.

## What Needs Attention

- `docs/directives/hook-worktree-edit-guard.md:34` says `hooks.PreToolUse.matchers`, but the configuration examples and current Claude docs use singular `matcher`.
- `docs/directives/hook-worktree-edit-guard.md:16,42` still use `file_path` as a generic shorthand for the four-tool surface. The executable contract is correct now, so this is wording cleanup rather than a directive-stage blocker.

## Bloat / Non-Functional

None. v2 added the missing contract precision without adding avoidable abstraction or widening the scope.

## Size Baseline

- `docs/directives/hook-worktree-edit-guard.md` — 199 LOC — still compact for a load-bearing hook directive; most of the growth is corrective contract detail and test coverage.
- `CLAUDE.md` — 132 LOC — policy baseline only; the directive now matches its load-bearing gate.

## Recommendations

- Approve the directive for implementation and apply `plan-approved`.
- Keep Chris human review as a required merge gate because this directive is now correctly classified as load-bearing.
- Clean up the stray `matcher` / generic-`file_path` wording during implementation or docs polish, but do not reopen directive stage over it.

## Bottom Line

Approve. The v2 directive at `179cca9` closes all four round-1 blockers, the new fail posture and expanded test matrix are sensible, and I do not see a new directive-level issue that warrants another `changes-requested` round.

— Codex review
