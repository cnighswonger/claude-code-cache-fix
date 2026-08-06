import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
});
