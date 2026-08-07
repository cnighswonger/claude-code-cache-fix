import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withDeadline } from "./child-deadline.mjs";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";

// A supervised stop must exit 0 whichever path it takes. server.close() waits
// for in-flight requests, and a live session always has one (the streaming
// /v1/messages response), so the 5s watchdog is the NORMAL exit under systemd.
// It used to exit(1) there, which made `systemctl stop` log status=1/FAILURE —
// a clean stop and a crash became indistinguishable, and Restart=on-failure
// fired on deliberate stops.

function startProxy(extraEnv = {}) {
  const env = { ...process.env, CACHE_FIX_PROXY_PORT: "0", ...extraEnv };
  // An ambient corp proxy would send this test's own requests somewhere real.
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  const proc = spawn(process.execPath, ["proxy/server.mjs"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const port = new Promise((resolve, reject) => {
    let out = "";
    proc.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/listening on [\d.]+:(\d+)/);
      if (m) resolve(parseInt(m[1], 10));
    });
    proc.on("exit", (code) => reject(new Error(`Proxy exited ${code}`)));
    setTimeout(() => reject(new Error("Proxy start timeout")), 5000);
  });
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c.toString()));
  return { proc, port, stderr: () => stderr };
}

function exitOf(proc) {
  // Bounded: this file exists to assert HOW the proxy exits, so a proxy that
  // never exits must fail here rather than hang the whole run.
  return withDeadline(
    new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal }))),
    30_000, proc, "the proxy never exited");
}

describe("SIGTERM exit code", () => {
  // A REQUEST THAT NEVER GOT HEADERS MUST NOT BE ANSWERED "200".
  //
  // The 5s watchdog res.end()s every live response so a client that already
  // received its bytes reads FIN rather than RST. But `liveResponses` is filled
  // at request START, so it also holds requests still blocked upstream — and
  // `res.end()` on a response with no writeHead emits an implicit
  // `HTTP/1.1 200 OK` + `Content-Length: 0`. Measured directly against node:
  // a handler that only calls res.end() puts exactly that on the wire.
  //
  // So a `systemctl stop` during a slow upstream call turned a retryable
  // ECONNRESET into a well-formed empty SUCCESS. A client cannot tell that from
  // a real empty answer, and will not retry.
  it("does not fabricate a 200 for a request that never got headers", async () => {
    // An upstream that accepts and never replies: the proxy is stuck waiting,
    // so the response is live with headersSent false when the watchdog fires.
    // Sockets tracked because close() alone WAITS for them — the proxy's
    // connection never ends, so the first cut of this hung the whole file for
    // 200s in its own cleanup. That was the fixture, not the product.
    const upSockets = [];
    const hung = net.createServer((s) => upSockets.push(s));
    await new Promise((r) => hung.listen(0, "127.0.0.1", r));
    const { proc, port } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${hung.address().port}`,
    });
    try {
      const p = await port;
      let firstLine = null, err = null;
      const c = net.connect(p, "127.0.0.1", () => c.write(
        "POST /v1/messages HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\n" +
        "content-length: 2\r\n\r\n{}"));
      c.on("data", (d) => { firstLine = firstLine ?? String(d).split("\r\n")[0]; });
      c.on("error", (e) => (err = err || e.code));
      // Let the request reach the hung upstream, then stop.
      await new Promise((r) => setTimeout(r, 500));
      const exited = exitOf(proc);
      proc.kill("SIGTERM");
      await exited;
      await new Promise((r) => setTimeout(r, 300));
      c.destroy();

      assert.ok(firstLine === null || !/^HTTP\/1\.[01] 2\d\d/.test(firstLine),
        `the shutdown answered a never-started response with ${JSON.stringify(firstLine)} — ` +
        `an empty 200 is indistinguishable from a real one, so the client keeps it ` +
        `instead of retrying`);
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      for (const s of upSockets) { try { s.destroy(); } catch {} }
      await new Promise((r) => hung.close(r));
    }
  });

  it("exits 0 when nothing is in flight", async () => {
    const { proc, port } = startProxy();
    await port;
    const exited = exitOf(proc);
    proc.kill("SIGTERM");
    const { code } = await exited;
    assert.equal(code, 0, "clean shutdown must exit 0");
  });

  // One shutdown, both questions. A streaming response holds server.close()
  // open, so this takes the same watchdog path a half-sent request does — and
  // unlike that fixture it has a RESPONSE to end, which is what separates FIN
  // from RST. Destroying the laggards makes the kernel answer RST, and a client
  // that had already received every byte reads that as ECONNRESET and discards
  // the delivered data. Merged rather than run twice: the grace is 5 s.
  it("exits 0 via the watchdog, ending an in-flight response with FIN not RST", async () => {
    const upstream = http.createServer((q, r) => {
      r.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const t = setInterval(() => r.write(`data: ${++n}\n\n`), 100);
      r.on("close", () => clearInterval(t));
      q.resume();
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    });
    try {
      const p = await port;
      let chunks = 0, outcome = null;
      const req = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => {
          res.on("data", () => chunks++);
          res.on("end", () => (outcome = outcome || "FIN"));
          res.on("error", (e) => (outcome = outcome || e.code));
        });
      req.on("error", (e) => (outcome = outcome || e.code));
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));

      const flowing = Date.now() + 10_000;
      while (chunks === 0 && Date.now() < flowing) await new Promise((r) => setTimeout(r, 50));
      assert.ok(chunks > 0, "premise: bytes must have reached the client before the shutdown");

      const exited = exitOf(proc);
      const started = Date.now();
      proc.kill("SIGTERM");
      const { code } = await exited;
      const elapsed = Date.now() - started;

      assert.equal(code, 0, "watchdog shutdown must exit 0, not 1");
      assert.ok(elapsed >= 4500, `expected the 5s watchdog path, exited after ${elapsed}ms`);
      assert.match(stderr(), /forcing close/, "the forced path must stay visible on stderr");

      const deadline = Date.now() + 5000;
      while (outcome === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.equal(outcome, "FIN",
        `the forced shutdown reset the connection (${outcome}); a client that ` +
        `already had every byte reads that as ECONNRESET and throws the data away`);
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      await new Promise((r) => upstream.close(r));
    }
  });
});
