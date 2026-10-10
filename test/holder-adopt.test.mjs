import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HOP_ENV, cmdOf, onPort } from "./proc-helpers.mjs";

// A HOLDER THAT ADOPTS ITS PREDECESSOR'S SOCKET, started the way a handover
// starts one: the listening socket on fd 3 and the two handover variables. It
// then retires the dead holder's standby relay, and that scan has to be a
// question about relays and nothing else.
const launcher = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-via-proxy.mjs");
const scratch = mkdtempSync(join(tmpdir(), "holder-adopt-"));
const sleeper = join(scratch, "sleeper.mjs");
writeFileSync(sleeper, "setInterval(() => {}, 1e6);\n");
after(() => rmSync(scratch, { recursive: true, force: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// reap() below runs in a case's `finally`, which an abort skips. This hook is the
// backstop. It signals the processes THIS file spawned while they are unreaped (a
// pid that has exited can be reused, a ChildProcess cannot), then sweeps the ports
// adopt() opened: the holder's standby and proxy are nobody's child.
const spawned = [], ports = new Set();
const track = (p) => { spawned.push(p); return p; };
process.on("exit", () => {
  for (const p of spawned) if (p.exitCode === null && p.signalCode === null) { try { p.kill("SIGKILL"); } catch { } }
  for (const port of ports) for (const p of onPort(port)) { try { process.kill(Number(p), "SIGKILL"); } catch { } }
});

// `script` is a symlink to the launcher, so the command line the scan reads is
// the one under test while the code that runs is the real one. `alongside` are
// stand-ins that hold the same socket under their own command lines.
async function adopt(script, { env: extra = {}, alongside = [] } = {}) {
  const link = (from, to) => { mkdirSync(dirname(to), { recursive: true }); symlinkSync(from, to); return to; };
  const sock = net.createServer();
  await new Promise((r) => sock.listen(0, "127.0.0.1", r));
  const port = sock.address().port, fd = sock._handle.fd;
  ports.add(port);
  const env = { ...process.env, ...extra };
  for (const k of [...HOP_ENV, "LISTEN_PID", "CACHE_FIX_HOLD_PORT", "CACHE_FIX_WATCH_DEPLOY_MS"]) delete env[k];
  Object.assign(env, { CACHE_FIX_PROXY_PORT: String(port), CACHE_FIX_HOLDER_HANDOVER: "1",
                       LISTEN_FDS: "1", CACHE_FIX_SELF_HEAL: "off",
                       // The scan is one shot and a probe that times out reads "cannot
                       // tell", so on a box saturated by sibling files the 2s default
                       // leaves the stale relay alone and this reads as a defect.
                       CACHE_FIX_PROBE_TIMEOUT_MS: "20000" });
  const others = alongside.map((p) => track(spawn(process.execPath, [link(sleeper, p)], { stdio: ["ignore", "ignore", "ignore", fd] })));
  const holder = track(spawn(process.execPath, [link(launcher, script), "run-service"], { env, stdio: ["ignore", "ignore", "ignore", fd] }));
  sock.close();   // the holder keeps the listening socket; this copy must not accept
  return { holder, port, others };
}

// Holder first, so nothing respawns what is reaped after it; then whatever of
// ours is still on this port.
async function reap({ holder, port, others }) {
  for (const p of [holder, ...others]) { try { p.kill("SIGKILL"); } catch { } }
  for (let i = 0; i < 3; i++) {
    const left = onPort(port);
    if (!left.length) break;
    for (const p of left) { try { process.kill(Number(p), "SIGKILL"); } catch { } }
    await sleep(300);
  }
  ports.delete(port);   // freed: the exit hook sweeps only ports whose case aborted before here
}

const health = (port) => new Promise((r) => {
  http.get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 3_000 }, (s) => { s.resume(); r(s.statusCode); })
    .on("error", () => r(0)).on("timeout", function () { this.destroy(); });
});

// "" when the proxy answers and the holder is still there a second later, else
// what went wrong. A holder that signals itself still lets the proxy it had
// already started answer once, so the answer alone proves nothing.
async function serving({ holder, port }) {
  const gone = () => holder.exitCode !== null || holder.signalCode;
  for (const by = Date.now() + 15_000; !gone() && Date.now() < by && await health(port) !== 200;) await sleep(100);
  if (!gone()) await sleep(1_000);
  if (gone()) return `the holder exited (${holder.exitCode ?? holder.signalCode})`;
  return await health(port) === 200 ? "" : "the proxy is not answering";
}

// The gap-relay children of <pid>: the standby a holder places at adoption.
const standbysOf = (pid) => {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n")
      .filter((p) => /\/bin\/gap-relay\.mjs\b/.test(cmdOf(p)));
  } catch { return []; }
};

describe("a holder adopting a dead holder's socket", () => {
  // Every process holding the adopted socket is in the scan's answer, and only a
  // relay is to be retired. Not the holder itself (run here AS a relay-named
  // script, so only an exclusion by pid saves it), not the standby the holder
  // placed itself (a gap-relay holding this very socket, spared by its pid), and
  // not a proxy whose install path merely contains "gap-relay": the relay is its
  // script, not the word, and the whole word: `gap-relay.mjs.bak` is another file.
  it("retires a stale relay and nothing else", async () => {
    const h = await adopt(join(scratch, "self", "bin", "gap-relay.mjs"),
      { alongside: [join(scratch, "stale", "bin", "gap-relay.mjs"), join(scratch, "gap-relay", "proxy", "server.mjs"),
                    join(scratch, "decoy", "bin", "gap-relay.mjs.bak")] });
    const [stale, bystander, decoy] = h.others;
    try {
      assert.equal(await serving(h), "", "the holder signalled itself");
      for (const by = Date.now() + 10_000; !stale.signalCode && Date.now() < by;) await sleep(50);
      assert.equal(stale.signalCode, "SIGHUP", "the stale standby was not retired");
      assert.equal(bystander.signalCode ?? bystander.exitCode, null, "a proxy under a gap-relay install path was signalled");
      assert.equal(decoy.signalCode ?? decoy.exitCode, null, "a script whose name only starts with gap-relay.mjs was signalled");
      // The signals went out in one loop, so a standby they reached is dying by now.
      await sleep(300);
      assert.equal(standbysOf(h.holder.pid).length, 1, "the holder retired the standby it had just placed");
    } finally { await reap(h); }
  });

  // The scan shells out, and every connection that arrives while it runs queues
  // with nobody accepting, on every deploy that finds nothing to retire. So it
  // runs after `listening`, once the proxy is already being started.
  it("scans for the stale standby only after the proxy is started", async () => {
    const bin = join(scratch, "shim");
    mkdirSync(bin);
    writeFileSync(join(bin, "lsof"),
      `#!/bin/sh\npgrep -P "$PPID" -f server.mjs | wc -l >> "${join(scratch, "lsof.log")}"\nexit 1\n`);
    chmodSync(join(bin, "lsof"), 0o755);
    const h = await adopt(join(scratch, "order", "bin", "claude-via-proxy.mjs"), { env: { PATH: `${bin}:${process.env.PATH}` } });
    try {
      assert.equal(await serving(h), "");
      assert.equal(readFileSync(join(scratch, "lsof.log"), "utf8").trim().split("\n")[0].trim(), "1",
        "the scan ran before the holder had started its proxy");
    } finally { await reap(h); }
  });
});
