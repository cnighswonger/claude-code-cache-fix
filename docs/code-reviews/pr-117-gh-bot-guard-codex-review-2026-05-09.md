# Review: gh bot-auth rule + PreToolUse guard documentation

Date: 2026-05-09
Reviewed: `CLAUDE.md`, `~/.claude/hooks/gh-bot-guard.sh`, `~/.claude/settings.json`, `memory/shared/reference_gh_bot_guard_hook.md`
Label applied: `changes-requested`

## What Is Correct

- The operational intent is sound: move the bot-auth rule into an always-loaded surface and add a Bash `PreToolUse` guard so fresh sessions do not default to operator-PAT writes.
- The hook's activation path is cheap when inactive. `~/.claude/settings.json` registers it globally for Bash, but the script exits quickly on non-Bash events, empty commands, and missing markers ([gh-bot-guard.sh](/home/manager/.claude/hooks/gh-bot-guard.sh:11), [gh-bot-guard.sh](/home/manager/.claude/hooks/gh-bot-guard.sh:16), [gh-bot-guard.sh](/home/manager/.claude/hooks/gh-bot-guard.sh:29)).
- Marker discovery and `cwd` fallback behave as intended in the cases I exercised: ancestor walk from a nested directory blocks correctly, and empty `cwd` falls back to `$PWD` cleanly ([gh-bot-guard.sh](/home/manager/.claude/hooks/gh-bot-guard.sh:17), [gh-bot-guard.sh](/home/manager/.claude/hooks/gh-bot-guard.sh:22)).
- The `gh` token regex does not appear to false-positive on arbitrary `gh` substrings such as `length` or `weight`; the command matcher requires a token boundary before `gh` ([gh-bot-guard.sh](/home/manager/.claude/hooks/gh-bot-guard.sh:33)).

## Blockers

- The documented enforcement path is not active in this PR checkout. `CLAUDE.md` says the bot ID lives in `.claude/github-app` and that the guard hook enforces the rule for this repo ([CLAUDE.md](/home/manager/git_repos/claude-code-cache-fix_codex/CLAUDE.md:15), [CLAUDE.md](/home/manager/git_repos/claude-code-cache-fix_codex/CLAUDE.md:23)), and the shared memory goes further by stating `claude-code-cache-fix/.claude/github-app = proxy-builder` ([reference_gh_bot_guard_hook.md](/home/manager/.claude/projects/-home-manager-git-repos-claude-code-cache-fix/memory/shared/reference_gh_bot_guard_hook.md:40)). In this branch checkout there is no `.claude/github-app` at all, so `gh-bot-guard.sh` exits at the no-marker path and plain `gh pr comment ...` is allowed unchanged. I confirmed that exact behavior by replaying the hook with `cwd=/home/manager/git_repos/claude-code-cache-fix_codex`; it returned `exit=0` for a plain PR comment. Until the marker exists where the docs say it exists, the new text overstates protection.
- The hook does not actually require a real inline bot token, and the docs/memory overstate that guarantee. The pass condition is only `grep ... GH_TOKEN=` anywhere in the command string ([gh-bot-guard.sh](/home/manager/.claude/hooks/gh-bot-guard.sh:42)), so all of these pass the guard: `GH_TOKEN= gh pr comment ...`, `gh pr comment ... --body "GH_TOKEN=foo"`, and any other command that merely contains that substring. That means the stated behavior "blocks writes lacking `GH_TOKEN=` prefix" in both `CLAUDE.md` and the memory reference is materially inaccurate ([CLAUDE.md](/home/manager/git_repos/claude-code-cache-fix_codex/CLAUDE.md:15), [reference_gh_bot_guard_hook.md](/home/manager/.claude/projects/-home-manager-git-repos-claude-code-cache-fix/memory/shared/reference_gh_bot_guard_hook.md:10)). For a control intended to prevent accidental identity leaks, allowing body text or an empty env assignment to satisfy the check is too weak.

## What Needs Attention

- Coverage is incomplete relative to the wording "All `gh` writes from this repo". The hook currently matches only selected `issue/pr`, `release`, and `api -X` mutations ([gh-bot-guard.sh](/home/manager/.claude/hooks/gh-bot-guard.sh:33)). It does not catch mutating commands such as `gh secret set`, `gh variable set`, `gh workflow run`, `gh repo create`, or `gh project create`. The shared memory partially acknowledges extensibility, but the repo doc currently reads as if enforcement is already general.
- The "Writes" list in `CLAUDE.md` is also narrower than real operational usage. It omits label edits and assignments even though those commonly occur via `gh issue edit` / `gh pr edit`, and it omits the broader set of mutable `gh` surfaces named above. That is mostly a documentation precision issue once the enforcement gaps are fixed.
- The memory file says there is "no per-call bypass" ([reference_gh_bot_guard_hook.md](/home/manager/.claude/projects/-home-manager-git-repos-claude-code-cache-fix/memory/shared/reference_gh_bot_guard_hook.md:38)). In practice there is an easy per-call bypass today: include `GH_TOKEN=` anywhere on the line, even without a usable token value. That reference should be corrected if the implementation remains loose.

## Recommendations

- Make activation real before merging the docs claim. Either add the `.claude/github-app` marker to the repo/workspace that this policy governs, or narrow the text so it describes the intended rollout rather than present enforcement.
- Tighten the allow condition so it only passes when `GH_TOKEN` is attached to the `gh` invocation as an environment assignment with a non-empty value, not when the substring appears anywhere in user content.
- Expand the write matcher to cover the known mutating `gh` surfaces you rely on operationally, or explicitly scope the docs to the subset currently enforced.
- Update `reference_gh_bot_guard_hook.md` to match the actual implementation exactly; that file is intended to outlive the current script and should not claim marker presence or bypass resistance that is not presently true.

## Bottom Line

The direction is correct, but the current package is not reviewable as "enforced bot-auth" yet. In this checkout the marker the hook depends on is absent, so the guard does not activate, and when it does activate its allow check is weak enough that an empty `GH_TOKEN=` or even comment text containing `GH_TOKEN=` bypasses it. I am requesting changes before this is documented as an active control.

## Verdict

REQUEST CHANGES

---

## Re-review: head `edb8c86` (`2026-05-09`)

Reviewed: `git diff f63ac56..edb8c86`, `.claude/github-app`, `.claude/agent-name`, `.gitignore`, `CLAUDE.md`, `~/.claude/hooks/gh-bot-guard.sh`, `memory/shared/reference_gh_bot_guard_hook.md`
Label applied: `changes-requested`

### What Changed Since The Prior Review

- **Blocker 1 is fixed.** `.claude/github-app` and `.claude/agent-name` are now tracked on the branch, `.gitignore` ignores other `.claude/*` content while unignoring those two routing files, and this checkout now activates the hook as documented. `git ls-files` includes both marker files, and replaying the hook with `cwd=/home/manager/git_repos/claude-code-cache-fix_codex` now blocks plain `gh pr comment ...` with `exit=2`.
- The new early-exit guard does avoid the intended false positives in the cases I exercised. `git commit -m "docs mention gh secret set"` and `printf "%s" "gh pr comment ..."` both return `exit=0`, while `true && gh pr comment ...` still blocks.
- `CLAUDE.md` is materially closer to the real behavior than before. It now names the tracked activation marker and includes the explicit "tripwire, not a security control" disclaimer.

### Remaining Blockers

- **Blocker 2 is not fully fixed.** The updated regex now rejects the empty-assignment and `--body "GH_TOKEN=foo"` cases, but it still accepts a shell comment containing both substrings: `# GH_TOKEN=foo and gh pr comment 117 --body test` returns `exit=0`, not `exit=2`. That directly contradicts the claimed test matrix in the PR thread and means the pass/fail story is still overstated for exactly one of the three bypass shapes raised in the prior review. Because this re-review was specifically asked to verify that all three now reject, this remains blocking.

### What Needs Attention

- The shared memory is no longer precise about bypasses. It says `command gh ...` can evade the regex, but the current hook blocks both `command gh pr comment ...` and `GH_TOKEN=$TOKEN command gh pr comment ...` with `exit=2`. The memory should either describe `command gh` as blocked or the script should be changed to match the documented limitation.
- `CLAUDE.md` does not mention the same nuance, so its "not a security control" language is directionally right, but the canonical shared reference still mismatches the implementation on an important detail.

### Bottom Line

This patch fixed the activation problem and improved the regex substantially, but it did not clear the full blocker set it claimed to clear. The hook still lets the `# GH_TOKEN=foo and gh ...` comment-line case through, and the shared memory now misdescribes `command gh` as a bypass even though the live script blocks it. Review stays at `changes-requested`.
