import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProxyServer, startProxy } from "../proxy/server.mjs";

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

describe("embeddable proxy", () => {
  it("createProxyServer returns an http.Server that is not yet listening", () => {
    const server = createProxyServer();
    assert.ok(server instanceof http.Server);
    assert.equal(server.listening, false);
  });

  it("startProxy({port:0}) resolves with an OS-assigned port", async () => {
    const handle = await startProxy({ port: 0, watch: false });
    try {
      assert.equal(typeof handle.port, "number");
      assert.ok(handle.port > 0);
      assert.equal(handle.address, "127.0.0.1");
      assert.equal(handle.server.listening, true);

      const res = await get(handle.port, "/health");
      assert.equal(res.status, 200);
    } finally {
      await handle.close();
    }
  });

  it("two startProxy instances coexist on different ports", async () => {
    const a = await startProxy({ port: 0, watch: false });
    const b = await startProxy({ port: 0, watch: false });
    try {
      assert.notEqual(a.port, b.port);
      assert.equal((await get(a.port, "/health")).status, 200);
      assert.equal((await get(b.port, "/health")).status, 200);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("close() lets the port be reused", async () => {
    const first = await startProxy({ port: 0, watch: false });
    const port = first.port;
    await first.close();
    assert.equal(first.server.listening, false);

    const second = await startProxy({ port, bind: "127.0.0.1", watch: false });
    try {
      assert.equal(second.port, port);
    } finally {
      await second.close();
    }
  });
});
