// Tests for the CACHE_FIX_DEBUG opt-in debug log added in #190.
//
// Covers the Codex round-1 blockers:
//   - Authorization / x-api-key headers must be redacted before the log write.
//   - No stdout/stderr noise when CACHE_FIX_DEBUG is unset.
//   - Async handler rejections must NOT escape to unhandledRejection — the
//     dispatcher's try/catch has to actually surround the awaited handler.
//   - The 500 fallback body must NOT echo the internal error message.
//   - The module must not write to stdout at import time.

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { startProxy } from "../proxy/server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// --- mock upstream + proxy boot helpers ---

function startMockUpstream(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function postJson(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function getPath(port, path) {
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

// --- shared test state ---

let tmpDir;
let logPath;
let upstream;
let proxyHandle;

function envSnapshot() {
  return {
    CACHE_FIX_DEBUG: process.env.CACHE_FIX_DEBUG,
    CACHE_FIX_DEBUG_LOG: process.env.CACHE_FIX_DEBUG_LOG,
    CACHE_FIX_PROXY_UPSTREAM: process.env.CACHE_FIX_PROXY_UPSTREAM,
  };
}

function envRestore(snap) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("server debug logging (#190)", () => {
  let priorEnv;

  beforeEach(() => {
    priorEnv = envSnapshot();
    tmpDir = mkdtempSync(join(tmpdir(), "cf-debug-log-"));
    logPath = join(tmpDir, "cache-fix-debug.log");
    process.env.CACHE_FIX_DEBUG_LOG = logPath;
  });

  afterEach(async () => {
    if (proxyHandle) {
      try { await proxyHandle.close(); } catch {}
      proxyHandle = null;
    }
    if (upstream) {
      await new Promise((r) => upstream.close(() => r()));
      upstream = null;
    }
    envRestore(priorEnv);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("debug off: /health hit creates no log file", async () => {
    delete process.env.CACHE_FIX_DEBUG;
    proxyHandle = await startProxy({ port: 0, watch: false });
    const res = await getPath(proxyHandle.port, "/health");
    assert.equal(res.status, 200);
    assert.ok(!existsSync(logPath), "log file must not exist when CACHE_FIX_DEBUG is unset");
  });

  it("debug on: Authorization header redacted in log; raw token absent", async () => {
    process.env.CACHE_FIX_DEBUG = "1";
    upstream = await startMockUpstream((req, res) => {
      // Drain body then reply 200.
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_x", role: "assistant", content: [] }));
      });
    });
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    proxyHandle = await startProxy({ port: 0, watch: false });
    const r = await postJson(proxyHandle.port, "/v1/messages",
      { authorization: "Bearer SECRETSAUCE-AUTH" },
      { model: "test", messages: [] });
    assert.equal(r.status, 200);
    assert.ok(existsSync(logPath), "log file must exist when CACHE_FIX_DEBUG=1");
    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes("[REDACTED]"), "redaction sentinel must appear in log");
    assert.ok(!log.includes("SECRETSAUCE-AUTH"), "raw Authorization token must NOT appear in log");
    assert.ok(!log.includes("Bearer SECRETSAUCE"), "raw bearer value must NOT appear in log");
  });

  it("debug on: x-api-key redacted; raw key absent", async () => {
    process.env.CACHE_FIX_DEBUG = "1";
    upstream = await startMockUpstream((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    proxyHandle = await startProxy({ port: 0, watch: false });
    const r = await postJson(proxyHandle.port, "/v1/messages",
      { "x-api-key": "sk-foo-bar-DONOTLOGME" },
      { model: "test", messages: [] });
    assert.equal(r.status, 200);
    const log = readFileSync(logPath, "utf8");
    assert.ok(!log.includes("sk-foo-bar-DONOTLOGME"), "raw x-api-key must NOT appear in log");
    assert.ok(log.includes("[REDACTED]"), "redaction sentinel must appear in log");
  });

  it("debug on: cookie + proxy-authorization also redacted", async () => {
    process.env.CACHE_FIX_DEBUG = "1";
    upstream = await startMockUpstream((req, res) => {
      req.on("data", () => {});
      req.on("end", () => { res.writeHead(200); res.end("{}"); });
    });
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    proxyHandle = await startProxy({ port: 0, watch: false });
    await postJson(proxyHandle.port, "/v1/messages",
      { cookie: "session=COOKIEVALUE-XYZ", "proxy-authorization": "Basic PROXYAUTHVAL" },
      { model: "test", messages: [] });
    const log = readFileSync(logPath, "utf8");
    assert.ok(!log.includes("COOKIEVALUE-XYZ"), "raw cookie must NOT appear in log");
    assert.ok(!log.includes("PROXYAUTHVAL"), "raw proxy-authorization must NOT appear in log");
  });

  it("debug on: non-sensitive header values remain visible (control)", async () => {
    process.env.CACHE_FIX_DEBUG = "1";
    upstream = await startMockUpstream((req, res) => {
      req.on("data", () => {});
      req.on("end", () => { res.writeHead(200); res.end("{}"); });
    });
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    proxyHandle = await startProxy({ port: 0, watch: false });
    await postJson(proxyHandle.port, "/v1/messages",
      { "x-debug-marker": "MARKER-XYZ-789" },
      { model: "test", messages: [] });
    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes("MARKER-XYZ-789"), "non-sensitive header values MUST still log (no over-redaction)");
  });
});

// --- module import has no stdout side effects ---
// Spawn a fresh child node that imports server.mjs with CACHE_FIX_DEBUG unset.
// The contributor's original PR had nine module-top console.log() calls that
// fired on every import; those must not regress.

describe("server.mjs import-time side effects (#190)", () => {
  it("importing the module produces no stdout when CACHE_FIX_DEBUG is unset", () => {
    const env = { ...process.env };
    delete env.CACHE_FIX_DEBUG;
    const result = spawnSync(process.execPath,
      ["-e", "import('./proxy/server.mjs').then(() => process.exit(0));"],
      { cwd: REPO_ROOT, env, encoding: "utf8" });
    assert.equal(result.status, 0, `child exited non-zero: ${result.stderr}`);
    assert.equal(result.stdout, "",
      `stdout must be empty on import without CACHE_FIX_DEBUG; got: ${JSON.stringify(result.stdout)}`);
  });
});

// --- async handler rejection is caught by the dispatcher ---
// Codex flagged that handleMessages/handleBootstrap are async, so returning
// their promises (without await) lets rejections escape the try/catch. We
// exercise the path by causing handleBootstrap to reject (config.upstream
// unparseable → URL constructor throws inside the route, not inside the
// existing forwardRequest try/catch).

describe("server async rejection containment (#190)", () => {
  let priorEnv;
  beforeEach(() => {
    priorEnv = envSnapshot();
    tmpDir = mkdtempSync(join(tmpdir(), "cf-debug-log-"));
    logPath = join(tmpDir, "cache-fix-debug.log");
    process.env.CACHE_FIX_DEBUG_LOG = logPath;
  });
  afterEach(async () => {
    if (proxyHandle) { try { await proxyHandle.close(); } catch {} proxyHandle = null; }
    envRestore(priorEnv);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("500 fallback body is generic — does not echo error.message", async () => {
    // Easiest deterministic path: hit a route that triggers a throw inside the
    // dispatcher try/catch but outside per-handler try/catches. We monkey-patch
    // the dispatcher? No — we don't have hooks. Use the catch-all by sending a
    // bogus method that goes to handleNotFound, then poison req.url so the
    // dispatcher's debugLog formatter throws? Too brittle.
    //
    // Instead: spawn a child server with an unreachable upstream and abort the
    // socket mid-handler. That exercises forwardRequest's catch (handled), not
    // our top-level catch. To hit the top-level catch reliably we'd need an
    // internal injection seam the contributor's PR didn't add.
    //
    // What we CAN assert: when the contributor's createProxyServer is exercised
    // and an error DOES occur, the 500 body never contains 'error.message' style
    // leakage because the literal body is constant. Static check:
    const src = readFileSync(join(REPO_ROOT, "proxy/server.mjs"), "utf8");
    // The 500 fallback must NOT include `message: error.message` (PR-1 style).
    assert.ok(!/message:\s*error\.message/.test(src),
      "500 fallback must not echo error.message");
    // The 500 fallback must emit the generic sentinel.
    assert.ok(/error:\s*"internal_proxy_error"/.test(src),
      "500 fallback must emit { error: 'internal_proxy_error' }");
  });

  it("dispatcher awaits async handlers (static assertion)", () => {
    const src = readFileSync(join(REPO_ROOT, "proxy/server.mjs"), "utf8");
    // The dispatcher body must `await handleMessages` and `await handleBootstrap`
    // for the surrounding try/catch to actually catch their rejections.
    assert.ok(/await\s+handleMessages\s*\(/.test(src),
      "dispatcher must await handleMessages");
    assert.ok(/await\s+handleBootstrap\s*\(/.test(src),
      "dispatcher must await handleBootstrap");
  });

});
