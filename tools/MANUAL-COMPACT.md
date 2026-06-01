# manual-compact.sh — Manual Compaction for 1M Context Hack Sessions

## Purpose

When using the 1M context window hack (`DISABLE_COMPACT=1` + `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000`), the `/compact` command is disabled by CC. This tool provides a manual compaction alternative: extract the conversation, summarize it via Claude, and restore context after `/clear`.

**This tool is specifically for sessions running the 1M hack.** If you have `/compact` available, use that instead — it's built-in, integrated, and handles the full compaction lifecycle automatically.

## How It Works

1. Extracts conversation turns from the session JSONL transcript
2. Splits turns into three weighted segments:
   - **Foundational** (first 20%) — truncated to 300 chars each
   - **Working** (middle 40%) — truncated to 1500 chars each
   - **Active** (last 40%) — preserved up to 8000 chars each
3. Sends the weighted extract to Claude Opus for summarization
4. Produces a structured summary optimized for agent handoff

The weighting ensures recent active work (the part you're most likely to need) gets full detail, while earlier completed work is compressed.

## Usage

```bash
# By project directory (recommended) — auto-finds the most recent session
manual-compact.sh ~/git_repos/myproject

# By project directory with user context
manual-compact.sh ~/git_repos/myproject /tmp/context.txt

# By direct JSONL path (if you know the exact session)
manual-compact.sh ~/.claude/projects/-home-user-git-repos-myproject/abc123.jsonl

# By direct JSONL path with user context
manual-compact.sh ~/.claude/projects/-home-user-git-repos-myproject/abc123.jsonl /tmp/context.txt
```

When you pass a project directory, the tool:
1. Converts it to CC's internal project path format
2. Finds the most recently modified session JSONL
3. Shows you the session details (modified date, size)
4. **Asks for confirmation** before proceeding

### WARNING: Wrong Session = Wrong Context

**If you select the wrong session JSONL, the summary will be from a completely different conversation.** Loading that summary after `/clear` will inject false context — the agent will confidently act on information from another session, another project, or another agent's work.

Always:
- Verify the session timestamp matches your active session
- Review the summary output before feeding it to an agent
- When in doubt, check the last few lines of the JSONL to confirm it's the right conversation

### Example: Basic Compaction

```bash
./tools/manual-compact.sh ~/git_repos/kanfei-nowcast-e3b
```

```
Project directory: ~/git_repos/your-project
Auto-detected session: db11f377-4ca8-4fc3-9b6d-1069da58c1b2.jsonl
  Modified: 2026-04-19 13:26:42
  Size: 4.8M

Is this the correct session? [Y/n]
```

Output: `/tmp/db11f377-...-compact-summary.txt`

### Example: With User Context

If there's specific context you know the summary might miss:

```bash
echo "The MR2 OOM debugging took 3 days. The PR #75 architectural recommendation
was max(dualpol_lr, hail_lr) for correlation grouping." > /tmp/context.txt

./tools/manual-compact.sh ~/git_repos/kanfei-nowcast-e3b /tmp/context.txt
```

The user context is injected into the summarization prompt, ensuring those details appear in the output.

### Pre-Clear Agent Review (Recommended)

Before `/clear`, let the agent review the summary while it still has full context. Paste this prompt into the session:

```
I'm about to /clear this session. Read /tmp/<session-id>-compact-summary.txt — that's the summary that will be used to restore context after the clear.

Review it against your current knowledge and do the following:

1. Write a SESSION_STATE.md in this project directory that captures anything the summary missed — especially:
   - Active work state details the summary got wrong or understated
   - Decisions made and their rationale that aren't in the summary
   - Context about collaborators, dependencies, or constraints
   - Anything you'd need to know to resume work that isn't recoverable from git

2. Write any critical findings to memory files (if your project uses them) that should persist across sessions.

3. Tell me what's missing from the summary so I can verify the gap is covered.

Do NOT do a /clear yourself. I will do it after you've finished writing.
```

Replace `<session-id>` with the actual path shown in the script output.

The agent will identify gaps while it still has the context to fill them. This typically raises summary fidelity from ~85% to ~95%+.

### Restoring Context After /clear

In the CC session:

```
/clear
```

Then as your first message:

```
Read /tmp/<session-id>-compact-summary.txt for context on where we left off. Also read SESSION_STATE.md in this directory for additional context the summary may have missed.
```

## Limitations

### This tool is a workaround, not a replacement for /compact

- `/compact` operates inside CC with full access to the internal message array, system prompt, tool schemas, and session state. This tool only sees the JSONL transcript, which is a subset.
- `/compact` preserves CC's internal state (tool registration, MCP connections, plugin state). This tool + `/clear` resets all of that. The agent must re-establish any stateful connections.
- `/compact` is atomic — one command, seamless continuation. This tool requires `/clear` + paste, which is a hard context boundary.

### Summary fidelity

Tested at ~95% fidelity for active work resumption, ~70% for broader project context. Gaps typically include:

- **Operational debugging history** — multi-day debugging sagas compress away
- **Timeline information** — the summary doesn't indicate when things happened or how long they took
- **Depth of architectural discussions** — detailed technical recommendations get compressed to one-liners
- **Background process context** — overnight watchers, cron monitoring, polling patterns

Use the user context file to fill known gaps.

### Token cost

Two costs to account for:

1. **Summarization call** — the `claude --print` call through Opus. With the relaxed recent-turn caps the extract is larger (and Opus costs more per token than Sonnet), so expect a few % Q5h rather than ~1-2%. The tradeoff buys markedly higher-fidelity summaries; override with `MANUAL_COMPACT_MODEL=claude-sonnet-4-6` if you need to minimize cost.
2. **Cold start after /clear** — the first API call rebuilds the full cache from scratch. Real-world example from a 954K-token session:

```
Before /clear:  cache_read=954,399  cache_creation=0      (warm)
First call:     cache_read=0        cache_creation=954,399 (cold rebuild)
Second call:    cache_read=957,253  cache_creation=5,569   (warm again)
```

The cold rebuild consumed ~15% Q5h in one call on our Max 5x account. After that single rebuild, the session is warm again and cache hits resume at 99%+.

**Total cost of a manual compact cycle:** roughly ~15% cold rebuild plus a few % for the Opus summarization. Compare to hitting the 1M wall and losing the session entirely.

### Stale transcripts get swept (CC's `cleanupPeriodDays`)

Heads up if you're treating the on-disk `.jsonl` as a "keep just in case" backup after `/clear`: it isn't durable. Claude Code maintains a transcript-retention setting `cleanupPeriodDays` in `~/.claude/settings.json` (default 30 days). On every fresh `claude` startup, CC walks every `.jsonl` under `~/.claude/projects/` and deletes any whose `mtime` is past the cutoff — including the matching `<session-id>/` companion directory next to it. A session you compacted, `/clear`-ed, and stopped retaining ~31 days ago will be gone the next time you launch CC, even if you'd planned to grep it for context.

Practical implications:

- **If you need the post-compact JSONL preserved**, copy it out of `~/.claude/projects/` to a path that isn't subject to CC's cleanup — e.g. `~/snapshots/cc-jsonl-backups/`. Copying it into the same project dir as a `.bak` does not help; the sweep walks the whole dir.
- **A stopped session held in heal-and-await state is especially vulnerable** — it's idle by definition, so it crosses `cleanupPeriodDays` faster than an actively-used session whose appends keep mtime fresh. If you've stopped a session intending to resume later, either resume promptly, `touch` the `.jsonl` to refresh mtime, or copy it out of the tree.
- A read (`cat`/`grep`/`less`) does **not** advance mtime — modern Linux mounts default to `relatime`/`noatime`, so inspecting the file for recovery doesn't extend its lifespan. Only an append (CC writing to it during an active session, or a manual `touch`) refreshes mtime.

Tracked upstream as [anthropics/claude-code#62272](https://github.com/anthropics/claude-code/issues/62272) — cache-fix doesn't touch this surface, but documenting it because manual-compact users are the population most likely to bank on the `.jsonl` sticking around.

### Summarizer model

The tool defaults to `claude --print --model claude-opus-4-7` for the highest-fidelity summary. Override with the `MANUAL_COMPACT_MODEL` env var — e.g. `MANUAL_COMPACT_MODEL=claude-sonnet-4-6` to minimize Q5h impact, or to point at a different model if Opus is rate-limited or retired.

### Troubleshooting: empty summary output

If `$OUTPUT` comes back empty, the most likely cause is that the extract exceeded the summarizer's context window — this tool runs near the 1M wall, and the relaxed recent-turn caps (active turns up to 8000 chars) make the extract large on exactly those big sessions. The summarizer call swallows stderr, so an oversized-input rejection surfaces as an empty file rather than a visible error. Fixes, in order of preference:

- Use a 1M-window model for the summarization: `MANUAL_COMPACT_MODEL='claude-opus-4-7[1m]' manual-compact.sh ...`
- Or lower the per-turn caps in the script's extraction block (the `text[:8000]` / `text[:1500]` / `text[:300]` slices).

## Why the 1M Hack Disables /compact

The 1M context hack works by setting `DISABLE_COMPACT=1`, which CC reads as "disable all compaction." CC's code uses a single env var to control both:
- The context window calculation (`ff()` returns 1M when `DISABLE_COMPACT=1`)
- The `/compact` command availability (`isEnabled: () => !DISABLE_COMPACT`)

These are coupled in CC's source — there is no way to get 1M context AND `/compact` simultaneously without CC code changes. The coupling is in the CC binary, not in our interceptor.

We attempted to toggle `DISABLE_COMPACT` via the interceptor (set during API calls, unset between turns), but CC registers available commands at startup before any API call, so the toggle cannot re-enable `/compact` after session start.

## Requirements

- Claude Code v2.1.112 (the last Node.js version — v2.1.113+ uses Bun)
- The cache-fix interceptor loaded via `NODE_OPTIONS=--import`
- `DISABLE_COMPACT=1` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` set
- `claude` CLI available in PATH (used for summarization)
