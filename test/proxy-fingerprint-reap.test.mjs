// The launcher leaks one `cache-fix-proxy-<port>.sha256` per proxy start and
// nothing removed them. These tests lift the shipped reaper out of the launcher
// and run it, the way proxy-held-port.test.mjs lifts holderPidOn: every slice is
// asserted, so a rename fails the test instead of quietly testing nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net, { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { onPort } from "./proc-helpers.mjs";

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

// tmpdir() is rebound to the scratch dir, so the real temp directory is never
// touched. Every callee comes with it.
function runReaper(dir) {
  return new Function("readdirSync", "statSync", "rmSync", "join", "tmpdir", "net", "bindAddr",
    `const RECORD_PREFIX = ${JSON.stringify(recordPrefix())};\n` +
    `${lift("function portFree(")}\n` +
    `${lift("async function reapFingerprintRecords()")}\nreturn reapFingerprintRecords();`
  )(readdirSync, statSync, rmSync, join, () => dir, net, () => "127.0.0.1");
}

// A FIXED PORT SITS INSIDE THE EPHEMERAL RANGE, so a sibling test's launcher can
// be handed one and hold it for a whole run; portFree then answers false and the
// reaper correctly keeps a record these cases expect reaped. A port the kernel
// has just released is the last one it hands out again.
function releasedPort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => res(port)); });
  });
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

// AGE ALONE MAKES SEVEN DAYS A DEADLINE, NOT A MARGIN. Nothing republishes a
// record, so a holder that neither respawns nor is redeployed for a week has an
// over-age record while fully live, and the next launcher to start would delete
// it: runningOurCode() then answers null and takeOver() exits 0 announcing a
// deploy that has not taken effect. A listening port is the discriminator age
// cannot be.
test("a record whose port still has a listener is kept however old it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccf-fpreap-live-"));
  const srv = createServer();
  try {
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const live = join(dir, `cache-fix-proxy-${port}.sha256`);
    const deadPort = await releasedPort();
    const dead = join(dir, `cache-fix-proxy-${deadPort}.sha256`);
    for (const p of [live, dead]) writeFileSync(p, "x");
    const old = Date.now() / 1000 - 30 * 86400;
    for (const p of [live, dead]) utimesSync(p, old, old);

    await runReaper(dir);

    const left = readdirSync(dir);
    assert.ok(left.includes(`cache-fix-proxy-${port}.sha256`),
              `the reaper deleted a live holder's record: ${left}`);
    assert.ok(!left.includes(`cache-fix-proxy-${deadPort}.sha256`),
              `a record for a port nothing listens on survived: ${left}`);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// THE TESTS ABOVE ALL RUN LIFTED SOURCE, SO NONE OF THEM CAN SEE WHETHER THE
// LAUNCHER EVER CALLS IT. Commenting the call out leaves every one of them green.
// This one spawns the real thing.
test("a launcher that binds reaps on the way up", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccf-fpreap-e2e-"));
  let child = null, port = 0;
  try {
    const stalePort = await releasedPort();
    const stale = join(dir, `cache-fix-proxy-${stalePort}.sha256`);
    writeFileSync(stale, "x");
    const old = Date.now() / 1000 - 30 * 86400;
    utimesSync(stale, old, old);

    port = await releasedPort();
    const env = { ...process.env, TMPDIR: dir, CACHE_FIX_PROXY_PORT: String(port),
                  CACHE_FIX_FORWARD_PROXY: "on", CACHE_FIX_SELF_HEAL: "off" };
    for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete env[k];
    child = spawn(process.execPath, [LAUNCHER, "run-service"], { env, stdio: "ignore" });

    const deadline = Date.now() + 25_000;
    while (existsSync(stale) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.ok(!existsSync(stale),
              "the launcher bound its port and never reaped — the call is unreachable");
  } finally {
    // THE HOLDER IS NOT THE ONLY PROCESS THIS STARTED. run-service spawns a
    // DETACHED standby gap-relay that only stands down for a claimant's SIGHUP,
    // so killing the launcher reparents it to init still holding the port —
    // measured, one per run. Holder first, then whatever is left on the port,
    // the order proxy-held-port's own sweep documents.
    if (child) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    for (const p of onPort(port)) { try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

// A NAME WHOSE PORT IS NOT A NUMBER is not this reaper's to judge, and asking
// the kernel to bind NaN throws rather than answering.
test("a record whose port is not a number is kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccf-fpreap-nan-"));
  try {
    const odd = join(dir, "cache-fix-proxy-healthcheck.sha256");
    writeFileSync(odd, "x");
    const old = Date.now() / 1000 - 30 * 86400;
    utimesSync(odd, old, old);

    await runReaper(dir);

    assert.ok(readdirSync(dir).includes("cache-fix-proxy-healthcheck.sha256"),
              "the reaper judged a name it cannot parse a port out of");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale record is removed, and anything a live holder may still own is kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccf-fpreap-"));
  try {
    const stalePort = await releasedPort();
    const stale = join(dir, `cache-fix-proxy-${stalePort}.sha256`);
    // Fixed numbers, below the ephemeral floor so they cannot collide with the
    // derived one above: none of these four reaches portFree, so only the name
    // has to be distinct.
    const fresh = join(dir, "cache-fix-proxy-30002.sha256");
    // A holder that merely lives long: nothing republishes, so its mtime is its
    // launch time and a short gate would reap a live proxy's own record.
    const longLived = join(dir, "cache-fix-proxy-30003.sha256");
    // Just inside the gate: pins the number, not merely its sign.
    const nearGate = join(dir, "cache-fix-proxy-30005.sha256");
    // A concurrent launcher's in-flight write. publishFingerprint writes
    // `<record>.<pid>` and renames; that name carries RECORD_PREFIX, so only the
    // suffix check stands between this reaper and someone else's pending rename.
    const inflight = join(dir, "cache-fix-proxy-30006.sha256.99999");
    // Ends in .sha256 on purpose: with any other suffix endsWith() alone saves
    // it and an empty prefix would pass.
    const alien = join(dir, "cache-fix-ca-scratch-keepme.sha256");
    for (const p of [stale, fresh, longLived, nearGate, alien, inflight]) writeFileSync(p, "x");
    const age = (p, days) => utimesSync(p, Date.now() / 1000 - days * 86400, Date.now() / 1000 - days * 86400);
    age(stale, 8); age(longLived, 3); age(nearGate, 6); age(alien, 8); age(inflight, 8);

    await runReaper(dir);

    const left = readdirSync(dir).sort();
    assert.ok(!left.includes(`cache-fix-proxy-${stalePort}.sha256`), `the stale record survived: ${left}`);
    assert.ok(left.includes("cache-fix-proxy-30002.sha256"), `the fresh record was removed: ${left}`);
    assert.ok(left.includes("cache-fix-proxy-30003.sha256"),
              `a 3-day-old record was reaped: a holder up that long loses its own record — ${left}`);
    assert.ok(left.includes("cache-fix-proxy-30005.sha256"),
              `a 6-day-old record was reaped: the gate is shorter than 7 days — ${left}`);
    assert.ok(left.includes("cache-fix-proxy-30006.sha256.99999"),
              `the reaper took a concurrent launcher's pending write — ${left}`);
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
