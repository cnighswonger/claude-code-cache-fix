// With extensions loaded, handleMessages and handleBootstrap re-serialise the
// upstream JSON body (JSON.stringify(resCtx.body)) but used to keep upstream's
// content-length. A pretty-printed upstream body is then shorter on the wire
// than its declared length (the client waits for bytes that never come), a
// body whose re-serialisation grows (1e21 -> 1e+21) is longer (client parse
// error). Every other fixture answers chunked, which is why nothing caught it.
// A mock upstream with an explicit content-length is what exposes it.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../proxy/server.mjs";

const PRETTY = JSON.stringify({ type: "message", content: [{ type: "text", text: "héllo" }] }, null, 2);
const GROWS = '{"n":1e21}';

let handle, upstream, extDir, upstreamStatus, upstreamBody;

function clientRequest(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: handle.port, path, method: "POST", agent: false,
        headers: { "content-type": "application/json" } },
      (res) => {
        const chunks = [];
        res.on("error", reject);
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(2000, () => req.destroy(new Error("client timed out waiting for the declared content-length")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("proxy server re-serialised JSON body carries its own content-length", () => {
  before(async () => {
    extDir = await mkdtemp(join(tmpdir(), "content-length-ext-"));
    await writeFile(join(extDir, "extensions.json"), "{}");
    // Any loaded extension routes the response through the re-serialising branch.
    await writeFile(join(extDir, "noop.mjs"), `export default { name: "noop", onResponse() {} };`);

    upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(upstreamStatus, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(upstreamBody),
        });
        res.end(upstreamBody);
      });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    handle = await startProxy({ port: 0, watch: false, extensionsDir: extDir, extensionsConfig: join(extDir, "extensions.json") });
  });

  after(async () => {
    await handle.close();
    await new Promise((r) => upstream.close(r));
    delete process.env.CACHE_FIX_PROXY_UPSTREAM;
    await rm(extDir, { recursive: true, force: true });
  });

  for (const [name, path, status, body, reqBody] of [
    ["/v1/messages 200, pretty-printed upstream", "/v1/messages", 200, PRETTY, { model: "test", messages: [] }],
    ["/v1/messages 429, pretty-printed upstream", "/v1/messages", 429, PRETTY, { model: "test", messages: [] }],
    ["/v1/messages 200, re-serialisation grows the body", "/v1/messages", 200, GROWS, { model: "test", messages: [] }],
    ["bootstrap 200, pretty-printed upstream", "/api/claude_cli/bootstrap", 200, PRETTY, { version: "2.1.150" }],
    ["bootstrap 200, re-serialisation grows the body", "/api/claude_cli/bootstrap", 200, GROWS, { version: "2.1.150" }],
  ]) {
    it(`${name}: client body parses and matches content-length`, async () => {
      upstreamStatus = status;
      upstreamBody = body;
      const res = await clientRequest(path, reqBody);
      assert.equal(res.status, status);
      assert.deepEqual(JSON.parse(res.body.toString()), JSON.parse(body));
      assert.equal(Number(res.headers["content-length"]), res.body.length);
    });
  }
});
