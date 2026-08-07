// ONE CASE, ITS OWN FILE — the same remedy proxy-holder-handover.test.mjs
// applies to itself, and for the same measured reason.
//
// This case runs a full run-service holder, its proxy child, an in-flight
// connection, a 3 s settle and a cleanup loop that SIGHUPs every pid on its
// port. node runs a `describe`'s subtests concurrently, so inside the handover
// file it starved its neighbours: measured over 7 full-suite runs, 3 failures,
// all in that file and varying between cases — while the identical tree with
// this case excised was 0 failures in 3. The case itself is sound and
// mutation-checked; it needed isolating, not deleting.
//
// node gives each FILE its own process, which is the whole mechanism.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const launcherPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-via-proxy.mjs");

const listeners = (port) => {
  try {
    return execFileSync("lsof", ["-nP", "-t", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"],
                        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter(Boolean);
  } catch { return []; }
};
const cmdOf = (pid) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }); }
  catch { return ""; }
};
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const probe = (port) => new Promise((res) => {
  const r = http.get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 8_000 },
                     (s) => { s.resume(); s.on("end", () => res(s.statusCode === 200 ? "ok" : `ERR:${s.statusCode}`)); });
  r.on("error", (e) => res(`ERR:${e.code}`));
  r.on("timeout", () => { r.destroy(); res("ERR:ETIMEDOUT"); });
});

describe("shutdown runs once per stop", () => {
  // A SUPERVISED STOP DELIVERS MORE THAN ONE SIGNAL, AND THE BODY MUST RUN ONCE.
  //
  // shutdown() is bound to SIGTERM, SIGINT and SIGHUP. systemd SIGTERMs the
  // whole control group, so the proxy receives it directly AND the holder
  // forwards its own SIGHUP — two entries into a function with no guard. Each
  // entry can spawn a successor on fd 3, so a stop could leave TWO proxies on
  // one socket: the same "one extra per deploy" the (handed off) announcement
  // exists to prevent, arriving by a different door. Each also re-announces the
  // release and arms another 5s force-close.
  //
  // Counted on the announcement rather than on surviving processes: the line is
  // emitted once per entry into shutdown(), so it reports the re-entry directly
  // instead of through whatever the holder does about it.
  it("announces its release exactly once, however many stop signals arrive", async () => {
    const port = await freePort();
    const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port),
                  CACHE_FIX_FORWARD_PROXY: "on", CACHE_FIX_SELF_HEAL: "off" };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID",
                     "CACHE_FIX_HOLD_PORT", "CACHE_FIX_WATCH_DEPLOY_MS"]) delete env[k];
    const holder = spawn(process.execPath, [launcherPath, "run-service"],
                         { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    holder.stdout.on("data", (d) => { out += d; });
    try {
      const up = Date.now() + 25_000;
      let body = await probe(port);
      while (body.startsWith("ERR:") && Date.now() < up) body = await probe(port);
      assert.equal(body, "ok", "the holder never came up, so nothing was measured");

      // The proxy CHILD, which is what a control-group signal reaches directly.
      const kid = listeners(port)
        .map(Number)
        .find((q) => /server\.mjs/.test(cmdOf(q)));
      assert.ok(kid, "premise: there must be a proxy child to signal");

      out = "";
      // A REQUEST MUST BE IN FLIGHT, and this is not decoration — it is the
      // window. With nothing to drain, close() resolves on the next tick and
      // process.exit() beats the second signal's delivery, so an unguarded
      // shutdown announces once and the case passes against the defect
      // (measured: guard removed, still 1). A live Claude session always has a
      // streaming response open — which is why the 5s watchdog is the NORMAL
      // exit under systemd — so the drain is the real condition, not the edge.
      const inflight = net.connect(port, "127.0.0.1");
      await new Promise((r) => inflight.on("connect", r));
      inflight.on("error", () => { });
      // Headers complete, body promised and never sent: the connection is
      // "sending a request", which is exactly what server.close() waits for.
      inflight.write("POST /v1/messages HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n");
      await new Promise((r) => setTimeout(r, 300));

      // Both signals, back to back, the way a control-group stop delivers them.
      try { process.kill(kid, "SIGTERM"); } catch { }
      try { process.kill(kid, "SIGHUP"); } catch { }
      await new Promise((r) => setTimeout(r, 3_000));
      try { inflight.destroy(); } catch { }

      const n = (out.match(/releasing the listening socket/g) || []).length;
      assert.equal(n, 1,
        `the proxy entered shutdown ${n} times for one stop — each entry can put ` +
        `another successor on the socket. saw: ${JSON.stringify(out.slice(-300))}`);
    } finally {
      try { holder.kill("SIGHUP"); } catch { }
      for (let i = 0; i < 6; i++) {
        const held = listeners(port);
        if (!held.length) break;
        for (const q of held) {
          const pid = Number(q);
          if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, "SIGHUP"); } catch { } }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  });
});
