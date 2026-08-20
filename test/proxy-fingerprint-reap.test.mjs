// A fingerprint record must not outlive every proxy that could read it.
//
// `publishFingerprint(port)` writes `cache-fix-proxy-<port>.sha256` before each
// spawn and nothing removed it. The port is ephemeral wherever the OS picks it,
// so the records accumulate one per proxy start, forever. Measured on a
// long-lived container 2026-08-20: 6,743 records, 461 a day. `runningOurCode`
// assumed systemd-tmpfiles sweeps /tmp; that host has zsh as PID 1 and no
// sweeper. The cost is not the 284 KB — the launcher's own scratch reaper walks
// `readdirSync(tmpdir())` on every start, 117 ms at 74,493 entries.
//
// This file lifts the shipped source and runs it, the way
// proxy-held-port.test.mjs lifts holderPidOn: the assert on each slice is the
// control, so a rename fails the test instead of quietly testing nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../bin/claude-via-proxy.mjs", import.meta.url));
const SRC = readFileSync(LAUNCHER, "utf-8");

// A lazy regex stopped at the first `\n}` — an inner block's close — and
// produced an unbalanced fragment that failed only as a SyntaxError inside
// new Function(). Count braces.
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

// ONCE PER LAUNCHER PROCESS, NOT ONCE PER SPAWN. publishFingerprint runs on
// every respawn — the restart ladder is documented at 51 spawns in 1.2 s — and
// each reap is a full readdirSync(tmpdir()). It also opens with `if (!fp)
// return;`, so reaping from there stops exactly when publishing is persistently
// broken: the mistake the sibling CA reaper documents ("Sharing that block made
// reaping conditional on the rename succeeding").
test("the reap is driven by the supervisor, and off its startup path", () => {
  const hold = lift("function holdPort(");
  assert.ok(hold.includes("reapFingerprintRecords"),
            "holdPort does not reap — the records are never collected");
  assert.ok(!lift("function publishFingerprint(").includes("reapFingerprintRecords"),
            "publishFingerprint reaps, so it is skipped whenever publishing fails and " +
            "repeated on every respawn");
  // DEFERRED, and this is measured, not taste. Calling it inline costs one
  // readdirSync(tmpdir()) before the bind — 135-193 ms at the 68,533 entries
  // this box carries. Interleaved against upstream/main at one load,
  // test/proxy-held-port.test.mjs failed 2 of 10 runs with the scan inline and
  // 0 of 5 with the same diff's scan body disabled; upstream/main was 0 of 14.
  // Nothing reads the result, so nothing has to wait for it.
  assert.match(hold, /setTimeout\(reapFingerprintRecords, 0\)\.unref\(\)/,
               "the reap runs inline on the supervisor's startup path; a tmpdir scan " +
               "there delays the bind and destabilises the held-port suite");
});

test("a stale record is removed, and anything a live holder may still own is kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccf-fpreap-"));
  try {
    const stale = join(dir, "cache-fix-proxy-40001.sha256");
    const fresh = join(dir, "cache-fix-proxy-40002.sha256");
    // A HOLDER THAT MERELY LIVES LONG. Nothing republishes a record: the one
    // call site is the spawn path, so an unrestarted holder's mtime is its
    // launch time. Reaping it makes runningOurCode() answer null, and the
    // launcher's own comment says where that ends — "a swept /tmp turned a
    // deploy into a no-op that read as a success".
    const longLived = join(dir, "cache-fix-proxy-40003.sha256");
    // PREFIX DISCIPLINE, the mistake the CA reaper already paid for once. It
    // ends in .sha256 on purpose: with any other suffix the endsWith() check
    // alone saves it, and an empty prefix would pass this test.
    const alien = join(dir, "cache-fix-ca-scratch-keepme.sha256");
    for (const p of [stale, fresh, longLived, alien]) writeFileSync(p, "x");
    const age = (p, days) => utimesSync(p, Date.now() / 1000 - days * 86400, Date.now() / 1000 - days * 86400);
    age(stale, 8); age(longLived, 3); age(alien, 8);

    // EVERY CALLEE COMES TOO, and tmpdir() is rebound to the scratch dir so the
    // real temp directory is never touched.
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

// ONE CONSTANT, TWO SITES — the writer and the reaper. Deriving the reaper's
// prefix from fingerprintPath() at runtime read `head.lastIndexOf("/")`, which
// is -1 on Windows: the whole absolute path became the prefix and no basename
// from readdirSync ever matched, so the reaper was a silent no-op there.
function recordPrefix() {
  const m = SRC.match(/const RECORD_PREFIX = "([^"]+)";/);
  assert.ok(m, "RECORD_PREFIX is gone — the writer and the reaper can drift apart again");
  assert.ok(lift("function fingerprintPath(").includes("RECORD_PREFIX"),
            "fingerprintPath no longer builds the name from RECORD_PREFIX");
  return m[1];
}
