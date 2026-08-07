// ONE CASE, ITS OWN FILE, and that is the point rather than tidiness.
//
// Node gives each test FILE its own process. This case measures whether a
// single upstream connection is freed, and process-global state from
// neighbouring cases — cached keep-alive agents, a forward-mode instance's
// self-heal swallowers, another startProxy still winding down — is enough to
// free it by other means. Measured: the identical assertions inside
// proxy-server.test.mjs passed with the guard DELETED, three times, while the
// same logic in a process of its own separated them cleanly. The same reason
// proxy-holder-handover.test.mjs is one case alone.
//
// WHAT IS UNDER TEST: handleMessages aborts its upstream request when the
// client goes away. forwardRequest wires that signal to upstreamReq.destroy(),
// and when the upstream has NOT yet answered there is no pipe for socket
// teardown to travel along — the abort is the only thing that can free it.
//
//   with the listener   dialled 1, live 1 at walk-away -> 0 after 2s
//   listener deleted    dialled 1, live 1 at walk-away -> 1 after 2s
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../proxy/server.mjs";

const ENV = ["CACHE_FIX_PROXY_UPSTREAM", "CACHE_FIX_FORWARD_PROXY", "CACHE_FIX_CA_DIR",
             "CACHE_FIX_FALLBACK_PROXIES", "CACHE_FIX_UPSTREAM_PROXY",
             "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

test("frees an upstream that has not answered yet when the client walks away", async () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const caDir = mkdtempSync(join(tmpdir(), "ccf-abort-"));
  let live = 0, dialled = 0;
  const sockets = new Set();
  const upstream = http.createServer(() => { dialled++; /* never respond */ });
  upstream.on("connection", (sock) => {
    live++; sockets.add(sock);
    sock.on("close", () => { live--; sockets.delete(sock); });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  let h;
  try {
    for (const k of ENV) delete process.env[k];
    process.env.CACHE_FIX_CA_DIR = caDir;
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    h = await startProxy({ port: 0, watch: false });
    await new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: h.port, method: "POST",
                               path: "/v1/messages", headers: { "content-type": "application/json" } },
        (res) => res.resume());
      r.on("error", () => {});
      r.end(JSON.stringify({ model: "x", messages: [] }));
      // Long enough that the proxy has dialled and is WAITING on the upstream,
      // which is the only state where the abort has anything to do.
      setTimeout(() => { r.destroy(); resolve(); }, 500);
    });
    // BOTH PREMISES, or the result below means nothing: the first two versions
    // of this case asserted only the end state, and "0 connections" is satisfied
    // by a proxy that never connected at all.
    assert.equal(dialled, 1, "the proxy never reached the upstream, so nothing was measured");
    assert.ok(live > 0, "the upstream connection was already gone when the client left");

    for (let i = 0; i < 40 && live > 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(live, 0,
      "the client walked away while the upstream had not answered, and the connection " +
      "stayed open — one leaked socket per abandoned request, with no pipe in place " +
      "for socket teardown to travel along");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    // DESTROY THE LEAKED SOCKETS BEFORE CLOSING THE PROXY. When the guard is
    // absent the connection this case is about is still open, and h.close()
    // drains before it resolves — so cleanup hung and the file died at the
    // runner's 120s timeout with `pass 0 fail 0`, losing the assertion message
    // that had already fired. A test that discriminates only by timing out is
    // a test nobody can read.
    for (const sock of sockets) { try { sock.destroy(); } catch { } }
    if (h) await h.close();
    await new Promise((r) => upstream.close(r));
    try { rmSync(caDir, { recursive: true, force: true }); } catch {}
  }
});
