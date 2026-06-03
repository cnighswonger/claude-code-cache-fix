import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "examples", "worktree-edit-guard.py");

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function runHook({ toolName, toolInput, cwd }) {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd });
  const r = spawnSync(SCRIPT, [], { input: payload, encoding: "utf8" });
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

test("Edit on in-tree symlink pointing outside → exit 2 (realpath catches)", () => {
  const repo = makeRepo(); const wt = makeWorktree(repo);
  try {
    const linkPath = join(wt, "escape");
    symlinkSync("/tmp", linkPath);
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
