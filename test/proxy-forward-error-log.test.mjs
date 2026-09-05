// A 502 handed to the client used to leave no record of why: the three
// forwardRequest catches in server.mjs (messages, bootstrap, passthrough)
// only logged through debugLog, gated on CACHE_FIX_DEBUG=1 and off by
// default on every host. This asserts each site now writes one
// [cache-fix] stderr line naming the error and the route, on by default,
// silenced only by CACHE_FIX_GATEWAY_ERROR_LOG=off — and that a session id
// in the route never reaches stderr.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startProxy } from "../proxy/server.mjs";
import { freePort } from "./proc-helpers.mjs";

const SESSION_ID = "cse_01ABCDEFGHIJKLMNOPQRSTUV";

function clientRequest(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path, headers: body ? { "content-type": "application/json" } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function captureStderr() {
  const original = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return original(chunk, ...rest);
  };
  return { lines, restore: () => { process.stderr.write = original; } };
}

describe("upstream connection failures are reported on stderr, not only debugLog", () => {
  let handle;
  let caDir;
  const savedEnv = {};
  const ENV_KEYS = ["CACHE_FIX_PROXY_UPSTREAM", "CACHE_FIX_FORWARD_PROXY", "CACHE_FIX_CA_DIR", "CACHE_FIX_GATEWAY_ERROR_LOG"];

  before(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    // Dead upstream: bind, read the port, close. Every forwardRequest to it
    // fails ECONNREFUSED.
    const deadPort = await freePort();
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${deadPort}`;

    // Forward-proxy mode so an origin-form request that is neither
    // /v1/messages nor /api/claude_cli/bootstrap reaches handlePassthrough
    // (server.mjs gates it on _forwardActive > 0).
    caDir = mkdtempSync(join(tmpdir(), "uerr-ca-"));
    process.env.CACHE_FIX_FORWARD_PROXY = "on";
    process.env.CACHE_FIX_CA_DIR = caDir;

    handle = await startProxy({ port: 0, watch: false });
  });

  after(async () => {
    await handle.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    try { rmSync(caDir, { recursive: true, force: true }); } catch {}
  });

  it("passthrough site: 502 and one stderr line with ECONNREFUSED, method, route, session id scrubbed", async () => {
    delete process.env.CACHE_FIX_GATEWAY_ERROR_LOG;
    const cap = captureStderr();
    let res;
    try {
      res = await clientRequest(handle.port, "POST", `/v1/code/sessions/${SESSION_ID}/worker/heartbeat`);
    } finally {
      cap.restore();
    }
    assert.equal(res.status, 502);
    const matches = cap.lines.filter((l) => l.startsWith("[cache-fix] upstream error -> 502:"));
    assert.equal(matches.length, 1, `expected exactly one line, got:\n${cap.lines.join("")}`);
    const line = matches[0];
    assert.match(line, /ECONNREFUSED/);
    assert.match(line, /POST/);
    assert.match(line, /\/v1\/code\/sessions\/cse_<id>\/worker\/heartbeat/);
    assert.ok(!line.includes(SESSION_ID), `session id reached stderr:\n${line}`);
  });

  it("passthrough site, absolute-form foreign target: userinfo, host and query never reach stderr", async () => {
    delete process.env.CACHE_FIX_GATEWAY_ERROR_LOG;
    const foreignPort = await freePort();
    const cap = captureStderr();
    let res;
    try {
      res = await clientRequest(handle.port, "GET", `http://alice:s3cret@127.0.0.1:${foreignPort}/v1/code/sessions/${SESSION_ID}/x?token=T`);
    } finally {
      cap.restore();
    }
    assert.equal(res.status, 502);
    const matches = cap.lines.filter((l) => l.startsWith("[cache-fix] upstream error -> 502:"));
    assert.equal(matches.length, 1, `expected exactly one line, got:\n${cap.lines.join("")}`);
    assert.match(matches[0], /for GET \/v1\/code\/sessions\/cse_<id>\/x\n$/);
    assert.ok(!matches[0].includes("s3cret") && !matches[0].includes("token=T"), `leaked:\n${matches[0]}`);
  });

  it("passthrough site, non-origin-form targets: authority never reaches stderr, not just the http(s) scrub", async () => {
    delete process.env.CACHE_FIX_GATEWAY_ERROR_LOG;
    for (const target of ["ftp://alice:s3cret@127.0.0.1:9/p?q=1", "//alice:s3cret@evil/p"]) {
      const cap = captureStderr();
      let res;
      try {
        res = await clientRequest(handle.port, "GET", target);
      } finally {
        cap.restore();
      }
      assert.equal(res.status, 502, `status for ${target}`);
      const matches = cap.lines.filter((l) => l.startsWith("[cache-fix] upstream error -> 502:"));
      assert.equal(matches.length, 1, `expected exactly one line for ${target}, got:\n${cap.lines.join("")}`);
      assert.ok(
        !matches[0].includes("s3cret") && !matches[0].includes("alice") && !matches[0].includes("evil"),
        `leaked for ${target}:\n${matches[0]}`,
      );
    }
  });

  it("messages site: 502 and one stderr line with ECONNREFUSED and the route", async () => {
    delete process.env.CACHE_FIX_GATEWAY_ERROR_LOG;
    const cap = captureStderr();
    let res;
    try {
      res = await clientRequest(handle.port, "POST", "/v1/messages", JSON.stringify({ model: "x" }));
    } finally {
      cap.restore();
    }
    assert.equal(res.status, 502);
    const matches = cap.lines.filter((l) => l.startsWith("[cache-fix] upstream error -> 502:"));
    assert.equal(matches.length, 1, `expected exactly one line, got:\n${cap.lines.join("")}`);
    assert.match(matches[0], /ECONNREFUSED/);
    assert.match(matches[0], /POST \/v1\/messages/);
  });

  it("bootstrap site: 502 and one stderr line with ECONNREFUSED and the route", async () => {
    delete process.env.CACHE_FIX_GATEWAY_ERROR_LOG;
    const cap = captureStderr();
    let res;
    try {
      res = await clientRequest(handle.port, "POST", "/api/claude_cli/bootstrap", JSON.stringify({ version: "2.1.150" }));
    } finally {
      cap.restore();
    }
    assert.equal(res.status, 502);
    const matches = cap.lines.filter((l) => l.startsWith("[cache-fix] upstream error -> 502:"));
    assert.equal(matches.length, 1, `expected exactly one line, got:\n${cap.lines.join("")}`);
    assert.match(matches[0], /ECONNREFUSED/);
    assert.match(matches[0], /POST \/api\/claude_cli\/bootstrap/);
  });

  it("CACHE_FIX_GATEWAY_ERROR_LOG=off: still 502, no such line", async () => {
    process.env.CACHE_FIX_GATEWAY_ERROR_LOG = "off";
    const cap = captureStderr();
    let res;
    try {
      res = await clientRequest(handle.port, "POST", `/v1/code/sessions/${SESSION_ID}/worker/heartbeat`);
    } finally {
      cap.restore();
      delete process.env.CACHE_FIX_GATEWAY_ERROR_LOG;
    }
    assert.equal(res.status, 502);
    const matches = cap.lines.filter((l) => l.startsWith("[cache-fix] upstream error -> 502:"));
    assert.equal(matches.length, 0, `expected no line with the flag off, got:\n${cap.lines.join("")}`);
  });
});
