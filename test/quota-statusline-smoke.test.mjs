// Smoke tests for tools/quota-statusline.sh — T1-T5 from the per-session
// quota-status directive. Runs the shell script as a subprocess under a
// tmpdir-rooted HOME so we don't touch the developer's real ~/.claude/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "..", "tools", "quota-statusline.sh");

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), "qsl-"));
  mkdirSync(join(home, ".claude", "quota-status", "sessions"), { recursive: true });
  return {
    home,
    account: join(home, ".claude", "quota-status", "account.json"),
    sessionsDir: join(home, ".claude", "quota-status", "sessions"),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

const ACCOUNT_JSON = JSON.stringify({
  five_hour: { utilization: 0.42, pct: 42, resets_at: 1776960600 },
  seven_day: { utilization: 0.15, pct: 15, resets_at: 1776970800 },
  status: "allowed",
  overage_status: "allowed",
  peak_hour: false,
  timestamp: "2026-05-05T12:00:00.000Z",
});

const SESSION_JSON = JSON.stringify({
  cache: {
    ttl_tier: "1h",
    cache_creation: 0,
    cache_read: 12345,
    ephemeral_1h: 0,
    ephemeral_5m: 0,
    hit_rate: "92.5",
    timestamp: "2026-05-05T12:00:00.000Z",
  },
  timestamp: "2026-05-05T12:00:00.000Z",
  session_id: "b16c607d-d484-4935-840e-e3f7ee78eb08",
});

function runScript(home, stdin) {
  return spawnSync("bash", [SCRIPT], {
    input: stdin,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

test("T1. UUID session, both files present → label has quota and TTL", () => {
  const env = setupHome();
  try {
    writeFileSync(env.account, ACCOUNT_JSON);
    writeFileSync(join(env.sessionsDir, "b16c607d-d484-4935-840e-e3f7ee78eb08.json"), SESSION_JSON);
    const r = runScript(env.home, '{"session_id": "b16c607d-d484-4935-840e-e3f7ee78eb08"}');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Q5h: 42%/);
    assert.match(r.stdout, /Q7d: 15%/);
    assert.match(r.stdout, /TTL:1h/);
    assert.match(r.stdout, /92\.5%/);
  } finally {
    env.cleanup();
  }
});

test("T2. session_id missing from stdin → quota shown, no TTL block", () => {
  const env = setupHome();
  try {
    writeFileSync(env.account, ACCOUNT_JSON);
    const r = runScript(env.home, "{}");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Q5h: 42%/);
    assert.match(r.stdout, /Q7d: 15%/);
    assert.doesNotMatch(r.stdout, /TTL:/);
  } finally {
    env.cleanup();
  }
});

test("T3. per-session file missing (fresh/warming session) → quota shown, no TTL", () => {
  const env = setupHome();
  try {
    writeFileSync(env.account, ACCOUNT_JSON);
    // No file in sessions/ yet.
    const r = runScript(env.home, '{"session_id": "fresh-session-no-file-yet"}');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Q5h: 42%/);
    assert.doesNotMatch(r.stdout, /TTL:/);
  } finally {
    env.cleanup();
  }
});

test("T4. both files missing → script exits cleanly with no output", () => {
  const env = setupHome();
  try {
    // Don't write account.json or session file.
    const r = runScript(env.home, '{"session_id": "any"}');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  } finally {
    env.cleanup();
  }
});

test("T5. malformed session_id → reads hashed filename matching the writer's rule", () => {
  const env = setupHome();
  try {
    writeFileSync(env.account, ACCOUNT_JSON);
    const raw = "../foo";
    const hash = "inv-" + createHash("sha256").update(raw).digest("hex").slice(0, 16);
    // Writer's per-session payload uses the raw session id; we mock with the
    // value the script will compute the filename from.
    const sessJson = JSON.stringify({
      cache: { ttl_tier: "5m", cache_creation: 999, cache_read: 0, hit_rate: "0.0", timestamp: "2026-05-05T12:00:00.000Z" },
      timestamp: "2026-05-05T12:00:00.000Z",
      session_id: raw,
    });
    writeFileSync(join(env.sessionsDir, `${hash}.json`), sessJson);
    const r = runScript(env.home, JSON.stringify({ session_id: raw }));
    assert.equal(r.status, 0);
    // Should display the hashed file's contents — proves filename rule matches writer.
    assert.match(r.stdout, /TTL:5m/);
  } finally {
    env.cleanup();
  }
});
