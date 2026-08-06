import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const launcherPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-via-proxy.mjs");

// Its own file, and that is the point rather than tidiness. This case samples a
// live port while a holder is replaced, so it is sensitive to how much else is
// running — inside the held-port file it starved a neighbour into failing 4 of
// 5 runs, and node gives each FILE its own process. One case here, alone.

function listeners(port) {
  try {
    return execFileSync("lsof", ["-nP", "-t", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"],
                        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter(Boolean);
  } catch { return []; }
}

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

const probe = (port) => new Promise((res) => {
  const r = http.get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 8_000 },
                     (s) => { s.resume(); s.on("end", () => res("ok")); });
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
describe("holder handover (SIGUSR2)", () => {
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

      const health = await new Promise((res) => {
        http.get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 8_000 },
                 (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(b)); })
          .on("error", () => res("{}"));
      });
      const reported = JSON.parse(health).holder_tree;
      const onDisk = createHash("sha256").update(readFileSync(launcherPath)).digest("hex").slice(0, 12);
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
  // THIS CASE DOES NOT KILL ITS MUTATION, and that is stated here rather than
  // discovered later. Removing the releasingPort guard leaves it green: on the
  // SIGHUP path the child drains and exits faster than the self-heal's 1s poll,
  // so the race never opens here. It opened on the work Mac, where nine proxies
  // were serving and drained slowly enough to poll once with their holder
  // already gone. The case is kept because it pins the CONTRACT and would catch
  // a gross regression; it is not evidence the guard works, and the evidence
  // that it does is the fleet measurement in the commit, not this file.
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
    const holder = spawn(process.execPath, [launcherPath, "run-service"],
                         { env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const up = Date.now() + 25_000;
      let body = await probe(port);
      while (body.startsWith("ERR:") && Date.now() < up) body = await probe(port);
      assert.equal(body, "ok", "the holder never came up, so nothing was measured");

      holder.kill("SIGHUP");
      // Long enough for the self-heal to have fired: it polls every second, and
      // the resurrection this guards against was observed within 23s.
      await new Promise((r) => setTimeout(r, 25_000));
      assert.deepEqual(listeners(port), [],
        "the port came back after being released — the lineage resurrected itself, " +
        "so no port can ever be retired and every stray one is permanent");
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
});
