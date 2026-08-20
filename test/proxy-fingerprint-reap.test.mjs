// The launcher leaks one `cache-fix-proxy-<port>.sha256` per proxy start and
// nothing removed them. These tests lift the shipped reaper out of the launcher
// and run it, the way proxy-held-port.test.mjs lifts holderPidOn: every slice is
// asserted, so a rename fails the test instead of quietly testing nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../bin/claude-via-proxy.mjs", import.meta.url));
const SRC = readFileSync(LAUNCHER, "utf-8");

// Brace-counted, not regex: a lazy match stops at an inner block's close and
// yields a fragment that fails as a SyntaxError rather than a named assertion.
function lift(decl) {
  const start = SRC.indexOf(decl);
  assert.ok(start >= 0, `${decl} is gone from the launcher — this test guards nothing`);
  let depth = 0, end = -1;
  for (let i = SRC.indexOf("{", start); i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > start, `could not lift ${decl} whole — this test guards nothing`);
  return SRC.slice(start, end);
}

test("the launcher carries a reaper for its own fingerprint records", () => {
  assert.match(SRC, /const\s+recordAgeMs\s*=/,
               "no fingerprint reaper found in claude-via-proxy.mjs — this test guards nothing");
});

// Once per launcher process, not once per spawn, and not behind
// publishFingerprint's early return.
test("the reap is driven by the supervisor, and off its startup path", () => {
  const hold = lift("function holdPort(");
  assert.ok(hold.includes("reapFingerprintRecords"),
            "holdPort does not reap — the records are never collected");
  assert.ok(!lift("function publishFingerprint(").includes("reapFingerprintRecords"),
            "publishFingerprint reaps, so it is skipped whenever publishing fails and " +
            "repeated on every respawn");
  // Deferred: run inline the tmpdir scan delays the bind and destabilises the
  // held-port suite. Nothing reads the result.
  assert.match(hold, /setTimeout\(reapFingerprintRecords, 0\)\.unref\(\)/,
               "the reap runs inline on the supervisor's startup path; a tmpdir scan " +
               "there delays the bind and destabilises the held-port suite");
});

test("a stale record is removed, and anything a live holder may still own is kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccf-fpreap-"));
  try {
    const stale = join(dir, "cache-fix-proxy-40001.sha256");
    const fresh = join(dir, "cache-fix-proxy-40002.sha256");
    // A holder that merely lives long: nothing republishes, so its mtime is its
    // launch time and a short gate would reap a live proxy's own record.
    const longLived = join(dir, "cache-fix-proxy-40003.sha256");
    // Ends in .sha256 on purpose: with any other suffix endsWith() alone saves
    // it and an empty prefix would pass.
    const alien = join(dir, "cache-fix-ca-scratch-keepme.sha256");
    for (const p of [stale, fresh, longLived, alien]) writeFileSync(p, "x");
    const age = (p, days) => utimesSync(p, Date.now() / 1000 - days * 86400, Date.now() / 1000 - days * 86400);
    age(stale, 8); age(longLived, 3); age(alien, 8);

    // tmpdir() is rebound to the scratch dir; the real temp directory is never
    // touched.
    const run = new Function("readdirSync", "statSync", "rmSync", "join", "tmpdir",
      `const RECORD_PREFIX = ${JSON.stringify(recordPrefix())};\n` +
      `${lift("function reapFingerprintRecords()")}\nreturn reapFingerprintRecords();`);
    run(readdirSync, statSync, rmSync, join, () => dir);

    const left = readdirSync(dir).sort();
    assert.ok(!left.includes("cache-fix-proxy-40001.sha256"), `the stale record survived: ${left}`);
    assert.ok(left.includes("cache-fix-proxy-40002.sha256"), `the fresh record was removed: ${left}`);
    assert.ok(left.includes("cache-fix-proxy-40003.sha256"),
              `a 3-day-old record was reaped: a holder up that long loses its own record — ${left}`);
    assert.ok(left.includes("cache-fix-ca-scratch-keepme.sha256"),
              `the reaper took a name that is not its own: ${left}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The writer and the reaper must read one constant, or they drift apart on any
// platform whose separator is not "/".
function recordPrefix() {
  const m = SRC.match(/const RECORD_PREFIX = "([^"]+)";/);
  assert.ok(m, "RECORD_PREFIX is gone — the writer and the reaper can drift apart again");
  assert.ok(lift("function fingerprintPath(").includes("RECORD_PREFIX"),
            "fingerprintPath no longer builds the name from RECORD_PREFIX");
  return m[1];
}
