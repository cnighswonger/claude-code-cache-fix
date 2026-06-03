# Review: worktree-edit-guard directive

Date: 2026-06-03
Reviewed: PR #183 directive (`docs/directives/hook-worktree-edit-guard.md`)
Label applied: `changes-requested`

## What Is Correct

- The directive is appropriately narrow for directive stage: one small user-side hook, explicit out-of-scope boundaries around Bash/subprocess writes and read-side access, and no unnecessary proxy coupling.
- The strict-containment direction is defensible. "Edits stay inside the active worktree" is easier to reason about than a special-case parent-checkout rule, and it closes the obvious arbitrary out-of-tree write class as well as the parent-checkout corruption case.
- The non-existent-target approach is directionally right. Resolving the parent directory before reattaching the basename is the correct shape for preserving symlink-escape protection when the target file does not exist yet.
- The anti-bloat framing is good. An example hook under ~80 LOC with no shared module or framework is the right implementation target for this behavior.

## Blockers

- `docs/directives/hook-worktree-edit-guard.md:21-22`, `:68-71`, and the test table at `:108-117` specify "exit non-zero" / `exit 1` as the blocking path. Current Claude Code hook behavior does not work that way: for `PreToolUse`, only `exit 2` blocks via stderr feedback, or `exit 0` plus structured `hookSpecificOutput.permissionDecision: "deny"` blocks via JSON. `exit 1` is a non-blocking hook error and the tool call still proceeds. As written, the directive's core enforcement contract is wrong.
- `docs/directives/hook-worktree-edit-guard.md:17-22`, `:64-71`, and `:112-118` assume the in-scope tools all expose `tool_input.file_path`, with `MultiEdit` paths under `tool_input.edits[i].file_path`. That does not match the current tool schemas: `NotebookEdit` uses `tool_input.notebook_path`, and `MultiEdit` is a single-file edit with one top-level `file_path`, not per-edit paths. In its current form the spec would fail to guard notebook edits and would implement/test the MultiEdit branch against the wrong payload shape.
- `docs/directives/hook-worktree-edit-guard.md:60-63` says a regular checkout can be detected when `git rev-parse --git-common-dir` equals `.git`. That is only true at the repo root. From a normal subdirectory in a regular checkout, Git returns a relative path like `../.git`, so this rule would misclassify ordinary non-worktree sessions as worktrees and unexpectedly enforce containment there. That contradicts the directive's "safe to install globally" / non-worktree pass-through claim.
- `docs/directives/hook-worktree-edit-guard.md:130-134` marks the change as `Load-bearing? No`, but `CLAUDE.md:86-94` says the answer must be yes for anything security-relevant. This hook is a filesystem-boundary enforcement control and the directive's own threat model explicitly centers on symlink escape and out-of-tree writes. That is security-relevant enough to require Chris review before merge, so the current load-bearing classification is not correct.

## What Needs Attention

- The strict-containment choice should explicitly call out intentional multi-root sessions as a false-positive class, not just "writing to the parent checkout intentionally." Claude Code supports extra writable directories via `--add-dir` / `permissions.additionalDirectories`; this hook would still block them by design unless the user disables or narrows it.
- The test plan should add the case that actually validates the non-existent-path fallback against symlink escape: `Write` or `NotebookEdit` to a not-yet-created target whose parent directory inside the worktree is a symlink to a location outside the worktree.
- The non-worktree pass-through behavior should be tested from a nested subdirectory, not just from the repo root, because that is where the current `--git-common-dir == .git` rule breaks.
- If fail-open remains the posture, keep it scoped to environmental failures such as `git` timeout / permission problems. Missing or unexpected path fields on an in-scope tool should not silently disable the protection without at least an explicit error path.

## Bloat / Non-Functional

- None on size or scope. The problem here is contract precision, not over-engineering: this is still the right size and shape for a leaf hook once the tool-schema, blocking-contract, and worktree-detection details are corrected.

## Size Baseline

- `docs/directives/hook-worktree-edit-guard.md` — 150 LOC — compact directive with a good narrow cut, but several load-bearing contract details are currently wrong.
- `CLAUDE.md` — 132 LOC — policy baseline for the load-bearing and NFR checks applied in this review.

## Recommendations

- Change the enforcement contract to either `exit 2` with stderr feedback or structured `hookSpecificOutput.permissionDecision: "deny"` output, and align the test table with that exact blocking mechanism.
- Update the tool-path extraction rules to match the current tool contracts: `file_path` for `Edit` / `Write` / `MultiEdit`, `notebook_path` for `NotebookEdit`. Add explicit NotebookEdit allow/block tests.
- Replace the regular-checkout detection rule with a path-stable check, for example comparing the realpaths of `git rev-parse --git-dir` and `git rev-parse --git-common-dir`, or another documented equivalent that works from nested subdirectories.
- Reclassify the directive as load-bearing and call out Chris review as a required gate before merge.
- Keep strict-containment if desired, but document the deliberate incompatibility with intentional extra writable directories so users understand the tradeoff before enabling it globally.

## Bottom Line

Request changes for directive stage. The overall idea is sound and the scope is small, but the current spec misstates the hook blocking contract, two of the in-scope tool payloads, the regular-checkout detection rule, and the load-bearing gate. Fix those directive-level contract errors and this should be ready for rereview.

— Codex review
