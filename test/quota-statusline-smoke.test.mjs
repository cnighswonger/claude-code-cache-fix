// Smoke tests for tools/quota-statusline.sh — T1-T5 from the per-session
// quota-status directive. Runs the shell script as a subprocess under a
// tmpdir-rooted HOME so we don't touch the developer's real ~/.claude/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
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

test("T2. session_id missing from stdin → quota shown, no TTL block (sessions/unknown.json absent)", () => {
  const env = setupHome();
  try {
    writeFileSync(env.account, ACCOUNT_JSON);
    // No sessions/unknown.json on disk → reader applies rule, attempts read,
    // file missing, falls back to account-only.
    const r = runScript(env.home, "{}");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Q5h: 42%/);
    assert.match(r.stdout, /Q7d: 15%/);
    assert.doesNotMatch(r.stdout, /TTL:/);
  } finally {
    env.cleanup();
  }
});

test("T2a. session_id null/empty/whitespace → all read sessions/unknown.json (rule applied identically)", () => {
  // The writer maps null, "", and whitespace-only ids to "unknown" via
  // sessionFilename. The reader must do the same so the contract is
  // identical end-to-end. Verify by populating sessions/unknown.json and
  // confirming each null-ish input picks it up.
  for (const raw of [null, "", "   ", "\t\n"]) {
    const env = setupHome();
    try {
      writeFileSync(env.account, ACCOUNT_JSON);
      const unknownPayload = JSON.stringify({
        cache: { ttl_tier: "1h", cache_creation: 0, cache_read: 100, hit_rate: "50.0", timestamp: "2026-05-05T12:00:00.000Z" },
        timestamp: "2026-05-05T12:00:00.000Z",
        session_id: null,
      });
      writeFileSync(join(env.sessionsDir, "unknown.json"), unknownPayload);
      const r = runScript(env.home, JSON.stringify({ session_id: raw }));
      assert.equal(r.status, 0, `failed for raw=${JSON.stringify(raw)}: ${r.stderr}`);
      assert.match(r.stdout, /Q5h: 42%/);
      assert.match(r.stdout, /TTL:1h/, `expected TTL:1h for raw=${JSON.stringify(raw)}, got: ${r.stdout}`);
      assert.match(r.stdout, /50\.0%/);
    } finally {
      env.cleanup();
    }
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

test("T6 (security #108). triple-quote injection payload does NOT execute — heredoc isolation intact", () => {
  // Regression for cnighswonger/claude-code-cache-fix#108: pre-v3.5.2,
  // tools/quota-statusline.sh interpolated stdin into a Python triple-quoted
  // literal (`json.loads('''$input''')`). A `'''` byte sequence in any
  // user-controlled field — session_id, cwd, workspace.current_dir, etc. —
  // closes the literal early and lets the following bytes execute as Python
  // in the user's CC process. The fix moves stdin into a single-quoted
  // bash heredoc + env var so the bytes are inert at every layer.
  //
  // This test pipes a payload that, on the vulnerable script, creates a
  // sentinel file via __import__('os').system. After the script runs, the
  // sentinel must NOT exist.
  const env = setupHome();
  // Sentinel must live under the test's tmpdir-rooted HOME so we never
  // touch real /tmp state and the assertion can't false-pass against a
  // pre-existing file the developer happens to have.
  const sentinel = join(env.home, "PWNED_SHOULD_NOT_EXIST");
  try {
    writeFileSync(env.account, ACCOUNT_JSON);
    // Build the malicious session_id. Triple-single-quote closes the literal,
    // then arbitrary Python runs, then we re-open with `+'''` so the original
    // syntax of the vulnerable line stays balanced (otherwise json.loads
    // raises before reaching the dangerous code, masking the test).
    const malicious = `abc'''+__import__('os').system(${JSON.stringify(`touch ${sentinel}`)})+'''def`;
    const stdinPayload = JSON.stringify({ session_id: malicious });
    const r = runScript(env.home, stdinPayload);
    assert.equal(r.status, 0, `script must exit clean even with hostile payload; stderr=${r.stderr}`);
    // The script should still render a normal quota line — the hostile
    // payload is just a weird session_id string from the parser's perspective.
    assert.match(r.stdout, /Q5h: 42%/);
    // The critical assertion: no execution.
    assert.equal(
      existsSync(sentinel),
      false,
      `SECURITY REGRESSION: triple-quote injection payload created ${sentinel} — heredoc isolation has broken. See cache-fix issue #108.`,
    );
  } finally {
    env.cleanup();
  }
});

test("T7 (security #108). injection in non-session_id fields is also inert", () => {
  // The brief flagged that CC's hook payload has multiple user-controlled
  // string fields (cwd, workspace.current_dir, workspace.project_dir,
  // transcript_path). Even though the current script only consumes
  // session_id from the parsed JSON, a future change might surface other
  // fields. Belt-and-suspenders: confirm the heredoc isolation holds when
  // the malicious bytes appear elsewhere in the JSON object.
  const env = setupHome();
  const sentinel = join(env.home, "PWNED_VIA_CWD_SHOULD_NOT_EXIST");
  try {
    writeFileSync(env.account, ACCOUNT_JSON);
    const malicious = `/tmp/foo'''+__import__('os').system(${JSON.stringify(`touch ${sentinel}`)})+'''bar`;
    const stdinPayload = JSON.stringify({
      cwd: malicious,
      workspace: { current_dir: malicious, project_dir: malicious },
      transcript_path: malicious,
      session_id: "valid-session-id-passes-canonical-rule",
    });
    const r = runScript(env.home, stdinPayload);
    assert.equal(r.status, 0);
    assert.equal(
      existsSync(sentinel),
      false,
      `SECURITY REGRESSION via non-session_id field: ${sentinel} created. See cache-fix issue #108.`,
    );
  } finally {
    env.cleanup();
  }
});
