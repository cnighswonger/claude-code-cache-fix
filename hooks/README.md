# cache-fix hook examples

Standalone `PreToolUse` / `PostToolUse` / `SessionStart` hook scripts that address specific Claude Code behaviors. These are **examples** — you install them by pointing at them from your own `~/.claude/settings.json` (or per-project `.claude/settings.json`). cache-fix does not register them automatically.

Independent of the proxy. Hooks run client-side via CC's hooks contract; they don't touch the API request path.

## Available examples

| Script | Event | Purpose | Docs |
|---|---|---|---|
| `examples/worktree-edit-guard.py` | `PreToolUse` | Block `Edit`/`Write`/`MultiEdit`/`NotebookEdit` calls whose target path falls outside the active git worktree root. Addresses [CC#59628](https://github.com/anthropics/claude-code/issues/59628). | [`docs/hooks/worktree-edit-guard.md`](../docs/hooks/worktree-edit-guard.md) |

## Installing a hook

Each script's docs page has its own settings.json snippet. The general shape:

```jsonc
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<ToolName1>|<ToolName2>",
        "hooks": [
          { "type": "command", "command": "/abs/path/to/hooks/examples/<script>" }
        ]
      }
    ]
  }
}
```

The `command` field must be an absolute path per CC's hooks contract. Make sure the script is executable.

## CC hooks reference

https://code.claude.com/docs/en/hooks — exit-code semantics, structured output schema, matcher patterns, the full event taxonomy.
