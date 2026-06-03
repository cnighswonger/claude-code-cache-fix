# Review: worktree-edit-guard implementation — Codex review

Date: 2026-06-03
Reviewed: PR #184 implementation (`hooks/examples/worktree-edit-guard.py`, tests, and docs) at `77ef040`
Label applied: changes-requested

## What Is Correct

- The exit-code contract matches the approved v2 directive: `0` pass-through, `2` deny, with fail-closed only for missing path fields (`hooks/examples/worktree-edit-guard.py:58-84`).
- Tool payload extraction matches the directive and current Claude hooks docs: `file_path` for `Edit` / `Write` / `MultiEdit`, `notebook_path` for `NotebookEdit` (`hooks/examples/worktree-edit-guard.py:19-21,66-71`).
- Worktree detection uses the corrected realpath comparison between `--git-dir` and `--git-common-dir`, and the nested-subdir regular-checkout case is covered (`hooks/examples/worktree-edit-guard.py:34-48`, `test/hook-worktree-edit-guard.test.mjs:155-170`).
- The install docs and matcher shape are correct: `matcher: "Edit|Write|MultiEdit|NotebookEdit"` is the right bare-tool matcher form for `PreToolUse`, and the `settings.json` shape matches Claude Code's current hooks docs (`docs/hooks/worktree-edit-guard.md:28-47`, `hooks/README.md:15-32`, `README.md:234-240`).
- Verification: `node --test test/hook-worktree-edit-guard.test.mjs` passes 17/17, and `npm test` passes 924/924 on this branch.

## Blockers

- Existing-file symlink escapes are still allowed. `resolved_target()` only realpath-resolves `dirname(target)` and then reattaches the basename (`hooks/examples/worktree-edit-guard.py:51-55`), so an `Edit` against `<worktree>/filelink` where `filelink -> /tmp/outside` resolves to `<worktree>/filelink`, not `/tmp/outside`. On `77ef040`, a disposable repro returns `status=0` for that case, which violates the approved strict-containment contract and the directive's explicit "symlink in worktree -> outside" requirement (`docs/directives/hook-worktree-edit-guard.md:28-29,49-53,75-82,149-154,177-180`). This is a load-bearing filesystem-boundary bypass.
- The test that claims to cover the symlink-escape case does not exercise the directive's case. `test/hook-worktree-edit-guard.test.mjs:73-80` uses a symlinked parent directory (`<worktree>/escape/x` where `escape -> /tmp`), not an existing symlink file target (`<worktree>/filelink -> /tmp/outside`). That mismatch is why the suite stays green while the first blocker exists. The approved matrix also explicitly includes a `git` timeout fail-open case, but the implementation swaps that out for malformed-JSON coverage instead (`docs/directives/hook-worktree-edit-guard.md:152-165` vs `test/hook-worktree-edit-guard.test.mjs:190-193`). For a load-bearing hook, those directive/test-plan drifts need to be corrected before approval.

## What Needs Attention

- The relative-path fallback (`if not os.path.isabs(target): target = os.path.join(cwd, target)`) is sensible defense in depth, but Claude's current `PreToolUse` docs describe `Edit` / `Write` paths as absolute. If you intend to keep the fallback, add one explicit test and a short note so future reviewers know it is deliberate rather than accidental (`hooks/examples/worktree-edit-guard.py:76-77`).
- The docs currently describe the hook as realpath-resolving the target and blocking symlink escapes generically (`docs/hooks/worktree-edit-guard.md:8,21-24`). That wording is correct only after the first blocker is fixed; until then it overstates the actual protection.

## Bloat / Non-Functional

- No over-abstraction, dead code, or framework creep. The script is still a small single-purpose hook, and the docs additions are proportionate.
- The over-budget sizes are only partly justified today. The extra 8 script lines are mostly the fail-closed branch and are fine; the extra 43 test lines are not yet pulling their weight because the suite still misses one of the directive's two highest-value edge cases (existing-file symlink escape) and the explicit timeout branch.

## Size Baseline

- `hooks/examples/worktree-edit-guard.py` — 88 LOC — compact single-purpose hook; slight overage, but the current target-resolution shortcut is the main correctness risk.
- `test/hook-worktree-edit-guard.test.mjs` — 193 LOC — straightforward fixture-driven coverage; most of the size is setup/teardown repetition.
- `docs/hooks/worktree-edit-guard.md` — 89 LOC — within budget; install and behavioral contract are clear.
- `hooks/README.md` — 36 LOC — within budget; concise landing page.
- `README.md` — +8 lines — minimal pointer section only.

## Recommendations

- Change target resolution so existing paths use `os.path.realpath(target)` and only not-yet-existing paths fall back to the parent-dir reconstruction path. `os.path.lexists(target)` is the right existence check if you want broken symlinks treated as existing symlink objects rather than as "new file under parent".
- Replace the current "symlink escape" test with the actual directive case: an existing symlink file inside the worktree pointing outside. Keep the current parent-symlink scenario as the separate not-yet-existing `Write` case.
- Add a deterministic `git` timeout test, e.g. by prepending a fake `git` on `PATH` that sleeps past the 2-second timeout, so the approved fail-open environmental branch is actually exercised.
- After the code fix lands, recheck the docs language so the claimed protection matches the implemented containment behavior exactly.

## Bottom Line

Revise before approval. The overall shape is close: the hook contract, tool-field extraction, worktree detection, and install docs are all in the right place, and the branch is green. But the load-bearing symlink-escape requirement from the approved v2 directive is not actually satisfied for an existing symlink file target, and the current tests miss that exact case while also dropping the approved timeout case. That is too much drift for a filesystem-boundary guard.
