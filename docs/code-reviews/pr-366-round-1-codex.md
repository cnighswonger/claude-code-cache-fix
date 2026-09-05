# Review: PR #366 WORKAROUND_CATALOG durable snapshot recipe

Date: 2026-09-05
Reviewed: PR #366 (`WORKAROUND_CATALOG.md`) at head `713989ce053a28e2636b1a7efafa84d367570b0d`
Round: 1
Label applied: `changes-requested`

## What Is Correct

- [Read] The new subsection does not reintroduce the retracted signed-int32-overflow mechanism. The existing entry still says the int32 hypothesis was retracted and the mechanism is unresolved (`WORKAROUND_CATALOG.md:80-101`), while the added recipe explicitly frames the snapshot mitigation as mechanism-independent (`WORKAROUND_CATALOG.md:103-105`).
- [Read] The subagent fallback is coherent at the docs level. The daily `find ~/.claude/projects/ -type f -mtime +20 -exec touch {} +` traversal reaches nested per-session trees, and the fallback explicitly names `~/.claude/projects/<key>/<sid>/subagents/` plus `~/.claude/history.jsonl` as reconstruction sources (`WORKAROUND_CATALOG.md:111`, `WORKAROUND_CATALOG.md:129`).
- [Measured] I found no client/customer/project identifiers or origin secrets in the PR diff. Command: `gh pr diff 366 --repo cnighswonger/claude-code-cache-fix | rg -n '(/home/|visits-|vsits|client|customer|project name|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+|ssh-rsa|BEGIN .*PRIVATE|api[_-]?key|token|secret)'` exited 1 with no matches.
- [Measured] `Closes #364` targets the intended open issue. `gh issue view 364 --repo cnighswonger/claude-code-cache-fix --json number,state,title` reports issue 364 as `OPEN`, titled `docs(WORKAROUND_CATALOG): add durable-snapshot + touch-refresh workaround stack for CC#41458 (session-JSONL loss)`.
- [Measured] The upstream status references still match the catalog context: `gh issue view 62272 --repo anthropics/claude-code --json state,stateReason,closedAt` reports `CLOSED`, `DUPLICATE`, `2026-08-19T20:52:54Z`; `gh issue view 41458 --repo anthropics/claude-code --json state` reports `OPEN`.

## Blockers

1. [Read] The restore command omits the `projects/` path component from the archive side, so it does not match the snapshot shape documented four lines earlier. The stack says the hourly job snapshots all of `~/.claude/` to `<archive>/snap-*` (`WORKAROUND_CATALOG.md:110`), which means project directories would restore from something like `<archive>/snap-<ts>/projects/<project-key>/`. The restore step instead says `rsync -a <archive>/snap-<pre-loss-timestamp>/-home-manager-... ~/.claude/projects/-home-manager-.../` (`WORKAROUND_CATALOG.md:125`). That command only works if the archive root is already `~/.claude/projects/`, contradicting the "not just `projects/`" invariant. Fix the example to include `projects/<project-key>/` on the source side, or explicitly document that `<archive>` points at the snapshot's `projects/` subdirectory.

## What Needs Attention

- [Measured] CI was not green at review time. `gh pr view 366 --repo cnighswonger/claude-code-cache-fix --json statusCheckRollup` showed Node 18, 20, and 22 test jobs `IN_PROGRESS`; GitGuardian and Snyk were `SUCCESS`. This PR is docs-only, so I did not run `uv run pytest -q`.

## Bloat / Non-Functional

- [Measured] Proportionate. The PR touches only `WORKAROUND_CATALOG.md` with 28 additions and 0 deletions: `gh pr diff 366 --repo cnighswonger/claude-code-cache-fix | awk ...` reported `additions=28 deletions=0`.

## Recommendations

1. Replace the restore command with a placeholder form that preserves the documented whole-`~/.claude/` archive layout, for example `rsync -a <archive>/snap-<pre-loss-timestamp>/projects/<project-key>/ ~/.claude/projects/<project-key>/`.
2. Keep the mechanism-independent wording as-is; it correctly avoids reviving the PR #359 int32-overflow framing.

## Bottom Line

Request changes. The new workaround section is directionally sound and avoids the retracted mechanism claim, but the restore command is load-bearing for the documented operational recipe and currently points at the wrong archive path for the snapshot shape the PR recommends.

— Codex, cross-LLM review, round 1
