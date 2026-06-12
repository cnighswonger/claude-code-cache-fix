import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, utimesSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeRecordsSync,
  sweepRetentionThrottled,
  _resetWriterState,
  _appendEvent,
} from "../proxy/session-mirror-writer.mjs";

let tmpDir;

beforeEach(() => {
  _resetWriterState();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  tmpDir = mkdtempSync(join(tmpdir(), "mirror-writer-test-"));
  process.env.CACHE_FIX_SESSION_MIRROR_DIR = tmpDir;
  process.env.CACHE_FIX_SESSION_MIRROR_EVENT_LOG = join(tmpDir, "session-mirror-events.jsonl");
  delete process.env.CACHE_FIX_SESSION_MIRROR_MAX_BYTES;
  delete process.env.CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS;
});

function eventLogLines() {
  const p = process.env.CACHE_FIX_SESSION_MIRROR_EVENT_LOG;
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function sessionFiles(sessionDirName) {
  const dir = join(tmpDir, sessionDirName);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
}

function readSessionRecords(sessionDirName) {
  const files = sessionFiles(sessionDirName);
  const all = [];
  for (const f of files) {
    const content = readFileSync(join(tmpDir, sessionDirName, f), "utf8");
    for (const line of content.split("\n")) {
      if (line.trim()) all.push(JSON.parse(line));
    }
  }
  return all;
}

// ----------------------------------------------------------------------------
// Basic write
// ----------------------------------------------------------------------------

test("writeRecordsSync writes a single batch to the active file", () => {
  const sessionId = "sess-abc";
  writeRecordsSync(sessionId, [{ a: 1 }, { a: 2 }]);
  const recs = readSessionRecords(sessionId);
  assert.equal(recs.length, 2);
  assert.deepEqual(recs[0], { a: 1 });
  assert.deepEqual(recs[1], { a: 2 });
});

test("writeRecordsSync reuses the same active file across batches", () => {
  const sessionId = "sess-stick";
  writeRecordsSync(sessionId, [{ a: 1 }]);
  writeRecordsSync(sessionId, [{ a: 2 }]);
  assert.equal(sessionFiles(sessionId).length, 1, "should not create a new file per batch");
  assert.equal(readSessionRecords(sessionId).length, 2);
});

test("writeRecordsSync handles an empty array as a no-op", () => {
  const sessionId = "sess-empty";
  const written = writeRecordsSync(sessionId, []);
  assert.equal(written, 0);
  assert.equal(sessionFiles(sessionId).length, 0);
});

// ----------------------------------------------------------------------------
// Rotation
// ----------------------------------------------------------------------------

test("active file rotates at MAX_BYTES threshold", () => {
  process.env.CACHE_FIX_SESSION_MIRROR_MAX_BYTES = "200";
  const sessionId = "sess-rotate";
  // Each record JSON-serializes to enough bytes that 5 of them blow past 200.
  const filler = "x".repeat(50);
  for (let i = 0; i < 5; i++) {
    writeRecordsSync(sessionId, [{ i, filler }]);
  }
  const files = sessionFiles(sessionId);
  assert.ok(files.length >= 2, `expected rotation; got ${files.length} files`);
});

test("rotation logs a 'rotate' event to session-mirror-events.jsonl", () => {
  process.env.CACHE_FIX_SESSION_MIRROR_MAX_BYTES = "200";
  const sessionId = "sess-rotate-log";
  for (let i = 0; i < 5; i++) {
    writeRecordsSync(sessionId, [{ i, filler: "x".repeat(50) }]);
  }
  const events = eventLogLines();
  assert.ok(events.some((e) => e.event === "rotate" && e.session_id === sessionId),
    "expected at least one rotate event");
});

// ----------------------------------------------------------------------------
// Path safety (session id sanitization via sessionFilename)
// ----------------------------------------------------------------------------

test("path traversal in session id is sanitized to inv-<hash> bucket", () => {
  const evil = "../../etc/passwd";
  writeRecordsSync(evil, [{ scary: true }]);
  // The only thing that matters: under our managed root, we created exactly
  // one directory and it's named `inv-<hash>` — never `..`, never `etc`.
  const entries = readdirSync(tmpDir);
  const invDirs = entries.filter((e) => e.startsWith("inv-"));
  const escapeDirs = entries.filter((e) => e === ".." || e === "etc" || e.includes("/"));
  assert.equal(escapeDirs.length, 0, "must not escape the managed root");
  assert.ok(invDirs.length >= 1, "evil session id should bucket under inv-<hash>");
});

test("sessionless / unknown session id buckets to 'unknown' directory", () => {
  writeRecordsSync(null, [{ orphan: true }]);
  assert.ok(existsSync(join(tmpDir, "unknown")));
});

// ----------------------------------------------------------------------------
// Retention sweep — files past RETENTION_DAYS are unlinked
// ----------------------------------------------------------------------------

test("retention sweep unlinks files past RETENTION_DAYS", () => {
  process.env.CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS = "30";
  const sessionId = "sess-old";
  writeRecordsSync(sessionId, [{ payload: "stale" }]);
  const dir = join(tmpDir, sessionId);
  const files = sessionFiles(sessionId);
  assert.equal(files.length, 1);
  const oldPath = join(dir, files[0]);
  // Backdate the file to 60 days ago.
  const sixtyDaysAgo = Date.now() - 60 * 86400_000;
  utimesSync(oldPath, sixtyDaysAgo / 1000, sixtyDaysAgo / 1000);
  // Force the sweep to fire.
  _resetWriterState();
  sweepRetentionThrottled();
  assert.equal(sessionFiles(sessionId).length, 0, "stale file should be unlinked");
});

test("retention sweep prunes empty session directories", () => {
  process.env.CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS = "30";
  const sessionId = "sess-empty-prune";
  writeRecordsSync(sessionId, [{ payload: "stale" }]);
  const dir = join(tmpDir, sessionId);
  const files = sessionFiles(sessionId);
  const oldPath = join(dir, files[0]);
  const sixtyDaysAgo = Date.now() - 60 * 86400_000;
  utimesSync(oldPath, sixtyDaysAgo / 1000, sixtyDaysAgo / 1000);
  _resetWriterState();
  sweepRetentionThrottled();
  assert.ok(!existsSync(dir), "empty directory should be pruned");
});

test("retention sweep does NOT unlink files inside the retention window", () => {
  process.env.CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS = "30";
  const sessionId = "sess-fresh";
  writeRecordsSync(sessionId, [{ payload: "fresh" }]);
  _resetWriterState();
  sweepRetentionThrottled();
  assert.equal(sessionFiles(sessionId).length, 1);
});

test("retention sweep is throttled — second call within 60s is a no-op", () => {
  process.env.CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS = "30";
  const sessionId = "sess-throttle";
  writeRecordsSync(sessionId, [{ payload: "stale" }]);
  const dir = join(tmpDir, sessionId);
  const oldPath = join(dir, sessionFiles(sessionId)[0]);
  const sixtyDaysAgo = Date.now() - 60 * 86400_000;
  utimesSync(oldPath, sixtyDaysAgo / 1000, sixtyDaysAgo / 1000);

  _resetWriterState();
  sweepRetentionThrottled();
  // File should be gone after first sweep.
  assert.equal(sessionFiles(sessionId).length, 0);

  // Write a new file, then re-trigger sweep within the throttle window — it
  // must NOT fire (the new file would otherwise be safe by mtime; this just
  // verifies the throttle prevents needless I/O).
  writeRecordsSync(sessionId, [{ payload: "new" }]);
  const newPath = join(dir, sessionFiles(sessionId)[0]);
  const oldTime = Date.now() - 60 * 86400_000;
  utimesSync(newPath, oldTime / 1000, oldTime / 1000);
  sweepRetentionThrottled();
  // Even though the new file is now backdated, the throttle should have
  // skipped the sweep — the file is still there.
  assert.equal(sessionFiles(sessionId).length, 1, "throttle should have skipped the second sweep");
});

// ----------------------------------------------------------------------------
// Event log PII discipline + rotation
// ----------------------------------------------------------------------------

test("event log carries no image bytes / no prompt content (PII discipline)", () => {
  _appendEvent({ event: "open", session_id: "sess-x", file: "/path/to/x.jsonl" });
  const events = eventLogLines();
  assert.equal(events.length, 1);
  const serialized = JSON.stringify(events[0]);
  assert.ok(!/authorization|x-api-key|content-block|base64/i.test(serialized));
});
