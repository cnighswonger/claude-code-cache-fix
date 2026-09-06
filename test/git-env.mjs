// The environment a test must hand any `git` it spawns.
//
// One copy, because the two hand-rolled ones already cost an incident: the
// scrub was written in the file that NOTICED the damage and never swept to the
// file that produced it. The fixture identity named in that write-up —
// `user.name=t`, `user.email=t@t` — is hook-worktree-edit-guard.test.mjs's, and
// that file was still spawning git with an inherited environment months later.
// A shared definition cannot drift from itself; two cannot stay in step.
//
// WHY IT IS NEEDED AT ALL. Git's own environment overrides cwd, so a scratch
// repo built with `cwd: <tmpdir>` and an INHERITED environment is not scratch:
// under an exported GIT_DIR every `git init` / `git config` / `git commit`
// resolves to whatever repo the runner was pointed at. Git exports exactly that
// into the hooks it runs — a relative `.git` for a main-tree operation, an
// ABSOLUTE path for a worktree one — and an absolute GIT_DIR beats cwd-based
// discovery everywhere.
//
// Measured 2026-08-05: run from a pre-push hook, a suite file wrote
// `user.name=t` / `user.email=t@t` into the REAL repository config, and because
// `git init` guesses bare-ness from a git-dir not named `.git`, it set
// `core.bare=true` on top — which breaks every work-tree command in the real
// clone. It recurred the same day from a plain `GIT_DIR=… node --test`
// invocation, which is the evidence that hardening the pre-push hook alone was
// not the fix: the hazard belongs to ANY runner with these set, so the scrub
// belongs at the spawn, where no caller can forget it.
//
// UNDEFINED, NOT EMPTY STRING: `GIT_DIR=""` is still "set" as far as git is
// concerned, so an empty-string scrub leaves the hazard in place while reading
// as a fix.
export const SCRUBBED_GIT_ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_CEILING_DIRECTORIES: undefined,
};
