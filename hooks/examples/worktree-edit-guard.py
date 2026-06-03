#!/usr/bin/env python3
"""PreToolUse hook: refuse Edit/Write/MultiEdit/NotebookEdit calls whose
target path falls outside the active git worktree root.

Addresses anthropics/claude-code#59628 (worktree sessions can corrupt the
parent main checkout). See docs/hooks/worktree-edit-guard.md for install.

Exit codes (per CC PreToolUse hook contract):
  0  pass-through (allow)
  2  block (CC feeds stderr back to the agent)
Posture: environmental failures fail open (exit 0); protocol-shape failures
(missing expected path field on an in-scope tool) fail closed (exit 2)."""

import json
import os
import subprocess
import sys

IN_SCOPE = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
PATH_FIELD = {"Edit": "file_path", "Write": "file_path",
              "MultiEdit": "file_path", "NotebookEdit": "notebook_path"}


def git(*args, cwd):
    """Run git; return stripped stdout on success, None on any failure."""
    try:
        r = subprocess.run(("git",) + args, cwd=cwd, timeout=2,
                           capture_output=True, text=True, check=False)
        return r.stdout.strip() if r.returncode == 0 else None
    except (subprocess.TimeoutExpired, OSError):
        return None


def worktree_root(cwd):
    """Return the worktree root if cwd is inside a linked worktree, else None.

    Detection: realpath-equality of --git-dir and --git-common-dir. They are
    equal in a regular checkout (from any depth) and differ inside a linked
    worktree. Compare realpaths because --git-common-dir returns paths
    relative to cwd, so raw string compare breaks below the repo root."""
    top = git("rev-parse", "--show-toplevel", cwd=cwd)
    gd = git("rev-parse", "--git-dir", cwd=cwd)
    gcd = git("rev-parse", "--git-common-dir", cwd=cwd)
    if not (top and gd and gcd):
        return None
    if os.path.realpath(os.path.join(cwd, gd)) == os.path.realpath(os.path.join(cwd, gcd)):
        return None
    return os.path.realpath(top)


def resolved_target(target):
    """Realpath the target. If the target exists (including as a broken
    symlink), realpath it directly so a target that IS a symlink resolves
    to its destination (not back to itself). If it doesn't exist, fall
    back to realpath(parent_dir) + basename so a symlinked PARENT still
    gets caught even when the leaf will be created by the tool."""
    if os.path.lexists(target):
        return os.path.realpath(target)
    return os.path.join(os.path.realpath(os.path.dirname(target)),
                        os.path.basename(target))


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0  # fail-open: malformed input is an environmental fault
    tool = payload.get("tool_name")
    if tool not in IN_SCOPE:
        return 0
    field = PATH_FIELD[tool]
    target = (payload.get("tool_input") or {}).get(field)
    if not isinstance(target, str) or not target:
        sys.stderr.write(f"worktree-edit-guard: refusing {tool} — "
                         f"missing tool_input.{field}.\n")
        return 2  # fail-closed: protocol-shape mismatch
    cwd = payload.get("cwd") or os.getcwd()
    root = worktree_root(cwd)
    if root is None:
        return 0  # not in a linked worktree; nothing to enforce
    if not os.path.isabs(target):
        target = os.path.join(cwd, target)
    abs_target = resolved_target(target)
    if abs_target == root or abs_target.startswith(root + os.sep):
        return 0
    sys.stderr.write(f"worktree-edit-guard: refusing {tool} on {abs_target} — "
                     f"outside worktree {root}. Use a path inside the worktree, "
                     f"or disable this hook in settings.json.\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
