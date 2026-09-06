// Threat-matrix row 31: CC issues one sidecar request TWICE, 6-25 ms apart,
// with distinct upstream request-ids and two completed usage-log records —
// both answered, both charged. The mitigation coalesces the pair into ONE
// upstream call serving both callers.
//
// These bites exercise the predicate AT THE WIRE, through a real proxy
// instance against a real (local) upstream that counts what it received,
// because the defect is a count of upstream calls and nothing below that
// altitude can observe it. The arms MUST DIFFER: an assertion that only
// showed "one call" for the coalescing case would pass equally against a
// build that coalesced everything, which is the over-reach this predicate
// exists to prevent — so the mid-session arm asserting TWO calls is the
// discriminating half, not decoration.

import { tmpDir } from "../tools/tmpdir.mjs";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rm } from "node:fs/promises";
import {
  startProxy, coalesceCandidate, coalesceIdentity, createFanOut,
  inFlightSidecarCount, COALESCE_SWEEP_AFTER_MS,
} from "../proxy/server.mjs";

// Two callers the UPSTREAM can tell apart. Synthetic by construction — the
// point is only that the two strings differ, so nothing here needs to look
// like a real credential.
const TENANT_A = { "x-api-key": "tenant-a-credential" };
const TENANT_B = { "x-api-key": "tenant-b-credential" };

function clientRequest(port, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json", ...extraHeaders },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

// A caller whose hang-up we choose the moment of. `clientRequest` above reads
// to the end, which never reaches the abort guard — the guard only fires on a
// response that closes UNANSWERED, so producing that state deliberately is the
// only way to exercise it.
function openAndHangUpOnCommand(port, body) {
  let hangUp;
  const done = new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve("ended"));
      },
    );
    // BOTH, and "close" is the one that fires: `req.destroy()` with no error
    // argument emits no "error" at all, so an error-only settle leaves this
    // promise pending forever and the case times out instead of asserting.
    req.on("error", () => resolve("hung-up"));
    req.on("close", () => resolve("hung-up"));
    hangUp = () => req.destroy();
    req.end(JSON.stringify(body));
  });
  return { done, hangUp: () => hangUp() };
}

// Holds the response open long enough that a duplicate arriving inside the
// 50 ms window finds the first still IN FLIGHT — condition 4. Without the
// hold the first call would complete before the second arrived and the
// coalescing arm would pass for the wrong reason.
function slowSseUpstream(counter, holdMs = 120) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      counter.calls += 1;
      counter.bodies.push(Buffer.concat(chunks).toString());
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"message_start","message":{"model":"claude-haiku-4-5","usage":{}}}\n\n');
      setTimeout(() => {
        res.write('data: {"type":"message_stop"}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      }, holdMs);
    });
  });
}

const SIDECAR = {
  model: "claude-haiku-4-5",
  max_tokens: 32000,
  stream: true,
  messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(337) }] }],
};

const MID_SESSION = {
  ...SIDECAR,
  messages: [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: [{ type: "text", text: "second" }] },
  ],
};

describe("row 31 — the structural half of the predicate (conditions 1 and 2)", () => {
  it("accepts a single-message request carrying no tools", () => {
    assert.equal(coalesceCandidate(SIDECAR), true);
  });

  it("REJECTS a mid-session request — nMsg alone is the discriminator the row asked for", () => {
    assert.equal(coalesceCandidate(MID_SESSION), false);
  });

  it("REJECTS a single-message request that carries tools", () => {
    assert.equal(coalesceCandidate({ ...SIDECAR, tools: [{ name: "Bash" }] }), false);
  });

  it("treats an EMPTY tools array as no tools — the measured request carried 0", () => {
    assert.equal(coalesceCandidate({ ...SIDECAR, tools: [] }), true);
  });

  it("rejects a body with no messages array at all", () => {
    assert.equal(coalesceCandidate({ model: "x" }), false);
    assert.equal(coalesceCandidate(null), false);
  });
});

describe("row 31 — the key separates CALLERS, not only bytes", () => {
  // The shared-proxy leak the coalescing key has to close: the session-start
  // sidecar has a FIXED shape, so two different users' sends are byte-
  // identical. A body-only key lets one user's in-flight call answer the
  // other's request — leader's account billed for both, leader's 401
  // propagated to a follower holding valid credentials, leader's plan-tier
  // context in bytes the follower reads.

  it("different credentials produce different identities", () => {
    assert.notEqual(coalesceIdentity(TENANT_A), coalesceIdentity(TENANT_B));
  });

  it("the same credential produces the same identity — coalescing must still happen", () => {
    assert.equal(coalesceIdentity({ ...TENANT_A }), coalesceIdentity({ ...TENANT_A }));
  });

  it("separates on `authorization` too, not just `x-api-key`", () => {
    assert.notEqual(
      coalesceIdentity({ authorization: "Bearer aaa" }),
      coalesceIdentity({ authorization: "Bearer bbb" }),
    );
  });

  it("keys on the LOWERCASED header name — an extension may have added its own casing", () => {
    // Node lowercases what arrives on the wire, but `reqCtx.headers` is
    // handed to extensions to mutate, and an extension setting `X-Api-Key`
    // must not read as a different caller from one setting `x-api-key`.
    assert.equal(coalesceIdentity({ "X-Api-Key": "same" }), coalesceIdentity({ "x-api-key": "same" }));
  });

  it("ignores headers that carry no caller identity", () => {
    assert.equal(
      coalesceIdentity({ ...TENANT_A, "content-type": "application/json" }),
      coalesceIdentity({ ...TENANT_A, "content-type": "text/plain", "x-request-id": "abc" }),
    );
  });

  it("is a CONSTANT when the request carries no credential at all", () => {
    // Deliberate, not a hole. A caller presenting no credential has no
    // per-caller billing identity to leak: every such request is answered
    // under whatever single credential the deployment supplies, or 401s
    // alike. The leak the key closes is between callers the upstream can
    // tell apart.
    assert.equal(coalesceIdentity({}), coalesceIdentity({ "content-type": "application/json" }));
  });

  it("never carries the credential itself — the identity is a digest", () => {
    // The key's first 16 chars are written to the debug log. A key built by
    // concatenating the raw credential would put it on disk, which is what
    // SENSITIVE_HEADERS exists upstream of this to prevent.
    assert.doesNotMatch(coalesceIdentity(TENANT_A), /tenant-a-credential/);
    assert.match(coalesceIdentity(TENANT_A), /^[0-9a-f]{64}$/);
  });
});

describe("row 31 — the fan-out writable serves every attached caller", () => {
  function fakeRes() {
    return {
      writableEnded: false, destroyed: false, writableNeedDrain: false,
      head: null, chunks: [], ended: false,
      writeHead(status, headers) { this.head = { status, headers }; },
      write(c) { this.chunks.push(String(c)); return true; },
      end(c) { if (c !== undefined) this.chunks.push(String(c)); this.ended = true; this.writableEnded = true; },
      destroy() { this.destroyed = true; },
      once() {},
    };
  }

  it("a follower attaching MID-STREAM receives the chunks already written", () => {
    const leader = fakeRes();
    const fan = createFanOut(leader);
    fan.writeHead(200, { "content-type": "text/event-stream" });
    fan.write("data: one\n\n");

    const follower = fakeRes();
    assert.equal(fan.attach(follower), true);

    fan.write("data: two\n\n");
    fan.end();

    assert.deepEqual(leader.chunks, ["data: one\n\n", "data: two\n\n"]);
    assert.deepEqual(follower.chunks, ["data: one\n\n", "data: two\n\n"],
      "the follower must receive the whole response, not only what came after it attached");
    assert.deepEqual(follower.head, { status: 200, headers: { "content-type": "text/event-stream" } });
    assert.equal(follower.ended, true);
  });

  it("a follower attaching AFTER the response ended is served in full and reports not-joined", () => {
    const leader = fakeRes();
    const fan = createFanOut(leader);
    fan.writeHead(200, {});
    fan.write("data: one\n\n");
    fan.end();

    const late = fakeRes();
    assert.equal(fan.attach(late), false, "a late follower must not be added to the live set");
    assert.deepEqual(late.chunks, ["data: one\n\n"]);
    assert.equal(late.ended, true, "it is still owed a complete response");
  });

  it("a leader whose own client hung up keeps writing to its followers", () => {
    const leader = fakeRes();
    const fan = createFanOut(leader);
    fan.writeHead(200, {});
    const follower = fakeRes();
    fan.attach(follower);

    leader.destroyed = true; // the leader's client goes away mid-stream
    fan.write("data: after\n\n");

    assert.equal(fan.writableEnded, false, "someone is still listening");
    assert.deepEqual(follower.chunks, ["data: after\n\n"]);
    assert.deepEqual(leader.chunks, [], "nothing is written to a dead socket");
  });
});

describe("row 31 at the wire — the upstream call COUNT is the defect", () => {
  let handle, upstream, counter, extDir;

  before(async () => {
    extDir = await tmpDir("coalesce-ext-");
    counter = { calls: 0, bodies: [] };
    upstream = slowSseUpstream(counter);
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    process.env.CACHE_FIX_COALESCE_SIDECAR = "1";
    handle = await startProxy({ port: 0, watch: false, extensionsDir: extDir });
  });

  after(async () => {
    await handle.close();
    await new Promise((r) => upstream.close(r));
    delete process.env.CACHE_FIX_PROXY_UPSTREAM;
    delete process.env.CACHE_FIX_COALESCE_SIDECAR;
    await rm(extDir, { recursive: true, force: true });
  });

  it("all four conditions: ONE upstream call, BOTH callers answered", async () => {
    counter.calls = 0;
    const a = clientRequest(handle.port, SIDECAR);
    await new Promise((r) => setTimeout(r, 15)); // inside the 50 ms window
    const b = clientRequest(handle.port, SIDECAR);
    const [ra, rb] = await Promise.all([a, b]);

    assert.equal(counter.calls, 1, "the duplicate must not reach upstream");
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    assert.equal(ra.body, rb.body, "both callers receive byte-identical output");
    assert.ok(ra.body.includes("message_stop"), "and it is the COMPLETE response, not a truncated replay");
  });

  it("the leader's client hangs up mid-stream: the FOLLOWER is still served in full", async () => {
    // THE ABORT GUARD'S POLARITY, and nothing else in this file reaches it.
    // On the plain path "this response closed without being answered" means
    // nobody is left to serve, so freeing the upstream call is right. Under
    // coalescing it stops meaning that: the leader's fan-out is carrying a
    // follower, and aborting cuts the call THAT caller is waiting on.
    //
    // Order matters here and the first cut had it wrong: hanging up before
    // the follower arrives removes the leader from the map, the pair never
    // coalesces, and the arm passes for the wrong reason. The premise
    // assertion below is what pins that.
    //
    // Measured both ways before this landed. Against the naive guard
    // (`if (!sink.writableEnded) abortController.abort()`) this case goes red
    // and the other fifteen stay green; against the guard as written all
    // sixteen pass. The red is a TIMEOUT rather than a truncated body, which
    // is the more useful fact: aborting the upstream call leaves the fan-out
    // with nothing to end, so the follower is not cut short — it hangs until
    // its own timeout, holding a live session open on a request that will
    // never answer.
    counter.calls = 0;
    const leader = openAndHangUpOnCommand(handle.port, SIDECAR);
    await new Promise((r) => setTimeout(r, 15));   // inside the 50 ms window
    const follower = clientRequest(handle.port, SIDECAR);
    await new Promise((r) => setTimeout(r, 20));   // follower attached; upstream still holding
    leader.hangUp();
    await leader.done;
    const rb = await follower;

    assert.equal(counter.calls, 1,
      "premise: the pair did not coalesce, so there was no follower on the leader's call and this arm tests nothing");
    assert.equal(rb.status, 200);
    assert.ok(rb.body.includes("message_stop"),
      `the follower was cut off when the LEADER's client left: ${JSON.stringify(rb.body)}`);
  });

  it("TWO TENANTS, byte-identical sidecars inside the window: TWO upstream calls", async () => {
    // The shared-proxy arm. Every one of the four conditions holds and the
    // pair must STILL not coalesce, because the callers are different.
    counter.calls = 0;
    const a = clientRequest(handle.port, SIDECAR, TENANT_A);
    await new Promise((r) => setTimeout(r, 15)); // inside the 50 ms window
    const b = clientRequest(handle.port, SIDECAR, TENANT_B);
    await Promise.all([a, b]);

    assert.equal(counter.calls, 2,
      "one tenant's in-flight call must never answer another tenant's request");
  });

  it("ONE tenant's duplicate still coalesces: ONE upstream call", async () => {
    // The other half of the pair, and it is not decoration: the arm above
    // passes equally against a build that stopped coalescing altogether, or
    // one whose key picked up something per-request. This is what pins that
    // the identity is per-CALLER and not per-REQUEST.
    counter.calls = 0;
    const a = clientRequest(handle.port, SIDECAR, TENANT_A);
    await new Promise((r) => setTimeout(r, 15));
    const b = clientRequest(handle.port, SIDECAR, TENANT_A);
    const [ra, rb] = await Promise.all([a, b]);

    assert.equal(counter.calls, 1, "the same caller's duplicate is exactly what row 31 coalesces");
    assert.equal(ra.body, rb.body);
  });

  it("mid-session pair (nMsg > 1): TWO upstream calls, unchanged", async () => {
    counter.calls = 0;
    const a = clientRequest(handle.port, MID_SESSION);
    await new Promise((r) => setTimeout(r, 15));
    const b = clientRequest(handle.port, MID_SESSION);
    await Promise.all([a, b]);

    assert.equal(counter.calls, 2,
      "a mid-session duplicate is a legitimate retry — suppressing it would leave a real request unanswered");
  });

  it("three of four conditions (tools present): TWO upstream calls", async () => {
    counter.calls = 0;
    const withTools = { ...SIDECAR, tools: [{ name: "Bash", input_schema: {} }] };
    const a = clientRequest(handle.port, withTools);
    await new Promise((r) => setTimeout(r, 15));
    const b = clientRequest(handle.port, withTools);
    await Promise.all([a, b]);

    assert.equal(counter.calls, 2, "failing any one condition must not coalesce");
  });

  it("three of four conditions (still in flight, but PAST the 50 ms window): TWO upstream calls", async () => {
    // The second send must arrive while the first is STILL IN FLIGHT (the
    // upstream holds 120 ms) but outside the window, or this arm proves
    // nothing about condition 4. The first version awaited both requests
    // sequentially, so the leader had already left the map and the window
    // check was never reached — disabling the window left it green, which
    // is how the gap was found.
    counter.calls = 0;
    const a = clientRequest(handle.port, SIDECAR);
    await new Promise((r) => setTimeout(r, 80));
    const b = clientRequest(handle.port, SIDECAR);
    await Promise.all([a, b]);

    assert.equal(counter.calls, 2, "past the window the pair is not a duplicate send");
  });

  it("a sequential repeat (first already completed) is not coalesced", async () => {
    counter.calls = 0;
    await clientRequest(handle.port, SIDECAR);
    await clientRequest(handle.port, SIDECAR);

    assert.equal(counter.calls, 2, "the leader must not outlive its own request");
  });

  it("differing bodies inside the window: TWO upstream calls", async () => {
    counter.calls = 0;
    const a = clientRequest(handle.port, SIDECAR);
    await new Promise((r) => setTimeout(r, 15));
    const b = clientRequest(handle.port, { ...SIDECAR, max_tokens: 16000 });
    await Promise.all([a, b]);

    // What this establishes, stated precisely because the first version of
    // this arm claimed more: differing forwarded bytes produce a different
    // KEY, so the pair never meets. It does not exercise a separate
    // byte-compare, and the mutation proof is what showed that — disabling
    // one left this arm green.
    assert.equal(counter.calls, 2, "differing forwarded bytes never share a coalescing key");
  });
});

describe("row 31 — the in-flight map is BOUNDED, not trusting `close`", () => {
  // Entries normally leave on their leader's `close`. A client that hangs
  // without closing its socket, against an upstream that never answers,
  // leaves one behind for as long as both hold — so the bound cannot rest on
  // that event. This arm builds exactly that state: an upstream that accepts
  // the request and never responds, and a client that never hangs up.
  const HANG = "HANG-FOREVER";
  let handle, upstream, held, extDir;

  before(async () => {
    extDir = await tmpDir("coalesce-bound-ext-");
    held = [];
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (Buffer.concat(chunks).toString().includes(HANG)) { held.push(res); return; }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"message_stop"}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    process.env.CACHE_FIX_COALESCE_SIDECAR = "1";
    handle = await startProxy({ port: 0, watch: false, extensionsDir: extDir });
  });

  after(async () => {
    for (const r of held) { try { r.destroy(); } catch {} }
    await handle.close();
    await new Promise((r) => upstream.close(r));
    delete process.env.CACHE_FIX_PROXY_UPSTREAM;
    delete process.env.CACHE_FIX_COALESCE_SIDECAR;
    await rm(extDir, { recursive: true, force: true });
  });

  it("a stale leader whose client never closes is swept by the next insert", async () => {
    const stuckBody = { ...SIDECAR, messages: [{ role: "user", content: [{ type: "text", text: HANG }] }] };
    const stuck = http.request(
      { hostname: "127.0.0.1", port: handle.port, path: "/v1/messages", method: "POST",
        headers: { "content-type": "application/json" } },
      (res) => res.on("data", () => {}),
    );
    stuck.on("error", () => {});
    stuck.end(JSON.stringify(stuckBody));

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(inFlightSidecarCount(), 1,
      "premise: the stuck leader never entered the map, so this arm tests nothing");

    await new Promise((r) => setTimeout(r, COALESCE_SWEEP_AFTER_MS + 20));
    assert.equal(inFlightSidecarCount(), 1,
      "premise: nothing sweeps on a timer — the entry survives until an insert, which is what the next line exercises");

    // A DIFFERENT body, so it takes its own key and does not coalesce with
    // the stuck one. Its insert is what runs the sweep.
    await clientRequest(handle.port, { ...SIDECAR, max_tokens: 16000 });
    await new Promise((r) => setTimeout(r, 20)); // let the second leader's own close land

    assert.equal(inFlightSidecarCount(), 0,
      "the stale leader outlived the window it could be hit in — the map grows with process lifetime");

    stuck.destroy();
  });
});

describe("row 31 — the gate is OFF by default", () => {
  let handle, upstream, counter, extDir;

  before(async () => {
    extDir = await tmpDir("coalesce-off-ext-");
    counter = { calls: 0, bodies: [] };
    upstream = slowSseUpstream(counter);
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    delete process.env.CACHE_FIX_COALESCE_SIDECAR;
    handle = await startProxy({ port: 0, watch: false, extensionsDir: extDir });
  });

  after(async () => {
    await handle.close();
    await new Promise((r) => upstream.close(r));
    delete process.env.CACHE_FIX_PROXY_UPSTREAM;
    await rm(extDir, { recursive: true, force: true });
  });

  it("without the gate the duplicate still reaches upstream — the pre-fix behaviour, pinned", async () => {
    counter.calls = 0;
    const a = clientRequest(handle.port, SIDECAR);
    await new Promise((r) => setTimeout(r, 15));
    const b = clientRequest(handle.port, SIDECAR);
    await Promise.all([a, b]);

    assert.equal(counter.calls, 2,
      "this is the RED baseline: the same input under the shipped-but-disabled build double-bills");
  });
});
