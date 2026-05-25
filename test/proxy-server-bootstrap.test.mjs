import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startProxy } from "../proxy/server.mjs";

let handle;
let proxyPort;
let upstreamServer;
let upstreamPort;
let lastUpstreamRequest;
let upstreamResponseFn;
let tmpHome;

function clientRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: proxyPort, method, path, headers: body ? { "content-type": "application/json" } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("proxy server — /api/claude_cli/bootstrap routing", () => {
  before(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "bootstrap-route-"));
    process.env.CACHE_FIX_BOOTSTRAP_LOG_PATH = join(tmpHome, "bootstrap-log.jsonl");

    // Local upstream that pretends to be api.anthropic.com for the bootstrap path.
    upstreamServer = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastUpstreamRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        };
        if (upstreamResponseFn) {
          upstreamResponseFn(req, res);
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ system_prompt_section: "from-upstream" }));
        }
      });
    });
    await new Promise((r) => upstreamServer.listen(0, "127.0.0.1", r));
    upstreamPort = upstreamServer.address().port;

    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
    handle = await startProxy({ port: 0, watch: false });
    proxyPort = handle.port;
  });

  after(async () => {
    await handle.close();
    await new Promise((r) => upstreamServer.close(r));
    delete process.env.CACHE_FIX_PROXY_UPSTREAM;
    delete process.env.CACHE_FIX_BOOTSTRAP_LOG_PATH;
    delete process.env.CACHE_FIX_BOOTSTRAP_MODE;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("default (audit) mode forwards bootstrap to upstream and returns 200 with body", async () => {
    delete process.env.CACHE_FIX_BOOTSTRAP_MODE;
    upstreamResponseFn = null;
    const res = await clientRequest("POST", "/api/claude_cli/bootstrap", JSON.stringify({ version: "2.1.150" }));
    assert.equal(res.status, 200);
    assert.equal(lastUpstreamRequest.url, "/api/claude_cli/bootstrap");
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.system_prompt_section, "from-upstream");
  });

  it("block mode short-circuits with empty 200, never calls upstream", async () => {
    process.env.CACHE_FIX_BOOTSTRAP_MODE = "block";
    lastUpstreamRequest = null;
    const res = await clientRequest("POST", "/api/claude_cli/bootstrap", JSON.stringify({ version: "2.1.150" }));
    assert.equal(res.status, 200);
    assert.equal(res.body, "{}");
    assert.equal(lastUpstreamRequest, null, "upstream must not be called in block mode");
  });

  it("non-bootstrap unrouted path still returns 404", async () => {
    delete process.env.CACHE_FIX_BOOTSTRAP_MODE;
    const res = await clientRequest("POST", "/api/claude_cli/feedback", "{}");
    assert.equal(res.status, 404);
  });

  it("bootstrap routes through pipeline even with empty body", async () => {
    delete process.env.CACHE_FIX_BOOTSTRAP_MODE;
    upstreamResponseFn = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    };
    const res = await clientRequest("POST", "/api/claude_cli/bootstrap");
    assert.equal(res.status, 200);
    assert.equal(res.body, "{}");
  });

  it("upstream connection error is audited as anomaly before returning 502", async () => {
    delete process.env.CACHE_FIX_BOOTSTRAP_MODE;
    const { readFileSync, existsSync } = await import("node:fs");
    const logPath = process.env.CACHE_FIX_BOOTSTRAP_LOG_PATH;
    const sizeBefore = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).length : 0;

    // Bind an ephemeral port, close it, point upstream there → ECONNREFUSED.
    const tmpSrv = http.createServer(() => {});
    await new Promise((r) => tmpSrv.listen(0, "127.0.0.1", r));
    const deadPort = tmpSrv.address().port;
    await new Promise((r) => tmpSrv.close(r));

    const prevUpstream = process.env.CACHE_FIX_PROXY_UPSTREAM;
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${deadPort}`;
    try {
      const res = await clientRequest("POST", "/api/claude_cli/bootstrap", JSON.stringify({ version: "2.1.150" }));
      assert.equal(res.status, 502);
      const records = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(records.length, sizeBefore + 1, "exactly one new audit record was written");
      const latest = records[records.length - 1];
      assert.equal(latest.phase, "upstream_error_audited");
      assert.equal(latest.status, 502);
      assert.ok(latest.error, "error field must be populated");
    } finally {
      process.env.CACHE_FIX_PROXY_UPSTREAM = prevUpstream;
    }
  });

  it("non-JSON upstream response is still audited (anomaly case) and forwarded raw", async () => {
    delete process.env.CACHE_FIX_BOOTSTRAP_MODE;
    const { readFileSync, existsSync } = await import("node:fs");
    const logPath = process.env.CACHE_FIX_BOOTSTRAP_LOG_PATH;
    const sizeBefore = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).length : 0;

    upstreamResponseFn = (_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error not json");
    };
    const res = await clientRequest("POST", "/api/claude_cli/bootstrap", JSON.stringify({ version: "2.1.150" }));
    assert.equal(res.status, 500);
    assert.equal(res.body, "internal error not json");

    const records = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(records.length, sizeBefore + 1, "exactly one new audit record was written");
    const latest = records[records.length - 1];
    assert.equal(latest.phase, "response_audited");
    assert.equal(latest.status, 500);
    assert.equal(latest.body_bytes, Buffer.byteLength("internal error not json"));
  });
});
