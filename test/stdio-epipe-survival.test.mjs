// A DEAD LOG READER MUST NOT TAKE THE PROCESS THAT SERVES THE PORT.
//
// Measured outage, 27 minutes: a leftover `… | tee <file>` was killed, that tee
// was the only reader of the pipe the proxy held as stdout/stderr, and the next
// write raised EPIPE — an asynchronous 'error' event, which Node promotes to
// uncaughtException when nothing listens. The self-heal handler then wrote the
// stack to the same dead stream and re-entered itself at 100% CPU.
//
// THREE PROCESSES SHARE THAT PIPE and each needed its own guard: the proxy, the
// holder that supervises it (spawned stdio ["inherit","pipe","inherit", fd]),
// and the gap relay (stderr "inherit"). The fix landed in one, then two, then
// all three — each time under a static guard that read the source and each time
// the next reviewer found a shape it accepted. Six revisions of that guard were
// defeated by: a copy inside a function that only runs in forward mode, an
// install one brace deeper than it looked, a feature-flag `if`, a wrapped
// function signature, an `else if` leg, and a comment carrying a stray `}`.
//
// So this asks the question directly instead of describing it. Kill the reader,
// force a write, see who is still alive. A regex cannot be wrong about that.
//
// Four cases for three processes: the relay, the proxy in its DEFAULT (reverse)
// mode, and the holder through BOTH of its dispatch doors — `server` with
// CACHE_FIX_HOLD_PORT=on was the one an earlier fix missed while the other
// passed, so a single holder row would have called that fixed.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { withDeadline } from "./child-deadline.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// A PRIVATE TMPDIR FOR THE WHOLE FILE. Every launcher spawned here inherits
// process.env, and the launcher writes cache-fix-proxy-<port>.sha256 under
// os.tmpdir() on each spawn — so without this the run leaves those records in
// the shared /tmp, one per spawn. Set once rather than at each spawn site: the
// env is inherited, so this also covers sites added later.
const FILE_TMP = mkdtempSync(join(tmpdir(), "ccf-se-"));
process.env.TMPDIR = FILE_TMP;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reap = (p) => { try { process.kill(-p.pid, "SIGKILL"); } catch {} try { p.kill("SIGKILL"); } catch {} };
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                   "ALL_PROXY", "all_proxy", "CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_REQUIRE_HOP",
                   "CACHE_FIX_STANDBY", "LISTEN_FDS", "LISTEN_PID"]) delete env[k];
  return env;
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

describe("a dead stdio reader does not kill the port's process", () => {
  // The relay is the last line of defence: if it dies the address is gone. It
  // needs a REAL socket on fd 3 — handed a pipe it exits 1 by design, which
  // would read as "killed by EPIPE" and prove nothing.
  it("gap-relay survives, and keeps carrying", async (t) => {
    const sock = net.createServer(() => {});
    await new Promise((r) => sock.listen(0, "127.0.0.1", r));
    const port = sock.address().port;
    // A DEAD HOP IS WHAT MAKES IT WRITE. Its only repeatable stderr line is
    // "hop … unusable — trying the next", emitted per failed hop; with no hops
    // configured it goes straight to the origin and says nothing, so the case
    // would pass against a relay with no guard at all. Measured: without this,
    // removing the guard entirely left the relay alive and the test green.
    const deadHop = net.createServer();
    await new Promise((r) => deadHop.listen(0, "127.0.0.1", r));
    const deadPort = deadHop.address().port;
    await new Promise((r) => deadHop.close(r));          // nothing listens there now
    const env = { ...cleanEnv(), CACHE_FIX_FALLBACK_PROXIES: `http://127.0.0.1:${deadPort}` };
    const relay = spawn(process.execPath, [join(root, "bin", "gap-relay.mjs")],
                        { cwd: root, env, detached: true,
                          stdio: ["ignore", "pipe", "pipe", sock._handle.fd] });
    t.after(async () => { reap(relay); await new Promise((r) => sock.close(r)); });
    let err = "";
    relay.stderr.on("data", (d) => (err += d));
    for (let i = 0; i < 80 && !/carrying/.test(err); i++) await settle(50);
    assert.match(err, /carrying/, `premise: the relay never took the socket: ${JSON.stringify(err)}`);
    await new Promise((r) => sock.close(r));

    // PROVE THE WRITE PATH IS LIVE while someone is still reading. Without this
    // the case asserts only that the process survives doing nothing: its first
    // cut had no dead hop, took the origin route which writes nothing, and
    // passed against a relay carrying no guard at all.
    await new Promise((r) => {
      const c = net.connect(port, "127.0.0.1", () => {
        c.write("GET / HTTP/1.0\r\n\r\n"); setTimeout(() => { c.destroy(); r(); }, 400);
      });
      c.on("error", () => r());
    });
    assert.match(err, /unusable/,
      `premise: a connection produced no log line, so destroying the readers below ` +
      `tests nothing: ${JSON.stringify(err)}`);

    relay.stdout.destroy();
    relay.stderr.destroy();                       // nothing reads its pipes now
    // A connection now makes it write: the configured hop refuses, and it logs
    // that before falling through to the origin.
    await new Promise((r) => {
      const c = net.connect(port, "127.0.0.1", () => {
        c.write("GET / HTTP/1.0\r\n\r\n"); setTimeout(() => { c.destroy(); r(); }, 300);
      });
      c.on("error", () => r());
    });
    await settle(600);
    assert.equal(relay.exitCode, null,
      `the relay exited ${relay.exitCode} after its log reader went away. It holds ` +
      `the last descriptor on this address, so that is ECONNREFUSED for every ` +
      `session whose HTTPS_PROXY was fixed at exec`);
  });

  // The proxy's own guard lived inside installSelfHeal(), which runs only when
  // forward mode attaches — and forward mode is opt-in, so the DEFAULT path had
  // none. Measured here before it was moved to module scope: SIGTERM after the
  // readers die exits 1 without the guard and 0 with it, because the shutdown
  // announcement (`proxy releasing the listening socket`) is the write.
  it("the proxy survives in reverse mode, its default", async (t) => {
    const env = { ...cleanEnv(), CACHE_FIX_PROXY_PORT: "0",
                  CACHE_FIX_HOLD_PORT: "off", CACHE_FIX_FORWARD_PROXY: "off" };
    const proxy = spawn(process.execPath, [join(root, "proxy", "server.mjs")],
                        { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => reap(proxy));
    let out = "";
    proxy.stdout.on("data", (d) => (out += d));
    proxy.stderr.on("data", (d) => (out += d));
    for (let i = 0; i < 100 && !/listening on/.test(out); i++) await settle(50);
    assert.match(out, /listening on/,
      `premise: the proxy never came up: ${JSON.stringify(out.slice(-300))}`);
    // PREMISE THAT THE WRITE PATH IS LIVE, not merely that the state is right.
    // A case that proves only "it started" passes against a process that never
    // writes again — which is how the relay row below first passed against a
    // relay carrying no guard at all.
    assert.ok(out.length > 0, "premise: nothing was written before the readers died");

    proxy.stdout.destroy();
    proxy.stderr.destroy();
    proxy.kill("SIGTERM");                     // the shutdown line is the write
    const code = await withDeadline(
      new Promise((r) => proxy.on("exit", (c) => r(c))), 15_000, proxy,
      "the proxy never exited after SIGTERM");
    assert.equal(code, 0,
      `the proxy exited ${code} on a supervised stop whose only difference was a ` +
      `dead log reader. A stop and a crash became indistinguishable, which is what ` +
      `makes Restart=on-failure fire on a deliberate stop`);
  });

  // The holder is reached two ways and both must be covered — an earlier fix
  // guarded only the run-service door, and `server` + CACHE_FIX_HOLD_PORT=on
  // (the door most of the held-port suite uses) still died.
  for (const [name, argv] of [["run-service", ["run-service"]], ["server", ["server"]]]) {
    it(`the holder survives when reached via ${name}`, async (t) => {
      const env = { ...cleanEnv(), CACHE_FIX_PROXY_PORT: "0", CACHE_FIX_HOLD_PORT: "on",
                    CACHE_FIX_FORWARD_PROXY: "off" };
      const holder = spawn(process.execPath, [join(root, "bin", "claude-via-proxy.mjs"), ...argv],
                           { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      t.after(() => reap(holder));
      let out = "";
      holder.stdout.on("data", (d) => (out += d));
      holder.stderr.on("data", (d) => (out += d));
      for (let i = 0; i < 100 && !/listening on/.test(out); i++) await settle(100);
      assert.match(out, /listening on/,
        `premise: the holder never got a proxy up, so nothing here writes: ${JSON.stringify(out.slice(-300))}`);

      holder.stdout.destroy();
      holder.stderr.destroy();                    // nothing reads its pipes now
      // Kill the proxy child: the holder logs the restart, which is the write.
      const port = Number(/listening on [\d.]+:(\d+)/.exec(out)[1]);
      // BOUNDED: `lsof` walks the process table, and this file exists because
      // of a machine whose process table was in trouble. An unbounded wait here
      // hangs the whole run instead of failing — the suite's own static guard
      // caught this one, which is the guard doing exactly its job.
      const listeners = spawn("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: ["ignore", "pipe", "ignore"] });
      let pids = ""; listeners.stdout.on("data", (d) => (pids += d));
      await withDeadline(new Promise((r) => listeners.on("exit", r)), 10_000, listeners,
                         "lsof never returned while looking for the proxy child");
      for (const pid of pids.trim().split("\n").map(Number).filter((n) => n > 1 && n !== holder.pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      await settle(1500);
      assert.equal(holder.exitCode, null,
        `the holder exited ${holder.exitCode} after its log reader went away. It is ` +
        `the process whose entire job is to put the proxy back, and it died writing ` +
        `about doing so`);
    });
  }
});

// A LATE EVENT FROM AN OLD GAP MUST NOT RETIRE A LIVE ONE.
//
// openGap() refuses to open a second gap while `this._gap` is set (`if (this._gap
// || !this._handle) return`), so that field is the only thing standing between
// one acceptor on the descriptor and two. Its 'exit' and 'error' handlers used to
// null it unconditionally — but each fires for the gap it was attached to, and
// openGap runs on EVERY proxy restart, so a late event from the previous gap
// cleared a live successor and the next restart opened a second one beside it.
// Two acceptors on one socket is the shape this file's siblings measured at 60 of
// 125 requests reset.
//
// Counted rather than inspected: the property is "how many gap-relay processes
// does this holder have", which is a number on the machine, not a shape in the
// source. `openStandby` states the same identity rule twenty lines below and had
// always followed it; this is the sibling that was missed in the same sweep.

// LAST, so it cannot delete the dir out from under a sweep that reaps ports
// after the cases: node runs root hooks in registration order.
after(() => { try { rmSync(FILE_TMP, { recursive: true, force: true }); } catch { /* gone */ } });
