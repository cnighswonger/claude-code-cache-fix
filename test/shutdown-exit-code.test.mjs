import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withDeadline } from "./child-deadline.mjs";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { drainBudgetMs, drainRoute, forcedCloseLine } from "../proxy/server.mjs";
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

// An upstream that accepts and never replies: the response stays OWED with
// headersSent false and bytesWritten 0, which is the shape a ceiling waits out
// and a stall test ends. The sockets are tracked because close() alone WAITS
// for them -- the proxy's connection never ends, and one cut of this hung the
// whole file for 200s in its own cleanup. That was the fixture, not the product.
async function hungUpstream() {
  const sockets = [];
  const srv = net.createServer((s) => sockets.push(s));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    port: srv.address().port,
    close: () => {
      for (const s of sockets) { try { s.destroy(); } catch {} }
      return new Promise((r) => srv.close(r));
    },
  };
}

// An SSE upstream that keeps writing, so socket.bytesWritten keeps advancing --
// which is all the stall predicate reads. `stallHeader` names an `x-fixture`
// value that gets NO reply at all, so ONE server can serve a moving connection
// and a stalled one on the same port, which is what separates a per-connection
// clock from an aggregate one.
async function sseUpstream({ everyMs = 100, stallHeader = null } = {}) {
  const srv = http.createServer((q, r) => {
    q.resume();
    if (stallHeader && q.headers["x-fixture"] === stallHeader) return;
    r.writeHead(200, { "content-type": "text/event-stream" });
    let n = 0;
    const t = setInterval(() => { try { r.write(`data: ${++n}\n\n`); } catch {} }, everyMs);
    r.on("close", () => clearInterval(t));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
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
    // The response is live with headersSent false when the watchdog fires.
    const hung = await hungUpstream();
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${hung.port}`,
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
      await hung.close();
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
    const upstream = await sseUpstream();
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.port}`,
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
      await upstream.close();
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
  // THE PREDICATE, END TO END, BOTH DIRECTIONS. A budget test can only ever
  // assert "it eventually stopped", which a ceiling also satisfies — so the pair
  // that matters is: a drain with nothing moving must end WITHOUT reaching the
  // ceiling, and a drain with bytes moving must NOT end while they move. Neither
  // alone distinguishes a stall predicate from a shorter clock.
  // WHAT WAS CUT, not just how many. This port carries CLI turns alongside
  // bridge traffic, quota polls, statusline and title generation; a cut of 15 is
  // a different event depending on the mix, and the count alone cannot say. One
  // host measured ~98 cuts against 6 user-visible events and neither of the two
  // sessions looking at it could name the other ninety-two.
  it("names the routes it cut, and never writes a query string", async () => {
    // The never-answers upstream: the request is owed with headers unsent, which
    // is the arm that reaches `destroyed` rather than `ended`.
    const hung = await hungUpstream();
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${hung.port}`,
    });
    try {
      const p = await port;
      // A QUERY STRING CARRYING SOMETHING THAT MUST NOT REACH A LOG. The proxy
      // sees whole request URLs and this line is written to stderr, so the
      // grouping is the only thing between an identifier in a path and a log
      // file that outlives the process.
      const c = net.connect(p, "127.0.0.1", () => c.write(
        "POST /v1/messages?beta=true&tok=SHOULD-NOT-APPEAR HTTP/1.1\r\nHost: x\r\n" +
        "content-type: application/json\r\ncontent-length: 2\r\n\r\n{}"));
      c.on("error", () => {});
      await new Promise((r) => setTimeout(r, 500));

      const exited = exitOf(proc);
      proc.kill("SIGTERM");
      await exited;
      c.destroy();

      assert.match(stderr(), /routes: \/v1\/messages=1/,
        `the cut line does not name what it cut; stderr was:\n${stderr()}`);
      assert.doesNotMatch(stderr(), /SHOULD-NOT-APPEAR/,
        "the route tally wrote the QUERY STRING into a log — this proxy sees whole " +
        "request URLs, so the grouping is what keeps an identifier in a path out of " +
        "a file that outlives the process");
      assert.doesNotMatch(stderr(), /routes: \/v1\/messages\?/,
        "the tally kept the `?` — grouping must cut at the query, not merely omit " +
        "the value");
    } finally {
      await hung.close();
      proc.kill("SIGKILL");
    }
  });

  it("ends the only owed connection on the stall, not on the ceiling", async () => {
    // The same never-answers upstream the destroy-arm case uses: the proxy is
    // stuck waiting, so the response is owed with bytesWritten 0 — the exact
    // shape a ceiling waits out and a stall test does not.
    const hung = await hungUpstream();
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${hung.port}`,
      CACHE_FIX_DRAIN_STALL_MS: "1500",
      // A ceiling far enough away that reaching it is unmistakable: if this is
      // what ends the drain the case takes a minute and fails on the elapsed
      // assertion rather than passing slowly.
      CACHE_FIX_DRAIN_MS: "60000",
    });
    try {
      const p = await port;
      const c = net.connect(p, "127.0.0.1", () => c.write(
        "POST /v1/messages HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\n" +
        "content-length: 2\r\n\r\n{}"));
      c.on("error", () => {});
      await new Promise((r) => setTimeout(r, 500));

      const exited = exitOf(proc);
      const t0 = Date.now();
      proc.kill("SIGUSR2");          // the HANDOVER arm, not a supervised stop
      await exited;
      const elapsed = Date.now() - t0;
      c.destroy();

      assert.ok(elapsed < 20_000,
        `the handover drain took ${elapsed}ms against a 1500ms stall window and a ` +
        `60000ms ceiling — the ceiling is what ended it, so the stall test is not ` +
        `what decides and this is a clock wearing a predicate's name`);
      assert.match(stderr(), /with no byte written for \d+s/,
        `no per-connection end said the stall was what ended it; stderr was:\n${stderr()}`);
      assert.doesNotMatch(stderr(), /BACKSTOP/,
        `the drain ended on the backstop budget, which means the stall test never ` +
        `fired — that is a defect in the predicate, not a slow client`);
      assert.doesNotMatch(stderr(), /drained clean/,
        `the drain cut a reply and still called itself "clean". A reader greps that ` +
        `phrase unanchored, so a suffix naming the cut does not save it`);
    } finally {
      await hung.close();
      proc.kill("SIGKILL");
    }
  });

  it("does not end a handover drain while bytes are still moving", async () => {
    // The SSE fixture the watchdog case uses, because it is the one that actually
    // gets bytes through this proxy — my first cut dribbled raw chunks from a
    // net server and delivered nothing, which its own premise assertion caught.
    // socket.bytesWritten advances per chunk here, which is all the predicate
    // reads; a CONTENT test would see the same thing and a rate test would have
    // to decide whether 10 bytes per 100ms is a reply or a heartbeat.
    const upstream = await sseUpstream();
    const { proc, port } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.port}`,
      CACHE_FIX_DRAIN_STALL_MS: "1500",
      CACHE_FIX_DRAIN_MS: "60000",
    });
    try {
      const p = await port;
      let chunks = 0;
      const req = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => { res.on("data", () => chunks++); res.on("error", () => {}); });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));

      const flowing = Date.now() + 10_000;
      while (chunks === 0 && Date.now() < flowing) await new Promise((r) => setTimeout(r, 50));
      assert.ok(chunks > 0, "premise: bytes must be reaching the client before the handover");

      const exited = exitOf(proc);
      let alive = true;
      exited.then(() => (alive = false));
      const before = chunks;
      proc.kill("SIGUSR2");
      // FOUR stall windows. A predicate that ignores movement ends at ~1.5s, so
      // this fails on the arm it is aimed at rather than on timing noise.
      await new Promise((r) => setTimeout(r, 6_000));
      assert.ok(alive,
        "the handover drain ended within 6s while the reply was still delivering " +
        "a chunk every 100ms — movement does not hold it open, so this is a 1500ms " +
        "clock and it cuts exactly what the 5s one did");
      assert.ok(chunks > before,
        `the reply stopped delivering during the drain (${before} -> ${chunks}), so ` +
        `"still alive" says nothing about movement — the fixture stalled, not the proxy`);
    } finally {
      upstream.close();
      proc.kill("SIGKILL");
    }
  });

  it("ends the stalled connection and keeps the moving one", async () => {
    // BOTH the cases above use exactly ONE connection, and with one connection
    // an aggregate clock and a per-connection one are the SAME PROGRAM — no
    // fixture built that way can fail either version. Three assertions, not
    // two; each says at its own failure what it catches.
    // `stallHeader`: the stalled request gets no reply at all, so both shapes
    // live on ONE server and share nothing but the port.
    const upstream = await sseUpstream({ stallHeader: "stall" });
    const { proc, port } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.port}`,
      CACHE_FIX_DRAIN_STALL_MS: "1500",
      CACHE_FIX_DRAIN_MS: "60000",
    });
    let c;
    try {
      const p = await port;

      let chunks = 0;
      const req = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json", "x-fixture": "stream" } },
        (res) => { res.on("data", () => chunks++); res.on("error", () => {}); });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));

      // ITS OWN SOCKET. `bytesWritten` is a property of the SOCKET, not of the
      // response, so two requests sharing one keep-alive connection would share
      // the very clock this case exists to separate.
      let stalledClosed = false;
      c = net.connect(p, "127.0.0.1", () => c.write(
        "POST /v1/messages HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\n" +
        "x-fixture: stall\r\ncontent-length: 2\r\n\r\n{}"));
      c.on("error", () => {});
      c.on("close", () => (stalledClosed = true));

      const flowing = Date.now() + 10_000;
      while (chunks === 0 && Date.now() < flowing) await new Promise((r) => setTimeout(r, 50));
      assert.ok(chunks > 0,
        "premise: the moving reply must be delivering before the handover, or " +
        "this case is two stalled connections and proves nothing about movement");
      assert.ok(!stalledClosed,
        "premise: the stalled connection must still be open at the handover, or " +
        "it was ended by something other than the drain");

      const exited = exitOf(proc);
      let alive = true;
      exited.then(() => (alive = false)).catch(() => {});
      const before = chunks;
      proc.kill("SIGUSR2");          // the HANDOVER arm

      // Four stall windows: long enough that a per-connection test has fired
      // and far short of the 60s backstop, so neither outcome is timing noise.
      await new Promise((r) => setTimeout(r, 6_000));

      assert.ok(stalledClosed,
        "the stalled connection was still open four stall windows into the drain. " +
        "The moving reply kept a SHARED clock fresh, so the stall test answered " +
        "\"still moving\" about a connection that had written nothing — this is the " +
        "aggregate predicate, and it is what let six connections sit for the whole " +
        "1800s budget and then be cut on the backstop");
      assert.ok(chunks > before,
        `the moving reply stopped delivering during the drain (${before} -> ${chunks}). ` +
        "Ending the stalled connection took the live one with it, which is the " +
        "all-or-nothing close: per-connection STAMPING alone does not fix this, the " +
        "cut has to be per-connection too");
      assert.ok(alive,
        "the drain returned while a reply was still delivering a chunk every 100ms — " +
        "the drain ends when nothing is OWED, not when the first connection goes quiet");
    } finally {
      try { c?.destroy(); } catch { /* never opened */ }
      upstream.close();
      proc.kill("SIGKILL");
    }
  });

  it("ages an owed connection from when it arrived, not from when the drain first saw it", async () => {
    // A connection already stalled when the drain begins has no byte to date
    // from. Stamping it at first SIGHT restarts its clock at the handover, so
    // the one connection most certainly dead gets a fresh full window — and the
    // longer the window, the longer it holds the drain open. `res._bornAt` is
    // what makes the first stamp a real age instead of zero, and without this
    // case nothing in the suite can tell the two apart: every other fixture
    // opens its connection moments before the handover, where arrival and first
    // sight are the same instant.
    const hung = await hungUpstream();
    const { proc, port } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${hung.port}`,
      CACHE_FIX_DRAIN_STALL_MS: "4000",
      CACHE_FIX_DRAIN_MS: "60000",
    });
    let c;
    try {
      const p = await port;
      let closedAt = 0;
      c = net.connect(p, "127.0.0.1", () => c.write(
        "POST /v1/messages HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\n" +
        "content-length: 2\r\n\r\n{}"));
      c.on("error", () => {});
      c.on("close", () => (closedAt = Date.now()));

      // IDLE LONGER THAN THE WINDOW BEFORE THE HANDOVER. This is the whole
      // fixture: 6s of silence against a 4s window means an age-from-arrival
      // test is already satisfied when the drain starts.
      await new Promise((r) => setTimeout(r, 6_000));
      assert.equal(closedAt, 0,
        "premise: the connection must still be open at the handover, or it was " +
        "ended by something other than the drain");

      const exited = exitOf(proc);
      const t0 = Date.now();
      proc.kill("SIGUSR2");
      const deadline = t0 + 12_000;
      while (!closedAt && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await exited.catch(() => {});

      assert.ok(closedAt, "the connection was never ended at all within 12s");
      const took = closedAt - t0;
      // Ages from arrival: stamped on tick 1 with a 6s age, ended on tick 2.
      // Ages from first sight: stamped at 0 on tick 1, so it waits out a fresh
      // 4s window and ends around tick 5. The gap is ~2s against ~5s.
      assert.ok(took < 3_500,
        `the stalled connection took ${took}ms to end against a 4000ms window it ` +
        `had ALREADY exceeded by 6000ms before the handover. Its clock was ` +
        `restarted at first sight, so the deadest connection on the port bought ` +
        `itself another full window`);
    } finally {
      try { c?.destroy(); } catch { /* never opened */ }
      await hung.close();
      proc.kill("SIGKILL");
    }
  });

  it("keeps a reply that has been streaming since long before the handover", async () => {
    // The other direction of the arrival stamp, and the one that makes it
    // dangerous. Ageing an owed connection from arrival is right only for one
    // that has written NOTHING — that is the connection with no byte to date
    // from. A connection that has been delivering since before the drain began
    // is aged from its arrival too, so on the first tick that happens to see no
    // byte cross, `now - at` is the REQUEST'S AGE, which exceeds the window for
    // any request older than it. The live reply is then cut.
    //
    // This selects for exactly what the drain protects: a reply is exposed only
    // once it is older than the window, so the longer a turn has run the more
    // certainly it qualifies.
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      // A gap WIDER than two ticks, so the handover below lands in one
      // deterministically rather than racing the chunk.
      const t2 = setInterval(() => { try { r.write(`data: ${++i}\n\n`); } catch {} }, 3_000);
      r.on("close", () => clearInterval(t2));
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CACHE_FIX_DRAIN_STALL_MS: "4000",
      CACHE_FIX_DRAIN_MS: "60000",
    });
    try {
      const p = await port;
      let chunks = 0, lastAt = 0;
      const req = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => { res.on("data", () => { chunks++; lastAt = Date.now(); });
                   res.on("error", () => {}); });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));

      // OLDER THAN THE WINDOW before we signal: 7s against 4000ms. That is the
      // whole premise — a young request is immune and proves nothing.
      // WAIT ON THE CLOCK, not on a chunk count: the count is satisfied within
      // the first seconds and would signal while the request is still younger
      // than the window, where every implementation keeps it and the case
      // proves nothing. Its own premise caught that.
      const t0 = Date.now();
      while (Date.now() - t0 < 7_000) await new Promise((r) => setTimeout(r, 100));
      assert.ok(chunks >= 2, "premise: the reply must be delivering before the handover");
      assert.ok(Date.now() - t0 > 4_000,
        "premise: the request must be OLDER than the stall window at the handover");

      // Immediately after a chunk, so the next two ticks fall inside the 3s gap.
      while (Date.now() - lastAt > 300) await new Promise((r) => setTimeout(r, 25));
      const before = chunks;
      const exited = exitOf(proc);
      let alive = true;
      exited.then(() => (alive = false)).catch(() => {});
      proc.kill("SIGUSR2");

      await new Promise((r) => setTimeout(r, 7_000));
      assert.ok(alive && chunks > before,
        `a reply that had been streaming for ${Math.round((Date.now() - t0) / 1000)}s was cut ` +
        `${Math.round(Date.now() - lastAt)}ms into the drain (alive=${alive}, ` +
        `${before} -> ${chunks} chunks). It was aged from ARRIVAL rather than from its ` +
        `last byte, so its own age was read as the time it had been silent. stderr:\n${stderr()}`);
    } finally {
      upstream.close();
      proc.kill("SIGKILL");
    }
  });

  it("ends a connection once even when its FIN cannot flush", async () => {
    // `res.end()` only QUEUES the FIN. With the client not reading and the
    // socket's write queue deeply backed up, the response cannot finish, so
    // `close` never fires and it stays in the live set — where a loop that
    // FORGETS an ended connection re-stamps it as new and ends it again one
    // window later, and every window after. The count that certifies the drain
    // inflates for as long as the drain runs.
    //
    // An earlier fixture used 64 KB chunks on a live upstream and could not
    // reproduce it: the writes kept `bytesWritten` advancing, so the stall
    // never fired. The queue has to be deep AND the upstream has to go silent.
    //
    // WHAT THIS PINS, precisely: that AT LEAST ONE of the two guards survives,
    // not marking-versus-deleting. `rec.done` and the `writableEnded` check are
    // mutually redundant on the ended arm — `res.end()` makes `writableEnded`
    // true, so the later guard catches the re-visit — and on the destroyed arm
    // `close` drops the response before the next tick. Removing either alone
    // leaves this case green; removing BOTH gives three ends over six windows.
    // The redundancy is deliberate; do not read this case as proving more.
    const BLOB = "x".repeat(256 * 1024);
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < 200; i++) r.write(`data: ${BLOB}\n\n`);   // ignore backpressure
      // then silent forever, so bytesWritten goes constant
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CACHE_FIX_DRAIN_STALL_MS: "1500",
      CACHE_FIX_DRAIN_MS: "60000",
    });
    let c;
    try {
      const p = await port;
      c = net.connect(p, "127.0.0.1", () => {
        c.write("POST /v1/messages HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\n" +
          "content-length: 41\r\n\r\n" + JSON.stringify({ model: "x", messages: [], stream: true }));
        c.pause();          // NEVER READ: both kernel buffers fill
      });
      c.on("error", () => {});
      await new Promise((r) => setTimeout(r, 6_000));   // fill, then go quiet

      const exited = exitOf(proc);
      exited.catch(() => {});
      proc.kill("SIGUSR2");
      await new Promise((r) => setTimeout(r, 9_000));   // six stall windows

      const ends = stderr().match(/drain (ended|destroyed|gone) one connection/g) ?? [];
      assert.ok(ends.length >= 1,
        `premise: the drain never ended the stalled connection at all, so this case ` +
        `is not exercising the stall path; stderr was:\n${stderr()}`);
      assert.equal(ends.length, 1,
        `one connection, ended ${ends.length} times over six stall windows. Its FIN ` +
        `could not flush, so it stayed in the live set and an entry that was DELETED ` +
        `rather than MARKED was re-stamped from arrival and ended again — inflating ` +
        `the very count the backstop line reports`);
    } finally {
      try { c?.destroy(); } catch { /* never opened */ }
      upstream.close();
      proc.kill("SIGKILL");
    }
  });

  it("does not answer 200 for a stall that delivered no byte", async () => {
    // `headersSent` goes true at writeHead with `bytesWritten` still 0, so a
    // response blocked upstream AFTER its headers were buffered looks
    // mid-response to it. `res.end()` on one emits a well-formed empty 200 —
    // which a client cannot tell from a real empty success and will not retry,
    // the same non-retryable answer the bulk close was fixed for. The stall
    // path has the byte count in hand, so it must split on that.
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "text/event-stream" });
      // FLUSH IS LOAD-BEARING. `writeHead` alone buffers, so without this the
      // headers never reach the proxy, its own `headersSent` stays false, and
      // both arms take the destroy path — the case passes without exercising
      // anything. Measured: the fixture was green against the defect until
      // this line was added.
      r.flushHeaders();   // headers on the wire, and no body byte ever
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CACHE_FIX_DRAIN_STALL_MS: "1500",
      CACHE_FIX_DRAIN_MS: "60000",
    });
    let c;
    try {
      const p = await port;
      let seen = "";
      c = net.connect(p, "127.0.0.1", () => c.write(
        "POST /v1/messages HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\n" +
        "content-length: 2\r\n\r\n{}"));
      c.on("data", (b) => (seen += b.toString("latin1")));
      c.on("error", () => {});
      await new Promise((r) => setTimeout(r, 1_000));
      assert.equal(seen, "",
        "premise: nothing must have reached the client before the handover, or " +
        "this case is about a response that really did deliver");

      const exited = exitOf(proc);
      exited.catch(() => {});
      proc.kill("SIGUSR2");
      await new Promise((r) => setTimeout(r, 5_000));

      assert.match(stderr(), /drain destroyed one connection .* \(before headers\)/,
        `the stall ended a byte-less response on the "ended" arm; it must be reset, ` +
        `and labelled for what reached the client rather than for what was buffered. ` +
        `stderr:\n${stderr()}`);
      assert.equal(seen, "",
        `the client received ${JSON.stringify(seen.slice(0, 120))} for a request that ` +
        `never delivered a byte. A well-formed empty success is not retryable and is ` +
        `indistinguishable from a real one; a reset is the honest answer here`);
    } finally {
      try { c?.destroy(); } catch { /* never opened */ }
      upstream.close();
      proc.kill("SIGKILL");
    }
  });

  it("counts a stall-ended connection once, not once per half of the line", async () => {
    // The backstop line is machine-read — a sibling monitor greps
    // `drained clean in|cut \d+ in-flight` — and this branch's own deploy
    // evidence is quoted from it. So the number has to be right.
    //
    // An `end()`ed response stays in the live set ONLY because its FIN cannot
    // flush, and while it is held `server.close()` cannot resolve, so the
    // backstop always fires. Without a filter it is reported by the stall test
    // AND counted again by the forced close: one connection, two numbers, on a
    // line that reads as a total.
    const BLOB = "x".repeat(256 * 1024);
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < 200; i++) r.write(`data: ${BLOB}\n\n`);
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CACHE_FIX_DRAIN_STALL_MS: "1500",
      // Short enough that the backstop is reached inside the case.
      CACHE_FIX_DRAIN_MS: "9000",
    });
    let c;
    try {
      const p = await port;
      c = net.connect(p, "127.0.0.1", () => {
        c.write("POST /v1/messages HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\n" +
          "content-length: 41\r\n\r\n" + JSON.stringify({ model: "x", messages: [], stream: true }));
        c.pause();          // never read, so the FIN can never flush
      });
      c.on("error", () => {});
      await new Promise((r) => setTimeout(r, 5_000));

      const exited = exitOf(proc);
      exited.catch(() => {});
      proc.kill("SIGUSR2");
      await new Promise((r) => setTimeout(r, 12_000));

      const back = stderr().match(/on the BACKSTOP budget[^\n]*/)?.[0];
      assert.ok(back, `premise: the backstop never fired; stderr was:\n${stderr()}`);
      assert.match(back, /1 ended on the stall test/,
        `the backstop line does not report the stall end; got: ${back}`);
      assert.match(back, /0 response\(s\) still owed/,
        `the one connection the stall test ended is also reported as still owed. ` +
        `\`_live\` holds it until its FIN flushes, so counting it there reports one ` +
        `connection twice: ${back}`);
      assert.match(stderr(), /cut no responses/,
        `the forced close counted the connection the stall test had already ended. ` +
        `That number is parsed by a sibling monitor and is this project's own ` +
        `evidence for what a handover costs. stderr:\n${stderr()}`);
    } finally {
      try { c?.destroy(); } catch { /* never opened */ }
      upstream.close();
      proc.kill("SIGKILL");
    }
  });

  it("does not report a cut for a reply that had already ended itself", async () => {
    // NON-STREAMING, which is the whole fixture. The streaming path pipes, and
    // pipe() honours backpressure, so `clientRes.end()` is never reached while
    // the client is not reading — no body size gets there. The BUFFERED branch
    // collects the whole upstream reply and answers with ONE
    // `clientRes.end(rawResponse)` that ignores backpressure, so the response
    // is `writableEnded` with megabytes still queued. `res.end()` on one is a
    // no-op: the drain ends nothing, and saying it did both invents a cut and
    // suppresses "drained clean" for a drain that lost nothing.
    //
    // AFTER THE HANDOVER, or there is nothing to test: `closeIdleConnections()`
    // runs once at drain start and Node counts a finished-but-unflushed
    // response as idle, so a reply that completed BEFORE the signal is severed
    // there and never reaches the stall loop at all.
    const BODY = Buffer.alloc(16 * 1024 * 1024, 0x61);
    const upstream = http.createServer((q, r) => {
      q.resume();
      setTimeout(() => {
        r.writeHead(200, { "content-type": "application/json", "content-length": BODY.length });
        r.end(BODY);
      }, 1_200);
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CACHE_FIX_DRAIN_STALL_MS: "1500",
      CACHE_FIX_DRAIN_MS: "8000",
    });
    let c;
    try {
      const p = await port;
      const reqBody = JSON.stringify({ model: "x", messages: [], stream: true });
      c = net.connect(p, "127.0.0.1", () => c.write(
        "POST /v1/messages HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\n" +
        `content-length: ${Buffer.byteLength(reqBody)}\r\n\r\n` + reqBody));
      c.on("error", () => {});          // NEVER READ: no 'data' listener, no resume()

      const exited = exitOf(proc);
      await new Promise((r) => setTimeout(r, 800));
      proc.kill("SIGUSR2");             // upstream is still thinking
      await exited.catch(() => {});

      // PREMISES, both implementation-independent. Without them a fixture whose
      // request never reached the proxy passes on the assertion below.
      assert.match(stderr(), /BACKSTOP/,
        `premise: the drain must have run to the backstop holding this connection, ` +
        `or nothing was in the stall loop to judge; stderr:\n${stderr()}`);
      let got = 0;
      c.on("data", (b) => (got += b.length));
      c.resume();
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(got > 0 && got < BODY.length,
        `premise: the proxy must have answered this connection with a body it ` +
        `could not flush (got ${got} of ${BODY.length})`);

      // AND IT IS STILL OWED. `res.end()` was a no-op, but megabytes sit queued
      // on a socket the client is not reading and closeAllConnections() destroys
      // it. Marking the connection done for the stall test also took it out of
      // the backstop's owed count AND out of the forced close's tally, so the
      // drain reported `0 response(s) still owed` and `cut no responses` about a
      // reply it was about to truncate -- the severed-and-called-clean shape
      // this drain exists to remove, one branch over.
      assert.match(stderr(), /[1-9][0-9]* response\(s\) still owed/,
        `the backstop said nothing was owed while holding a reply with megabytes ` +
        `queued on it; stderr:\n${stderr()}`);
      assert.match(stderr(), /cut 1 in-flight request\(s\)/,
        `the forced close said it cut nothing and then destroyed a socket carrying ` +
        `an unflushed body; stderr:\n${stderr()}`);
      // AND THE BUDGET STAYS IN SECONDS. The backstop passes the ELAPSED time,
      // which is not a round number of milliseconds, so this arm alone rendered
      // `after 8003ms` where every other one renders `after 8s` -- and a reader
      // outside this repo matches `after (\d+)s`.
      assert.match(stderr(), /forcing close[^\n]*after \d+s/,
        `the forced-close line reports its budget in milliseconds on the backstop ` +
        `arm; stderr:\n${stderr()}`);

      assert.doesNotMatch(stderr(), /drain ended one connection/,
        `the stall test called res.end() on a response that had ALREADY ended ` +
        `itself — a no-op — and reported it as a cut. Nothing was cut: the ` +
        `connection lived on to the backstop. The false count also flips ` +
        `"drained clean" off for a drain that lost nothing to the stall test. ` +
        `stderr:\n${stderr()}`);
    } finally {
      try { c?.destroy(); } catch { /* never opened */ }
      upstream.close();
      proc.kill("SIGKILL");
    }
  });

  it("spends the 5s outage budget only where something waits on our exit", () => {
    const src = readFileSync(serverPath, "utf8");
    // BOTH LINES. The predicate moved off the budget line into `unwaited`, so
    // lifting only `const budgetMs = ...` leaves it unbound and this throws a
    // ReferenceError instead of testing anything. That is the correct failure
    // and it is not a test — measured when the predicate moved.
    const expr = /const unwaited = [\s\S]*?;\n\s*const budgetMs = [\s\S]*?;\n/.exec(src)?.[0];
    assert.ok(expr, "the drain budget is no longer chosen here — this tests nothing");
    assert.match(expr, /handedOff/, "the budget no longer consults handedOff");
    assert.match(expr, /handoverRelease/,
      "the budget ignores handoverRelease, so a holder-driven handover still spends " +
      "the SUPERVISED budget — the arm that cut 14-18 mid-response replies on every " +
      "one of six handovers in one evening, every one 100% mid-response");
    assert.match(expr, /heldByLiveHolder/,
      "the budget ignores heldByLiveHolder, so a stop under a live holder is back on " +
      "the 5s ceiling — the arm that cut 15 replies on one host across four stops " +
      "(4, 3, 1, 7), every one with no stall predicate installed at all");

    const pick = (handedOff, handoverRelease, heldByLiveHolder, env) => {
      // eslint-disable-next-line no-new-func
      // The REAL helper, injected rather than re-implemented: the lifted line
      // calls it, and a copy here would let the two drift into agreeing about
      // a budget the server does not actually use.
      return Function("handedOff", "handoverRelease", "heldByLiveHolder", "process",
        "drainBudgetMs", `${expr} return budgetMs;`)(
          handedOff, handoverRelease, heldByLiveHolder, { env }, drainBudgetMs);
    };
    assert.equal(pick(false, false, false, {}), 5_000,
      "a STANDALONE stop no longer uses the 5s it was measured for. With no holder " +
      "above it this process IS what someone waits on, and that wait is serial: 120s " +
      "against a 90s TimeoutStopSec took restart downtime 5.0s -> 53.9s. This is the " +
      "one arm that still pays a ceiling, and removing it here removes it everywhere");

    // THE HELD STOP. The holder settles on our RELEASE announcement rather than
    // on our exit (claude-via-proxy.mjs, the `stopping` arm of onLine), so from
    // that line nothing is waiting and the ceiling has nothing left to buy.
    // Landing this half without the holder half puts the 53.9s straight back.
    assert.ok(pick(false, false, true, {}) >= 600_000,
      `a stop under a LIVE HOLDER got ${pick(false, false, true, {})}ms — back on the ` +
      `ceiling that cut 4, 3, 1 and 7 in-flight replies on one host, 15 in total, ` +
      `every one at 5s with no predicate installed`);
    assert.ok(pick(true, false, false, {}) >= 600_000,
      `a HANDOVER got ${pick(true, false, false, {})}ms — nothing waits on that path and the ` +
      `short budget is what cut 16 mid-response replies on the last deploy`);

    // THE THIRD CASE, and the one that was spending the wrong budget. A holder
    // handover never sets `handedOff`: it sets `releasing`, so askForSuccessor
    // is false. The successor has adopted fd 3 and the holder settles the moment
    // it signals us, so nothing waits on this exit.
    assert.ok(pick(false, true, false, {}) >= 600_000,
      `a HOLDER-DRIVEN handover got ${pick(false, true, false, {})}ms. Measured over one ` +
      `evening of six handovers: cut 17 / 18 / 18 / 16 / 15 / 14 in-flight, every ` +
      `one 100% mid-response and 0 before headers — and that six is a floor, the ` +
      `log had already been truncated at its 4MB cap`);

    assert.equal(pick(false, true, false, { CACHE_FIX_DRAIN_MS: "90000" }), 90_000,
      "CACHE_FIX_DRAIN_MS does not move the holder-driven handover budget");
    assert.equal(pick(true, false, false, { CACHE_FIX_DRAIN_MS: "90000" }), 90_000,
      "CACHE_FIX_DRAIN_MS does not move the handover budget");
    assert.equal(pick(false, false, false, { CACHE_FIX_DRAIN_MS: "90000" }), 5_000,
      "CACHE_FIX_DRAIN_MS moved the STANDALONE budget too — that one is bounded by " +
      "the unit's TimeoutStopSec and is not the operator's to raise from here");
  });

  // THE SIGNAL IS THE WHOLE DISCRIMINATOR, so pin which handler may set it.
  // The holder rewrites EVERY stop to SIGHUP (`systemctl stop`, Ctrl-C, a plain
  // kill, and a takeover asking it to release the port all arrive as SIGHUP), so
  // SIGHUP cannot mean "a successor is already serving" without also meaning
  // "the supervisor is waiting on your exit". Reading the handover off SIGHUP
  // gives a supervised stop the 30-minute budget, which is the 53.9s downtime
  // measured above; reading it off SIGUSR2 cannot, because nothing else sends it.
  it("reads the handover from SIGUSR2 and never from the stop signal", () => {
    const src = readFileSync(serverPath, "utf8");
    const hup = /process\.on\("SIGHUP",[\s\S]*?\);\n/.exec(src)?.[0];
    assert.ok(hup, "the proxy no longer handles SIGHUP — this tests nothing");
    assert.doesNotMatch(hup, /handoverRelease/,
      "SIGHUP sets the handover flag, so `systemctl stop` now takes the handover " +
      "budget and the supervisor SIGKILLs it at TimeoutStopSec");

    const usr2 = /process\.on\("SIGUSR2", \(\) => \{[\s\S]*?\}\);\n/.exec(src)?.[0];
    assert.ok(usr2, "the proxy no longer handles SIGUSR2, so a handover cannot say so");
    assert.match(usr2, /handoverRelease = true/,
      "SIGUSR2 no longer marks the handover, so every handover falls back to the 5s " +
      "outage budget — the arm this whole case exists to keep off that path");
    assert.match(usr2, /releasingPort = true/,
      "SIGUSR2 must still mark the port released, or the lineage self-heals into a " +
      "rival on a socket the successor already holds");
  });

  it("reports the budget it actually spent, not the one it was written against", () => {
    assert.match(forcedCloseLine(1, 0, 0, 5_000), /after 5s/);
    assert.match(forcedCloseLine(1, 0, 0, 1_800_000), /after 1800s/,
      "the forced-close line still hardcodes 5s, so an operator reading it cannot " +
      "tell a handover drain from a supervised stop");
    assert.match(forcedCloseLine(0, 0, 3, 1_800_000), /after 1800s, cut no responses/);

    // The tally rides the CUT line only. On the no-cut line there is nothing to
    // attribute, and an empty `routes: ` there reads as "no routes" rather than
    // "nothing was cut".
    assert.match(forcedCloseLine(2, 0, 0, 5_000, "", "/v1/messages=2"),
      / routes: \/v1\/messages=2\n$/, "the cut line does not carry the tally it was given");
    assert.doesNotMatch(forcedCloseLine(2, 0, 0, 5_000), /routes:/,
      "a caller that passes no tally still gets `routes:` — the field must be absent, " +
      "not empty, or every old line grows a meaningless suffix");
    assert.doesNotMatch(forcedCloseLine(0, 0, 3, 5_000, "", "/v1/messages=9"), /routes:/,
      "the no-cut line carries a tally of things it did NOT cut");
  });

  // THE ADJACENCY THIS LINE'S OWN COMMENT CALLS THE CONTRACT. `why` was appended
  // to the budget, which is the one position that block says a field must not
  // take -- and it takes it on the BACKSTOP arm, the arm that fires in
  // production, while every pinned case passes `why=""` and cannot see it.
  it("keeps the cut-line prefix parseable when the drain names why it ended", () => {
    const legacy = /cut (\d+) in-flight request\(s\) after (\d+)s \((\d+) mid-response/;
    assert.match(forcedCloseLine(4, 0, 0, 1_800_000), legacy,
      "the baseline rendering already fails this, so the case below proves nothing");
    assert.match(forcedCloseLine(4, 0, 0, 1_800_000, ", on the BACKSTOP budget — 0 ended"), legacy,
      "naming why the drain ended pushed a field between the budget and " +
      "`(N mid-response`, which is the adjacency this line's own comment records " +
      "as a contract with a reader outside this repo");
    assert.match(forcedCloseLine(0, 0, 3, 1_800_000, ", on the BACKSTOP budget"),
      /after 1800s, cut no responses/,
      "the no-cut line took the same field in the same wrong place");
  });

  // A PROXY SEES WHOLE REQUEST URLS. Absolute-form carries an authority and an
  // authority can carry userinfo, so the tally that rides a log line has to cut
  // the credential off, not merely the query string.
  it("the drain route tally never writes userinfo or a query string", () => {
    assert.equal(drainRoute("/v1/messages?beta=true&tok=SECRET"), "/v1/messages");
    assert.equal(drainRoute("http://user:hunter2@example.test/v1/messages?x=1"), "/v1/messages",
      "an absolute-form target reached the tally with its AUTHORITY intact, so a " +
      "credential in the userinfo is written to a file that outlives the process");
    // parseAbsoluteForm knows http and https. Every OTHER authority-first shape
    // reaches here unparsed and renders the authority verbatim, which is the
    // credential this function exists to keep out of the log. Origin-form is a
    // SINGLE leading slash, so `//host` is not one of them.
    // A SHAPE FILTER CANNOT ENFORCE A CONTENT RULE. Each of these is a single
    // leading slash, so a prefix test admits it, and each renders an authority
    // into a log line that outlives the process.
    for (const target of [
      "//user:hunter2@example.test/v1/messages",
      "ftp://user:hunter2@example.test/v1/messages",
      "example.test:443",
      "/http://user:hunter2@example.test/v1",
      "/\\user:hunter2@example.test/x",
      "/%2F%2Fuser:hunter2@example.test/x",
      "/;user:hunter2@example.test/x",
      "/v1/messages#tok=hunter2",
    ]) {
      assert.equal(drainRoute(target), "?",
        `an authority-first target rendered into the log: ${drainRoute(target)}`);
    }
    assert.equal(drainRoute("/a/b/c/d"), "/a/b", "the tally must stay two segments deep");
  });

  it("a drain budget refuses a value that would cut live work", () => {
    // `Number(x) || fallback` is wrong in BOTH directions here: it discards an
    // explicit 0 and it passes a negative straight through. A negative stall
    // budget makes `now - rec.at < stallMs` false on the first tick, so every
    // owed connection ends at once -- the guillotine this drain replaced,
    // reachable from one typo in an env file.
    assert.equal(drainBudgetMs(undefined, 90_000), 90_000);
    assert.equal(drainBudgetMs("", 90_000), 90_000);
    assert.equal(drainBudgetMs("abc", 90_000), 90_000);
    assert.equal(drainBudgetMs("-1", 90_000), 90_000,
      "a negative budget cuts every owed connection on the first tick");
    assert.equal(drainBudgetMs("0", 90_000), 0,
      "an explicit zero asks to cut now; it is not an absent setting");
    assert.equal(drainBudgetMs("30000", 90_000), 30_000);
    // `Number()` reads whitespace as 0, so a value that is only whitespace --
    // trivially written into an env file or a systemd unit -- becomes the
    // guillotine, not the default. Same for a non-string caller.
    for (const blank of [" ", "\t", "\n", "  \t "]) {
      assert.equal(drainBudgetMs(blank, 90_000), 90_000,
        `whitespace ${JSON.stringify(blank)} was read as an explicit budget`);
    }
    assert.equal(drainBudgetMs(null, 90_000), 90_000);
    assert.equal(drainBudgetMs("-0", 90_000), 90_000,
      "negative zero makes `now - at < budget` false on every tick, like -1");
    assert.equal(drainBudgetMs(" 5 ", 90_000), 5, "a padded number still parses");
    assert.equal(drainRoute(undefined), "?");
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


  it("delivers a finished-but-unflushed reply instead of severing it and calling it clean", async () => {
    // MEASURED, on this proxy: a client received 4,217,792 bytes of a declared
    // 67,108,872 while stderr said `drained clean in 0.0s of 9s budget`.
    //
    // The mechanism is not the stall predicate and not closeIdleConnections().
    // Discriminated on plain Node with three arms, no proxy involved:
    //     no close()                    100.0% delivered
    //     server.close() alone            6.2%
    //     server.close() + closeIdle      6.2%
    // `server.close()` is the agent. Node treats a response whose end() has been
    // CALLED as idle, so a reply that is complete but still flushing is severed
    // at drain start -- before any predicate can judge it, which is also why the
    // branch that would decline to claim a cut for it is unreachable today.
    const SIZE = 16 * 1024 * 1024;
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "application/octet-stream",
                         "content-length": String(SIZE) });
      r.end(Buffer.alloc(SIZE, 0x61));
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CACHE_FIX_DRAIN_MS: "60000",
    });
    try {
      const p = await port;
      let got = 0, declared = -1, ended = false;
      const req = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => {
          declared = parseInt(res.headers["content-length"] ?? "-1", 10);
          res.pause();                       // let the bytes queue on the proxy
          res.on("data", (b) => { got += b.length; });
          res.on("end", () => { ended = true; });
          res.on("error", () => {});
          setTimeout(() => res.resume(), 2_500);
        });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [] }));

      // Long enough for the whole body to reach the proxy and for it to call
      // end() with the client still not reading.
      await new Promise((r) => setTimeout(r, 1_500));
      proc.kill("SIGTERM");

      const t0 = Date.now();
      while (!ended && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 100));

      // PRECONDITION, not the assertion. A fixture that never got headers is
      // measuring nothing, and would otherwise read as the defect.
      assert.ok(declared > 0 && got > 0,
        `fixture never reached the arm: declared=${declared} got=${got}`);

      assert.equal(got, declared,
        `the drain severed a finished-but-unflushed reply: the client received ` +
        `${got} of a declared ${declared} bytes (${(100 * got / declared).toFixed(1)}%). ` +
        `FULL STDERR:\n${stderr()}`);
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      upstream.close();
    }
  });


  it("a forced close names how long each cut connection had been quiet", async () => {
    // MEASURED, the first real drain after the rewrite shipped, under live
    // traffic:
    //   shutdown: forcing close, cut 4 in-flight request(s) after 1800660ms on
    //   the BACKSTOP budget -- 0 ended on the stall test, 4 response(s) still
    //   owed (4 mid-response, 0 before headers) routes: /v1/code=4
    //
    // `0 ended on the stall test` across 1800s with a 90s window means bytes
    // kept moving, so the predicate was RIGHT to hold them and the backstop cut
    // four live replies. But that reading is an INFERENCE from a zero. The line
    // carries no per-connection byte timing, so the next backstop needs the
    // same reasoning instead of being read.
    //
    // The data already exists: the predicate's own record dates each connection
    // from its last byte. This asserts the line reports it.
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "text/event-stream" });
      r.write("data: 1\n\n");            // headers + one byte, then silence
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CACHE_FIX_DRAIN_STALL_MS: "600000",   // predicate must NOT fire; the backstop must
      CACHE_FIX_DRAIN_MS: "3000",
    });
    try {
      const p = await port;
      const req = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => { res.on("data", () => {}); res.on("error", () => {}); });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));

      await new Promise((r) => setTimeout(r, 2_000));   // let it go quiet
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));

      const line = stderr().match(/shutdown: forcing close.*/)?.[0] ?? "";
      // PRECONDITION: the fixture must actually reach a backstop, not a stall end.
      assert.ok(line, `no forced-close line at all. stderr:\n${stderr()}`);
      // The blindness is on BOTH arms, so this does not require the backstop
      // wording: a supervised stop cuts at a hard 5s with no predicate at all,
      // and its line is just as unreadable. What it must NOT be is a stall-test
      // end, where the predicate already decided and said so.
      assert.ok(!/drain (ended|destroyed)/.test(stderr()),
        `the predicate ended it, so no connection was OWED: ${line}`);

      assert.match(line, /quiet [0-9]+(\.[0-9]+)?s/,
        "a backstop must say how long each owed connection had been quiet -- " +
        "without it, `N still owed` cannot distinguish a stalled reply from a " +
        `live one and every backstop needs re-derivation. Got: ${line}`);
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      upstream.close();
    }
  });


  it("waits past the budget while a reply is still delivering, instead of cutting it", async () => {
    // MEASURED TWICE on one machine, identical both times:
    //   cut 4 in-flight request(s) after 1800660ms on the BACKSTOP budget
    //   -- 0 ended on the stall test, 4 response(s) still owed (4 mid-response)
    //   cut 4 ... after 1800015ms ... 0 ended on the stall test, 4 still owed
    //
    // `0 ended on the stall test` means the predicate ended NOTHING: it judged
    // all four alive and was right. The wall clock then overruled all four.
    //
    // A last resort that overrules the only informed opinion in the system is
    // not a last resort. And the drain's own comment says a lingering
    // predecessor costs RAM and nothing else -- so a timer that converts that
    // into cut replies trades the cheap failure for the expensive one.
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const t = setInterval(() => { try { r.write(`data: ${++i}\n\n`); } catch {} }, 200);
      r.on("close", () => clearInterval(t));
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CACHE_FIX_DRAIN_STALL_MS: "5000",   // 200ms writes keep it well inside the window
      CACHE_FIX_DRAIN_MS: "2000",         // budget expires while it is still streaming
    });
    try {
      const p = await port;
      let chunks = 0;
      const req = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => { res.on("data", () => { chunks++; }); res.on("error", () => {}); });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));

      while (chunks < 3) await new Promise((r) => setTimeout(r, 100));
      proc.kill("SIGUSR2");                       // handover arm, so the budget is ours

      // PAST the budget, by a margin. A cut would already have happened.
      await new Promise((r) => setTimeout(r, 6_000));

      const err = stderr();
      assert.ok(chunks > 3, `premise: the reply stopped streaming on its own (${chunks} chunks)`);
      assert.doesNotMatch(err, /forcing close/,
        `the budget cut a reply the stall test had not ended. stderr:\n${err}`);
      assert.match(err, /still waiting/,
        `a drain that stays past its budget must say so, and say what it is " +
        "waiting on. stderr:\n${err}`);
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      upstream.close();
    }
  });


  // A STOP UNDER A LIVE HOLDER IS THE ARM THAT CUT THE MOST, AND NOTHING WAS
  // WATCHING IT. Two filters over one proxy log disagreed — one matched the
  // BACKSTOP text and saw 5 cuts, the other matched the monitor's own line and
  // saw 34 — and the gap was this arm: a plain `after 5s` with no predicate
  // installed at all, 15 replies on one host across four stops (4, 3, 1, 7).
  // The disagreement is the only reason either of us looked.
  //
  // It is fixable only in a pair. The proxy may stop cutting here ONLY because
  // the holder now settles on the release announcement instead of on this
  // process's exit; before that, patience here was downtime and the ceiling was
  // buying something real (120s against a 90s TimeoutStopSec took restart
  // downtime 5.0s -> 53.9s). Delete either half and this case must fail.
  it("a stop under a live holder waits for a reply instead of severing it", async () => {
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const t = setInterval(() => { try { r.write(`data: ${++i}\n\n`); } catch {} }, 200);
      r.on("close", () => clearInterval(t));
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    // OUR OWN PID AS THE HOLDER MARKER. `heldByLiveHolder` is
    // CACHE_FIX_HELD_BY === String(process.ppid), and we ARE the proxy's parent,
    // so this is the real predicate rather than a stand-in for it.
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CACHE_FIX_HELD_BY: String(process.pid),
      CACHE_FIX_DRAIN_STALL_MS: "5000",   // 200ms writes keep it inside the window
      CACHE_FIX_DRAIN_MS: "2000",         // budget expires while it is still streaming
    });
    try {
      const p = await port;
      let chunks = 0;
      const req = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => { res.on("data", () => { chunks++; }); res.on("error", () => {}); });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));

      while (chunks < 3) await new Promise((r) => setTimeout(r, 100));
      // SIGHUP, NOT SIGTERM, because that is what a stop actually looks like from
      // here: the holder rewrites every stop to SIGHUP before forwarding
      // (claude-via-proxy.mjs `sig = "SIGHUP"`), so a case that sends SIGTERM is
      // testing a signal this process never receives under a holder.
      proc.kill("SIGHUP");

      await new Promise((r) => setTimeout(r, 6_000));   // well past the 2s budget

      const err = stderr();
      assert.ok(chunks > 3, `premise: the reply stopped streaming on its own (${chunks} chunks)`);
      assert.doesNotMatch(err, /forcing close/,
        `a stop severed a reply the stall test had not ended. stderr:\n${err}`);
      assert.match(err, /still waiting/,
        `a drain that stays past its budget must say so, and say what it is waiting ` +
        `on. stderr:\n${err}`);
      // THE COST, ASSERTED RATHER THAN TOLERATED. Not cutting means the process
      // is still here. How often that happens is bounded by CONCURRENT ACTIVITY,
      // not by deploy count: an upstream hop carrying a live stream keeps the
      // drainer alive, and a host with no live stream drains clean and exits.
      // Measured across three machines — two carried a resident for over two
      // hours each, the third held zero connections and no drainer at all.
      // A case that only checked "no cut" would pass identically on a build that
      // exited, and would hide the half of the trade that costs something.
      assert.equal(proc.exitCode, null,
        "the drain ended anyway, so this case is no longer showing what not-cutting " +
        "costs — one resident process per stop, unbounded in count");
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      upstream.close();
    }
  });

  // THE CONTROL, and without it the case above only proves the ceiling was
  // deleted. Standalone, nothing supervising: this process IS what a caller is
  // waiting on, so the bet a ceiling makes is real here and it must still cut.
  it("a standalone stop keeps its ceiling and does sever a live reply", async () => {
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const t = setInterval(() => { try { r.write(`data: ${++i}\n\n`); } catch {} }, 200);
      r.on("close", () => clearInterval(t));
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CACHE_FIX_HELD_BY: "",              // no holder — the whole difference
      CACHE_FIX_DRAIN_STALL_MS: "5000",
      CACHE_FIX_DRAIN_MS: "2000",         // ignored on this arm; asserted above
    });
    try {
      const p = await port;
      let chunks = 0;
      const req = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => { res.on("data", () => { chunks++; }); res.on("error", () => {}); });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));

      while (chunks < 3) await new Promise((r) => setTimeout(r, 100));
      proc.kill("SIGHUP");
      const { code } = await exitOf(proc);

      const err = stderr();
      assert.match(err, /forcing close/,
        `a standalone stop waited past its ceiling. Nothing here settles early on our ` +
        `behalf, so patience is somebody's downtime. stderr:\n${err}`);
      assert.match(err, /after 5s/,
        `the standalone ceiling is no longer 5s. stderr:\n${err}`);
      assert.equal(code, 0, "a deliberate stop must not look like a crash");
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      upstream.close();
    }
  });

  // EXIT 0, NOT 75, AND IT IS LOAD-BEARING RATHER THAN COSMETIC.
  //
  // One machine on this fleet carries a launchd agent for a DIFFERENT install of
  // this proxy (the npm-global tree, not the deployed fork) with
  // `KeepAlive = { SuccessfulExit = false }` — it restarts only a NON-ZERO exit.
  // It is dormant and it is not the parent of today's holder, which is what makes
  // the design survivable; but a drainer that starts exiting 75 there gets
  // resurrected as a second listener from a stale tree. 75 means "put a successor
  // on this socket" and a stop is precisely the case where nobody should.
  it("a stop exits 0 and never asks for a successor, held or not", async () => {
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "application/json" });
      setTimeout(() => { try { r.end(JSON.stringify({ ok: true })); } catch {} }, 300);
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    for (const [what, heldBy] of [["held", String(process.pid)], ["standalone", ""]]) {
      const { proc, port } = startProxy({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
        CACHE_FIX_HELD_BY: heldBy,
      });
      try {
        const p = await port;
        const req = http.request(
          { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
            headers: { "content-type": "application/json" } },
          (res) => { res.on("data", () => {}); res.on("error", () => {}); });
        req.on("error", () => {});
        req.end(JSON.stringify({ model: "x", messages: [] }));

        await new Promise((r) => setTimeout(r, 100));
        proc.kill("SIGHUP");
        const { code } = await exitOf(proc);
        assert.equal(code, 0,
          `a ${what} stop exited ${code}. 75 asks a supervisor to put a successor on ` +
          `this socket; under a launchd agent with SuccessfulExit=false a non-zero ` +
          `exit is also what gets restarted, and on one host that agent points at a ` +
          `stale npm-global install`);
      } finally {
        try { proc.kill("SIGKILL"); } catch {}
      }
    }
    upstream.close();
  });

  it("says what was owed when the drain started, even when it ends clean", async () => {
    // `drained clean in Xs of Ys budget` means everything owed FINISHED inside
    // the budget. It does NOT mean nothing was owed -- and nothing anywhere says
    // how much was. So "how often does a stop have anything at risk" cannot be
    // derived from these logs at all: a clean line and a stop with nothing in
    // flight are the same text.
    //
    // That number is what the supervised arm's cost is argued from, and the
    // sample behind it is four terminations. This makes every stop report it.
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "application/json" });
      setTimeout(() => { try { r.end(JSON.stringify({ ok: true })); } catch {} }, 500);
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    });
    try {
      const p = await port;
      let done = false;
      const req = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => { res.on("data", () => {}); res.on("end", () => { done = true; }); res.on("error", () => {}); });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [] }));

      // Signal while the reply is still owed; it finishes well inside the 5s
      // budget, so the drain ends CLEAN with something having been at risk.
      await new Promise((r) => setTimeout(r, 150));
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));

      const err = stderr();
      const line = err.match(/shutdown: drained.*/)?.[0] ?? "";
      // PRECONDITION: this must be the CLEAN path, not a cut. A cut line would
      // already carry a count and the case would prove nothing.
      assert.ok(line, `no drained line at all. stderr:\n${err}`);
      assert.doesNotMatch(line, /forcing close/,
        `the drain cut instead of finishing clean, so this case is not measuring ` +
        `the clean path: ${line}`);
      assert.ok(done, "premise: the reply never completed, so nothing was owed and finished");

      // NOT `[0-9]+`. This case holds a reply open across the stop, so the count
      // is known to be at least one -- and a shape-only match is satisfied by
      // `owed 0`, which is the exact reading the field exists to distinguish
      // from. Pinning the shape alone leaves the number free to be wrong.
      assert.match(line, /owed [1-9][0-9]* at the start/,
        `a clean drain must still say how much was owed when it began -- otherwise ` +
        `"nothing was in flight" and "everything finished in time" are the same ` +
        `line, and the arm's cost cannot be counted. Got: ${line}`);
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      upstream.close();
    }
  });

  // A DRAIN MUST NOT KEEP THE ADDRESS. The release announcement goes out before
  // the drain, and a holder settles on it, so from that line the port has to be
  // free for whoever takes it next. `http.Server.close()` runs the idle sweep
  // that severs a finished-but-unflushed reply, so the unbind was deferred
  // behind that reply -- and the deferral takes the LISTENING socket with it.
  it("unbinds the port on a stop even while a reply is still flushing", async () => {
    const SIZE = 16 * 1024 * 1024;
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "application/octet-stream",
                         "content-length": String(SIZE) });
      r.end(Buffer.alloc(SIZE, 0x61));          // ignores backpressure
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      // The held arm, so the drain has no ceiling to end it early: this case is
      // about the unbind, not about how long the drain runs.
      CACHE_FIX_HELD_BY: String(process.pid),
      CACHE_FIX_DRAIN_MS: "60000",
    });
    try {
      const p = await port;
      let got = 0, declared = -1, ended = false, resObj = null;
      const req = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => {
          resObj = res;
          declared = parseInt(res.headers["content-length"] ?? "-1", 10);
          res.pause();                          // let the bytes queue on the proxy
          res.on("data", (b) => { got += b.length; });
          res.on("end", () => { ended = true; });
          res.on("error", () => {});
        });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [] }));

      const upTo = Date.now() + 15_000;
      while (declared < 0 && Date.now() < upTo) await new Promise((r) => setTimeout(r, 50));
      assert.ok(declared > 0, "premise: the proxy never answered, so nothing is flushing");
      // Long enough for the whole body to reach the proxy and for it to call
      // end() with the client still not reading.
      await new Promise((r) => setTimeout(r, 1_500));

      proc.kill("SIGHUP");
      await new Promise((r) => setTimeout(r, 3_000));

      const state = await new Promise((res) => {
        const s = net.connect(p, "127.0.0.1");
        s.on("connect", () => { s.destroy(); res("still listening"); });
        s.on("error", (e) => res(e.code));
        setTimeout(() => { try { s.destroy(); } catch {} res("timeout"); }, 2_000);
      });
      assert.equal(state, "ECONNREFUSED",
        `the port was ${state} 3s after the stop announced it had released the ` +
        `listening socket. The unbind is deferred behind a reply that cannot flush, ` +
        `so the address stays held for the whole drain budget -- 30 minutes by ` +
        `default -- and the dying proxy goes on ACCEPTING requests it will cut. ` +
        `stderr:\n${stderr()}`);

      // AND THE REPLY SURVIVED IT. Unbinding by severing passes the assertion
      // above and is the defect the deferral was introduced to fix.
      resObj?.resume();
      const t0 = Date.now();
      while (!ended && Date.now() - t0 < 25_000) await new Promise((r) => setTimeout(r, 100));
      assert.equal(got, declared,
        `the unbind severed a finished-but-unflushed reply: the client received ` +
        `${got} of a declared ${declared} bytes. stderr:\n${stderr()}`);
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      upstream.close();
    }
  });

  // `quiet` IS THE FIELD THAT SAYS WHETHER A CUT MATTERED, so it must not report
  // a live reply as silent. The stall loop runs on the handover arm only; with no
  // record the forced close dates a connection from ARRIVAL, which is its whole
  // age rather than the time it had been silent.
  it("a forced close reports silence, not the age of the request", async () => {
    const upstream = http.createServer((q, r) => {
      q.resume();
      r.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const t = setInterval(() => { try { r.write(`data: ${++i}\n\n`); } catch {} }, 200);
      r.on("close", () => clearInterval(t));
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { proc, port, stderr } = startProxy({
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CACHE_FIX_HELD_BY: "",            // the standalone arm: a 5s ceiling, no stall loop
    });
    try {
      const p = await port;
      let chunks = 0, lastAt = 0;
      const req = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => { res.on("data", () => { chunks++; lastAt = Date.now(); });
                   res.on("error", () => {}); });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));

      while (chunks < 3) await new Promise((r) => setTimeout(r, 50));
      // OLDER THAN THE CEILING BY A MARGIN, and never silent for a moment of it.
      // A young request cannot tell the two readings apart.
      await new Promise((r) => setTimeout(r, 12_000));
      assert.ok(Date.now() - lastAt < 2_000,
        "premise: the fixture stopped streaming on its own, so there is a real silence");

      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));

      const line = stderr().match(/shutdown: forcing close.*/)?.[0] ?? "";
      assert.ok(line, `no forced-close line at all. stderr:\n${stderr()}`);
      const quiet = Number(/quiet ([0-9.]+)/.exec(line)?.[1]);
      assert.ok(Number.isFinite(quiet), `the line carries no quiet figure: ${line}`);
      assert.ok(quiet < 6,
        `a reply delivering a chunk every 200ms was reported as quiet ${quiet}s. ` +
        `That is its AGE, not its silence, and it reads as "the cut took a reply ` +
        `that was already dead" about the one case the drain exists to protect. ` +
        `Got: ${line}`);
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      upstream.close();
    }
  });

});
