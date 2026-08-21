// The operator gate on ctx.meta.upstreamOverride, at the wire level.
//
// proxy-upstream.test.mjs covers forwardRequest's 4th parameter as a unit: given
// an override base, the request lands there. That is the mechanism. THIS file
// covers the decision — handleMessages honours an extension's override only when
// the host set CACHE_FIX_UPSTREAM_OVERRIDE=on — and the mechanism test cannot
// reach it, because it calls forwardRequest directly and so never runs the line
// that consults the gate.
//
// Why the gate exists at all is recorded on config.upstreamOverrideEnabled: the
// redirected request carries the caller's API key in its own bytes, and the
// override target's response is relayed back to Claude Code unmodified, where a
// synthetic tool_use block would be executed with the user's permissions.
//
// One proxy instance, both cases: the config getter reads process.env per call,
// so flipping the variable between requests is what a `systemctl set-environment`
// + reload does to a running proxy, and asserting both directions on ONE instance
// also proves the gate is not merely read once at boot.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../proxy/server.mjs";

function clientRequest(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model: "test", messages: [] });
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST",
        headers: { "content-type": "application/json", ...headers } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

function fakeSseUpstream(onRequest) {
  return http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      onRequest(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"message_start","message":{"model":"claude-opus-4-20250514","usage":{}}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
}

describe("meta.upstreamOverride is gated on CACHE_FIX_UPSTREAM_OVERRIDE", () => {
  let handle, defaultUpstream, overrideUpstream, extDir;
  let defaultHits = 0;
  let overrideHits = 0;
  let overrideUrl = null;

  before(async () => {
    extDir = await mkdtemp(join(tmpdir(), "upstream-override-ext-"));
    await writeFile(join(extDir, "extensions.json"), JSON.stringify({}));
    // Stands in for the extension an operator would write: sets the override on
    // a header it recognises, unconditionally, with no gate of its own. The
    // point of the proxy-side gate is that THIS extension is inert on a host
    // that never opted in.
    await writeFile(
      join(extDir, "override-router.mjs"),
      `export default {
        name: "override-router",
        order: 100,
        onRequest(ctx) {
          const target = ctx.headers["x-override-target"];
          if (target) ctx.meta.upstreamOverride = target;
        },
      };`,
    );

    defaultUpstream = fakeSseUpstream(() => { defaultHits++; });
    overrideUpstream = fakeSseUpstream((req) => { overrideHits++; overrideUrl = req.url; });
    await new Promise((r) => defaultUpstream.listen(0, "127.0.0.1", r));
    await new Promise((r) => overrideUpstream.listen(0, "127.0.0.1", r));

    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${defaultUpstream.address().port}`;
    handle = await startProxy({ port: 0, watch: false, extensionsDir: extDir, extensionsConfig: join(extDir, "extensions.json") });
  });

  after(async () => {
    await handle.close();
    await new Promise((r) => defaultUpstream.close(r));
    await new Promise((r) => overrideUpstream.close(r));
    delete process.env.CACHE_FIX_PROXY_UPSTREAM;
    delete process.env.CACHE_FIX_UPSTREAM_OVERRIDE;
    await rm(extDir, { recursive: true, force: true });
  });

  const target = () => `http://127.0.0.1:${overrideUpstream.address().port}/anthropic`;

  it("gate unset: the extension's override is ignored and the request goes to config.upstream", async () => {
    delete process.env.CACHE_FIX_UPSTREAM_OVERRIDE;
    defaultHits = 0; overrideHits = 0;
    assert.equal(await clientRequest(handle.port, { "x-override-target": target() }), 200);
    assert.equal(overrideHits, 0, "override target must not be contacted with the gate off");
    assert.equal(defaultHits, 1, "the request still goes upstream normally — off means ignored, not rejected");
  });

  it("gate set to a value other than \"on\": still ignored", async () => {
    process.env.CACHE_FIX_UPSTREAM_OVERRIDE = "1";
    defaultHits = 0; overrideHits = 0;
    assert.equal(await clientRequest(handle.port, { "x-override-target": target() }), 200);
    assert.equal(overrideHits, 0, "only the exact string \"on\" enables the seam, per repo gate convention");
    assert.equal(defaultHits, 1);
  });

  it("gate on: the override is honoured and the base path is preserved", async () => {
    process.env.CACHE_FIX_UPSTREAM_OVERRIDE = "on";
    defaultHits = 0; overrideHits = 0; overrideUrl = null;
    assert.equal(await clientRequest(handle.port, { "x-override-target": target() }), 200);
    assert.equal(overrideHits, 1);
    assert.equal(defaultHits, 0, "the two destinations are disjoint");
    assert.equal(overrideUrl, "/anthropic/v1/messages");
  });

  it("gate on but no extension sets the field: config.upstream, unchanged", async () => {
    process.env.CACHE_FIX_UPSTREAM_OVERRIDE = "on";
    defaultHits = 0; overrideHits = 0;
    assert.equal(await clientRequest(handle.port), 200);
    assert.equal(defaultHits, 1);
    assert.equal(overrideHits, 0);
  });
});
