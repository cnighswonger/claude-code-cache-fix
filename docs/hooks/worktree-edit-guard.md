# worktree-edit-guard — PreToolUse hook

**Script:** `hooks/examples/worktree-edit-guard.py`
**Addresses:** [anthropics/claude-code#59628](https://github.com/anthropics/claude-code/issues/59628)

When a Claude Code session is launched inside a git worktree, the harness sets cwd to the worktree and announces "You are operating in a git worktree" in the system prompt — but it does **not** block `Edit`/`Write`/`MultiEdit`/`NotebookEdit` calls whose target path resolves to a location outside the worktree (typically the parent main checkout). An agent can dirty whatever branch the main checkout has out, bypassing the branch isolation that worktrees are supposed to provide.

This hook is a user-side workaround until Anthropic fixes the harness. It's a `PreToolUse` hook script that realpath-resolves the target path on each in-scope tool call and blocks the call (CC exit-2 contract) if it falls outside the active worktree root.

## What it covers

| Tool | Path field checked |
|---|---|
| `Edit` | `tool_input.file_path` |
| `Write` | `tool_input.file_path` |
| `MultiEdit` | `tool_input.file_path` (single top-level; same for all edits) |
| `NotebookEdit` | `tool_input.notebook_path` |

For each in-scope call, the hook:

1. Detects whether the session is in a linked worktree (realpath-compares `git rev-parse --git-dir` and `--git-common-dir`; they differ inside a linked worktree, match in a regular checkout from any depth).
2. Realpath-resolves the target. For paths that don't exist yet (`Write`'s common case), it resolves the parent directory first so a symlinked parent still gets caught.
3. If the resolved target is inside the resolved worktree root → exit 0 (CC proceeds).
4. Otherwise → exit 2 with a stderr message naming the rejected path and worktree root. CC feeds stderr back to the agent as an error.

When the session is **not** in a linked worktree (regular checkout, no git repo, or git command failure), the hook exits 0 and stays out of the way. It's safe to install globally.

## Install

Add to `~/.claude/settings.json` (or per-project `.claude/settings.json`):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "/abs/path/to/hooks/examples/worktree-edit-guard.py" }
        ]
      }
    ]
  }
}
```

The `command` field must be an absolute path (CC's hooks contract requires it). Make sure the file is executable (`chmod +x`).

## What it does NOT cover

- **`Bash` tool calls** (`sed -i path`, `cat > path`, `> path`, etc.) — different surface, different mitigation. This hook only inspects the four file-editing tools that take an explicit target-path argument.
- **Read-side access** — agent reading parent-checkout files is not a corruption risk, so `Read`/`Grep`/`Glob`/`LSP` are untouched.
- **Subprocess-spawned editors** — a `Bash` call that launches `vim` or `code` against a path outside the worktree is out of scope (same reason as Bash edits).
- **Convincing CC to fix the harness** — that's upstream's job ([CC#59628](https://github.com/anthropics/claude-code/issues/59628)).

## Deliberate incompatibility with `--add-dir`

The hook is **strict-containment** — it blocks edits to any path outside the resolved worktree root, including extra writable directories you've explicitly opted into via `--add-dir` or `permissions.additionalDirectories`. This is by design (the threat model centers on accidental out-of-tree writes), but if you run multi-root sessions intentionally, you have three options:

1. Don't install this hook in your global settings — install per-project instead, only in projects where worktree containment matters.
2. Narrow the matcher (e.g. only `Edit|MultiEdit`) so other tools pass through unconditionally.
3. Fork the script and add an allow-list of additional roots.

## Fail-open vs fail-closed

- **Environmental failures fail open** (exit 0): `git` subprocess timeout, `git` returns non-zero from a permission problem, malformed JSON on stdin. The hook should not block edits when its own infrastructure is broken — that's a worse failure mode than the bug it's guarding.
- **Protocol-shape failures fail closed** (exit 2): the expected path field is missing on an in-scope tool call. This indicates schema drift in CC's tool definitions, and silently passing it through would defeat the protection without notifying you. Stderr names the missing field and the tool, so a future CC schema change surfaces immediately.

## Disable for one session

If you need to write to the parent checkout intentionally in one session, either:

- Remove or comment out the hook entry in settings.json before launching
- Move/rename the script so the command in settings.json points at nothing (the resulting "command not found" makes CC log an error but doesn't block tool calls)
- Use `--add-dir` and the hook will still block — see above; that's intentional

## Implementation notes

- Python 3 stdlib only (`os`, `sys`, `json`, `subprocess`)
- ~88 lines including the docstring and the missing-field fail-closed path
- Python cold-start (~50ms on Linux) is the dominant cost; script logic is sub-millisecond
- `git` subprocess capped at 2-second timeout so a slow filesystem doesn't wedge the hook
- Tests: `test/hook-worktree-edit-guard.test.mjs` (17 cases including symlink escape, schema drift, nested-subdir non-worktree pass-through)

## References

- Upstream: [anthropics/claude-code#59628](https://github.com/anthropics/claude-code/issues/59628)
- Directive: `docs/directives/hook-worktree-edit-guard.md`
- CC hooks reference: https://code.claude.com/docs/en/hooks
