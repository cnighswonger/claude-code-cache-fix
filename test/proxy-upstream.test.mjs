import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let fakeUpstream;
let fakePort;
let forwardRequest;
let defaultHits = 0;

describe("upstream.mjs", () => {
  before(async () => {
    fakeUpstream = http.createServer((req, res) => {
      defaultHits++;
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const delay = req.headers["x-test-delay"] ? parseInt(req.headers["x-test-delay"], 10) : 0;
        const respond = () => {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "x-test-received-headers": JSON.stringify(req.headers),
            "connection": "keep-alive",
            "transfer-encoding": "chunked",
          });
          res.end("data: {\"type\":\"ping\"}\n\n");
        };
        if (delay > 0) setTimeout(respond, delay);
        else respond();
      });
    });
    await new Promise((resolve) => fakeUpstream.listen(0, "127.0.0.1", resolve));
    fakePort = fakeUpstream.address().port;

    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${fakePort}`;
    const mod = await import("../proxy/upstream.mjs");
    forwardRequest = mod.forwardRequest;
  });

  after(() => {
    fakeUpstream.close();
  });

  it("forwards request to http:// upstream and returns response", async () => {
    const mockReq = {
      url: "/v1/messages",
      method: "POST",
      headers: {
        authorization: "Bearer sk-test",
        "content-type": "application/json",
        "x-stainless-timeout": "600",
      },
    };

    const { upstreamRes, responseHeaders, statusCode } = await forwardRequest(mockReq, "{}", null);
    assert.equal(statusCode, 200);
    assert.equal(responseHeaders["content-type"], "text/event-stream");

    const chunks = [];
    for await (const chunk of upstreamRes) chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).toString().includes("ping"));
  });

  it("strips hop-by-hop request headers", async () => {
    const mockReq = {
      url: "/v1/messages",
      method: "POST",
      headers: {
        authorization: "Bearer sk-test",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        "proxy-authorization": "Basic abc",
        "content-type": "application/json",
        "x-stainless-timeout": "600",
      },
    };

    const { upstreamRes, responseHeaders } = await forwardRequest(mockReq, "{}", null);
    const received = JSON.parse(responseHeaders["x-test-received-headers"]);

    assert.ok(!received["proxy-authorization"], "proxy-* headers should be stripped");
    assert.equal(received["authorization"], "Bearer sk-test");
    assert.equal(received["content-type"], "application/json");
    assert.equal(received["accept-encoding"], "identity");
    assert.equal(received["x-stainless-timeout"], "600");

    for await (const _ of upstreamRes) {}
  });

  it("strips hop-by-hop response headers", async () => {
    const mockReq = {
      url: "/v1/messages",
      method: "POST",
      headers: { "content-type": "application/json" },
    };

    const { upstreamRes, responseHeaders } = await forwardRequest(mockReq, "{}", null);

    assert.ok(!responseHeaders["connection"], "connection should be stripped from response");
    assert.ok(!responseHeaders["transfer-encoding"], "transfer-encoding should be stripped from response");

    for await (const _ of upstreamRes) {}
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    const mockReq = {
      url: "/v1/messages",
      method: "POST",
      headers: { "content-type": "application/json", "x-test-delay": "5000" },
    };

    setTimeout(() => controller.abort(), 50);

    try {
      await forwardRequest(mockReq, "{}", controller.signal);
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(
        err.message.includes("abort") ||
        err.message.includes("destroyed") ||
        err.message.includes("socket hang up")
      );
    }
  });

  // Per-request upstream override: the 4th forwardRequest parameter
  // (upstreamBase) replaces config.upstream for that call only.
  describe("forwardRequest upstreamBase override", () => {
    let overrideUpstream;
    let overrideReceived = null;

    before(async () => {
      overrideUpstream = http.createServer((req, res) => {
        overrideReceived = { url: req.url, headers: req.headers };
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      await new Promise((r) => overrideUpstream.listen(0, "127.0.0.1", r));
    });

    beforeEach(() => {
      defaultHits = 0;
      overrideReceived = null;
    });

    after(() => {
      overrideUpstream.close();
    });

    it("sends the request to the override base with mutated headers", async () => {
      const override = `http://127.0.0.1:${overrideUpstream.address().port}/anthropic`;
      const mockReq = {
        url: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": "sk-override-test",
          "content-type": "application/json",
          "proxy-authorization": "Basic abc", // proxy-*: stripped on override path too
        },
      };

      const { statusCode, upstreamRes } = await forwardRequest(mockReq, "{}", null, override);
      for await (const _ of upstreamRes) {}

      assert.equal(statusCode, 200);
      assert.equal(defaultHits, 0, "default upstream must not be contacted");
      assert.equal(overrideReceived.url, "/anthropic/v1/messages",
        "base path of the override is preserved (buildUpstreamUrl concatenation)");
      assert.equal(overrideReceived.headers["x-api-key"], "sk-override-test");
      assert.equal(overrideReceived.headers.authorization, undefined);
      assert.equal(overrideReceived.headers["proxy-authorization"], undefined);
    });

    it("uses config.upstream when no override is given", async () => {
      const mockReq = {
        url: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json" },
      };
      const { statusCode, upstreamRes } = await forwardRequest(mockReq, "{}", null);
      for await (const _ of upstreamRes) {}

      assert.equal(statusCode, 200);
      assert.equal(defaultHits, 1);
    });
  });
});
