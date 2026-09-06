import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRUBBED_GIT_ENV } from "./git-env.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "examples", "worktree-edit-guard.py");

// SCRUBBED, or none of the scratch repos below are scratch. `cwd` does not win
// against an exported GIT_DIR, and makeRepo() runs exactly the operations that
// damaged a real clone once — `git init`, then `user.email=t@t` / `user.name=t`
// written straight into whatever config git resolved to. Those are this file's
// fixture values; see test/git-env.mjs for the incident.
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: SCRUBBED_GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

// The hook under test shells out to `git rev-parse` itself, so it inherits what
// it is handed. Unscrubbed, it answers about the RUNNER's repository instead of
// the fixture, and every assertion below reads the wrong repo while passing —
// the quiet direction of the same defect.
function runHook({ toolName, toolInput, cwd }) {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd });
  const r = spawnSync(SCRIPT, [], { input: payload, encoding: "utf8", env: SCRUBBED_GIT_ENV });
  return { code: r.status, stderr: r.stderr };
}

function makeRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wgt-")));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "a"), "x");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "i");
  return root;
}

function makeWorktree(repo) {
  const wt = join(repo, "wt");
  git(repo, "worktree", "add", "-q", wt);
  return realpathSync(wt);
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// --- in-scope tool tests inside a worktree ---

test("Edit inside worktree → exit 0 (pass-through)", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    writeFileSync(join(wt, "in.txt"), "x");
    const r = runHook({ toolName: "Edit", toolInput: { file_path: join(wt, "in.txt") }, cwd: wt });
    assert.equal(r.code, 0);
  } finally { cleanup(repo); }
});

test("Edit on parent main checkout → exit 2 (block)", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    const r = runHook({ toolName: "Edit", toolInput: { file_path: join(repo, "a") }, cwd: wt });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refusing Edit on/);
    assert.match(r.stderr, /outside worktree/);
  } finally { cleanup(repo); }
});

test("Edit in /tmp (totally out of tree) → exit 2 (block)", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    const r = runHook({ toolName: "Edit", toolInput: { file_path: "/tmp/totally-elsewhere" }, cwd: wt });
    assert.equal(r.code, 2);
  } finally { cleanup(repo); }
});

test("Edit on file_path that IS a symlink in worktree → resolves to symlink target outside → exit 2 (the directive's symlink-escape case)", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    const linkPath = join(wt, "filelink");
    symlinkSync("/tmp/wgt-target-outside", linkPath);  // broken symlink is fine; lexists detects it
    const r = runHook({ toolName: "Edit", toolInput: { file_path: linkPath }, cwd: wt });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /\/tmp\/wgt-target-outside/);  // stderr names the actual target, not the symlink path
  } finally { cleanup(repo); }
});

test("Edit through symlinked-parent-dir to an in-leaf path → exit 2 (parent-dir realpath catches)", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    const linkPath = join(wt, "escape");
    symlinkSync("/tmp", linkPath);  // escape/ -> /tmp/
    const r = runHook({ toolName: "Edit", toolInput: { file_path: join(linkPath, "x") }, cwd: wt });
    assert.equal(r.code, 2);
  } finally { cleanup(repo); }
});

test("Write to not-yet-existing file with parent in worktree → exit 0", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    const r = runHook({ toolName: "Write", toolInput: { file_path: join(wt, "new.txt") }, cwd: wt });
    assert.equal(r.code, 0);
  } finally { cleanup(repo); }
});

test("Write to not-yet-existing file whose parent is a symlink to outside worktree → exit 2", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    symlinkSync("/tmp", join(wt, "esc"));
    const r = runHook({ toolName: "Write", toolInput: { file_path: join(wt, "esc", "new.txt") }, cwd: wt });
    assert.equal(r.code, 2);
  } finally { cleanup(repo); }
});

test("MultiEdit with file_path in worktree → exit 0", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    writeFileSync(join(wt, "m.txt"), "x");
    const r = runHook({ toolName: "MultiEdit", toolInput: { file_path: join(wt, "m.txt"), edits: [{ old_string: "x", new_string: "y" }] }, cwd: wt });
    assert.equal(r.code, 0);
  } finally { cleanup(repo); }
});

test("MultiEdit with file_path out-of-tree → exit 2", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    const r = runHook({ toolName: "MultiEdit", toolInput: { file_path: join(repo, "a"), edits: [{ old_string: "x", new_string: "y" }] }, cwd: wt });
    assert.equal(r.code, 2);
  } finally { cleanup(repo); }
});

test("NotebookEdit with notebook_path in worktree → exit 0", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    const r = runHook({ toolName: "NotebookEdit", toolInput: { notebook_path: join(wt, "x.ipynb") }, cwd: wt });
    assert.equal(r.code, 0);
  } finally { cleanup(repo); }
});

test("NotebookEdit with notebook_path in parent → exit 2", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    const r = runHook({ toolName: "NotebookEdit", toolInput: { notebook_path: join(repo, "x.ipynb") }, cwd: wt });
    assert.equal(r.code, 2);
  } finally { cleanup(repo); }
});

// --- fail-closed: schema drift ---

test("Edit with missing file_path → exit 2 (fail-closed, names the field)", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    const r = runHook({ toolName: "Edit", toolInput: {}, cwd: wt });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /missing tool_input\.file_path/);
  } finally { cleanup(repo); }
});

test("NotebookEdit with file_path instead of notebook_path → exit 2 (fail-closed)", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    const r = runHook({ toolName: "NotebookEdit", toolInput: { file_path: join(wt, "x.ipynb") }, cwd: wt });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /missing tool_input\.notebook_path/);
  } finally { cleanup(repo); }
});

// --- fail-open: environmental / non-worktree pass-through ---

test("Regular checkout at repo root → exit 0 (no enforcement)", () => {
  const repo = makeRepo();
  try {
    const r = runHook({ toolName: "Edit", toolInput: { file_path: join(repo, "a") }, cwd: repo });
    assert.equal(r.code, 0);
  } finally { cleanup(repo); }
});

test("Regular checkout from nested subdirectory → exit 0 (validates realpath detection vs string compare)", () => {
  const repo = makeRepo();
  try {
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const r = runHook({ toolName: "Edit", toolInput: { file_path: join(repo, "a") }, cwd: sub });
    assert.equal(r.code, 0);
  } finally { cleanup(repo); }
});

test("Not in any git repo → exit 0 (fail-open)", () => {
  const r = runHook({ toolName: "Edit", toolInput: { file_path: "/tmp/x" }, cwd: "/tmp" });
  assert.equal(r.code, 0);
});

test("`git` subprocess times out → exit 0 (fail-open environmental, deterministic via PATH shim)", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  const shimDir = realpathSync(mkdtempSync(join(tmpdir(), "wgt-shim-")));
  try {
    const shim = join(shimDir, "git");
    writeFileSync(shim, "#!/usr/bin/env bash\nsleep 10\n");
    spawnSync("chmod", ["+x", shim]);
    const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(wt, "x") }, cwd: wt });
    const r = spawnSync(SCRIPT, [], {
      input: payload, encoding: "utf8",
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
    });
    assert.equal(r.status, 0);
  } finally {
    cleanup(repo); cleanup(shimDir);
  }
});

test("Relative file_path (defense in depth — CC docs use absolute paths, but verify the cwd-join fallback) → enforcement still applies", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    // Relative path resolving inside the worktree → exit 0
    writeFileSync(join(wt, "rel.txt"), "x");
    const inHook = runHook({ toolName: "Edit", toolInput: { file_path: "rel.txt" }, cwd: wt });
    assert.equal(inHook.code, 0);
    // Relative path resolving to parent main checkout → exit 2
    const outHook = runHook({ toolName: "Edit", toolInput: { file_path: "../a" }, cwd: wt });
    assert.equal(outHook.code, 2);
  } finally { cleanup(repo); }
});

// --- out-of-scope tools pass-through ---

test("Read tool (out-of-scope; matcher should already exclude, defensive case) → exit 0", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    const r = runHook({ toolName: "Read", toolInput: { file_path: join(repo, "a") }, cwd: wt });
    assert.equal(r.code, 0);
  } finally { cleanup(repo); }
});

// --- malformed input fails open ---

test("Malformed JSON on stdin → exit 0 (fail-open environmental)", () => {
  const r = spawnSync(SCRIPT, [], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
});
