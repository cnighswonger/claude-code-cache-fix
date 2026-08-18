import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withDeadline } from "./child-deadline.mjs";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { forcedCloseLine } from "../proxy/server.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "proxy", "server.mjs");

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

// Same, plus a real fd 3 that is NOT a servable socket, and the LISTEN_FDS
// claim that makes the proxy try to serve it. `inheritedFd()` returns 3 when
// LISTEN_FDS >= 1 and LISTEN_PID is unset or names us, so a plain pipe on fd 3
// reproduces the handover-refused path exactly.
function startProxyWithBadFd3(extraEnv = {}) {
  const env = { ...process.env, CACHE_FIX_PROXY_PORT: "0", LISTEN_FDS: "1", ...extraEnv };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  // Unset, or the proxy skips the whole path and there is nothing to test.
  delete env.LISTEN_PID;
  // CLEARED, because a live holder suppresses the successor spawn on its own
  // (`heldByLiveHolder`) and would hide the defect rather than fix it.
  delete env.CACHE_FIX_HELD_BY;
  // ITS OWN PROCESS GROUP, so the cleanup can reap what it spawns. On the
  // unfixed code SIGTERM hands fd 3 to a SUCCESSOR with stdio "inherit" — that
  // successor keeps our pipes open, is reparented to init when we exit, and the
  // test runner then waits on streams that never close. Measured: two orphaned
  // servers survived the run and hung `node --test` indefinitely. Killing the
  // group makes the leak this test exists to detect collectable.
  const proc = spawn(process.execPath, ["proxy/server.mjs"], {
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  let out = "";
  let stderr = "";
  proc.stdout.on("data", (c) => (out += c.toString()));
  proc.stderr.on("data", (c) => (stderr += c.toString()));
  const port = new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      const m = out.match(/listening on [\d.]+:(\d+)/);
      if (m) { clearInterval(tick); resolve(parseInt(m[1], 10)); }
    }, 25);
    proc.on("exit", (code) => { clearInterval(tick); reject(new Error(`Proxy exited ${code}`)); });
    setTimeout(() => { clearInterval(tick); reject(new Error("Proxy start timeout")); }, 8000);
  });
  return { proc, port, stdout: () => out, stderr: () => stderr };
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
    const { proc, port, stderr } = startProxy({
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

      // AND THAT THE COUNT SAW IT. This is the only fixture that drives the
      // destroy arm — headers never sent, because upstream never answered — so
      // without this assertion `destroyed++` is untested end to end. Measured:
      // deleting `destroyed++`, and folding the destroy branch into `ended`,
      // both left the suite green before this line existed.
      assert.match(stderr(), /cut 1 in-flight request\(s\) after 5s \(0 mid-response, 1 before headers\)/,
        `the forced close miscounted the never-answered request; stderr was:\n${stderr()}`);

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

  // A DEPARTING PROXY MUST STOP TAKING NEW WORK, NOT JUST NEW CONNECTIONS.
  //
  // server.close() unbinds the listener, so nothing NEW can connect — but a
  // client already holding a keep-alive goes on sending requests down it, and we
  // go on answering them. From the client's side nothing is wrong with the
  // socket, so it never reconnects, so it never reaches the successor that is
  // already serving on the inherited fd. The peer daemon measured the same shape
  // from the other side: eleven of twelve sessions held a stream to a process
  // that had stopped being the front door and was still answering the mail.
  //
  // `Connection: close` on the responses we complete during the drain is the
  // HTTP-native answer and it needs no constant: the in-flight reply finishes
  // normally, the client then opens a fresh connection, and that lands on the
  // successor. Sessions migrate one completed reply at a time.
  //
  // Driven on a RAW socket, because an http.Agent hides exactly the thing under
  // test — it would open a second connection and the assertion would pass
  // against a proxy that never sent the header.
  //
  // AND THE CONNECTION MUST BE BUSY WHEN THE DRAIN STARTS. An IDLE keep-alive is
  // closed by node itself at server.close(), so a fixture that signals between
  // requests measures nothing — its socket is simply gone and the second request
  // gets no answer at all. Measured on 18.20.8 / 20.20.2 / 24.11.1 with a
  // request in flight across close():
  //     after r1, socket destroyed = false
  //     r1 headers  ... Connection: keep-alive
  //     r2 answer   HTTP/1.1 200 OK ... Connection: keep-
  //     requests served after close(): 1
  // So the exposure is exactly the busy connection, on every supported major.
  it("tells a keep-alive client to close once it is draining", async () => {
    // A slow upstream, so request 1 is still in flight when SIGTERM lands.
    const slow = http.createServer((_q, r) => {
      setTimeout(() => { r.writeHead(200, { "content-length": "2" }); r.end("ok"); }, 900);
    });
    await new Promise((r) => slow.listen(0, "127.0.0.1", r));
    const { proc, port } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${slow.address().port}`,
    });
    const p = await port;
    const sock = net.connect(p, "127.0.0.1");
    // The 5s force-close RSTs this socket, and an unhandled 'error' on a
    // net.Socket takes the whole runner down rather than failing this case.
    sock.on("error", () => {});
    await new Promise((r) => sock.once("connect", r));
    // Sends, and returns the reply headers. `path` picks the route: /health is
    // instant, anything else is relayed to the slow upstream above.
    const ask = (path) => new Promise((resolve) => {
      let buf = "";
      const onData = (d) => {
        buf += d.toString();
        if (buf.includes("\r\n\r\n")) { sock.off("data", onData); resolve(buf); }
      };
      sock.on("data", onData);
      sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`);
      setTimeout(() => { sock.off("data", onData); resolve(buf); }, 4000);
    });
    try {
      // PREMISE: while healthy we keep the connection, or the assertion below
      // would pass against a proxy that closes every connection always.
      const before = await ask("/health");
      assert.match(before, /^HTTP\/1\.1 200/, `healthy /health did not answer 200: ${before.slice(0, 80)}`);
      assert.ok(!/^connection:\s*close/im.test(before),
        "a HEALTHY proxy already asks the client to close — then the drain header " +
        "proves nothing and every request pays a new connection");

      // A RELAYED POST, not a GET on a made-up path: /v1/slow is a 404 the proxy
      // answers instantly, so the connection would be idle again when the signal
      // lands and node would close it for us — the fixture would then measure
      // node, not us. Measured that way first, and it is why this is a POST.
      const body = JSON.stringify({ model: "claude-3", messages: [{ role: "user", content: "x" }] });
      const inflight = new Promise((resolve) => {
        let buf = "";
        const onData = (d) => {
          buf += d.toString();
          if (buf.includes("\r\n\r\n")) { sock.off("data", onData); resolve(buf); }
        };
        sock.on("data", onData);
        sock.write(`POST /v1/messages HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\n`
                 + `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        setTimeout(() => { sock.off("data", onData); resolve(buf); }, 6000);
      });
      await new Promise((r) => setTimeout(r, 250));
      proc.kill("SIGTERM");
      const midflight = await inflight;                // completes normally
      assert.match(midflight, /^HTTP\/1\.1 200/,
        `premise: the in-flight reply must FINISH, not be cut: ${midflight.slice(0, 60)}`);
      const after = await ask("/health");
      assert.match(after, /^HTTP\/1\.1 \d\d\d/,
        `the draining proxy answered nothing on the held keep-alive: ${JSON.stringify(after.slice(0, 80))}`);
      assert.match(after, /^connection:\s*close/im,
        "a draining proxy served a new request on a held keep-alive and told the " +
        "client to keep it — so that client never reconnects and never reaches the " +
        "successor already serving on the inherited fd");
    } finally {
      sock.destroy();
      try { proc.kill("SIGKILL"); } catch {}
      await new Promise((r) => slow.close(r));
    }
  });

  it("exits 0 when nothing is in flight, and says how long the drain took", async () => {
    const { proc, port, stderr } = startProxy();
    await port;
    const exited = exitOf(proc);
    proc.kill("SIGTERM");
    const { code } = await exited;
    assert.equal(code, 0, "clean shutdown must exit 0");

    // MEASURE THE PATIENCE THAT WAS ENOUGH, not only the patience that ran out.
    // 6d6f01d set an 1800s handover budget and gave nobody a way to see how
    // close a real drain comes to it: the forced-close line fires only when the
    // budget is SPENT, so it reports what was still open when we gave up and
    // never how long a drain that FINISHED actually needed. Those are the
    // numbers a future ceiling has to be chosen from.
    //
    // Folded into this case rather than given its own, because it needs exactly
    // what this one already builds — a spawned proxy, SIGTERM, clean exit — and
    // a second spawn is pure load. node:test runs FILES concurrently and CI
    // runners have two cores; an extra proxy here reddens a readiness assertion
    // somewhere else in the run.
    //
    // A SUPERVISED STOP, so the budget named must be 5s: printing the 1800s
    // handover budget here would misreport the path as badly as the old
    // hardcoded "after 5s" misreported a handover.
    assert.match(stderr(), /\[cache-fix\] shutdown: drained clean in \d+\.\d+s of 5s budget/,
      `no clean-drain measurement on the supervised path: ${JSON.stringify(stderr().slice(-200))}`);
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
      // AND SAY HOW MANY IT CUT. "forcing close" alone carries no number, so a
      // recycle that ended a live /v1/messages stream and one that merely
      // outwaited an idle socket print the same string. This fixture has
      // exactly one streaming response open, so the count is knowable: 1, and
      // it is mid-response because bytes already reached the client above.
      assert.match(stderr(), /cut 1 in-flight request\(s\)/,
        `the forced close did not report what it cut; stderr was:\n${stderr()}`);
      assert.match(stderr(), /1 mid-response/,
        "a response that had already sent bytes must be counted as mid-response");

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

  // A REFUSED HANDOVER MUST NOT STILL CLAIM THE SOCKET.
  //
  // `inheritedSocket` decides `askForSuccessor`, which decides whether we exit
  // 75 ("a successor is on the socket, do nothing") and hand fd 3 down to a
  // child. It was computed from `listenFd`, which records that handover was
  // ATTEMPTED — and the fallback at the listen site does not clear it. So a
  // proxy that was refused fd 3 and bound a port of its own still advertised
  // inheritedSocket:true.
  //
  // What that costs: on SIGTERM we spawn a successor pointed at the SAME
  // unservable fd 3, announce "(handed off)", and exit 75. The supervisor reads
  // 75 as covered and skips reclaim; the port we actually served is released
  // with nobody on it, while the child re-falls-back onto a different port. The
  // failure shape this whole branch exists to prevent, produced by the branch
  // itself.
  //
  // Reproduced on the PR head before the fix: LISTEN_FDS=1 with an unservable
  // fd 3 logged "socket handover refused (EINVAL); binding 127.0.0.1:0 instead"
  // and still returned {"inheritedSocket":true}.
  //
  // Both product assertions below fail on the unfixed code, for that reason.
  it("does not hand down a socket it was refused", async () => {
    const { proc, port, stdout, stderr } = startProxyWithBadFd3();
    try {
      const p = await port;

      // PREMISE, not product: without these the test would pass on a proxy that
      // never took the fallback path at all, which is the one way this could
      // certify nothing.
      assert.match(stderr(), /socket handover refused/,
        "premise: the fd-3 listen must have been refused, or nothing here is exercised");
      assert.ok(p > 0, "premise: it must have bound a port of its own");

      const exited = exitOf(proc);
      proc.kill("SIGTERM");
      const { code } = await exited;

      assert.equal(code, 0,
        `exited ${code}: 75 tells the supervisor a successor holds the socket, but the ` +
        `handover was REFUSED — the port it served is released with nobody on it`);
      const listens = (stdout().match(/proxy listening on/g) || []).length;
      assert.equal(listens, 1,
        `${listens} "proxy listening on" lines: a successor was spawned onto the same ` +
        `unservable fd 3 (a successor inherits our stdout, which is how it shows up here)`);
      // STDOUT, and the first cut of this read stderr — where the string never
      // appears, so the assertion could not fail on the fixed code, the unfixed
      // code, or any future regression. server.mjs writes it with
      // say(process.stdout, ...), and the holder parses that same stdout line to
      // decide whether a successor is already serving.
      assert.doesNotMatch(stdout(), /\(handed off\)/,
        "announced a handoff of a socket it never had — the holder reads this " +
        "exact line as 'a successor is on the socket' and skips its own recovery");
    } finally {
      // The GROUP, not the pid: on the unfixed code the successor outlives its
      // parent and is reparented to init, so killing `proc` alone leaves it
      // holding these pipes for the rest of the run.
      try { process.kill(-proc.pid, "SIGKILL"); } catch {}
      try { proc.kill("SIGKILL"); } catch {}
      for (const s of [proc.stdout, proc.stderr]) { try { s.destroy(); } catch {} }
    }
  });

  // THE 5s TIMER CAN FIRE WITH NOTHING IN FLIGHT, and it must not then claim it
  // cut something. On Node 18 an IDLE keep-alive socket keeps server.close()
  // unresolved, so the watchdog fires having cut nothing — the per-version table
  // lives beside the code, in proxy/server.mjs forcedCloseLine(). One string for
  // both cases is a string whose MEANING changes with the interpreter. Unit
  // rather than a spawn precisely because the branch is unreachable on the Node
  // this suite usually runs.
  // THE HELD COUNT MUST COME FROM THE SERVER, not from anything that agrees with
  // liveResponses. The unit case above proves the WORDING; only a live tunnel
  // proves the WIRING, and without this `finish(err ? null : n)` -> `finish(0)`
  // passed 5/5 while printing "0 connection(s) still held" with a tunnel open —
  // the one reading the code comment says must never appear.
  //
  // Forward mode, because that is the mode that has tunnels: attachForwardProxy
  // binds `connect` to the same server the watchdog closes, so a blind-tunnelled
  // CONNECT holds close() open while contributing nothing to liveResponses.
  it("reports connections it still held when it cut no responses", async () => {
    const target = net.createServer((s) => s.on("data", () => {}));
    await new Promise((r) => target.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({ CACHE_FIX_FORWARD_PROXY: "on" });
    try {
      const p = await port;
      const c = net.connect(p, "127.0.0.1", () => c.write(
        `CONNECT 127.0.0.1:${target.address().port} HTTP/1.1\r\nHost: x\r\n\r\n`));
      const established = await new Promise((resolve) => {
        c.once("data", (d) => resolve(String(d).split("\r\n")[0]));
        c.once("error", () => resolve(null));
      });
      assert.match(established ?? "", /^HTTP\/1\.[01] 200/,
        `premise: the tunnel must be up before the stop, got ${JSON.stringify(established)}`);

      const exited = exitOf(proc);
      const started = Date.now();
      proc.kill("SIGTERM");
      const { code } = await exited;
      const elapsed = Date.now() - started;

      assert.ok(elapsed >= 4500, `expected the 5s watchdog path, exited after ${elapsed}ms`);
      assert.equal(code, 0, "the watchdog must still exit 0 on this path");
      // No RESPONSE was open, so the cut count is zero and the held count is
      // what carries the information. A hardcoded or liveResponses-derived
      // number reads 0 here.
      assert.match(stderr(), /cut no responses, [1-9]\d* connection\(s\) still held/,
        `the held count did not come from the server; stderr was:\n${stderr()}`);
      c.destroy();
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      await new Promise((r) => target.close(r));
    }
  });

  // THE 5s IS AN OUTAGE BUDGET, AND A HANDOVER IS NOT AN OUTAGE.
  //
  // A supervised stop is SERIAL — stop, wait for exit, start — so a longer grace
  // there extends a real outage; at 120s against DefaultTimeoutStopSec=90s the
  // stop was SIGKILLed and restart downtime went 5.0s -> 53.9s. That reasoning
  // is sound and this case keeps it.
  //
  // On the handedOff path nothing waits: the successor was spawned detached with
  // fd 3 and is serving, and the holder reads "(handed off)" as "do nothing".
  // The same 5s applied there cut real replies on every deploy — measured on
  // <linux-host>, cut 4 / 14 / 17 / 14 / 16, every one 100% mid-response.
  //
  // LIFTED AND EVALUATED, not grepped: the whole point is which VALUE comes out
  // for which arm, and a grep for "handedOff" passes on the comment above it.
  it("spends the 5s outage budget only where something waits on our exit", () => {
    const src = readFileSync(serverPath, "utf8");
    const expr = /const budgetMs = handedOff\n?[\s\S]*?;\n/.exec(src)?.[0];
    assert.ok(expr, "the drain budget is no longer chosen here — this tests nothing");

    const pick = (handedOff, env) => {
      // eslint-disable-next-line no-new-func
      return Function("handedOff", "process", `${expr} return budgetMs;`)(handedOff, { env });
    };
    assert.equal(pick(false, {}), 5_000,
      "a SUPERVISED stop no longer uses the 5s it was measured for — systemd waits " +
      "serially there, so a longer grace is downtime");
    assert.ok(pick(true, {}) >= 600_000,
      `a HANDOVER got ${pick(true, {})}ms — nothing waits on that path and the ` +
      `short budget is what cut 16 mid-response replies on the last deploy`);
    assert.equal(pick(true, { CACHE_FIX_DRAIN_MS: "90000" }), 90_000,
      "CACHE_FIX_DRAIN_MS does not move the handover budget");
    assert.equal(pick(false, { CACHE_FIX_DRAIN_MS: "90000" }), 5_000,
      "CACHE_FIX_DRAIN_MS moved the SUPERVISED budget too — that one is bounded by " +
      "the unit's TimeoutStopSec and is not the operator's to raise from here");
  });

  // AND THE LINE MUST NAME THE BUDGET IT ACTUALLY USED. The two diverged the
  // moment the handover path got its own, and a log that says "after 5s" about a
  // 1800s wait reads like it was checked.
  it("reports the budget it actually spent, not the one it was written against", () => {
    assert.match(forcedCloseLine(1, 0, 0, 5_000), /after 5s/);
    assert.match(forcedCloseLine(1, 0, 0, 1_800_000), /after 1800s/,
      "the forced-close line still hardcodes 5s, so an operator reading it cannot " +
      "tell a handover drain from a supervised stop");
    assert.match(forcedCloseLine(0, 0, 3, 1_800_000), /after 1800s, cut no responses/);
  });

  it("says it cut nothing when it cut nothing, and never calls that idle", () => {
    const idle = forcedCloseLine(0, 0, 1);
    const unknown = forcedCloseLine(0, 0, null);

    // POSITIVE FIRST. Three negative assertions passed against a branch that
    // returned "" — measured — so the headline behaviour of this whole change
    // had no assertion that it says anything at all.
    assert.match(idle, /cut no responses/, `the zero branch said: ${JSON.stringify(idle)}`);
    assert.ok(idle.endsWith("\n"), "every stderr line must terminate itself");

    // AND IT MUST NOT CLAIM IDLENESS. liveResponses is filled by the request
    // handler only, so a blind-tunnelled CONNECT — forward mode's normal
    // traffic — holds the server open while counting zero. Measured on
    // 18.20.8 / 20.20.2 / 24.11.1: close unresolved, liveResponses 0,
    // server connections 1. A line saying "idle" there is false in the mode
    // we ship, so the held count is what has to appear.
    assert.match(idle, /1 connection\(s\) still held/,
      "the zero branch must name what was still held, or it is guessing");
    assert.doesNotMatch(idle, /\bidle\b/,
      "we measured that no RESPONSE was open, which is not the same as idle");

    // An UNKNOWN count must not read as zero — that is the one reading that
    // would wrongly clear a stop that severed something.
    assert.doesNotMatch(unknown, /0 connection/,
      `an unavailable count printed as zero: ${JSON.stringify(unknown)}`);

    assert.doesNotMatch(idle, /forcing close, cut \d/,
      "an idle expiry must not trip a grep written for a real cut");

    const mixed = forcedCloseLine(2, 3, 9);
    assert.match(mixed, /cut 5 in-flight request\(s\) /,
      "the total must be ended + destroyed, not one of them");
    assert.match(mixed, /\(2 mid-response, 3 before headers\)/,
      "both halves of the split must appear, and anchored");
  });

  // THE OTHER HALF OF ba2375b, AND IT IS NOT COVERED BY THE HEADER.
  //
  // `Connection: close` rides a request. A client that goes QUIET at the drain
  // and never sends another one never gets it, so something else has to close
  // that socket or it stays pinned to a departing proxy.
  //
  // ba2375b assumed node did that for us. It does from 19 on; 18.20.8 does NOT
  // — measured directly, a bare http server's idle keep-alive never closes on
  // 18 where 20.20.2 and 24.11.1 close it in 1-2 ms. Worse on the same major:
  // that socket also keeps close() unresolved (see forcedCloseLine's note), so
  // the handover spends its ENTIRE budget, which 6d6f01d just raised to 30
  // minutes. A quiet client on Node 18 was pinned for all of it.
  //
  // So this asserts OUR contract, not node's: a draining proxy leaves no idle
  // keep-alive open, on every major engines admits. The busy half is already
  // covered above ("tells a keep-alive client to close once it is draining"),
  // which requires the in-flight reply to FINISH — so a fix that simply closed
  // everything would fail there, and that is this test's control.
  it("closes a keep-alive the client left idle, on every supported major", async () => {
    const { proc, port } = startProxy();
    const p = await port;
    const sock = net.connect(p, "127.0.0.1");
    sock.on("error", () => {});
    let closed = false;
    sock.on("close", () => { closed = true; });
    await new Promise((r) => sock.once("connect", r));
    try {
      // One instant request, fully read, so the connection is genuinely IDLE
      // when the signal lands -- not mid-request, which is the other case.
      const reply = await new Promise((resolve) => {
        let buf = "";
        const onData = (d) => {
          buf += d.toString();
          if (/\r\n\r\n/.test(buf)) { sock.off("data", onData); resolve(buf); }
        };
        sock.on("data", onData);
        sock.write("GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
        setTimeout(() => { sock.off("data", onData); resolve(buf); }, 4000);
      });
      // PREMISE: it answered and it kept the socket. Without this the assertion
      // below passes against a proxy that was already dead or already closing.
      assert.match(reply, /^HTTP\/1\.1 200/, `healthy /health did not answer: ${reply.slice(0, 80)}`);
      assert.equal(closed, false, "the socket closed before we even signalled");

      proc.kill("SIGTERM");
      // WAIT ON THE EVENT, not on a fixed 2s. A flat sleep held a spawned proxy
      // alive for two seconds doing nothing, and node:test runs FILES
      // concurrently — that load reddened a readiness assertion in
      // proxy-held-port.test.mjs ("no proxy child to kill"), which is green at
      // HEAD and green with this file's production change alone. Bisected.
      // Cut the load rather than widen the victim's window: this now returns in
      // milliseconds when the socket closes, and only spends the budget when it
      // does not.
      closed = closed || await new Promise((r) => {
        const t = setTimeout(() => r(false), 2_000);
        sock.once("close", () => { clearTimeout(t); r(true); });
      });
      assert.equal(closed, true,
        "a draining proxy left an IDLE keep-alive open. That client never sends " +
        "another request, so it never gets Connection: close and never reaches " +
        "the successor -- and on Node 18 it also holds close() unresolved, so " +
        "the handover burns its whole 30-minute budget with the client pinned.");
    } finally {
      sock.destroy();
      try { proc.kill("SIGKILL"); } catch {}
    }
  });

});
