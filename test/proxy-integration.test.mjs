import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { exitWithin } from "./child-deadline.mjs";
import http from "node:http";

let proxyPort;
let proxyProcess;

function makeRequest(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/v1/messages",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

describe("proxy integration with extensions", () => {
  let fakeUpstream;
  let lastUpstreamBody;

  before(async () => {
    fakeUpstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastUpstreamBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-20250514","usage":{"input_tokens":100,"cache_read_input_tokens":80,"cache_creation_input_tokens":20}}}\n\n');
        res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n');
        res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    await new Promise((resolve) => {
      fakeUpstream.listen(0, "127.0.0.1", resolve);
    });
    const fakePort = fakeUpstream.address().port;

    process.env.CACHE_FIX_PROXY_PORT = "0";
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${fakePort}`;

    const { spawn } = await import("node:child_process");
    proxyProcess = spawn(process.execPath, ["proxy/server.mjs"], {
      env: {
        ...process.env,
        CACHE_FIX_PROXY_PORT: "0",
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${fakePort}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    proxyPort = await new Promise((resolve, reject) => {
      let output = "";
      proxyProcess.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const match = output.match(/listening on [\d.]+:(\d+)/);
        if (match) resolve(parseInt(match[1], 10));
      });
      proxyProcess.on("exit", (code) => reject(new Error(`Proxy exited ${code}`)));
      setTimeout(() => reject(new Error("Proxy start timeout")), 5000);
    });
  });

  after(async () => {
    if (proxyProcess) {
      proxyProcess.kill("SIGTERM");
      // Bounded: this is an `after` hook, so a proxy that never exits does not
      // fail a case — it stops the FILE from finishing, and with no default
      // test timeout the whole run hangs with nothing reported.
      await exitWithin(proxyProcess, 30_000, "the proxy never exited after SIGTERM");
    }
    if (fakeUpstream) {
      await new Promise((resolve) => fakeUpstream.close(resolve));
    }
    delete process.env.CACHE_FIX_PROXY_PORT;
    delete process.env.CACHE_FIX_PROXY_UPSTREAM;
  });

  it("health check returns ok", async () => {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/health`, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }).on("error", reject);
    });
    assert.equal(res.status, 200);
    const health = JSON.parse(res.body);
    assert.equal(health.status, "ok");
    // /health also reports version + mode fields. This suite runs the proxy in
    // reverse-proxy mode, so assert those explicitly rather than a whole-object
    // deep-equal, which would break on every new /health field and version bump.
    assert.equal(health.forward_proxy, false);
    assert.equal(health.https_proxy, null);
  });

  it("forwards request through extensions and streams response", async () => {
    const body = {
      model: "claude-opus-4-20250514",
      max_tokens: 100,
      system: [
        { type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
      ],
      tools: [
        { name: "Zebra", input_schema: {} },
        { name: "Alpha", input_schema: {} },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello world", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    };

    const res = await makeRequest(body);
    assert.equal(res.status, 200);

    // Verify tools were sorted by sort-stabilization extension
    assert.equal(lastUpstreamBody.tools[0].name, "Alpha");
    assert.equal(lastUpstreamBody.tools[1].name, "Zebra");

    // Verify TTL was injected by ttl-management extension
    assert.equal(lastUpstreamBody.system[0].cache_control.ttl, "1h");

    // Verify cache_control on user message was normalized
    // cache-control-normalize strips markers and re-applies at last block
    const lastUserMsg = lastUpstreamBody.messages[lastUpstreamBody.messages.length - 1];
    const lastBlock = lastUserMsg.content[lastUserMsg.content.length - 1];
    assert.ok(lastBlock.cache_control);

    // Verify SSE stream was forwarded
    assert.ok(res.body.includes("message_start"));
    assert.ok(res.body.includes("[DONE]"));
  });

  it("TTL injection applies to message content cache_control blocks", async () => {
    const body = {
      model: "claude-opus-4-20250514",
      max_tokens: 50,
      system: [
        { type: "text", text: "System prompt", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hi" },
            { type: "text", text: "Follow up", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    };

    await makeRequest(body);

    // TTL injected on system block
    assert.equal(lastUpstreamBody.system[0].cache_control.ttl, "1h");
    // cache-control-normalize strips user markers then re-applies canonical at last block
    const lastMsg = lastUpstreamBody.messages[0];
    const lastBlock = lastMsg.content[lastMsg.content.length - 1];
    // TTL should be injected on the canonical marker too
    assert.equal(lastBlock.cache_control.ttl, "1h");
  });
});
