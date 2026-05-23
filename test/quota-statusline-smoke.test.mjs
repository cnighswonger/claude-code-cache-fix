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
    assert.match(r.stdout, /Q5h \[.{10}\] 42%/);
    assert.match(r.stdout, /Q7d \[.{10}\] 15%/);
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
    assert.match(r.stdout, /Q5h \[.{10}\] 42%/);
    assert.match(r.stdout, /Q7d \[.{10}\] 15%/);
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
      assert.match(r.stdout, /Q5h \[.{10}\] 42%/);
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
    assert.match(r.stdout, /Q5h \[.{10}\] 42%/);
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

// Format-contract tests. The statusline output is public surface: docs,
// READMEs, screenshots, downstream tools that grep it. Pin the bar content
// and time-left wording explicitly so a format regression is caught here,
// not in the field.

// Anchor used by the format tests: timestamp present in account.json fixes
// `now` inside the script, so resets_at offsets render deterministically.
const FORMAT_NOW_EPOCH = 1777982400; // 2026-05-05T12:00:00.000Z
const FORMAT_NOW_ISO = "2026-05-05T12:00:00.000Z";

function formatAccount({ q5hPct, q5hOffsetSec, q7dPct, q7dOffsetSec }) {
  const acc = {
    status: "allowed",
    overage_status: "allowed",
    peak_hour: false,
    timestamp: FORMAT_NOW_ISO,
    five_hour: { pct: q5hPct },
    seven_day: { pct: q7dPct },
  };
  if (q5hOffsetSec !== undefined) acc.five_hour.resets_at = FORMAT_NOW_EPOCH + q5hOffsetSec;
  if (q7dOffsetSec !== undefined) acc.seven_day.resets_at = FORMAT_NOW_EPOCH + q7dOffsetSec;
  return JSON.stringify(acc);
}

test("T8 (format). under-pace: tick past fill; `exhaust` and `reset` both shown", () => {
  const env = setupHome();
  try {
    // 5h: 30% used, 2h elapsed of 5h = 40% elapsed (tick at idx 4).
    //     exhaust = 70 * 7200 / 30 = 16800s = 4h40m; reset = 3h00m.
    // 7d: 53% used, 4d elapsed of 7d ≈ 57% elapsed (tick at idx 5).
    //     exhaust = 47 * 345600 / 53 ≈ 306475s = 3d13h; reset = 3d0h.
    writeFileSync(env.account, formatAccount({
      q5hPct: 30, q5hOffsetSec: 3 * 3600,
      q7dPct: 53, q7dOffsetSec: 3 * 86400,
    }));
    const r = runScript(env.home, '{"session_id":"x"}');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Q5h \[███░┃░░░░░\] 30% \(exhaust 4h40m, reset 3h00m\)/);
    assert.match(r.stdout, /Q7d \[█████┃░░░░\] 53% \(exhaust 3d13h, reset 3d0h\)/);
  } finally {
    env.cleanup();
  }
});

test("T9 (format). over-pace: tick inside fill; exhaust < reset (the actionable signal)", () => {
  const env = setupHome();
  try {
    // 5h: 50% used at 1.5h elapsed = 30% elapsed (tick at idx 3).
    //     exhaust = 50 * 5400 / 50 = 5400s = 1h30m; reset = 3h30m.
    // exhaust < reset is the visible warning: at current pace we run out
    // before the window resets.
    writeFileSync(env.account, formatAccount({
      q5hPct: 50, q5hOffsetSec: Math.floor(3.5 * 3600),
      q7dPct: 0, q7dOffsetSec: 7 * 86400,
    }));
    const r = runScript(env.home, '{"session_id":"x"}');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Q5h \[███┃██░░░░\] 50% \(exhaust 1h30m, reset 3h30m\)/);
  } finally {
    env.cleanup();
  }
});

test("T10 (format). missing resets_at: bar without tick, no exhaust, no reset", () => {
  const env = setupHome();
  try {
    writeFileSync(env.account, formatAccount({ q5hPct: 30, q7dPct: 53 }));
    const r = runScript(env.home, '{"session_id":"x"}');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Q5h \[███░░░░░░░\] 30%/);
    assert.match(r.stdout, /Q7d \[█████░░░░░\] 53%/);
    assert.doesNotMatch(r.stdout, /\bexhaust\b/);
    assert.doesNotMatch(r.stdout, /\breset\b/);
  } finally {
    env.cleanup();
  }
});

test("T11 (format). stale window (reset_at in the past): no exhaust, no reset", () => {
  const env = setupHome();
  try {
    writeFileSync(env.account, formatAccount({
      q5hPct: 42, q5hOffsetSec: -3600,
      q7dPct: 15, q7dOffsetSec: -86400,
    }));
    const r = runScript(env.home, '{"session_id":"x"}');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Q5h \[████░░░░░┃\] 42%/);
    assert.match(r.stdout, /Q7d \[██░░░░░░░┃\] 15%/);
    assert.doesNotMatch(r.stdout, /\bexhaust\b/);
    assert.doesNotMatch(r.stdout, /\breset\b/);
  } finally {
    env.cleanup();
  }
});

test("T12 (format). quota at 0% (fresh window): exhaust dropped, reset shown", () => {
  const env = setupHome();
  try {
    writeFileSync(env.account, formatAccount({
      q5hPct: 0, q5hOffsetSec: 5 * 3600,
      q7dPct: 0, q7dOffsetSec: 7 * 86400,
    }));
    const r = runScript(env.home, '{"session_id":"x"}');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /\bexhaust\b/);
    assert.match(r.stdout, /Q5h \[┃░░░░░░░░░\] 0% \(reset 5h00m\)/);
    assert.match(r.stdout, /Q7d \[┃░░░░░░░░░\] 0% \(reset 7d0h\)/);
  } finally {
    env.cleanup();
  }
});

test("T13 (format). elapsed below min: exhaust dropped (noisy projection), reset shown", () => {
  const env = setupHome();
  try {
    // Q5h elapsed = 30s, Q7d elapsed = 120s — both below the 300s burn-warmup gate.
    writeFileSync(env.account, formatAccount({
      q5hPct: 2, q5hOffsetSec: 5 * 3600 - 30,
      q7dPct: 1, q7dOffsetSec: 7 * 86400 - 120,
    }));
    const r = runScript(env.home, '{"session_id":"x"}');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /\bexhaust\b/);
    assert.match(r.stdout, /Q5h \[.{10}\] 2% \(reset 4h59m\)/);
    assert.match(r.stdout, /Q7d \[.{10}\] 1% \(reset 6d23h\)/);
  } finally {
    env.cleanup();
  }
});

test("T14 (format). quota at 100% (already exhausted): exhaust dropped, reset shown", () => {
  const env = setupHome();
  try {
    writeFileSync(env.account, formatAccount({
      q5hPct: 100, q5hOffsetSec: 3600,
      q7dPct: 100, q7dOffsetSec: 86400,
    }));
    const r = runScript(env.home, '{"session_id":"x"}');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /\bexhaust\b/);
    assert.match(r.stdout, /Q5h \[.{10}\] 100% \(reset 1h00m\)/);
    assert.match(r.stdout, /Q7d \[.{10}\] 100% \(reset 1d0h\)/);
  } finally {
    env.cleanup();
  }
});

test("T15 (format). Q7d autoselect: durations under a day render as h/m, not 0d Xh", () => {
  const env = setupHome();
  try {
    // Q7d 99% used, reset 30 min away → elapsed ≈ 6d 23h 30m, secs_left = 1800.
    //   exhaust = 1 * 603000 / 99 ≈ 6091s = 1h41m (days==0 → h/m fallback)
    //   reset   = 1800s = 0h30m                    (days==0 → h/m fallback)
    writeFileSync(env.account, formatAccount({
      q5hPct: 0, q5hOffsetSec: 5 * 3600,
      q7dPct: 99, q7dOffsetSec: 1800,
    }));
    const r = runScript(env.home, '{"session_id":"x"}');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Q7d \[.{10}\] 99% \(exhaust 1h41m, reset 0h30m\)/);
    // Belt and suspenders: no `0d` token should appear when days collapse to 0.
    assert.doesNotMatch(r.stdout, /0d/);
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
    assert.match(r.stdout, /Q5h \[.{10}\] 42%/);
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
