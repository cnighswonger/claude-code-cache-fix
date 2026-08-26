// The launcher leaks one `cache-fix-proxy-<port>.sha256` per proxy start and
// nothing removed them. These tests lift the shipped reaper out of the launcher
// and run it, the way proxy-held-port.test.mjs lifts holderPidOn: every slice is
// asserted, so a rename fails the test instead of quietly testing nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { HOP_ENV, freePort, onPort } from "./proc-helpers.mjs";

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
    `const RECORD_PREFIX = ${JSON.stringify(recordConst("RECORD_PREFIX"))};\n` +
    `const RECORD_SUFFIX = ${JSON.stringify(recordConst("RECORD_SUFFIX"))};\n` +
    // Verbatim, not a copy of the number: the inner catch swallows a
    // ReferenceError, so a constant this harness forgets to inject makes the
    // reaper collect NOTHING while every case still reports what it expected.
    `const REAP_AGE_MS = ${ageGate()};\n` +
    `${lift("function portFree(")}\n` +
    `${lift("async function reapFingerprintRecords()")}\nreturn reapFingerprintRecords();`
  )(readdirSync, statSync, rmSync, join, () => dir, net, () => "127.0.0.1");
}

// Once per launcher process, not once per spawn, and not behind
// publishFingerprint's early return.
test("the reap is driven by the supervisor, and off its startup path", () => {
  const hold = lift("function holdPort(");
  assert.ok(hold.includes("reapFingerprintRecords"),
            "holdPort does not reap — the records are never collected");
  assert.ok(!lift("function publishFingerprint(").includes("reapFingerprintRecords"),
            "publishFingerprint reaps, so it is skipped whenever publishing fails and " +
            "repeated on every respawn");
  assert.match(hold, /setTimeout\(reapFingerprintRecords, 0\)\.unref\(\)/,
               "the reap runs inline on the supervisor's startup path; a tmpdir scan " +
               "there delays the bind and destabilises the held-port suite");
  // Deferring alone does not stop it blocking: nothing the loop awaits reaches
  // the poll phase, so without a periodic yield the scan holds the event loop
  // between the bind and the first accept. Measured at 300 records: a
  // setImmediate queued first fires 13 ms into a 28 ms scan with the yield, and
  // not at all without it, at no cost to the total.
  assert.match(lift("async function reapFingerprintRecords()"), /await new Promise\(setImmediate\)/,
               "the scan never yields, so it holds the event loop for its whole pass");
});

// AGE ALONE MAKES SEVEN DAYS A DEADLINE, NOT A MARGIN. Nothing republishes a
// record, so a holder that neither respawns nor is redeployed for a week has an
// over-age record while fully live, and the next launcher to start would delete
// it: runningOurCode() then answers null and takeOver() exits 0 announcing a
// deploy that has not taken effect. A listening port is the discriminator age
// cannot be.
test("a record whose port still has a listener is kept however old it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccf-fpreap-live-"));
  const srv = net.createServer();
  try {
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const live = join(dir, `cache-fix-proxy-${port}.sha256`);
    // Derived, not fixed: a fixed port sits inside the ephemeral range, so a
    // sibling file's launcher can hold it for a whole run and portFree() then
    // answers false for a record this case expects reaped.
    const deadPort = await freePort();
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

// Port 0 is the value `port` carries before freePort() assigns it, and the
// finally below sweeps whatever onPort() returns. The marker ours() reads is
// CACHE_FIX_PROXY_PORT, which a proxy child legitimately carries as 0 when it
// inherits the holder's listening fd -- so a throw above the assignment aims
// the sweep at the operator's live proxy. Measured on this host: 7 processes,
// one of them the deployed ~/.local/share/cache-fix-fork/proxy/server.mjs.
test("onPort(0) selects nothing, and still selects on a real port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccf-onport0-"));
  const kids = [];
  try {
    mkdirSync(join(dir, "bin"));
    const stub = join(dir, "bin", "stub.mjs");
    writeFileSync(stub, "setInterval(() => {}, 1e9);\n");
    const real = await freePort();
    const spawnStub = (portValue) => {
      const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(portValue) };
      for (const k of HOP_ENV) delete env[k];
      const c = spawn(process.execPath, [stub], { env, stdio: "ignore" });
      kids.push(c);
      return c;
    };
    const zero = spawnStub(0);
    const named = spawnStub(real);
    for (const c of [zero, named]) await new Promise((r) => setTimeout(r, 50));

    // THE CONTROL. Without it an empty onPort(0) proves nothing: a host with no
    // proxy at all answers [] either way.
    assert.ok(onPort(real).includes(String(named.pid)),
      `the instrument cannot see a stub on its own port ${real} -- the case below is vacuous`);

    assert.ok(!onPort(0).includes(String(zero.pid)),
      "onPort(0) selected a process carrying CACHE_FIX_PROXY_PORT=0; the sweep would SIGKILL the live proxy");
  } finally {
    for (const c of kids) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
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
    const stalePort = await freePort();
    const stale = join(dir, `cache-fix-proxy-${stalePort}.sha256`);
    writeFileSync(stale, "x");
    const old = Date.now() / 1000 - 30 * 86400;
    utimesSync(stale, old, old);

    port = await freePort();
    // CLAUDE_CONFIG_DIR with TMPDIR, or the launcher mints its CA in the
    // operator's real ~/.claude and republishes ca-trust.d/ccf.pem — the
    // rendezvous file every sibling component reads — from under a live proxy.
    // CACHE_FIX_FORWARD_PROXY is what asks for that publish, and the reap does
    // not need a CA at all.
    const env = { ...process.env, TMPDIR: dir, CLAUDE_CONFIG_DIR: dir,
                  CACHE_FIX_PROXY_PORT: String(port), CACHE_FIX_SELF_HEAL: "off" };
    for (const k of HOP_ENV) delete env[k];
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

// THE CEILING IS INVISIBLE FROM THE DIRECTORY. Without it listen() throws
// ERR_SOCKET_BAD_PORT, the reaper's inner catch keeps the record, and a fixture
// asserting "the record survived" passes either way — measured, that case stayed
// green with the guard deleted. Asked of the predicate the two differ: answer
// false, or reject.
test("portFree answers false outside the port range, rather than throwing", async () => {
  const portFree = new Function("net", "bindAddr",
    `${lift("function portFree(")}\nreturn portFree;`)(net, () => "127.0.0.1");
  assert.equal(await portFree("70000"), false, "a port above 65535 reached listen()");
  assert.equal(await portFree("0"), false, "port 0 reached listen(), which takes a random port");
  assert.equal(await portFree("-1"), false);
});

test("a stale record is removed, and anything a live holder may still own is kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccf-fpreap-"));
  try {
    const stalePort = await freePort();
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
    // Over-age, so it DOES reach portFree: a name with no port in it is not this
    // reaper's to judge, and asking the kernel to bind NaN throws rather than
    // answering.
    const unparsed = join(dir, "cache-fix-proxy-healthcheck.sha256");
    // The range edges, both over-age so they DO reach portFree. Port 0 is a name
    // older launcher versions demonstrably wrote, and it is the worst one to get
    // wrong: listen(0) binds a random free port and always succeeds, so without
    // the floor the probe would call every port-0 record collectable.
    const zero = join(dir, "cache-fix-proxy-0.sha256");
    for (const p of [stale, fresh, longLived, nearGate, alien, inflight, unparsed, zero]) writeFileSync(p, "x");
    const age = (p, days) => utimesSync(p, Date.now() / 1000 - days * 86400, Date.now() / 1000 - days * 86400);
    age(stale, 8); age(longLived, 3); age(nearGate, 6); age(alien, 8); age(inflight, 8); age(unparsed, 8);
    age(zero, 8);

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
    assert.ok(left.includes("cache-fix-proxy-healthcheck.sha256"),
              `the reaper judged a name it cannot parse a port out of: ${left}`);
    assert.ok(left.includes("cache-fix-proxy-0.sha256"),
              `port 0 was probed: listen(0) takes a random port and always succeeds — ${left}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// BOTH HALVES OF THE NAME, from the launcher's own constants. A hardcoded copy
// here drifts silently the other way: the reaper would match nothing and collect
// nothing, with every case in this file still green.
function ageGate() {
  const m = SRC.match(/const REAP_AGE_MS = ([^;]+);/);
  assert.ok(m, "REAP_AGE_MS is gone — the two reapers can drift to different gates");
  assert.match(lift("async function reapFingerprintRecords()"), /REAP_AGE_MS/,
               "the reaper no longer reads the shared gate");
  return m[1];
}

function recordConst(name) {
  const m = SRC.match(new RegExp(`const ${name} = "([^"]+)";`));
  assert.ok(m, `${name} is gone — the writer and the reaper can drift apart again`);
  assert.ok(lift("function fingerprintPath(").includes(name),
            `fingerprintPath no longer builds the name from ${name}`);
  return m[1];
}
