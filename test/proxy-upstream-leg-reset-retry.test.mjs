// The 2026-09-06 22:17-23:0xZ burst: 311 x "upstream error -> 502", 14 of them
// a TLS/CONNECT reset on a socket that never sent a byte, 44 a singleton
// ECONNRESET on a keep-alive socket the hop had already dropped. One attempt,
// no retry, every time -- and CCF's pool had no idle timeout against the
// hop's keep-alive, so a socket sat in the free list well past the point
// the hop had already closed it.
//
// Two guards in proxy/upstream.mjs forwardRequest()/buildAgent():
//  (1) retry ONCE, on a fresh dial, when the failure is provably pre-send
//      (nothing written to the wire yet) -- covers both a hop that resets the
//      CONNECT before replying and a reused socket the peer already reset
//      (req.reusedSocket + ECONNRESET, Node's own documented idiom).
//  (2) an Agent idle timeout well under privoxy's 300s, so a keep-alive socket
//      idle that long is destroyed and never handed back out for reuse.
//
// Case 1 goes through test/fixtures/resetting-hop.mjs, a CONNECT-relay stub
// standing in for the privoxy hop; cases 2/3 dial a raw backend directly --
// forwardRequest's retry logic reads the SAME socket/request events whether
// the reset came from the immediate peer or was relayed through a hop several
// legs down, so a direct reset is an equally faithful reproduction of "the hop
// dropped it" from the code under test's point of view.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startResettingHop } from "./fixtures/resetting-hop.mjs";

// A throwaway self-signed cert, generated once per case (openssl is already a
// build dependency here — proxy/forward-proxy.mjs shells out to it for the
// real MITM CA). Not that CA machinery: this is a one-off leaf for a local
// TLS test double, nothing this repo's own trust chain touches.
function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), "ccf-connect-budget-cert-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"],
    { timeout: 30_000, killSignal: "SIGKILL" });
  return { dir, key, cert };
}

// config.idleTimeoutMs is read once, at module load (`node --test` isolates
// each file into its own process) -- so a small value for the idle-timeout
// case below has to be set before ANYTHING in this file dynamically imports
// proxy/upstream.mjs for the first time, not scoped to that one test.
process.env.CACHE_FIX_UPSTREAM_IDLE_TIMEOUT_MS = "2000";

// An ambient HTTPS_PROXY would route these cases past the fixture; scrub it.
const ENV_KEYS = [
  "CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_PROXY_UPSTREAM", "CACHE_FIX_PROXY_REJECT_UNAUTHORIZED",
  "CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS", "CACHE_FIX_FALLBACK_PROXIES",
  "CACHE_FIX_UPSTREAM_SOCKET_MAX_LIFETIME_MS",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy",
];
function withEnv(overrides, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  return Promise.resolve().then(fn).finally(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
}

const mockReq = () => ({
  url: "/v1/messages",
  method: "POST",
  headers: { "content-type": "application/json" },
});

// A successful call over a keep-alive fixture server leaves ITS OWN side of
// the connection open (pooled, idle) even after the client side is unref'd
// -- server.close() only stops accepting new connections and waits for
// every existing one to end, which an idle pooled one never does on its
// own. Node 18's test runner waits for the process to exit naturally rather
// than forcing it, so a fixture left this way hangs the whole file. Track
// every connection a server accepts and destroy them in `finally`.
function trackConnections(server) {
  const sockets = new Set();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return () => { for (const s of sockets) s.destroy(); };
}

describe("upstream leg resets (PR fix/upstream-leg-resets)", () => {
  it("retries once when the hop resets the CONNECT before replying, and the retry lands on a fresh socket", async () => {
    const backend = http.createServer((req, res) => { res.end("backend-ok"); });
    const closeBackend = trackConnections(backend);
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    const hop = startResettingHop({ forward: `127.0.0.1:${backendPort}`, resetFirstConnect: true });
    const closeHop = trackConnections(hop);
    await new Promise((r) => hop.listen(0, "127.0.0.1", r));
    const hopPort = hop.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_PROXY: `http://127.0.0.1:${hopPort}`,
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const { statusCode, upstreamRes } = await forwardRequest(mockReq(), "{}", null);
        assert.equal(statusCode, 200, "the retry after the hop's reset did not reach the real backend");
        const chunks = [];
        for await (const c of upstreamRes) chunks.push(c);
        assert.equal(Buffer.concat(chunks).toString(), "backend-ok");
        assert.equal(hop.injected, 1, "the reset injection did not fire exactly once");
      });
    } finally {
      closeBackend();
      closeHop();
      backend.close();
      hop.close();
    }
  });

  it("retries once on ECONNRESET from a reused keep-alive socket, and the second call succeeds on a fresh one", async () => {
    // A raw server that answers once, then resets the socket right after --
    // the shape of a hop closing an idle keep-alive connection out from under
    // the client's Agent free-list.
    const srv = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (c) => {
        buf += c.toString();
        if (!buf.includes("\r\n\r\n")) return;
        buf = "";
        const body = "ok";
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`);
        setImmediate(() => sock.resetAndDestroy());
      });
    });
    const closeSrv = trackConnections(srv);
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${port}`,
        // Forces buildAgent's keepAlive-Agent branch (see comment on the
        // branch in proxy/upstream.mjs) so the pool actually reuses a socket
        // to this backend; without a real Agent there is nothing to reuse.
        CACHE_FIX_PROXY_REJECT_UNAUTHORIZED: "0",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const r1 = await forwardRequest(mockReq(), "{}", null);
        assert.equal(r1.statusCode, 200);
        for await (const _ of r1.upstreamRes) { /* drain */ }

        // Fired immediately, no delay: the whole point is that the client's
        // free-socket pool has not yet processed the peer's reset.
        const r2 = await forwardRequest(mockReq(), "{}", null);
        assert.equal(r2.statusCode, 200, "the retry after a reused-socket reset did not land");
        for await (const _ of r2.upstreamRes) { /* drain */ }
      });
    } finally {
      closeSrv();
      srv.close();
    }
  });

  it("does not retry a reset that arrives after the request was sent on a fresh connection", async () => {
    // Accepts the FIRST connection (so it is fully established) and waits for
    // real request bytes before resetting -- a post-send failure, never
    // eligible for the pre-send retry. Any SECOND connection (a wrongly-issued
    // retry would dial one, fresh) is served normally, so a guard that lets
    // this case retry anyway is caught by the response succeeding instead of
    // the single attempt rejecting -- not just by both ending in a 502 either way.
    let seen = 0;
    const srv = net.createServer((sock) => {
      seen += 1;
      if (seen === 1) {
        sock.once("data", () => {
          sock.resetAndDestroy();
        });
        return;
      }
      sock.on("data", (c) => {
        if (!c.toString().includes("\r\n\r\n")) return;
        const body = "ok";
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`);
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      await withEnv({ CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${port}` }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        await assert.rejects(forwardRequest(mockReq(), "{}", null));
        assert.equal(seen, 1, "a post-send reset on a fresh connection was retried");
      });
    } finally {
      srv.close();
    }
  });

  it("gives up after exactly one retry when the fresh dial also fails", async () => {
    // Resets EVERY connection before it ever completes -- the original
    // attempt and, if the guard let it through, the retry too. Bounds the
    // damage of a missing "never more than once" check: without it this would
    // retry forever against a hop that never comes back.
    let seen = 0;
    const srv = net.createServer((sock) => {
      seen += 1;
      sock.resetAndDestroy();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      await withEnv({ CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${port}` }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        await assert.rejects(forwardRequest(mockReq(), "{}", null));
        assert.equal(seen, 2, "did not retry exactly once (one original attempt + one retry)");
      });
    } finally {
      srv.close();
    }
  });

  it("does not retry once the caller has already aborted", async () => {
    let seen = 0;
    const srv = net.createServer((sock) => {
      seen += 1;
      sock.resetAndDestroy();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      await withEnv({ CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${port}` }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(forwardRequest(mockReq(), "{}", controller.signal));
        assert.equal(seen, 1, "retried a fresh-socket failure even though the caller had already aborted");
      });
    } finally {
      srv.close();
    }
  });

  it("destroys an idle keep-alive socket well under privoxy's 300s timeout, so two requests apart use two connections and two close together share one", async () => {
    const srv = net.createServer((sock) => {
      sock.on("data", (c) => {
        if (!c.toString().includes("\r\n\r\n")) return;
        const body = "ok";
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`);
      });
    });
    const closeSrv = trackConnections(srv);
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${port}`,
        CACHE_FIX_PROXY_REJECT_UNAUTHORIZED: "0",
      }, async () => {
        const mod = await import("../proxy/upstream.mjs");
        const call = async () => {
          const r = await mod.forwardRequest(mockReq(), "{}", null);
          for await (const _ of r.upstreamRes) { /* drain */ }
          return r.upstreamConnectionId;
        };
        const idA = await call();
        const idB = await call(); // back-to-back: shares the socket
        assert.equal(idA, idB, "two immediate requests did not share a pooled connection");

        await new Promise((r) => setTimeout(r, 2300)); // > the 2000ms idle timeout (top of file)
        const idC = await call();
        assert.notEqual(idB, idC, "an idle socket past the timeout was still reused");
      });
    } finally {
      closeSrv();
      srv.close();
    }
  });
});

describe("upstream CONNECT-phase budget (PR fix/upstream-leg-resets)", () => {
  it("retries once when the hop accepts the CONNECT and never answers, and the retry lands within ~2x the budget", async () => {
    const backend = http.createServer((req, res) => { res.end("backend-ok"); });
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    const hop = startResettingHop({ forward: `127.0.0.1:${backendPort}`, stallFirstConnect: true });
    const hopSockets = new Set();
    hop.on("connection", (s) => { hopSockets.add(s); s.on("close", () => hopSockets.delete(s)); });
    await new Promise((r) => hop.listen(0, "127.0.0.1", r));
    const hopPort = hop.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_PROXY: `http://127.0.0.1:${hopPort}`,
        CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS: "200",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const t0 = Date.now();
        const { statusCode, upstreamRes } = await forwardRequest(mockReq(), "{}", null);
        const took = Date.now() - t0;
        assert.equal(statusCode, 200, "the retry after the hop's silent CONNECT did not reach the real backend");
        assert.ok(took < 600, `retry took ${took}ms, more than ~3x the 200ms budget`);
        for await (const _ of upstreamRes) { /* drain */ }
        assert.equal(hop.injected, 1, "the stall injection did not fire exactly once");
      });
    } finally {
      // The successful retry leaves a live keep-alive tunnel through the hop
      // to the backend: server.close() alone waits for every connection to
      // end, which this one never does on its own (both ends are pooled,
      // unref'd, idle) -- drop them so the servers' own handles release.
      for (const s of hopSockets) s.destroy();
      backend.closeAllConnections();
      backend.close();
      hop.close();
    }
  });

  it("does not cut a stall that happens after the request was sent", async () => {
    // Accepts and completes the CONNECT immediately (so 'connect' fires and
    // the budget timer is cleared), then never answers the relayed request.
    // A connect budget that is still armed post-handshake would wrongly cut
    // this; the request timeout (config.timeout, untouched) is the only
    // thing that may.
    const backend = http.createServer(() => { /* accepts, never responds */ });
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    const controller = new AbortController();
    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS: "150",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const pending = forwardRequest(mockReq(), "{}", controller.signal)
          .then(() => "resolved").catch((e) => `rejected:${e.message}`);
        const settled = await Promise.race([
          pending,
          new Promise((r) => setTimeout(() => r("still-pending"), 500)),
        ]);
        assert.equal(settled, "still-pending",
          `a post-connect stall settled early (${settled}) — the connect budget cut a phase it must not touch`);
      });
    } finally {
      controller.abort();   // release the still-open connection so the process can exit
      backend.close();
    }
  });

  it("is off when set to 0", async () => {
    // A silent hop plus a 0 budget: nothing here should fire within this
    // test's window -- "off" falls back to the ordinary request timeout
    // (minutes), not to a short cut. `config.timeout` is read once at module
    // load, not per-request, so there is no env knob left to shrink it here;
    // proving "still pending" past a generous window and then tearing the
    // hop's own sockets down by hand (a stalled hpagent CONNECT sub-request
    // has no handle this file can reach otherwise) is what lets the test
    // finish instead of waiting out that timeout for real.
    const backend = http.createServer((req, res) => { res.end("backend-ok"); });
    const closeBackend = trackConnections(backend);
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    const hop = startResettingHop({ forward: `127.0.0.1:${backendPort}`, stallFirstConnect: true });
    const closeHop = trackConnections(hop);
    await new Promise((r) => hop.listen(0, "127.0.0.1", r));
    const hopPort = hop.address().port;

    let pending;
    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_PROXY: `http://127.0.0.1:${hopPort}`,
        CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS: "0",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        pending = forwardRequest(mockReq(), "{}", null).then(() => "resolved").catch((e) => `rejected:${e.message}`);
        const settled = await Promise.race([
          pending,
          new Promise((r) => setTimeout(() => r("still-pending"), 700)),
        ]);
        assert.equal(settled, "still-pending", `CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS=0 did not disable the budget: ${settled}`);
      });
    } finally {
      // Drop the stalled CONNECT so the orphaned forwardRequest call above can
      // actually settle (it retries fresh -- the hop is still listening and
      // serves a second CONNECT normally) instead of leaving a handle open
      // past this test, which some Node versions will not exit cleanly with.
      closeHop();
      if (pending) await pending;
      closeBackend();
      backend.close();
      hop.close();
    }
  });
});

// A REUSED (or already-connected) socket never re-fires 'connect'/
// 'secureConnect', so `established` stayed false for its whole life and the
// short connect budget — meant only for the CONNECT phase — stayed armed
// through the response wait too. Three shapes hand back such a socket: a
// keep-alive REUSE (any agent), and hpagent's HttpProxyAgent (plain http
// upstream through a hop), whose tunnel socket is already TCP-connected by
// the time it is handed over.
describe("upstream CONNECT-phase budget: already-established sockets", () => {
  it("re-arms on a REUSED keep-alive socket, so a slow second response is not cut by the connect budget", async () => {
    // HTTPS, not plain http: for a reused socket `!isHTTPS && !sock.connecting`
    // is excluded by construction, so this exercises `upstreamReq.reusedSocket`
    // specifically -- the real-world shape (every /v1/messages call is TLS).
    const { dir, key, cert } = selfSignedCert();
    let seen = 0;
    const backend = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      seen += 1;
      if (seen === 1) { res.end("first"); return; }
      setTimeout(() => res.end("second"), 300);
    });
    const closeBackend = trackConnections(backend);
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `https://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS: "100",
        CACHE_FIX_PROXY_REJECT_UNAUTHORIZED: "0",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const r1 = await forwardRequest(mockReq(), "{}", null);
        assert.equal(r1.statusCode, 200);
        for await (const _ of r1.upstreamRes) { /* drain */ }

        // Same connection, reused: today (pre-B1) `established` never becomes
        // true for it, so the 100ms budget — armed as this request's own
        // timeout — stays in effect and cuts the 300ms-delayed response.
        const r2 = await forwardRequest(mockReq(), "{}", null);
        assert.equal(r2.statusCode, 200, "a reused socket's slow response was cut by the connect budget");
        // NOT just "still 200": without the reusedSocket branch, the same
        // failure (established false, budget expires) is caught by the
        // existing pre-send retry path instead — a fresh dial that also
        // lands on 200, giving a false green. Pin it to the SAME connection
        // and to the backend having answered exactly twice.
        assert.equal(r2.upstreamConnectionId, r1.upstreamConnectionId,
          "the second call dialed a fresh connection instead of reusing the first — the timeout was retried, not avoided");
        assert.equal(seen, 2, "the backend saw more than two requests — a retry happened");
      });
    } finally {
      closeBackend();
      backend.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still re-arms on a genuinely fresh HTTPS connection (control)", async () => {
    const { dir, key, cert } = selfSignedCert();
    const backend = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      setTimeout(() => res.end("slow-but-real"), 300);
    });
    const closeBackend = trackConnections(backend);
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `https://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS: "100",
        CACHE_FIX_PROXY_REJECT_UNAUTHORIZED: "0",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const { statusCode, upstreamRes } = await forwardRequest(mockReq(), "{}", null);
        assert.equal(statusCode, 200, "a fresh HTTPS handshake did not re-arm past the connect budget");
        for await (const _ of upstreamRes) { /* drain */ }
      });
    } finally {
      closeBackend();
      backend.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not retry a post-send reset relayed through hpagent's HttpProxyAgent (http upstream via a hop)", async () => {
    let seen = 0;
    const backend = net.createServer((sock) => {
      seen += 1;
      sock.once("data", () => { sock.resetAndDestroy(); });
    });
    const closeBackend = trackConnections(backend);
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    const hop = startResettingHop({ forward: `127.0.0.1:${backendPort}` });   // plain relay, no reset/stall
    const closeHop = trackConnections(hop);
    await new Promise((r) => hop.listen(0, "127.0.0.1", r));
    const hopPort = hop.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_PROXY: `http://127.0.0.1:${hopPort}`,
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        await assert.rejects(forwardRequest(mockReq(), "{}", null));
        assert.equal(seen, 1,
          "a post-send reset relayed through the http-via-hop path was retried — established never became true for its tunnel socket");
      });
    } finally {
      closeBackend();
      closeHop();
      backend.close();
      hop.close();
    }
  });
});

// The retry dials through the SAME agent/pool, so it can land on ANOTHER
// pooled socket instead of a fresh one -- and when a hop drops, every free
// socket it was carrying tends to die together (the 2026-09-06 burst's own
// shape). One retry against a sibling that is also already dead just
// rejects (isRetry blocks a second try).
describe("upstream leg resets: sibling free sockets", () => {
  it("destroys sibling free sockets before a retry, so it does not land on another one the same hop dropped", async () => {
    // Resets a socket's SECOND request rather than answering it -- both A and
    // B, once free, carry this same fate, standing in for "the hop dropped
    // every pooled connection together".
    const answered = new WeakSet();
    const backend = net.createServer((sock) => {
      sock.on("data", (chunk) => {
        if (answered.has(sock)) { sock.resetAndDestroy(); return; }
        if (!chunk.toString().includes("\r\n\r\n")) return;
        answered.add(sock);
        const body = "ok";
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`);
      });
    });
    const closeBackend = trackConnections(backend);
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const port = backend.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${port}`,
        CACHE_FIX_PROXY_REJECT_UNAUTHORIZED: "0",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const call = async () => {
          const r = await forwardRequest(mockReq(), "{}", null);
          for await (const _ of r.upstreamRes) { /* drain */ }
          return r.upstreamConnectionId;
        };
        // Concurrent, not sequential: sequential calls would just reuse ONE
        // socket. Two AT ONCE forces two distinct connections, both free once
        // both finish.
        const [idA, idB] = await Promise.all([call(), call()]);
        assert.notEqual(idA, idB, "premise: two concurrent calls did not open two distinct sockets");

        // Whichever of A/B the pool hands back resets. Without destroying its
        // sibling first, a same-name retry can land on the OTHER one -- which
        // resets too, and (isRetry) is not retried a second time.
        const idC = await call();
        assert.ok(idC !== idA && idC !== idB,
          `the retry reused a sibling free socket (${idC}) instead of dialing fresh`);
      });
    } finally {
      closeBackend();
      backend.close();
    }
  });

  // getName() on an HTTPS agent appends ca/cert/rejectUnauthorized etc
  // (node:https Agent.prototype.getName calls http's getName first, then
  // keeps going) -- buildAgent always sets rejectUnauthorized, so an exact
  // name reconstructed from per-request `options` (which carries none of
  // those TLS fields at all) never matches the key Node actually stored the
  // free sockets under, and a sweep keyed that way silently destroys
  // nothing. The http-agent case above cannot see this: getName's http-only
  // prefix is already the whole name there. An https agent is what real
  // /v1/messages traffic uses.
  it("destroys sibling free sockets before a retry, on an HTTPS agent", async () => {
    const { dir, key, cert } = selfSignedCert();
    const answered = new WeakSet();
    const backend = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      // resetAndDestroy() only works on a raw TCP handle, not a TLSSocket's
      // wrapped one (ERR_INVALID_HANDLE_TYPE) -- a plain destroy() still
      // kills the peer's connection, which is all this fixture needs.
      if (answered.has(req.socket)) { req.socket.destroy(); return; }
      answered.add(req.socket);
      res.end("ok");
    });
    const closeBackend = trackConnections(backend);
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const port = backend.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `https://127.0.0.1:${port}`,
        CACHE_FIX_PROXY_REJECT_UNAUTHORIZED: "0",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const call = async () => {
          const r = await forwardRequest(mockReq(), "{}", null);
          for await (const _ of r.upstreamRes) { /* drain */ }
          return r.upstreamConnectionId;
        };
        const [idA, idB] = await Promise.all([call(), call()]);
        assert.notEqual(idA, idB, "premise: two concurrent calls did not open two distinct sockets");

        const idC = await call();
        assert.ok(idC !== idA && idC !== idB,
          `the retry reused a sibling free HTTPS socket (${idC}) instead of dialing fresh`);
      });
    } finally {
      closeBackend();
      backend.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The pool's tunnels outlive a hop instance. A socket reused more often than the
// idle timeout never idles out, so when the hop's address is re-pointed to a new
// instance (blue/green behind one port) the pool kept every tunnel on the old one
// for good, and the old instance's drain never finished.
describe("upstream pool: tunnels are retired, so a re-pointed hop is picked up", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(`127.0.0.1:${s.address().port}`)));

  // `cutover(status)` points new CONNECTs at the new instance; the old one keeps
  // answering the tunnels it holds, with `status`. `/stream` is a response that
  // outlives a short socket lifetime.
  async function rig(env, fn) {
    let oldStatus = 200;
    const oldB = http.createServer((req, res) => {
      if (req.url === "/hang") return;
      if (req.url !== "/stream") { res.statusCode = oldStatus; res.end("old"); return; }
      res.write("a");
      setTimeout(() => res.end("b"), 70);
    });
    const newB = http.createServer((req, res) => { res.end("new"); });
    const oldAddr = await listen(oldB);
    const newAddr = await listen(newB);
    const hop = startResettingHop({ forward: oldAddr });
    const servers = [oldB, newB, hop];
    const closeAll = servers.map(trackConnections);
    const hopAddr = await listen(hop);
    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://${oldAddr}`,
        CACHE_FIX_UPSTREAM_PROXY: `http://${hopAddr}`,
        ...env,
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const call = async (url = "/v1/messages") => {
          const r = await forwardRequest({ ...mockReq(), url }, "{}", null);
          let body = "";
          for await (const c of r.upstreamRes) body += c;
          return { status: r.statusCode, body, id: r.upstreamConnectionId };
        };
        await fn(call, (status) => { hop.forward = newAddr; oldStatus = status; });
      });
    } finally {
      closeAll.forEach((c) => c());
      servers.forEach((s) => s.close());
    }
  }

  it("a socket reused faster than the idle timeout is retired at its max lifetime", async () => {
    await rig({ CACHE_FIX_UPSTREAM_SOCKET_MAX_LIFETIME_MS: "50" }, async (call, cutover) => {
      assert.equal((await call()).body, "old");
      cutover(200);
      const t0 = Date.now();
      let r;
      do { await sleep(20); r = await call(); } while (r.body === "old" && Date.now() - t0 < 600);
      assert.equal(r.body, "new", "the pool kept reusing a tunnel to the old instance past its lifetime");
    });
  });

  it("a socket that passed the check just before its deadline is not handed out after it", async () => {
    await rig({ CACHE_FIX_UPSTREAM_SOCKET_MAX_LIFETIME_MS: "50" }, async (call, cutover) => {
      assert.equal((await call()).body, "old");   // released early: the lifetime check passes
      cutover(200);
      await sleep(80);   // past the lifetime, far under the file's 2000ms idle timeout
      assert.equal((await call()).body, "new", "an idle socket was handed out past its lifetime");
    });
  });

  it("a reused socket's response in flight is not cut by the idle clamp, even when Node leaves it armed", async () => {
    // Node re-arms a socket's timeout on reuse only when the request's own differs from
    // the agent's. Budget off makes the request's `config.timeout`; equal it to the idle one.
    const { default: config } = await import("../proxy/config.mjs");
    const prior = config.timeout;
    config.timeout = config.idleTimeoutMs;
    try {
      await rig({ CACHE_FIX_UPSTREAM_SOCKET_MAX_LIFETIME_MS: "50", CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS: "0" }, async (call) => {
        // The warm socket is kept only if it is released within the lifetime; a stalled
        // box misses that, so go again until one is (the stream then runs past the 50).
        let first, s;
        for (let i = 0; i < 20 && !(s && s.id === first.id); i++) {
          first = await call();
          s = await call("/stream");   // 70ms between chunks, over the <50ms the clamp left
        }
        assert.equal(s.id, first.id, "premise: the stream did not reuse the pooled socket");
        assert.equal(s.body, "ab", "the idle clamp cut a response in flight");
        assert.notEqual((await call()).id, s.id, "a socket past its lifetime went back to the pool");
      });
    } finally { config.timeout = prior; }
  });

  it("a lifetime of 0 turns the retirement off", async () => {
    await rig({ CACHE_FIX_UPSTREAM_SOCKET_MAX_LIFETIME_MS: "0" }, async (call) => {
      const first = await call();
      assert.equal((await call()).id, first.id, "a socket was retired with the lifetime off");
    });
  });

  it("three 5xx in a row empty the idle pool", async () => {
    await rig({}, async (call, cutover) => {
      const warm = await Promise.all([call(), call(), call(), call()]);
      assert.equal(new Set(warm.map((r) => r.id)).size, 4, "premise: four concurrent calls did not open four sockets");
      cutover(502);
      for (let i = 0; i < 3; i++) assert.equal((await call()).status, 502);
      assert.equal((await call()).body, "new", "an idle socket survived the failure streak");
    });
  });

  it("three timeouts in a row empty the idle pool", async () => {
    const { default: config } = await import("../proxy/config.mjs");
    await rig({}, async (call, cutover) => {
      await Promise.all([call(), call(), call(), call()]);
      cutover(200);
      const prior = config.timeout;
      config.timeout = 30;   // read live by forwardRequest; restored below
      try {
        await Promise.all([1, 2, 3].map(() => assert.rejects(call("/hang"), /Upstream timeout/)));
      } finally { config.timeout = prior; }
      assert.equal((await call()).body, "new", "an idle socket survived the timeout streak");
    });
  });
});
