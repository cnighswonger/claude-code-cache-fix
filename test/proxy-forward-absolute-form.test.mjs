// Tests for RFC 7230 §5.3.2 absolute-form request-targets in forward-proxy mode.
//
// A client configured with HTTP(S)_PROXY does not always tunnel: axios's
// built-in proxy support (which the Claude Code CLI's auto-updater and
// telemetry paths use) sends `GET https://host/path HTTP/1.1` on the plain
// proxy connection instead of issuing CONNECT. A conforming HTTP proxy must
// honor the authority in that request-target. The proxy instead treated the
// absolute URI as an origin-form path and concatenated it onto the configured
// upstream (`https://api.anthropic.com/https://downloads.claude.ai/...`),
// misrouting every such request to the upstream host — Cloudflare answers 404
// and the CLI renders a permanent "✘ Auto-update failed" banner (its 1P event
// export and Datadog flush 404 the same way).
//
// Contract under test:
//   - forward mode, absolute-form to a FOREIGN host  -> relayed to that host
//   - forward mode, absolute-form to the UPSTREAM    -> behaves as origin-form
//   - reverse mode, absolute-form                    -> 404 (contract unchanged)

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startProxy } from "../proxy/server.mjs";

const ENV_KEYS = [
  "CACHE_FIX_FORWARD_PROXY", "CACHE_FIX_CA_DIR", "CACHE_FIX_PROXY_UPSTREAM",
  "CACHE_FIX_HTTPS_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy",
  "NO_PROXY", "no_proxy",
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

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// Send a raw absolute-form request THROUGH the proxy port: the request line's
// target is the full URI, exactly what axios emits to a plain HTTP proxy.
function absoluteFormRequest(proxyPort, method, absoluteUrl, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: proxyPort, method, path: absoluteUrl },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("forward mode: absolute-form to a foreign host is relayed to that host, not the upstream", async () => {
  const saved = saveEnv();
  const caDir = mkdtempSync(join(tmpdir(), "absform-ca-"));

  const upstreamHits = [];
  const upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const upstreamPort = await listen(upstream);

  const foreignHits = [];
  const foreign = http.createServer((req, res) => {
    foreignHits.push({ url: req.url, host: req.headers.host });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("2.1.999");
  });
  const foreignPort = await listen(foreign);

  let handle;
  try {
    process.env.CACHE_FIX_FORWARD_PROXY = "on";
    process.env.CACHE_FIX_CA_DIR = caDir;
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
    delete process.env.CACHE_FIX_HTTPS_PROXY;
    delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY;
    delete process.env.https_proxy; delete process.env.http_proxy;
    delete process.env.NO_PROXY; delete process.env.no_proxy;

    handle = await startProxy({ port: 0, watch: false });

    const r = await absoluteFormRequest(
      handle.port, "GET", `http://127.0.0.1:${foreignPort}/claude-code-releases/latest`);

    assert.equal(r.status, 200, "absolute-form request must reach its own target host");
    assert.equal(r.body, "2.1.999", "response body must stream back from the target");
    assert.equal(foreignHits.length, 1, "target host must be hit exactly once");
    assert.equal(foreignHits[0].url, "/claude-code-releases/latest",
      "target must receive the origin-form path, not the absolute URI");
    assert.deepEqual(upstreamHits, [],
      "the upstream must NOT see a foreign-host absolute-form request");
  } finally {
    restoreEnv(saved);
    if (handle) await handle.close();
    upstream.close();
    foreign.close();
    try { rmSync(caDir, { recursive: true, force: true }); } catch {}
  }
});

test("forward mode: absolute-form to the upstream host behaves as origin-form (path + body intact)", async () => {
  const saved = saveEnv();
  const caDir = mkdtempSync(join(tmpdir(), "absform-up-ca-"));

  const upstreamHits = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      upstreamHits.push({ url: req.url, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const upstreamPort = await listen(upstream);

  let handle;
  try {
    process.env.CACHE_FIX_FORWARD_PROXY = "on";
    process.env.CACHE_FIX_CA_DIR = caDir;
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
    delete process.env.CACHE_FIX_HTTPS_PROXY;
    delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY;
    delete process.env.https_proxy; delete process.env.http_proxy;
    delete process.env.NO_PROXY; delete process.env.no_proxy;

    handle = await startProxy({ port: 0, watch: false });

    const r = await absoluteFormRequest(
      handle.port, "POST",
      `http://127.0.0.1:${upstreamPort}/api/event_logging/v2/batch`,
      '{"events":[]}');

    assert.equal(r.status, 200);
    assert.equal(upstreamHits.length, 1, "upstream must be hit exactly once");
    assert.equal(upstreamHits[0].url, "/api/event_logging/v2/batch",
      "upstream must receive the origin-form path, not a concatenated absolute URI");
    assert.equal(upstreamHits[0].body, '{"events":[]}', "request body must pass through");
  } finally {
    restoreEnv(saved);
    if (handle) await handle.close();
    upstream.close();
    try { rmSync(caDir, { recursive: true, force: true }); } catch {}
  }
});

test("reverse mode: absolute-form keeps the 404 contract (no relay)", async () => {
  const saved = saveEnv();

  const foreignHits = [];
  const foreign = http.createServer((req, res) => {
    foreignHits.push(req.url);
    res.writeHead(200);
    res.end("nope");
  });
  const foreignPort = await listen(foreign);

  let handle;
  try {
    delete process.env.CACHE_FIX_FORWARD_PROXY;
    delete process.env.CACHE_FIX_HTTPS_PROXY;
    delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY;
    delete process.env.https_proxy; delete process.env.http_proxy;

    handle = await startProxy({ port: 0, watch: false });

    const r = await absoluteFormRequest(
      handle.port, "GET", `http://127.0.0.1:${foreignPort}/anything`);

    assert.equal(r.status, 404, "reverse mode must not act as a forward proxy");
    assert.deepEqual(foreignHits, [], "reverse mode must not relay absolute-form requests");
  } finally {
    restoreEnv(saved);
    if (handle) await handle.close();
    foreign.close();
  }
});
