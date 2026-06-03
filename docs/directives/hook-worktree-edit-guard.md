# Directive: worktree-edit-guard — PreToolUse hook to prevent parent-checkout corruption

**Status:** directive draft v2 for issue #182. Tracks [anthropics/claude-code#59628](https://github.com/anthropics/claude-code/issues/59628).
**Author:** Proxy Builder (directive), revised after Codex directive-stage review (see `docs/code-reviews/pr-183-directive-worktree-edit-guard.md`)
**Surface:** client-side `PreToolUse` hook script, shipped under `hooks/examples/`. **Not a proxy extension.**

## Changes from v1 (in response to Codex review)

1. **Blocking contract corrected.** v1 specified `exit 1` to block; that's a non-blocking error in CC's PreToolUse contract. v2 specifies `exit 2` (with stderr feedback to the agent) as the primary blocking mechanism, and documents the structured `hookSpecificOutput.permissionDecision: "deny"` alternative for `exit 0` JSON output.
2. **Tool payload schemas corrected.** v1 assumed all four tools expose `tool_input.file_path` and `MultiEdit` had per-edit paths under `tool_input.edits[i].file_path`. v2 reflects the actual contract: `Edit`/`Write` use `file_path`, `MultiEdit` uses a single top-level `file_path` with an `edits` array of `{old_string, new_string}`, `NotebookEdit` uses `notebook_path`.
3. **Worktree-detection rule corrected.** v1 detected "regular checkout" via `git rev-parse --git-common-dir == ".git"`, which only holds at the repo root — from any subdirectory in a regular checkout the value is a relative path like `../.git`, which would misclassify ordinary sessions as worktrees and unexpectedly enforce containment there. v2 compares the **realpaths** of `git rev-parse --git-dir` and `git rev-parse --git-common-dir`: they are equal in a regular checkout and differ inside a linked worktree, from any subdirectory.
4. **Load-bearing reclassified to Yes.** v1 marked the change `Load-bearing? No`. Per CLAUDE.md's criterion (security-relevant), this hook is a filesystem-boundary enforcement control whose own threat model centers on symlink escape, so it qualifies as load-bearing. v2 declares Yes, which gates merge on Chris's human review per CLAUDE.md.

## Problem statement

When a Claude Code session is launched inside a git worktree, the harness sets cwd to the worktree path and announces "You are operating in a git worktree" in the system prompt, but it does **not** block `Edit`/`Write`/`NotebookEdit`/`MultiEdit` calls whose target path (`file_path` for Edit/Write/MultiEdit, `notebook_path` for NotebookEdit) resolves to a location outside the worktree (typically the parent main checkout). The agent can dirty whatever branch the main checkout has checked out — usually `master`/`main` — with no prompt, no warning, no confirmation. This bypasses the branch-isolation guarantee that worktrees are meant to provide.

Upstream [CC#59628](https://github.com/anthropics/claude-code/issues/59628) has the bug filed against the harness; the filer's own workaround note is "a `PreToolUse` hook ... roughly 20 lines of Python." Until Anthropic ships a harness-level fix, this directive ships that hook as a documented, tested, install-with-one-config-line script.

## Scope

A single hook script under `hooks/examples/worktree-edit-guard.py` that:

1. Reads CC's PreToolUse hook input (JSON on stdin per the hooks contract)
2. Filters to the four file-editing tools: `Edit`, `Write`, `NotebookEdit`, `MultiEdit`
3. Extracts the in-scope path field per tool (see the **Tool payload extraction** section)
4. Determines whether the session is in a linked git worktree (see the **Worktree detection** section). If not in a worktree → exit 0 (pass-through)
5. **realpath-resolves** both the worktree root and the tool call's target path
6. If the resolved target path is not inside the resolved worktree root → **exit 2** with a clear stderr message (CC's PreToolUse blocking contract: stderr is fed back to the agent as an error message)
7. Otherwise → exit 0 (pass-through)

Plus:

- A documentation page (`docs/hooks/worktree-edit-guard.md`) covering install steps, behavior, opt-in/out via the `matcher` field in `hooks.PreToolUse[].matcher`, and the upstream CC issue cross-reference
- A test (`test/hook-worktree-edit-guard.test.mjs`) covering the containment cases that matter most: in-tree allow, parent-checkout block, symlink-escape block, non-worktree pass-through, MultiEdit handling
- Hooks-collection README entry pointing at the new file

This is **independent of the proxy** — the hook fires client-side via CC's settings.json, doesn't touch the API request path, ships without any proxy version cut.

## Out of scope

- **Bash-tool edits** (`sed -i path`, `cat > path`, `>path`, etc.) — different surface, different mitigation. This directive sticks to the four documented file-editing tools (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`) that take an explicit target-path argument in their `tool_input`.
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

**Deliberate incompatibility with `--add-dir` / `permissions.additionalDirectories`.** Strict-containment blocks edits to any path outside the resolved worktree root, including extra writable directories the user has explicitly opted into via `--add-dir` or `permissions.additionalDirectories`. This is by design — the threat model centers on accidental out-of-tree writes — but users running multi-root sessions intentionally should either disable the hook for those sessions, narrow its matcher, or fork the script to allow-list their additional directories. Documentation calls this out explicitly so users understand the tradeoff before enabling globally.

### Tool payload extraction

The four in-scope tools expose their target path under different keys. The hook must extract correctly per `tool_name`:

| Tool | `tool_input` shape | Path field(s) the hook checks |
|---|---|---|
| `Edit` | `{file_path, old_string, new_string, ...}` | `tool_input.file_path` |
| `Write` | `{file_path, content}` | `tool_input.file_path` |
| `MultiEdit` | `{file_path, edits: [{old_string, new_string}, ...]}` | `tool_input.file_path` (single top-level, **not** per-edit) |
| `NotebookEdit` | `{notebook_path, cell_id, new_source, ...}` | `tool_input.notebook_path` (**not** `file_path`) |

If the expected path field is missing on an in-scope tool call (schema drift / unexpected payload), the hook **does not silently pass through** — it exits 2 with a stderr message stating the missing field and the tool name, so the user is notified rather than the protection being silently bypassed. This is the one case where the hook deliberately fails-closed (see "Fail-open vs fail-closed" below).

### Non-existent target path handling

`Write` often targets paths that don't exist yet, and `NotebookEdit` with `edit_mode: "insert"` may target a notebook that exists but the cell does not. `os.path.realpath` on a non-existent path resolves what it can and treats the remainder literally — but to guarantee symlink-escape protection on the **parent**, the hook:

1. Splits the target into `parent_dir = os.path.dirname(target)` and `basename = os.path.basename(target)`
2. Resolves `realpath(parent_dir)` (handles parent-dir symlinks even if the basename doesn't exist yet)
3. Reconstructs the resolved target as `os.path.join(realpath(parent_dir), basename)`
4. Applies the containment check against the reconstructed path

A `Write` to `worktree/subdir/symlink_pointing_outside/newfile.txt` is still caught because `realpath(parent_dir)` resolves the symlink.

### Worktree detection

The hook only enforces when the session is inside a linked git worktree. Detection:

1. Run `git rev-parse --show-toplevel` to get the worktree's working-tree root. On failure (not in a git repo), exit 0.
2. Run both `git rev-parse --git-dir` and `git rev-parse --git-common-dir`.
3. Compare the **realpaths** of those two values. In a regular checkout they resolve to the same absolute path (`<repo>/.git`). In a linked worktree they differ: `--git-dir` resolves to `<repo>/.git/worktrees/<name>/`, `--git-common-dir` resolves to `<repo>/.git/`.
4. If realpath-equal → regular checkout, no worktree to enforce; exit 0 (pass-through).
5. If realpath-differ → linked worktree; enforce containment against the `--show-toplevel` result.

**Why realpath both:** the raw `--git-common-dir` output is a path relative to the current directory in regular checkouts (e.g. `.git` at the repo root, `../.git` from a subdirectory, `../../.git` deeper). Direct string comparison to `.git` only works at the repo root, which would misclassify ordinary subdirectory sessions as worktrees. Realpath-resolving both values eliminates the depth-dependent string variation.

## Hook input/output contract

**Input** (stdin, JSON): CC's standard PreToolUse hook payload. Top-level fields are `tool_name`, `tool_input`, and `cwd`. See the **Tool payload extraction** table above for per-tool field names. Schema lives at [Claude Code's hooks reference](https://code.claude.com/docs/en/hooks).

**Output** (per CC's PreToolUse hook contract):
- **Exit code `0`** → pass-through (CC proceeds with the tool call). Stdout JSON `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "<reason>"}}` is the structured-form block; this directive uses exit-2 instead for simplicity.
- **Exit code `1`** → **non-blocking error.** Stderr is shown to the user but the tool call **still proceeds**. v1 of this directive incorrectly used this for blocking; do not.
- **Exit code `2`** → **blocks the tool call.** Stderr is fed back to the agent as an error message — the agent can react and retry with a different path. This is the primary blocking mechanism the hook uses.
- Stderr → user-visible rejection message on blocking exits; format: `worktree-edit-guard: refusing <ToolName> on <abs_target_path> — outside worktree <worktree_root>. Use a path inside the worktree, or disable this hook in settings.json.`
- Stdout → unused (structured-form is documented as an alternative but this directive does not use it).

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
- The `git rev-parse` invocations use `subprocess.run(..., timeout=2, check=False)` so a slow filesystem doesn't wedge the hook.

### Fail-open vs fail-closed posture

The hook applies different defaults to different failure modes:

- **Fail-open (exit 0, log to stderr) for environmental failures:** `git` subprocess timeout, `git` returns non-zero from a permission problem, the worktree-detection commands fail to run. The hook should not block edits when its own infrastructure is broken — that's a worse failure mode than the bug we're guarding against (a broken hook would wedge every edit; a missed enforcement window is one bug-class still uncovered).
- **Fail-closed (exit 2) for protocol failures:** an in-scope tool call's `tool_input` is missing the expected path field (`file_path` for Edit/Write/MultiEdit, `notebook_path` for NotebookEdit). This indicates schema drift or an unexpected payload, and silently passing it through would defeat the protection without notifying the user. Stderr names the missing field and the tool, so a future CC schema change surfaces immediately rather than silently.

This split is deliberate: environmental issues are the user's problem to fix and shouldn't block their session, but protocol-shape mismatches are a sign that the hook's assumptions about CC have drifted and the user needs to know.

## Test plan

`test/hook-worktree-edit-guard.test.mjs` covers the cases where the script's behavior would matter to a user. **All `exit 2` rows below specify the actual CC PreToolUse blocking contract** (v1 of this directive incorrectly used `exit 1`, which is non-blocking):

| Case | Expected |
|---|---|
| `Edit` with `file_path` inside worktree | exit 0 (pass-through) |
| `Edit` with `file_path` in parent main checkout | exit 2 (block) |
| `Edit` with `file_path` in `/tmp/` (totally out of tree) | exit 2 (block) |
| `Edit` with `file_path` = symlink in worktree → outside | exit 2 (block, via realpath) |
| `Write` with `file_path` that doesn't exist yet, parent in worktree | exit 0 (pass-through, parent-dir resolution path) |
| `Write` with `file_path` that doesn't exist yet, parent is a symlink to outside worktree | exit 2 (block — parent realpath catches the escape) |
| `MultiEdit` with `file_path` in-tree (single top-level path; all edits target same file) | exit 0 |
| `MultiEdit` with `file_path` out-of-tree | exit 2 (block on the one top-level path) |
| `NotebookEdit` with `notebook_path` (NOT `file_path`) in-tree | exit 0 |
| `NotebookEdit` with `notebook_path` in parent main checkout | exit 2 (block) |
| `NotebookEdit` with **missing `notebook_path`** in tool_input (schema drift case) | exit 2 (fail-closed; stderr names the missing field) |
| `Edit` with **missing `file_path`** in tool_input | exit 2 (fail-closed; stderr names the missing field) |
| Non-worktree cwd (regular checkout) at repo root | exit 0 (pass-through, no enforcement) |
| Non-worktree cwd (regular checkout) from a **nested subdirectory** | exit 0 (validates the realpath-equality detection rule, not the broken string-comparison rule) |
| Not in any git repo | exit 0 (pass-through, fail-open) |
| `git` command times out | exit 0 (pass-through, fail-open environmental) |
| `Read` tool call (matcher should already exclude; defensive case if mis-installed) | exit 0 |

Test harness: standard Node test runner, spawn the Python script as a subprocess, feed JSON on stdin, assert on exit code + stderr substring. Fixture setup creates a temp repo with `git worktree add` for the worktree cases and a plain `git init` for the regular-checkout cases.

## Documentation

- `docs/hooks/worktree-edit-guard.md` — install steps, behavior table, opt-out, upstream cross-ref
- `hooks/README.md` (NEW) — landing page for the `hooks/` directory, lists shipped examples
- Top-level `README.md` — one-line mention under "What's included" pointing at `hooks/README.md`

## Non-Functional Requirements

- **Size/complexity budget:** script ≤ 80 LOC, test ≤ 150 LOC (raised from 120 to cover the expanded test matrix), docs page ≤ 100 LOC, hooks/README ≤ 40 LOC. Total ≤ ~380 LOC across all files. If the implementation lands materially larger, the directive needs to be revisited.
- **Threat model:** the hook is a filesystem-boundary enforcement control. It prevents the upstream-documented data-loss scenario (parent-checkout corruption from worktree sessions) and the symlink-escape class. The script itself processes only a CC-supplied JSON blob on stdin, calls `git` as a subprocess, and exits — no network, no API surface, no file writes of its own. The relevant attack class is **symlink escape** (a path inside the worktree whose realpath is outside it); the test plan covers both the existing-file form (Edit through an in-tree symlink) and the not-yet-existing form (Write where the parent dir is a symlink to outside the worktree). See [[reference-realpath-containment-pattern]] memory.
- **Maintainability constraints:** single-purpose Python script in `hooks/examples/`. No new abstractions, no framework, no shared module. Tests live alongside other proxy tests in `test/`. Documentation lives under `docs/hooks/`. If a second hook example ships later, it lives next to this one — no premature directory restructuring.
- **Performance/reliability:** hook runs on every `Edit`/`Write`/`NotebookEdit`/`MultiEdit` tool call. Python cold-start ~50ms is the dominant cost; the script logic itself is sub-millisecond. Environmental failures (git timeout, permission errors) fail open; protocol-shape failures (missing expected path field) fail closed. See **Fail-open vs fail-closed posture** above. `git` subprocess capped at 2s timeout.
- **Load-bearing? Yes.** This hook is a security-relevant filesystem-boundary enforcement control whose threat model explicitly centers on symlink escape and out-of-tree writes. Per CLAUDE.md, load-bearing changes require human (Chris) review before merge in addition to the routine Lead + Codex review path. **v1 of this directive classified this as `No`; that was wrong** — the security-relevance criterion in CLAUDE.md applies, and Codex's directive-stage review correctly flagged the misclassification as a blocker. The reclassification was the change with the largest workflow impact among the v1→v2 corrections.

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
- CC hooks reference: https://code.claude.com/docs/en/hooks
- CC tools reference: https://code.claude.com/docs/en/tools-reference
- Codex directive-stage review (v1): `docs/code-reviews/pr-183-directive-worktree-edit-guard.md`
