// An API-key org whose credit is spent gets a 400 from upstream, and a key at
// its rate limit a 429. Claude Code re-runs apiKeyHelper only on 401/403: on a
// 400 it never does, on a 429 it retries the same cached key for 60 s. So
// handleMessages' buffered branch answers that one 400 as 401, and a 429 for a
// key listed in select-key's pool.fp as 401, once per session and retry-after
// window (a repeat from the same session inside it stays 429, so a fully
// limited pool waits instead of looping 401s). Body and headers are untouched.
// Claude Code sends an apiKeyHelper key in x-api-key AND as Authorization:
// Bearer <same key>; a static ANTHROPIC_API_KEY goes in x-api-key only. Only
// the helper pair is rewritten: a 401 to a static key is retried with backoff
// instead of failing at once. Everything else (x-api-key alone, OAuth Bearer,
// other 400s, other statuses, a 429 for a key outside pool.fp) passes as-is.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../proxy/server.mjs";

// Non-compact on purpose: a JSON.parse/stringify round trip would change it.
const CREDIT_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "billing_error",
    message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
  request_id: "req_credit",
}, null, 2);
const OTHER_400 = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } });
const OK_200 = JSON.stringify({ type: "message", content: [] });
const RATE_429 = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Error" }, request_id: "req_rate" }, null, 2);

function clientRequest(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model: "test", messages: [] }));
  });
}

const HELPER = { "x-api-key": "sk-ant-test", authorization: "Bearer sk-ant-test" };
const helperOf = (key, session) => ({ "x-api-key": key, authorization: `Bearer ${key}`, ...(session && { "x-claude-code-session-id": session }) });
const fp = (key) => createHash("sha256").update(key).digest("hex");

describe("apiKeyHelper credit-balance 400 and pooled-key 429 are answered as 401", () => {
  let handle, upstream, reply, stateDir, savedXdg;

  before(async () => {
    upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(reply.status, { "content-type": "application/json", "x-should-retry": "false", ...reply.headers });
        res.end(reply.body);
      });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    stateDir = mkdtempSync(join(tmpdir(), "ccf-pool-"));
    savedXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    handle = await startProxy({ port: 0, watch: false });
  });

  after(async () => {
    await handle.close();
    await new Promise((r) => upstream.close(r));
    delete process.env.CACHE_FIX_PROXY_UPSTREAM;
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = savedXdg;
    rmSync(stateDir, { recursive: true, force: true });
  });

  async function ask(status, body, headers, replyHeaders) {
    reply = { status, body, headers: replyHeaders };
    return clientRequest(handle.port, headers);
  }

  function writePool(...keys) {
    const dir = join(stateDir, "claude-api-key");
    rmSync(dir, { recursive: true, force: true });
    if (!keys.length) return;
    mkdirSync(dir);
    writeFileSync(join(dir, "pool.fp"), keys.map((k) => fp(k) + "\n").join(""));
  }

  it("x-api-key + Authorization: Bearer <same key> + credit 400 -> 401, body byte-identical, headers unchanged", async () => {
    const res = await ask(400, CREDIT_BODY, HELPER);
    assert.equal(res.status, 401);
    assert.equal(res.body.toString(), CREDIT_BODY);
    assert.equal(res.headers["x-should-retry"], "false");
    assert.equal(res.headers["content-type"], "application/json");
  });

  it("a static x-api-key alone keeps its 400", async () => {
    const res = await ask(400, CREDIT_BODY, { "x-api-key": "sk-ant-test" });
    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), JSON.parse(CREDIT_BODY));
  });

  it("a Bearer request keeps its 400 unless its Bearer is the x-api-key", async () => {
    for (const headers of [{ authorization: "Bearer x" }, { authorization: "Bearer x", "x-api-key": "sk-ant-test" }]) {
      const res = await ask(400, CREDIT_BODY, headers);
      assert.equal(res.status, 400);
      assert.deepEqual(JSON.parse(res.body), JSON.parse(CREDIT_BODY));
    }
  });

  it("helper pair + another 400 body keeps its 400", async () => {
    const res = await ask(400, OTHER_400, HELPER);
    assert.equal(res.status, 400);
    assert.equal(res.body.toString(), OTHER_400);
  });

  it("helper pair + 200 is untouched", async () => {
    const res = await ask(200, OK_200, HELPER);
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), OK_200);
  });

  it("a pooled helper key + 429 -> 401, body byte-identical, retry-after unchanged", async () => {
    writePool("sk-pool-1", "sk-pool-other");
    const res = await ask(429, RATE_429, helperOf("sk-pool-1"), { "retry-after": "7" });
    assert.equal(res.status, 401);
    assert.equal(res.body.toString(), RATE_429);
    assert.equal(res.headers["retry-after"], "7");
    assert.equal(res.headers["x-should-retry"], "false");
  });

  it("an OAuth Bearer (no x-api-key) + 429 keeps its 429", async () => {
    writePool("sk-pool-oauth");
    const res = await ask(429, RATE_429, { authorization: "Bearer sk-pool-oauth" });
    assert.equal(res.status, 429);
    assert.deepEqual(JSON.parse(res.body), JSON.parse(RATE_429));
  });

  it("a helper key outside pool.fp + 429 keeps its 429", async () => {
    writePool("sk-pool-other");
    const res = await ask(429, RATE_429, helperOf("sk-not-pooled"));
    assert.equal(res.status, 429);
    assert.deepEqual(JSON.parse(res.body), JSON.parse(RATE_429));
  });

  it("a pooled static x-api-key alone + 429 keeps its 429", async () => {
    writePool("sk-pool-static");
    const res = await ask(429, RATE_429, { "x-api-key": "sk-pool-static" });
    assert.equal(res.status, 429);
    assert.deepEqual(JSON.parse(res.body), JSON.parse(RATE_429));
  });

  it("no pool.fp + helper pair + 429 keeps its 429", async () => {
    writePool();
    const res = await ask(429, RATE_429, helperOf("sk-pool-nofile"));
    assert.equal(res.status, 429);
    assert.deepEqual(JSON.parse(res.body), JSON.parse(RATE_429));
  });

  it("the same pooled key, same session: first 429 -> 401, a repeat inside the window stays 429", async () => {
    writePool("sk-pool-twice");
    const first = await ask(429, RATE_429, helperOf("sk-pool-twice", "s1"));
    assert.equal(first.status, 401);
    const second = await ask(429, RATE_429, helperOf("sk-pool-twice", "s1"));
    assert.equal(second.status, 429);
    assert.deepEqual(JSON.parse(second.body), JSON.parse(RATE_429));
  });

  it("the same pooled key, another session: its first 429 is answered 401 too", async () => {
    writePool("sk-pool-shared");
    for (const session of ["s1", "s2"]) {
      const res = await ask(429, RATE_429, helperOf("sk-pool-shared", session));
      assert.equal(res.status, 401);
    }
  });

  it("retry-after: 0 leaves no window, so a repeat 429 is answered 401 again", async () => {
    writePool("sk-pool-zero");
    for (let i = 0; i < 2; i++) {
      const res = await ask(429, RATE_429, helperOf("sk-pool-zero"), { "retry-after": "0" });
      assert.equal(res.status, 401);
    }
  });
});
