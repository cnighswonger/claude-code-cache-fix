// Tests for forward-proxy attach-failure fallback semantics in proxy/server.mjs.
//
// Codex blocker #3 on PR #251: when CACHE_FIX_FORWARD_PROXY=on but
// attachForwardProxy() throws (e.g. openssl missing), the proxy must actually
// fall back to reverse-proxy-only behavior — /health already reports
// forward_proxy:false, but request routing keyed on config.forwardProxy (the
// env var), so non-/v1/messages paths were still passthrough-relayed upstream
// instead of keeping the reverse-mode 404 contract. The process-wide self-heal
// (uncaughtException/unhandledRejection swallowers) likewise must only be
// installed when forward mode actually attached, and must be removed again on
// close() so an embedded/shared process is not left with altered crash
// semantics after the forward-mode instance is gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startProxy } from "../proxy/server.mjs";

const ENV_KEYS = [
  "CACHE_FIX_FORWARD_PROXY", "CACHE_FIX_CA_DIR", "CACHE_FIX_PROXY_UPSTREAM",
  "CACHE_FIX_HTTPS_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy",
  "CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_FALLBACK_PROXIES",
  "PATH",
];

function saveEnv() {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved) {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method: "GET", path }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

const swallowerCount = () =>
  process.listeners("uncaughtException").length + process.listeners("unhandledRejection").length;

// Successful attach installs the self-heal swallowers; close() must remove
// them again and retire forward-mode routing, so a later reverse-only instance
// in the SAME process (embedded/shared usage) gets Node's default crash
// semantics and reverse-mode 404s — not the ghost of the closed instance.
test("successful attach: self-heal removed on close(), forward routing retired", async () => {
  const saved = saveEnv();
  const caDir = mkdtempSync(join(tmpdir(), "fwd-ok-ca-"));
  const upstreamHits = [];
  const upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const upstreamPort = await listen(upstream);
  const before = swallowerCount();
  let fwd, rev;
  try {
    process.env.CACHE_FIX_FORWARD_PROXY = "on";
    process.env.CACHE_FIX_CA_DIR = caDir;
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
    delete process.env.CACHE_FIX_HTTPS_PROXY;
    delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY;
    delete process.env.https_proxy; delete process.env.http_proxy;
    // PATH untouched: openssl available, attach succeeds.

    fwd = await startProxy({ port: 0, watch: false });
    const health = JSON.parse((await get(fwd.port, "/health")).body);
    assert.equal(health.forward_proxy, true, "attach should have succeeded");
    assert.equal(swallowerCount(), before + 2, "self-heal should be installed while forward mode is active");

    await fwd.close();
    fwd = null;
    assert.equal(swallowerCount(), before, "self-heal swallowers must be removed on close()");

    // A later reverse-only instance in the same process must not inherit
    // forward-mode routing (passthrough) or report forward_proxy:true.
    delete process.env.CACHE_FIX_FORWARD_PROXY;
    rev = await startProxy({ port: 0, watch: false });
    const revHealth = JSON.parse((await get(rev.port, "/health")).body);
    assert.equal(revHealth.forward_proxy, false, "closed forward instance leaked forward_proxy:true");
    const r = await get(rev.port, "/api/claude_cli/remote_control/credentials");
    assert.equal(r.status, 404, "reverse-only instance passthrough-relayed a non-core path");
    assert.deepEqual(upstreamHits, [], "reverse-only instance relayed upstream");
    assert.equal(swallowerCount(), before, "reverse-only instance must not install self-heal");
  } finally {
    restoreEnv(saved);
    if (fwd) await fwd.close();
    if (rev) await rev.close();
    upstream.close();
    try { rmSync(caDir, { recursive: true, force: true }); } catch {}
  }
});

// Forward mode requested but attach fails (openssl unreachable via a scrubbed
// PATH + fresh CA dir): routing must keep the reverse-mode 404 contract for
// non-core paths — NOT relay them upstream — and the self-heal swallowers must
// not be installed for a mode that never attached.
test("attach failure: non-core paths 404 (not passthrough), no self-heal installed", async () => {
  const saved = saveEnv();
  const caDir = mkdtempSync(join(tmpdir(), "fwd-fail-ca-"));
  const upstreamHits = [];
  const upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const upstreamPort = await listen(upstream);
  const before = swallowerCount();
  let handle;
  try {
    process.env.CACHE_FIX_FORWARD_PROXY = "on";
    process.env.CACHE_FIX_CA_DIR = caDir;                 // fresh: forces generation
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
    delete process.env.CACHE_FIX_HTTPS_PROXY;
    delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY;
    delete process.env.https_proxy; delete process.env.http_proxy;
    process.env.PATH = join(tmpdir(), "definitely-empty-path"); // no openssl -> attach throws

    handle = await startProxy({ port: 0, watch: false });

    const health = JSON.parse((await get(handle.port, "/health")).body);
    assert.equal(health.forward_proxy, false, "health must report attach failure");

    const r = await get(handle.port, "/api/claude_cli/remote_control/credentials");
    assert.equal(r.status, 404, "non-core path must keep reverse-mode 404 semantics");
    assert.deepEqual(upstreamHits, [], "request was passthrough-relayed despite failed attach");

    assert.equal(swallowerCount(), before, "self-heal installed despite failed attach");
  } finally {
    restoreEnv(saved);
    if (handle) await handle.close();
    upstream.close();
    try { rmSync(caDir, { recursive: true, force: true }); } catch {}
  }
});

// A CONNECT MUST TRAVERSE THE FALLBACK CHAIN, NOT DIAL DIRECT.
//
// Live outage on the work Mac, found by cswap's pin: every `/login` failed with
// UNABLE_TO_GET_ISSUER_CERT while plain HTTP was fine. The cause is one call
// away from the fix — resolveHop() consults fallbackProxyUrls(), and its ONLY
// caller was forwardRequest() (plain HTTP). Both CONNECT paths read
// config.httpsProxy directly, which is fed by CACHE_FIX_UPSTREAM_PROXY /
// HTTPS_PROXY and NEVER by CACHE_FIX_FALLBACK_PROXIES. With only the fallback
// configured — the shipped wiring — that value is "" and CONNECT dialled
// direct, straight into the corporate MITM.
//
// It hid for as long as it did because the host everyone probes is the one CCF
// MITMs: api.anthropic.com goes down the relay path, comes back re-signed by
// our own CA, and reads authorized=true. Only the hosts CCF does NOT MITM take
// the blind tunnel, and those are exactly the login hosts. Measured on the work
// Mac, same box, same minute:
//   claude.ai / console.anthropic.com via 9901 -> UNABLE_TO_GET_ISSUER_CERT
//   the same two              via 8118 -> authorized=true, Let's Encrypt
//
// A stand-in CONNECT proxy rather than a real hop: the assertion is WHICH
// SOCKET the tunnel is opened on, and a listener that records the CONNECT line
// answers that without TLS, a CA, or the network.
test("CONNECT traverses the fallback chain when only a fallback is configured", async () => {
  const saved = saveEnv();
  const caDir = mkdtempSync(join(tmpdir(), "ccf-connect-fallback-"));
  const seen = [];
  // The fallback hop. Speaks just enough CONNECT to be chosen and to record it.
  const hop = net.createServer((sock) => {
    sock.once("data", (d) => {
      seen.push(String(d).split("\r\n")[0]);
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      sock.end();
    });
    sock.on("error", () => {});
  });
  const hopPort = await listen(hop);
  // Where a DIRECT dial would land. Nothing may reach it.
  const direct = net.createServer((sock) => { seen.push("DIRECT"); sock.destroy(); });
  const directPort = await listen(direct);

  let handle;
  try {
    process.env.CACHE_FIX_FORWARD_PROXY = "on";
    process.env.CACHE_FIX_CA_DIR = caDir;
    // The shipped shape: a fallback and NOTHING else. Every variable that feeds
    // config.httpsProxy is cleared, because inheriting one here would let the
    // old code pass for the wrong reason.
    process.env.CACHE_FIX_FALLBACK_PROXIES = `http://127.0.0.1:${hopPort}`;
    for (const k of ["CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_HTTPS_PROXY",
                     "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete process.env[k];

    handle = await startProxy({ port: 0, watch: false });

    // A host CCF does not MITM, so this is the blind tunnel — the failing path.
    const target = `127.0.0.1:${directPort}`;
    await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: handle.port, method: "CONNECT",
                                 path: target, headers: { host: target } });
      req.on("connect", (_res, socket) => { socket.destroy(); resolve(); });
      req.on("error", () => resolve());
      req.setTimeout(4_000, () => { req.destroy(); resolve(); });
      req.end();
    });
    await new Promise((r) => setTimeout(r, 150));   // let the hop record it

    assert.ok(!seen.includes("DIRECT"),
      "CONNECT dialled the target directly, bypassing the configured fallback — " +
      "this is the work-Mac outage: every non-MITM'd host lands on the corporate proxy");
    assert.deepEqual(seen, [`CONNECT ${target} HTTP/1.1`],
      `CONNECT did not go through the fallback hop; saw ${JSON.stringify(seen)}`);
  } finally {
    restoreEnv(saved);
    if (handle) await handle.close();
    hop.close(); direct.close();
    try { rmSync(caDir, { recursive: true, force: true }); } catch {}
  }
});
