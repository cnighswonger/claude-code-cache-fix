# Directive: worktree-edit-guard — PreToolUse hook to prevent parent-checkout corruption

**Status:** directive draft for issue #182. Tracks [anthropics/claude-code#59628](https://github.com/anthropics/claude-code/issues/59628).
**Author:** Proxy Builder (directive), Codex review pending
**Surface:** client-side `PreToolUse` hook script, shipped under `hooks/examples/`. **Not a proxy extension.**

## Problem statement

When a Claude Code session is launched inside a git worktree, the harness sets cwd to the worktree path and announces "You are operating in a git worktree" in the system prompt, but it does **not** block `Edit`/`Write`/`NotebookEdit`/`MultiEdit` calls whose `file_path` resolves to a location outside the worktree (typically the parent main checkout). The agent can dirty whatever branch the main checkout has checked out — usually `master`/`main` — with no prompt, no warning, no confirmation. This bypasses the branch-isolation guarantee that worktrees are meant to provide.

Upstream [CC#59628](https://github.com/anthropics/claude-code/issues/59628) has the bug filed against the harness; the filer's own workaround note is "a `PreToolUse` hook ... roughly 20 lines of Python." Until Anthropic ships a harness-level fix, this directive ships that hook as a documented, tested, install-with-one-config-line script.

## Scope

A single hook script under `hooks/examples/worktree-edit-guard.py` that:

1. Reads CC's PreToolUse hook input (JSON on stdin per the hooks contract)
2. Filters to the four file-editing tools: `Edit`, `Write`, `NotebookEdit`, `MultiEdit`
3. Determines the active worktree root via `git rev-parse --show-toplevel` at cwd
4. **realpath-resolves** both the worktree root and the tool call's `file_path`
5. If the resolved `file_path` is not inside the resolved worktree root → exit non-zero, emit a clear stderr message
6. Otherwise → exit 0 (pass-through)

Plus:

- A documentation page (`docs/hooks/worktree-edit-guard.md`) covering install steps, behavior, opt-in/out via `hooks.PreToolUse.matchers`, and the upstream CC issue cross-reference
- A test (`test/hook-worktree-edit-guard.test.mjs`) covering the containment cases that matter most: in-tree allow, parent-checkout block, symlink-escape block, non-worktree pass-through, MultiEdit handling
- Hooks-collection README entry pointing at the new file

This is **independent of the proxy** — the hook fires client-side via CC's settings.json, doesn't touch the API request path, ships without any proxy version cut.

## Out of scope

- **Bash-tool edits** (`sed -i path`, `cat > path`, `>path`, etc.) — different surface, different mitigation. This directive sticks to the four documented file-editing tools that take an explicit `file_path` argument.
- **Read-side containment** — agent reading parent-checkout files is not a corruption risk; only writes are. Hook does not block `Read`/`Grep`/`Glob`.
- **Subprocess-spawned editors** — a Bash call that launches `vim` or `code` against a path outside the worktree is out of scope. Same reason as Bash-edits above.
- **Convincing CC to harden the harness** — that's upstream's job (CC#59628).

## Containment shape

The hook is **strict-containment**: rejects any `file_path` whose realpath is not inside the realpath of the active worktree root. This is broader than what upstream proposes (they suggest blocking "outside worktree but inside parent main checkout"). Reasons for the stricter shape:

1. **Simpler and safer to reason about.** "Edits stay in this tree" is one rule; "edits stay in this tree OR somewhere else but not over there" is two.
2. **Catches symlink escapes via the same check.** Realpath the file_path; if it falls outside the realpath'd worktree, block. A symlink inside the worktree pointing at `/etc/passwd` gets blocked too — defensible.
3. **Catches arbitrary out-of-tree writes**, not just parent-checkout writes. An agent writing to `~/scratch/` while in a worktree is probably also unintended; the user can opt out for those cases.
4. **Trivially correct when cwd is the worktree root** — the rule is exactly "edits stay under cwd-as-resolved."

Users who want the narrower "block only parent-checkout writes" behavior can adjust the script — it's an example, not a framework.

### Non-existent file_path handling

`Write` and `NotebookEdit` often target paths that don't exist yet (the tool is what creates them). `realpath` on a non-existent path fails on some systems. Handle this by:

1. Resolving the **parent directory** via `os.path.realpath(os.path.dirname(file_path))`
2. Joining the basename onto the resolved parent
3. Applying the containment check against the constructed path

This avoids "file doesn't exist" false-negatives while preserving symlink-escape protection (the parent's realpath still detects symlinked parent dirs).

### Non-git / non-worktree cwd

If `git rev-parse --show-toplevel` fails (not in a git repo) or `git rev-parse --git-common-dir` equals `.git` (regular checkout, not a worktree), the hook exits 0 without doing anything. The hook only enforces when there is a worktree relationship to enforce. This keeps it safe to install globally in settings.json without surprising users on non-worktree sessions.

## Hook input/output contract

**Input** (stdin, JSON): CC's standard PreToolUse hook payload. The relevant fields are `tool_name` and `tool_input.file_path` (or, for `MultiEdit`, `tool_input.edits[i].file_path`). The schema is documented in [Claude Code's hooks reference](https://docs.claude.com/en/docs/claude-code/hooks).

**Output**:
- Exit code `0` → pass-through (CC proceeds with the tool call)
- Exit code non-zero → CC blocks the tool call
- Stderr → user-visible rejection message; format: `worktree-edit-guard: refusing Edit on <abs_path> — outside worktree <worktree_root>. Use a path inside the worktree, or disable this hook in settings.json.`
- Stdout → unused

## Install pattern (docs page)

```jsonc
// ~/.claude/settings.json (or project settings.json)
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "/abs/path/to/hooks/examples/worktree-edit-guard.py" }
        ]
      }
    ]
  }
}
```

Documentation covers the absolute-path requirement, the matcher form, and how to disable per-project if a session needs to write to the parent checkout intentionally (rare but possible).

## Implementation notes

- Python 3, no third-party deps (only `os`, `sys`, `json`, `subprocess`)
- Script under ~80 LOC including comments and the docstring
- Hook startup latency: Python cold-start is ~50ms on Linux; acceptable for the user-visible "the edit was rejected" feedback path. Hot-path is the Python interpreter, not the script logic — keep imports minimal.
- Errors talking to `git` (timeout, permissions) → log to stderr, exit 0 (fail-open). Don't block edits when the hook itself is broken — that's a worse failure mode than the bug we're guarding.
- The `git rev-parse --show-toplevel` invocation uses `subprocess.run(..., timeout=2, check=False)` so a slow filesystem doesn't wedge the hook.

## Test plan

`test/hook-worktree-edit-guard.test.mjs` covers the cases where the script's behavior would matter to a user:

| Case | Expected |
|---|---|
| `Edit` with file_path inside worktree | exit 0 (pass-through) |
| `Edit` with file_path in parent main checkout | exit 1 (block) |
| `Edit` with file_path in `/tmp/` (totally out of tree) | exit 1 (block) |
| `Edit` with file_path = symlink in worktree → outside | exit 1 (block, via realpath) |
| `Write` with file_path that doesn't exist yet (parent in worktree) | exit 0 (pass-through, parent-dir resolution path) |
| `MultiEdit` with all edits in-tree | exit 0 |
| `MultiEdit` with one edit out-of-tree | exit 1 (first-failure short-circuit) |
| Non-worktree cwd (regular checkout) | exit 0 (pass-through, no enforcement) |
| Not in any git repo | exit 0 (pass-through, fail-open) |
| `git` command times out | exit 0 (pass-through, fail-open) |
| `Read` tool call | exit 0 (hook doesn't apply; matcher won't even invoke it but defensive case) |

Test harness: standard Node test runner, spawn the Python script as a subprocess, feed JSON on stdin, assert on exit code + stderr substring.

## Documentation

- `docs/hooks/worktree-edit-guard.md` — install steps, behavior table, opt-out, upstream cross-ref
- `hooks/README.md` (NEW) — landing page for the `hooks/` directory, lists shipped examples
- Top-level `README.md` — one-line mention under "What's included" pointing at `hooks/README.md`

## Non-Functional Requirements

- **Size/complexity budget:** script ≤ 80 LOC, test ≤ 120 LOC, docs page ≤ 100 LOC, hooks/README ≤ 40 LOC. Total ≤ ~350 LOC across all files. If the implementation lands materially larger, the directive needs to be revisited.
- **Threat model:** the hook prevents the upstream-documented data-loss scenario (parent-checkout corruption from worktree sessions). The script itself processes only a CC-supplied JSON blob on stdin, calls `git` as a subprocess, and exits — no network, no API surface, no file writes. A poorly-implemented realpath check could allow bypass via symlinks; the test plan covers this case explicitly. See [[reference-realpath-containment-pattern]] memory.
- **Maintainability constraints:** single-purpose Python script in `hooks/examples/`. No new abstractions, no framework, no shared module. Tests live alongside other proxy tests in `test/`. Documentation lives under `docs/hooks/`. If a second hook example ships later, it lives next to this one — no premature directory restructuring.
- **Performance/reliability:** hook runs on every Edit/Write/NotebookEdit/MultiEdit tool call. Python cold-start ~50ms is the dominant cost; the script logic itself is sub-millisecond. Fails open (exit 0) on any internal error so a broken hook can't wedge a session. `git` subprocess capped at 2s timeout.
- **Load-bearing? No.** Pure user-side hook script + docs page. No shared abstraction is touched, no wire/schema contract is altered, no proxy regression surface. Routine leaf code; ships under Lead + Codex review per CLAUDE.md.

## Open questions for review

None blocking. Items I considered and chose against:

1. **Should the hook be in Bash instead of Python?** Faster startup (~5ms vs 50ms), but loses portability (Windows users don't have it natively, and the upstream issue's repro was Windows). Python wins on portability for the cost of 45ms per hook fire — well within the user-visible latency budget.
2. **Should the hook also cover `Bash` tool calls?** No — separate surface, separate mitigation. Scope creep risk if bundled.
3. **Should the hook ship in `hooks/installed/` and auto-register via postinstall?** No. Hooks affect all CC sessions on a machine; auto-registration without user consent is the wrong default. Ship as an example, document the one-line settings.json install, let the user opt in.

## References

- Upstream: [anthropics/claude-code#59628](https://github.com/anthropics/claude-code/issues/59628) — bug + workaround note
- Tracking issue: [cache-fix #182](https://github.com/cnighswonger/claude-code-cache-fix/issues/182)
- cc-triage record: [cc-triage#421](https://github.com/cnighswonger/cc-triage/issues/421)
- Related symlink-containment pattern precedent: cache-fix's response posture on [CC#64582](https://github.com/anthropics/claude-code/issues/64582) (extensibility plugin symlink exfil)
- CC hooks reference: https://docs.claude.com/en/docs/claude-code/hooks
