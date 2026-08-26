// A private TMPDIR for this file, because the launchers spawned below write
// under os.tmpdir(). First, so nothing reads one before it is set.
import "./file-tmpdir.mjs";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { OURS, cmdOf, freePort as takePort, listeners, onPort } from "./proc-helpers.mjs";

const launcherPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-via-proxy.mjs");

// Its own file, and that is the point rather than tidiness. This case samples a
// live port while a holder is replaced, so it is sensitive to how much else is
// running — inside the held-port file it starved a neighbour into failing 4 of
// 5 runs, and node gives each FILE its own process. One case here, alone.

// Every port this file hands out, so the sweep at the bottom knows where to
// look. A standby that has not armed yet holds a socket nobody ever listened
// on, so `lsof -sTCP:LISTEN` cannot see it while a case is finishing — it
// becomes visible a couple of seconds later, by which time the case's own
// cleanup has run and moved on.
const usedPorts = [];
// The shared allocator plus this file's own cleanup registry — the registry is
// file-local (its after() hook sweeps it), the allocation is not.
async function freePort() {
  const p = await takePort();
  usedPorts.push(p);
  return p;
}

const probe = (port) => new Promise((res) => {
  const r = http.get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 8_000 },
                     // THE STATUS, not merely a reply. A standby relay carrying
                     // this address answers 503 on purpose, and a fixture that
                     // took any response for "the proxy is up" started measuring
                     // 1.3s before one existed.
                     (s) => { s.resume(); s.on("end", () => res(s.statusCode === 200 ? "ok" : `ERR:${s.statusCode}`)); });
  r.on("error", (e) => res(`ERR:${e.code}`));
  // The timeout must RESOLVE, not merely fire: an unhandled one leaves the
  // request hanging and the sampler stalls on it forever.
  r.on("timeout", () => { r.destroy(); res("ERR:ETIMEDOUT"); });
});

// SIGHUP and SIGUSR2 are a pair, and the difference is who ends up holding the
// address. SIGHUP says LET GO, which leaves the port unowned until somebody
// binds it — and nobody can bind while the incumbent still holds it, so the
// address is dead for the incoming child's whole boot. Measured on that route:
// 63 refused of 1,281.
//
// SIGUSR2 says REPLACE YOURSELF: the holder spawns its successor on THIS
// socket and only then leaves, so the last descriptor is never dropped and the
// successor never binds anything. Measured on this route: 0 refused of 2,941.
// cswap's pin hit the same failure first and fixed it the same way — a
// successor that adopts rather than binds, which makes the replacement
// same-tree instead of cross-tree.
// BOTH RELAYS MUST KNOW THE SAME ADDRESS IS THEIRS.
//
// gap-relay excludes itself from its own hop list using
// ["127.0.0.1","localhost","[::1]", CACHE_FIX_HELD_HOST] — so a relay spawned
// without HELD_HOST silently falls back to loopback-only. openStandby passed it;
// openGap did not, for the whole life of the file. With
// CACHE_FIX_PROXY_BIND=<lan-ip> and a fallback list naming that same address —
// the symmetric chain this repo documents — the armed gap forwards to ITSELF.
// gap-relay measured that: 22 -> 8,195 -> 29,814 descriptors, climbing.
//
// Asserted as a PAIR rather than on one spawn, because the defect was a
// divergence: one of two siblings drifted, and only comparing them says so.
describe("relay self-identification", () => {
  it("hands the gap and the standby the same self-address keys", () => {
    const src = readFileSync(launcherPath, "utf8");
    const envOf = (fn) => {
      const body = src.slice(src.indexOf(`  ${fn}(`));
      const env = /env: \{[\s\S]*?\},\n/.exec(body.slice(0, body.indexOf("\n  }")))?.[0];
      assert.ok(env, `${fn}'s spawn env is gone — this no longer compares anything`);
      return new Set([...env.matchAll(/CACHE_FIX_[A-Z_]+/g)].map((m) => m[0]));
    };
    const gap = envOf("openGap"), standby = envOf("openStandby");
    // Not set equality: the standby legitimately carries STANDBY and
    // STANDBY_PARENT, which say "arm later", not "this address is mine".
    for (const k of ["CACHE_FIX_HELD_PORT", "CACHE_FIX_HELD_HOST"]) {
      assert.ok(standby.has(k), `openStandby stopped passing ${k}`);
      assert.ok(gap.has(k),
        `openGap does not pass ${k} while openStandby does — the gap relay then ` +
        `excludes only loopback from its hop list, and a non-loopback bind whose ` +
        `fallback names the same address makes it forward to itself`);
    }
  });
});

describe("holder handover (SIGUSR2)", () => {
  // ONE SWEEP FOR THE FILE, over the ports it used and nobody else's. Reaping
  // by process name would reach into a neighbouring file's live fixture, since
  // node runs test files concurrently in their own processes.
  after(async () => {
    for (let i = 0; i < 6; i++) {
      let any = false;
      for (const port of usedPorts) {
        for (const q of onPort(port)) {
          try { process.kill(Number(q), "SIGHUP"); any = true; } catch { }
        }
      }
      if (!any && i) break;
      await new Promise((r) => setTimeout(r, 700));
    }
  });
  it("hands the port to a successor without refusing a request", async () => {
    const port = await freePort();
    const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port),
                  CACHE_FIX_FORWARD_PROXY: "on", CACHE_FIX_SELF_HEAL: "off" };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID",
                     "CACHE_FIX_HOLD_PORT", "CACHE_FIX_WATCH_DEPLOY_MS"]) delete env[k];
    const holder = spawn(process.execPath, [launcherPath, "run-service"],
                         { env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const up = Date.now() + 25_000;
      let body = await probe(port);
      while (body.startsWith("ERR:") && Date.now() < up) body = await probe(port);
      assert.equal(body, "ok", "the holder never came up, so nothing was measured");

      const before = new Set(listeners(port));
      assert.ok(before.size, "premise: somebody must hold the port before we hand it on");

      let stop = false, served = 0;
      const refused = [];
      const pump = (async () => {
        while (!stop) {
          const b = await probe(port);
          if (b.startsWith("ERR:")) refused.push(b); else served++;
          await new Promise((r) => setTimeout(r, 10));
        }
      })();

      holder.kill("SIGUSR2");
      // Until a process that did NOT hold it before does. A fixed wait either
      // races the handover or pads the run.
      const until = Date.now() + 25_000;
      let fresh = [];
      while (Date.now() < until && !fresh.length) {
        await new Promise((r) => setTimeout(r, 100));
        fresh = listeners(port).filter((p) => !before.has(p));
      }
      await new Promise((r) => setTimeout(r, 500));   // sample past the swap
      stop = true; await pump;

      assert.ok(fresh.length,
        "no new process ever held the port — SIGUSR2 was ignored and nothing was handed on");
      assert.ok(served > 0, "no request succeeded at all — the sampler measured nothing");
      assert.deepEqual(refused, [],
        `the handover refused ${refused.length} of ${served + refused.length} requests ` +
        `(${[...new Set(refused)].join(", ")}); a successor that BINDS instead of adopting ` +
        `cannot do better, which is why it has to be handed the descriptor`);
      assert.equal(await probe(port), "ok", "the port did not survive the handover");

      // AND THE HANDOVER CARRIED THE PROTECTION FORWARD. Every deploy comes
      // through here, so a successor that placed no standby of its own would
      // leave the fleet with the code and without the cover — and a predecessor
      // that kept its own would leave two of them, both waiting to arm.
      const relays = listeners(port).filter((p) => /gap-relay/.test(cmdOf(p)));
      assert.equal(relays.length, 1,
        `${relays.length} standby relays hold the port after a handover; one is the contract, ` +
        `two both arm when the lineage dies and take turns dropping connections`);
      for (const p of listeners(port).filter((q) => /\brun-service\b|server\.mjs/.test(cmdOf(q)))) {
        try { process.kill(Number(p), "SIGKILL"); } catch { }
      }
      const by = Date.now() + 15_000;
      let after = await probe(port);
      while (after === "ok" && Date.now() < by) {          // the proxy's own 200 first
        await new Promise((r) => setTimeout(r, 200));
        after = await probe(port);
      }
      while (after !== "ERR:503" && Date.now() < by) {     // then the relay's 503
        await new Promise((r) => setTimeout(r, 200));
        after = await probe(port);
      }
      assert.equal(after, "ERR:503",
        "the successor's lineage was killed and the address went with it — a deploy left the " +
        "port with no standby behind it");
    } finally {
      try { holder.kill("SIGKILL"); } catch { }
      // The successor is detached and deliberately outlives its predecessor —
      // that guard is what makes the handover free — so it has to be reaped by
      // the address it holds. SIGHUP, never SIGTERM: SIGTERM means "hand on".
      for (let i = 0; i < 5; i++) {
        const held = listeners(port);
        if (!held.length) break;
        for (const p of held) {
          const pid = Number(p);
          if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, "SIGHUP"); } catch { } }
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });
  // A HANDOVER SUCCESSOR MUST STILL PUT A HOLDER BACK. This is the state two of
  // our three machines sat in for 30 and 48 days: serving 200, holder long gone,
  // nothing left to restart the proxy if it ever stopped. The lineage reaches it
  // the first time anything redeploys, because a successor used to skip the
  // self-heal outright — and a successor is what every proxy becomes.
  //
  // The guard it skipped on was not wrong: a successor's ppid changes on EVERY
  // handover (the predecessor exits right after), so "ppid changed" fires on a
  // healthy one and starts a RIVAL holder — measured at 1,970 then 6,528
  // requests lost, port down twice. The answer is to ask whether anyone is
  // SUPERVISING the port, which is a fact, rather than whether our parent
  // changed, which is a heuristic that cannot tell the two apart.
  it("puts a holder back when a handover successor outlives its holder", async () => {
    const port = await freePort();
    const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port),
                  CACHE_FIX_FORWARD_PROXY: "on" };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID",
                     "CACHE_FIX_HOLD_PORT", "CACHE_FIX_WATCH_DEPLOY_MS",
                     "CACHE_FIX_SELF_HEAL"]) delete env[k];
    const holder = spawn(process.execPath, [launcherPath, "run-service"],
                         { env, stdio: ["ignore", "pipe", "pipe"] });
    const supervised = () => listeners(port).some((p) => {
      let pid = Number(p);
      for (let hop = 0; Number.isInteger(pid) && pid > 1 && hop < 4; hop++) {
        let line = "";
        try { line = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }); }
        catch { return false; }
        if (line.includes("run-service")) return true;
        try { pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()); }
        catch { return false; }
      }
      return false;
    });
    try {
      const up = Date.now() + 25_000;
      let body = await probe(port);
      while (body.startsWith("ERR:") && Date.now() < up) body = await probe(port);
      assert.equal(body, "ok", "the holder never came up, so nothing was measured");

      // Force a HANDOVER, so the process on the port carries FROM_HANDOVER: the
      // child hands its socket to a successor it spawns itself.
      const kids = execFileSync("pgrep", ["-P", String(holder.pid)], { encoding: "utf8" })
        .trim().split("\n").filter(Boolean).map(Number);
      assert.ok(kids.length, "premise: the holder must have a child to hand over");
      process.kill(kids[0], "SIGTERM");
      const swapped = Date.now() + 20_000;
      while (Date.now() < swapped && listeners(port).includes(String(kids[0])))
        await new Promise((r) => setTimeout(r, 100));

      assert.ok(supervised(), "premise: the port must be supervised before we take the holder away");
      holder.kill("SIGKILL");

      const back = Date.now() + 45_000;
      let ok = false;
      while (!ok && Date.now() < back) {
        await new Promise((r) => setTimeout(r, 500));
        ok = supervised();
      }
      assert.ok(ok,
        "the port is served but nothing supervises it — a handover successor skipped the " +
        "self-heal, so this lineage can never put a holder back and the next crash is an outage");
      assert.equal(await probe(port), "ok", "the port did not survive losing its holder");
    } finally {
      try { holder.kill("SIGKILL"); } catch { }
      for (let i = 0; i < 6; i++) {
        const held = listeners(port);
        if (!held.length) break;
        for (const p of held) {
          const pid = Number(p);
          if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, "SIGHUP"); } catch { } }
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });
  // A STALE HOLDER IS INVISIBLE FROM THE PROXY. It execs the launcher from
  // DISK, so it spawns a perfectly current proxy while carrying none of the
  // holder-side code itself — and proxy_tree therefore says nothing about the
  // layer above it. Presence of a marker proves a GENERATION, not a commit:
  // measured, our own fleet reported "current" on a marker check ten minutes
  // after a holder-side commit it was not running.
  //
  // cswap's pin hit the same blind spot from the other side and worse: they
  // diffed what shipped TODAY instead of what their PROCESSES lacked, and their
  // holders turned out to be twelve releases behind with the adopt branch
  // missing entirely.
  it("publishes the holder's own bytes, so a stale holder is visible", async () => {
    const port = await freePort();
    const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port),
                  CACHE_FIX_FORWARD_PROXY: "on", CACHE_FIX_SELF_HEAL: "off" };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID",
                     "CACHE_FIX_HOLD_PORT", "CACHE_FIX_WATCH_DEPLOY_MS"]) delete env[k];
    const holder = spawn(process.execPath, [launcherPath, "run-service"],
                         { env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const up = Date.now() + 25_000;
      let body = await probe(port);
      while (body.startsWith("ERR:") && Date.now() < up) body = await probe(port);
      assert.equal(body, "ok", "the holder never came up, so nothing was measured");

      // RETRIED TO 200. A restart can put the relay in front between the probe
      // above and this read, and the relay answers 503 on purpose — under full
      // suite load that turned into "no holder_tree" and a failure about the
      // wrong thing. The question here is what the HOLDER publishes, so wait
      // until a holder is the one answering.
      const readHealth = () => new Promise((res) => {
        http.get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 8_000 },
                 (r) => { let b = ""; r.on("data", (d) => (b += d));
                          r.on("end", () => res(r.statusCode === 200 ? b : "{}")); })
          .on("error", () => res("{}"));
      });
      let health = await readHealth();
      const by = Date.now() + 15_000;
      while (health === "{}" && Date.now() < by) {
        await new Promise((r) => setTimeout(r, 250));
        health = await readHealth();
      }
      const reported = JSON.parse(health).holder_tree;
      // THE WHOLE DIRECTORY, not a list of files. Naming them was wrong twice —
      // first gap-relay.mjs, then ca-trust.mjs which the launcher imports — and
      // both times a stale machine reported itself current. Recomputed the way
      // the launcher does, so this fails if the two ever diverge.
      const dir = dirname(launcherPath);
      const layer = createHash("sha256");
      // THE LAUNCHER'S OWN RULE, BOTH HALVES OF IT. A first attempt lifted only
      // the `.filter(...)` and passed `scratch` in as a parameter — which left
      // the regex a hand-written copy, so narrowing it to
      // /^scratch-launcher-/ produced a byte-identical lift and the case still
      // passed. Lifting the `const scratch = ...;` statement too is what makes
      // "this fails if the two diverge" actually true.
      // COMMENTS STRIPPED BEFORE LIFTING, and this is the load-bearing half —
      // the sibling source-parsing case in proxy-held-port.test.mjs learned it
      // first. Both regexes take the FIRST match in the file, so a comment that
      // quotes the rule shadows the code: measured, narrowing the real regex to
      // /^scratch-launcher-/ while a correct `const scratch = ...` sits quoted
      // in the prose above it makes this case PASS. That prose block is eleven
      // lines directly above the code and already discusses this filter, so the
      // trigger is one ordinary edit away, and it disarms the case silently.
      const src = readFileSync(launcherPath, "utf8").replace(/\/\/[^\n]*/g, "");
      const decl = /const scratch = \/[^\n]*\/;/.exec(src)?.[0];
      const pred = /\.filter\(\(n\) => n\.endsWith\("\.mjs"\)[^\n]*\)/.exec(src)?.[0];
      assert.ok(decl && pred,
        "the holder-tree filter moved — this no longer recomputes what the launcher does");
      // eslint-disable-next-line no-new-func
      const keep = Function("names", `${decl}\nreturn names${pred};`);

      // THE SUITE'S SCRATCH MUST NOT COUNT, and it is VISIBLE now (no leading
      // dot), so nothing but this predicate keeps it out. Counting it would make
      // holder_tree depend on WHEN it was read — measured on CI once as
      // ba5cbf0b4567 at startup vs a7a72ba4c005 a moment later.
      //
      // The names are `scratch-*`, NOT `test-*`, and that is load-bearing
      // elsewhere: `node --test` with no path argument globs `**/test-*.?(c|m)js`,
      // so a `bin/test-launcher-<tag>.mjs` left by a killed run would be
      // DISCOVERED AND EXECUTED as a test file — a launcher copy with no argv,
      // which falls through to wrapper mode inside the runner. Measured.
      assert.deepEqual(
        keep(["claude-via-proxy.mjs", "ca-trust.mjs", "scratch-launcher-99-1.mjs",
              "scratch-fake-server-99-1.mjs", ".hidden.mjs", "notes.txt"]),
        ["claude-via-proxy.mjs", "ca-trust.mjs"],
        "the holder-tree walk no longer ignores the suite's stand-ins — a run of the " +
        "tests now changes the identity the holder publishes about itself");

      for (const f of keep(readdirSync(dir)).sort()) {
        layer.update(f).update(readFileSync(join(dir, f)));
      }
      const onDisk = layer.digest("hex").slice(0, 12);
      assert.equal(reported, onDisk,
        "health does not report the bytes the HOLDER is running, so a holder left behind by a " +
        "deploy is indistinguishable from a current one — it spawns a current proxy either way");
    } finally {
      try { holder.kill("SIGKILL"); } catch { }
      for (let i = 0; i < 5; i++) {
        const held = listeners(port);
        if (!held.length) break;
        for (const p of held) {
          const pid = Number(p);
          if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, "SIGHUP"); } catch { } }
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });
  // DETERMINISTIC NOW, and it was not. This case used to pass with the guard
  // REMOVED: on the SIGHUP path the child drains and exits faster than the
  // self-heal's one-second poll, so the tick that would resurrect a holder
  // never happened here. It happened on the work Mac, where nine proxies were
  // serving and drained slowly enough to be polled with their holder already
  // gone — a real failure the harness could not reproduce.
  //
  // Fixed by making the race deterministic rather than hoping for it:
  // CACHE_FIX_SELF_HEAL_MS shortens the poll so a tick lands INSIDE the
  // release, and the holder is SIGKILLed first so the self-heal is armed
  // (marker set, ppid now 1) before the child is asked to let go. Mutation-
  // checked both ways — with the guard the port stays gone, without it a
  // replacement holder appears.
  //
  // RELEASE MUST MEAN THE LINEAGE STOPS. A holder asked to let go forwards that
  // to its child, and the child's self-heal used to notice its holder was gone
  // and put a replacement there — correct for a holder that DIED, wrong for one
  // that was asked to release. Measured on the work Mac before this was fixed:
  // nine holders released, nine back on the same ports within 23 seconds, so a
  // port could not be retired at all.
  it("stays gone when released, instead of resurrecting a holder", async () => {
    const port = await freePort();
    const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port),
                  CACHE_FIX_FORWARD_PROXY: "on" };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID",
                     "CACHE_FIX_HOLD_PORT", "CACHE_FIX_WATCH_DEPLOY_MS",
                     "CACHE_FIX_SELF_HEAL"]) delete env[k];
    env.CACHE_FIX_SELF_HEAL_MS = "50";
    const holder = spawn(process.execPath, [launcherPath, "run-service"],
                         { env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const up = Date.now() + 25_000;
      let body = await probe(port);
      while (body.startsWith("ERR:") && Date.now() < up) body = await probe(port);
      assert.equal(body, "ok", "the holder never came up, so nothing was measured");

      // ARM the self-heal first: kill the holder, so the child's marker no
      // longer matches its ppid. Then ask the CHILD to release. With the poll
      // at 50ms a tick is guaranteed to land while it is releasing.
      // THE PROXY child, not the first one. A holder also parents a standby
      // relay, and `| head -1` picked that instead — the release then went to a
      // process that has no release, the proxy never heard it, and the case
      // failed reporting a resurrection that had not happened.
      const kid = Number(execFileSync("pgrep", ["-P", String(holder.pid)], { encoding: "utf8" })
        .trim().split("\n").find((p) => /server\.mjs/.test(cmdOf(p))));
      assert.ok(Number.isInteger(kid) && kid > 1, "premise: the holder must have a proxy child");
      // AN ACCEPTED, IDLE CONNECTION, so the release cannot finish inside one
      // tick. server.close() waits on connections the proxy has ACCEPTED, and
      // without one the drain completes in under 50ms and the poll that would
      // resurrect a holder never runs — measured, the mutation survived twice
      // before this line existed.
      const held = net.connect({ host: "127.0.0.1", port });
      await new Promise((r) => held.on("connect", r));
      // STOPPED, NOT KILLED, AND ONLY THEN THE RELEASE. The self-heal fires on
      // exactly one condition (proxy/server.mjs): `heldBy !== String(ppid)`,
      // which becomes true the instant the holder DIES and its child reparents
      // to 1. Killing first and releasing second therefore opens a window in
      // which the self-heal is armed and the release word has not landed —
      // and a tick inside that window resurrects a supervisor LEGITIMATELY,
      // because from the proxy's side an unexplained holder death is exactly
      // what it must repair.
      //
      // That window was 50ms wide and it is what reddened CI. Measured on
      // run 32186749592 (node 20): this case failed with two pids and no names.
      // The mutation control here prints what a resurrection actually looks
      // like — `run-service` PLUS `server.mjs`, two processes — and the CI
      // failure had exactly two. A slow exit cannot produce that pair: the
      // holder was killed outright, so a lingering `run-service` can only be a
      // NEW one.
      //
      // SIGSTOP closes the window instead of narrowing it. A stopped holder
      // cannot restart the child — which is why the kill had to come first at
      // all — and its pid still exists, so `ppid` never moves and the self-heal
      // cannot arm. The release lands against a quiet lineage, and only then
      // does the kill arm the watcher, which now finds `releasingPort` already
      // true. Widening the poll would only have made the race rarer; this
      // removes the ordering the race needs.
      holder.kill("SIGSTOP");
      try { process.kill(kid, "SIGHUP"); } catch { }
      // The release word has to be PROCESSED before the watcher can arm, not
      // merely delivered — the flag is set in the proxy's own SIGHUP handler.
      await new Promise((r) => setTimeout(r, 250));
      holder.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 6_000));
      held.destroy();
      await new Promise((r) => setTimeout(r, 2_000));
      // NO LINEAGE, rather than no listener. The standby is a descriptor holder
      // that outlives a killed holder on purpose, so it is expected here; what
      // must not come back is a supervisor. Asserting on the command line keeps
      // the mutation this case exists for — a self-heal that resurrects a holder
      // shows up as `run-service` or `server.mjs` and fails right here.
      //
      // THE 2s ABOVE IS THE DETECTION WINDOW AND STAYS. A self-heal polls every
      // 50ms here, so a resurrection is back well inside it; shortening it would
      // lose the mutation. What follows is NOT more detection time — it is the
      // separate question of whether a doomed process has finished leaving.
      //
      // POLLED, because one sample after a fixed sleep cannot tell those two
      // apart. Measured in CI (run 32186749592, node 20): this case failed at
      // duration_ms 9007 — 6000 + 2000 of fixed sleep plus setup, so no deadline
      // was exhausted and nothing had been waited FOR. It reported two bare pids
      // and no command lines, which is why a run that reddens here has never
      // been diagnosable after the fact: a proxy still draining and a supervisor
      // that came back both print as a number that no longer exists.
      //
      // A doomed process leaves inside the deadline and the case passes. A
      // resurrected supervisor is still there at the end of it, so the assertion
      // fires exactly as before — the poll cannot mask the defect, it can only
      // stop blaming a slow exit for it. The names go into the message so the
      // NEXT red answers which one it was instead of posing the question again.
      const settle = Date.now() + 20_000;
      let lineage;
      for (;;) {
        lineage = listeners(port).filter((p) => /\brun-service\b|server\.mjs/.test(cmdOf(p)));
        if (!lineage.length || Date.now() > settle) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.deepEqual(lineage, [],
        "a supervisor came back after the port was released — the lineage resurrected " +
        "itself, so no port can ever be retired and every stray one is permanent: " +
        lineage.map((p) => `${p}=${cmdOf(p) || "<gone>"}`).join(" | "));
      // AND THE ADDRESS STILL RETIRES. That is the other half of the same harm:
      // a standby that ignored the release word would make every stray port
      // permanent by a different route.
      for (const p of listeners(port)) { try { process.kill(Number(p), "SIGHUP"); } catch { } }
      await new Promise((r) => setTimeout(r, 1_500));
      assert.deepEqual(listeners(port), [],
        "the address survived SIGHUP, so a released port cannot be retired at all");
    } finally {
      try { holder.kill("SIGKILL"); } catch { }
      for (let i = 0; i < 5; i++) {
        const held = listeners(port);
        if (!held.length) break;
        for (const p of held) {
          const pid = Number(p);
          if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, "SIGHUP"); } catch { } }
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });
  // THE SELF-HEAL'S EXIT CONDITION MUST WORK WITHOUT /proc. successorServing()
  // read /proc/net/tcp and nothing else, so on a mac it answered "no successor"
  // forever and the outgoing proxy waited out its whole 30s ceiling instead of
  // leaving once the replacement served. Two of our three machines are macs, so
  // the Linux-only path was the exception, not the rule.
  //
  // Driven through the REAL export rather than a stand-in, and with /proc made
  // unreadable on purpose, so the case exercises the fallback on Linux too —
  // simulating the platform we do not run on beats skipping it, which is
  // cswap's pin's framing and the reason this is a case at all.
  // TURNING CCF OFF MUST NOT TAKE THE ADDRESS WITH IT. A session's HTTPS_PROXY
  // is fixed at exec and cannot be re-pointed, so "the proxy is gone" still has
  // to mean "the address carries". Measured before the standby existed, with the
  // holder and its child killed together: no descriptor left, no listener, and
  // ECONNREFUSED — every live session on that port stranded for good.
  // TWO HOP STATES, ONE BODY. "Everything off" reaches this address in both
  // shapes: no fallback configured at all, and one configured but DOWN because
  // privoxy was stopped too. The second is the one that used to reset every
  // request — the hop is read once at startup, so a relay pointed at a dead
  // port stayed pointed at it.
  for (const [what, deadHop] of [["no hop is configured", false],
                                 ["the configured hop is down", true]]) {
  it(`carries the address when the holder and its child are both killed and ${what}`, async () => {
    // A real origin, because ANSWERING IS NOT CARRYING. A relay that accepted
    // and then sat there would pass a health probe and fail every request.
    // Answer once: a second read reaching an already-ended socket throws
        // ERR_STREAM_WRITE_AFTER_END, which is what broke CI node 22 in the
        // sibling case below (run 31146142838).
        const origin = net.createServer((s) => {
          let answered = false;
          s.on("data", () => { if (!answered) { answered = true; s.end("pong"); } });
        });
    await new Promise((r) => origin.listen(0, "127.0.0.1", r));
    const originPort = origin.address().port;
    const port = await freePort();
    const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port),
                  CACHE_FIX_FORWARD_PROXY: "on" };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID",
                     "CACHE_FIX_HOLD_PORT", "CACHE_FIX_WATCH_DEPLOY_MS",
                     "CACHE_FIX_FALLBACK_PROXIES"]) delete env[k];
    // A port nobody listens on, which is what a stopped privoxy leaves behind.
    if (deadHop) env.CACHE_FIX_FALLBACK_PROXIES = `http://127.0.0.1:${await freePort()}`;
    // STDERR KEPT. The launcher writes "standby relay gone (…)" precisely for
    // this case, and discarding it made "the standby never spawned" and "the
    // standby never armed" produce the same message — one flake here was
    // undiagnosable for exactly that reason.
    let err = "";
    const holder = spawn(process.execPath, [launcherPath, "run-service"],
                         { env, stdio: ["ignore", "ignore", "pipe"] });
    holder.stderr.on("data", (d) => { err += d; });
    const carries = () => new Promise((res) => {
      const req = http.request({ host: "127.0.0.1", port, method: "CONNECT",
                                 path: `127.0.0.1:${originPort}` });
      let done = false;
      const end = (v, s) => { if (done) return; done = true; clearTimeout(t);
                              try { s?.destroy(); req.destroy(); } catch { } res(v); };
      const t = setTimeout(() => end("HANG"), 10_000);
      req.on("error", (e) => end(e.code));
      req.on("connect", (r, socket) => {
        if (r.statusCode !== 200) return end("connect:" + r.statusCode, socket);
        socket.write("ping");
        socket.on("data", (d) => end(String(d), socket));
        socket.on("error", (e) => end(e.code, socket));
      });
      req.end();
    });
    try {
      const up = Date.now() + 25_000;
      let body = await probe(port);
      while (body.startsWith("ERR:") && Date.now() < up) body = await probe(port);
      assert.equal(body, "ok", "the holder never came up, so nothing was measured");
      assert.equal(await carries(), "pong", "premise: the live proxy must carry a CONNECT");

      // Kill the supervisor AND the proxy, and nothing else. Killing the standby
      // too would be killing the only thing that can survive this, which is not
      // the case under test.
      const doomed = listeners(port).filter((p) => /\brun-service\b|server\.mjs/.test(cmdOf(p)));
      assert.equal(doomed.length, 2,
        `premise: a holder and a child must both be on the port, found ${doomed.length}`);
      // AND THE THING THAT HAS TO SURVIVE THEM IS ALREADY THERE. Without this
      // the case cannot tell "it never armed" from "it was never spawned".
      assert.ok(listeners(port).some((p) => /gap-relay/.test(cmdOf(p))),
        `no standby relay is on the port before the kill, so nothing could survive it. ` +
        `Launcher stderr: ${JSON.stringify(err.slice(-300))}`);
      for (const p of doomed) { try { process.kill(Number(p), "SIGKILL"); } catch { } }

      // The standby polls before it arms, so give it the window it asks for.
      const by = Date.now() + 15_000;
      let got = await carries();
      while (got !== "pong" && Date.now() < by) got = await carries();
      assert.equal(got, "pong",
        "with the holder and the proxy both dead the address stopped carrying — a live " +
        `session whose HTTPS_PROXY points here has nowhere else to go. Launcher stderr: ` +
        JSON.stringify(err.slice(-300)));
    } finally {
      try { holder.kill("SIGKILL"); } catch { }
      for (const p of listeners(port)) { try { process.kill(Number(p), "SIGHUP"); } catch { } }
      await new Promise((r) => setTimeout(r, 300));
      for (const p of listeners(port)) { try { process.kill(Number(p), "SIGKILL"); } catch { } }
      await new Promise((r) => origin.close(r));
    }
  });
  }
  // A STOP MUST NOT TAKE THE ADDRESS WITH IT. `systemctl stop`, Ctrl-C and a
  // plain `kill` all arrive as SIGTERM, and an earlier draft ended the standby
  // there — measured, SIGTERM left ECONNREFUSED while `kill -9` on the same pair
  // carried, so the graceful path was the destructive one. Only SIGHUP, the word
  // for "give the address away", may end it.
  //
  // Driven through a LIVE hop and with the request SPLIT across two writes,
  // because that route reads the first chunk before it dials: removing a `data`
  // listener does not pause a flowing stream, so everything after that chunk
  // went to nobody and the hop waited out a Content-Length that never arrived.
  it("carries a split request through the hop after the holder is stopped", async () => {
    // A BIG body, written in the same breath as the headers. The window between
    // the relay reading its first chunk and piping the rest is one loop turn, so
    // a small body sent a beat later arrives after the pipe is up and proves
    // nothing — measured, that shape passed with the pause removed. A megabyte
    // spans many reads inside that one turn, so any of it that is emitted to
    // nobody shows up as a short count here.
    const BODY = 1 << 20;
    let head = "", bytes = 0;
    const hop = net.createServer((s) => {
      // ANSWER ONCE. `bytes >= BODY` is monotonic, so without this every read
      // that lands after the threshold re-enters and calls end() on an already
      // ended socket. The threshold is crossed with body still in flight (it
      // counts the request line and headers too), so whether another read
      // follows is pure timing — this box coalesces the writes and never split
      // it in any local run, while CI node 22 did: "write after end",
      // ERR_STREAM_WRITE_AFTER_END, thrown from this handler (run 31146142838).
      let answered = false;
      s.on("data", (d) => {
        if (head.length < 200) head += d.subarray(0, 200);
        bytes += d.length;
        if (!answered && bytes >= BODY) {
          answered = true;
          s.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        }
      });
    });
    await new Promise((r) => hop.listen(0, "127.0.0.1", r));
    // CREDENTIALS ON THE HOP, so the equality below is a stripping assertion and
    // not just a plumbing one. /health is readable by anything that can reach
    // the port, and a hop URL can carry them — cswap's pin publishes its own as
    // cswap:<token>@127.0.0.1:53749.
    const hopAddr = `http://127.0.0.1:${hop.address().port}`;
    const hopWithCreds = `http://ccfuser:ccfsecret@127.0.0.1:${hop.address().port}`;
    const port = await freePort();
    const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port),
                  CACHE_FIX_FORWARD_PROXY: "on", CACHE_FIX_FALLBACK_PROXIES: hopWithCreds };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID",
                     "CACHE_FIX_HOLD_PORT", "CACHE_FIX_WATCH_DEPLOY_MS"]) delete env[k];
    const holder = spawn(process.execPath, [launcherPath, "run-service"],
                         { env, stdio: ["ignore", "ignore", "ignore"] });
    const raw = (send) => new Promise((res) => {
      const c = net.connect(port, "127.0.0.1");
      let b = "";
      const done = (v) => { c.destroy(); res(v); };
      const t = setTimeout(() => done(`TIMEOUT:${b}`), 8_000);
      c.on("connect", () => send(c));
      c.on("data", (d) => { b += d; });
      c.on("close", () => { clearTimeout(t); res(b); });
      c.on("error", (e) => { clearTimeout(t); done(`ERR:${e.code}`); });
    });
    try {
      const up = Date.now() + 25_000;
      let body = await probe(port);
      while (body.startsWith("ERR:") && Date.now() < up) body = await probe(port);
      assert.equal(body, "ok", "the holder never came up, so nothing was measured");

      // The proxy's own answer first: same field, same stripping, different
      // implementation. Both sides publish the hop and neither may publish what
      // is in front of it.
      const alive = await raw((c) =>
        c.write("GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      const aliveJson = alive.slice(alive.indexOf("{"), alive.lastIndexOf("}") + 1);
      assert.equal(JSON.parse(aliveJson).https_proxy, hopAddr,
        "the live proxy does not name the hop its CONNECTs leave through");
      assert.ok(!/ccfuser|ccfsecret/.test(alive),
        "the proxy published the hop's credentials on /health");

      // THE GRACEFUL STOP, and nothing else. No SIGKILL anywhere in this case:
      // what is under test is that the polite signal is not the destructive one.
      holder.kill("SIGTERM");
      const stopped = Date.now() + 20_000;
      let left = listeners(port);
      while (Date.now() < stopped
             && left.some((q) => /\brun-service\b|server\.mjs/.test(cmdOf(q)))) {
        await new Promise((r) => setTimeout(r, 200));
        left = listeners(port);
      }
      assert.deepEqual(left.filter((q) => /\brun-service\b|server\.mjs/.test(cmdOf(q))), [],
        "the holder and its proxy never went, so the stop was not measured");
      assert.ok(left.length, "SIGTERM took the address down — every live session on it is stranded");

      // FIRED BEFORE THE RELAY ARMS, on purpose. The connection lands in the
      // backlog of a socket nobody is accepting yet — which is what a request
      // arriving during the gap actually does — so by the time the relay reads,
      // the whole body is already buffered and comes out in one flow loop.
      // That is what makes the loss deterministic: measured in isolation,
      // 983,051 of 1,048,587 bytes went to nobody without the pause, while the
      // same request sent to an already-armed relay lost nothing at all.
      const posted = raw((c) => {
        c.write("POST http://example.invalid/ HTTP/1.1\r\nHost: example.invalid\r\n" +
                `Content-Length: ${BODY}\r\n\r\n`);
        c.write(Buffer.alloc(BODY, 0x62));
      });

      // The relay names itself and names the hop, at a status that cannot be
      // mistaken for a healthy proxy by anything that gates on one.
      const health = await raw((c) =>
        c.write("GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      assert.match(health, /^HTTP\/1\.1 503 /, `a carrying relay must not report healthy: ${health}`);
      const json = JSON.parse(health.slice(health.indexOf("{"), health.lastIndexOf("}") + 1));
      assert.equal(json.carrying, "gap-relay");
      assert.equal(json.https_proxy, hopAddr,
        "the chain cannot be confirmed through an address that will not name its own next hop");
      assert.ok(!/ccfuser|ccfsecret/.test(health),
        "the carrying relay published the hop's credentials on /health");

      const reply = await posted;
      assert.match(head, /^POST http:\/\/example\.invalid\//,
        `the hop never saw the request line: ${JSON.stringify(head.slice(0, 80))}`);
      assert.ok(bytes >= BODY,
        `the hop got ${bytes} of ${BODY} body bytes — the relay dropped what arrived while it dialled`);
      assert.match(reply, /^HTTP\/1\.1 200 /, `the hop's answer never came back: ${reply}`);
    } finally {
      try { holder.kill("SIGKILL"); } catch { }
      for (const q of onPort(port)) { try { process.kill(Number(q), "SIGHUP"); } catch { } }
      await new Promise((r) => setTimeout(r, 300));
      for (const q of onPort(port)) { try { process.kill(Number(q), "SIGKILL"); } catch { } }
      await new Promise((r) => hop.close(r));
    }
  });
  it("does not mistake a neighbour on the port for a successor", async () => {
    const { successorServing } = await import("../proxy/server.mjs");

    // MEASURED IN PRODUCTION, 2026-08-18 on <linux-host>: THREE of our own
    // processes hold the same LISTEN inode on fd 3 at once —
    //   claude-via-proxy.mjs run-service   the holder
    //   gap-relay.mjs                      the standby
    //   proxy/server.mjs                   the proxy
    // and successorServing() excludes only process.pid. So the orphaned
    // proxy's "keep serving until the successor is up" poll is satisfied on
    // its FIRST 100 ms tick by the standby that was already there, and it
    // exits while the replacement holder is still booting — reopening exactly
    // the unowned-port window the wait was written to close.
    //
    // A foreign listener stands in for that here: the question the function
    // must answer is "is a SUCCESSOR PROXY serving", and holding the socket is
    // not the same claim. Both branches are checked, because they had the same
    // defect and a fix to one leaves the other lying.
    const port = await freePort();
    const child = spawn(process.execPath,
      ["-e", `require("net").createServer().listen(${port},"127.0.0.1",()=>console.log("up"))`],
      { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise((res, rej) => {
        child.stdout.on("data", (d) => String(d).includes("up") && res());
        setTimeout(() => rej(new Error("stand-in listener never came up")), 10_000);
      });
      // PREMISE: it really is holding the port, or both assertions below pass
      // against an empty process table and prove nothing.
      assert.ok(listeners(port).length === 0,
        "premise: proc-helpers must NOT class this stand-in as ours — if it does, " +
        "the fixture is a proxy and this case is asking the wrong question");
      // ASK THE PORT, not the process table. A raw lsof here is what
      // suite-collection's own guard forbids — and it is right: the question is
      // "is something serving this address", and connect() answers it directly
      // instead of through an instrument that is blind in another namespace.
      const reachable = await new Promise((res) => {
        const q = net.connect(port, "127.0.0.1");
        q.on("connect", () => { q.destroy(); res(true); });
        q.on("error", () => res(false));
        setTimeout(() => { q.destroy(); res(false); }, 2_000);
      });
      assert.ok(reachable, `premise: the stand-in is not accepting on ${port}`);

      assert.equal(successorServing(port), false,
        "a process that merely HOLDS the port read as a successor. The standby " +
        "relay holds the same inode on fd 3 for the whole handover, so the " +
        "departing proxy leaves on its first tick and the port is unowned until " +
        "the real successor finishes booting");

      process.env.CACHE_FIX_NO_PROC = "1";
      const viaLsof = successorServing(port);
      delete process.env.CACHE_FIX_NO_PROC;
      assert.equal(viaLsof, false,
        "the lsof branch has the same defect — it filters only process.pid, so " +
        "on a mac the standby answers for the successor there too");
    } finally {
      try { child.kill("SIGKILL"); } catch { }
    }
  });

  it("recognises a successor without /proc", async () => {
    const { successorServing } = await import("../proxy/server.mjs");
    if (typeof successorServing !== "function") {
      assert.fail("successorServing is no longer exported — this case cannot ask its question");
    }
    const srv = net.createServer(() => {});
    const port = await freePort();
    await new Promise((r) => srv.listen(port, "127.0.0.1", r));
    try {
      // A DIFFERENT process must own it, or the answer is trivially false: this
      // test process is the listener, and the function excludes itself by design.
      assert.equal(successorServing(port), false,
        "premise: our own listener must NOT read as a successor");
    } finally {
      await new Promise((r) => srv.close(r));
    }
    // Now a real other process on a real port.
    const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(await freePort()),
                  CACHE_FIX_FORWARD_PROXY: "on", CACHE_FIX_SELF_HEAL: "off" };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID",
                     "CACHE_FIX_HOLD_PORT", "CACHE_FIX_WATCH_DEPLOY_MS"]) delete env[k];
    const p2 = Number(env.CACHE_FIX_PROXY_PORT);
    const holder = spawn(process.execPath, [launcherPath, "run-service"],
                         { env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const up = Date.now() + 25_000;
      let body = await probe(p2);
      while (body.startsWith("ERR:") && Date.now() < up) body = await probe(p2);
      assert.equal(body, "ok", "the holder never came up, so nothing was measured");
      // WITH /proc DISABLED, so the lsof path is what answers even here.
      process.env.CACHE_FIX_NO_PROC = "1";
      const viaLsof = successorServing(p2);
      delete process.env.CACHE_FIX_NO_PROC;
      assert.equal(viaLsof, true,
        "a live proxy on this port was not recognised — on a machine without /proc the " +
        "self-heal waits out its 30s ceiling instead of handing over when the successor is up");

      // AND IT MUST NOT DEPEND ON THE BIND ADDRESS. The lsof branch pinned the
      // 127.0.0.1 literal while the /proc branch matched on the port alone, so
      // the two instruments answered the same question differently — and the
      // lsof one is the ONLY branch a mac reaches, which is two of our three
      // machines. A proxy bound anywhere else read as "no successor" forever.
      //
      // Asserted against a listener on a DIFFERENT address than the literal
      // that used to be hardcoded, so a revert fails here rather than passing
      // on a loopback-only fixture.
      // ANOTHER PROCESS, on 0.0.0.0. Ours would not do: the function excludes
      // its own pid, so a self-owned listener answers false either way and the
      // case would pass against the hardcoded literal it exists to catch.
      const wildPort = await freePort();
      // AND IT MUST LOOK LIKE A PROXY, because successorServing now requires
      // that: three of our processes hold one LISTEN inode at handover (holder,
      // standby, proxy) and only the proxy can serve, so holding the socket is
      // no longer the claim. The fixture is still a bare listener on 0.0.0.0 —
      // the address question this case asks is untouched — it just declares
      // what it stands in for, via the one thing the check reads. An `-e`
      // script has no path in its argv, which is why this is a file.
      const wildDir = join(mkdtempSync(join(tmpdir(), "ccf-wild-")), "proxy");
      mkdirSync(wildDir, { recursive: true });
      const wildScript = join(wildDir, "server.mjs");
      writeFileSync(wildScript,
        `import net from "node:net";\n` +
        `net.createServer(()=>{}).listen(${wildPort},"0.0.0.0",()=>process.stdout.write("up\\n"));\n`);
      const wild = spawn(process.execPath, [wildScript], { stdio: ["ignore", "pipe", "ignore"] });
      try {
        await Promise.race([
          new Promise((r) => wild.stdout.once("data", r)),
          new Promise((_, j) => setTimeout(() => j(new Error("wildcard listener never came up")), 8_000)),
        ]);
        process.env.CACHE_FIX_NO_PROC = "1";
        const seen = successorServing(wildPort);
        delete process.env.CACHE_FIX_NO_PROC;
        assert.equal(seen, true,
          "a listener on 0.0.0.0 was invisible to the lsof branch — that branch is the " +
          "ONLY one a mac reaches, so a proxy bound off loopback reads as having no " +
          "successor forever and every handover waits out the full 30s ceiling");
      } finally {
        try { wild.kill("SIGKILL"); } catch { }
      }

      // AND WITH /proc AVAILABLE BUT BLIND. Everything above disables /proc to
      // reach the lsof branch; this is the case where /proc answers and its
      // answer is wrong. `/proc/net/tcp` is IPv4-ONLY — an IPv6 listener lives
      // in tcp6 — so under CACHE_FIX_PROXY_BIND=::1 the scan found no inode and
      // the function used to `return false` right there, never consulting lsof.
      // False means "no successor", so the outgoing proxy waited out its entire
      // 30s ceiling on every handover instead of leaving when its replacement
      // was already serving.
      //
      // NOT stubbed: a real IPv6 listener in a real other process, so the
      // blindness is the kernel's own and not a fixture's.
      const v6Port = await freePort();
      // A FILE, not `-e`, for the same reason as the wildcard fixture above:
      // successorServing now requires the pid to BE a proxy, and an `-e`
      // script carries no path in its argv. Still a real listener in a real
      // other process — the kernel blindness this case measures is untouched.
      const v6Dir = join(mkdtempSync(join(tmpdir(), "ccf-v6-")), "proxy");
      mkdirSync(v6Dir, { recursive: true });
      const v6Script = join(v6Dir, "server.mjs");
      writeFileSync(v6Script,
        `import net from "node:net";\n` +
        `net.createServer(()=>{}).listen(${v6Port},"::1",()=>process.stdout.write("up\\n"));\n`);
      const v6 = spawn(process.execPath, [v6Script], { stdio: ["ignore", "pipe", "ignore"] });
      try {
        await Promise.race([
          new Promise((r) => v6.stdout.once("data", r)),
          new Promise((_, j) => setTimeout(() => j(new Error("IPv6 listener never came up")), 8_000)),
        ]);
        // The premise this case rests on: /proc/net/tcp really cannot see it.
        const hex = v6Port.toString(16).toUpperCase().padStart(4, "0");
        const inV4 = readFileSync("/proc/net/tcp", "utf8").split("\n").slice(1)
          .some((l) => l.trim().split(/\s+/)[1]?.endsWith(":" + hex));
        assert.equal(inV4, false,
          "premise: an IPv6 listener must be absent from /proc/net/tcp, or this case " +
          "is not exercising the blindness it was written for");
        // /proc ENABLED — the whole point. A miss must fall through, not answer.
        assert.equal(successorServing(v6Port), true,
          "an IPv6 listener read as 'no successor' because /proc/net/tcp is IPv4-only " +
          "and the scan answered instead of falling through to lsof — every handover " +
          "under an IPv6 bind then burns its full 30s ceiling");
      } finally {
        try { v6.kill("SIGKILL"); } catch { }
      }
    } finally {
      try { holder.kill("SIGTERM"); } catch { }
      for (let i = 0; i < 5; i++) {
        const held = listeners(p2);
        if (!held.length) break;
        for (const q of held) {
          const pid = Number(q);
          if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, "SIGHUP"); } catch { } }
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });
});

// A LATE EVENT FROM A RETIRED GAP MUST NOT RETIRE THE LIVE ONE.
//
// openGap() refuses to open a second gap while `this._gap` is set, so that field
// is the only thing between one acceptor on the descriptor and two. Its 'exit'
// and 'error' handlers used to null it unconditionally — but each fires for the
// gap it was attached to, and openGap runs again on every proxy restart, so a
// late event from the PREVIOUS gap cleared a LIVE successor and the next open
// stacked a second relay on the same socket. Two acceptors on one descriptor is
// the shape this file's siblings measured at 60 of 125 requests reset.
//
// DRIVEN DIRECTLY, not observed in a running holder, and that is not a shortcut.
// Measured: a real gap is unobservable by design — start() calls closeGap()
// immediately before spawning the child, because two handles may BIND one port
// but only one may LISTEN (holder.mjs:1124). Sampling `ps` at 10 ms intervals
// through boot and through a child death found a gap exactly zero times, while
// suppressing that one closeGap() made it appear at once. A property with no
// observable window has to be asked of the object that owns it.
describe("openGap identity", () => {
  it("a retired gap's late exit does not clear the live one", () => {
  const src = readFileSync(new URL("../bin/claude-via-proxy.mjs", import.meta.url), "utf8");
  const body = /  openGap\(\) \{[\s\S]*?\n  \}/.exec(src)?.[0];
  assert.ok(body, "openGap moved — this no longer tests it");

  // The real method, lifted, with spawn() replaced by a fake that hands back a
  // controllable EventEmitter. Everything else is the shipped code.
  const spawned = [];
  const fakeSpawn = () => { const p = new EventEmitter(); p.unref = () => {}; spawned.push(p); return p; };
  const holder = { _handle: { fd: 3 }, _port: 9901, _host: "127.0.0.1", _gap: null };
  holder.openGap = new Function("spawn", "GAP_RELAY_PATH", "process",
    `return function openGap() {${body.slice(body.indexOf("{") + 1, body.lastIndexOf("}"))}}`
  )(fakeSpawn, "/gap-relay.mjs", process);

  holder.openGap();
  const first = spawned[0];
  assert.equal(spawned.length, 1, "premise: the first open did not spawn a gap");

  holder._gap = null;                       // the holder retired it (closeGap)
  holder.openGap();                         // ... and opened the next one
  assert.equal(spawned.length, 2, "premise: the second open did not spawn a gap");
  const second = spawned[1];

  first.emit("exit");                       // the RETIRED gap's late event
  assert.ok(holder._gap === second,
    "a late 'exit' from the retired gap cleared the live one. openGap's re-entry " +
    "guard now sees an empty field and stacks a second relay on the same " +
    "descriptor — two acceptors on one socket, which is how a restart resets " +
    "live requests");

  first.emit("error", new Error("EAGAIN"));  // and the async spawn-failure door
  assert.ok(holder._gap === second, "a late 'error' from the retired gap cleared the live one");
});
});
