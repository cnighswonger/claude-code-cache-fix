// ONE CASE, ITS OWN FILE — the same remedy proxy-holder-handover.test.mjs
// applies to itself, and for the same measured reason.
//
// This case runs a full run-service holder, its proxy child, an in-flight
// connection, a 3 s settle and a cleanup loop that SIGHUPs every pid on its
// port. node runs a `describe`'s subtests concurrently, so inside the handover
// file it starved its neighbours: measured over 7 full-suite runs, 3 failures,
// all in that file and varying between cases — while the identical tree with
// this case excised was 0 failures in 3. The case itself is sound and
// mutation-checked; it needed isolating, not deleting.
//
// node gives each FILE its own process, which is the whole mechanism.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OURS, cmdOf, freePort, listeners } from "./proc-helpers.mjs";
import { tmpdir } from "node:os";

// A PRIVATE TMPDIR FOR THE WHOLE FILE. Every launcher spawned here inherits
// process.env, and the launcher writes cache-fix-proxy-<port>.sha256 under
// os.tmpdir() on each spawn — so without this the run leaves those records in
// the shared /tmp, one per spawn. Set once rather than at each spawn site: the
// env is inherited, so this also covers sites added later.
const FILE_TMP = mkdtempSync(join(tmpdir(), "ccf-so-"));
process.env.TMPDIR = FILE_TMP;

const here = dirname(fileURLToPath(import.meta.url));
const launcherPath = join(here, "..", "bin", "claude-via-proxy.mjs");
const serverPath = join(here, "..", "proxy", "server.mjs");

const probe = (port) => new Promise((res) => {
  const r = http.get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 8_000 },
                     (s) => { s.resume(); s.on("end", () => res(s.statusCode === 200 ? "ok" : `ERR:${s.statusCode}`)); });
  r.on("error", (e) => res(`ERR:${e.code}`));
  r.on("timeout", () => { r.destroy(); res("ERR:ETIMEDOUT"); });
});

describe("shutdown runs once per stop", () => {
  // A SUPERVISED STOP DELIVERS MORE THAN ONE SIGNAL, AND THE BODY MUST RUN ONCE.
  //
  // shutdown() is bound to SIGTERM, SIGINT and SIGHUP. systemd SIGTERMs the
  // whole control group, so the proxy receives it directly AND the holder
  // forwards its own SIGHUP — two entries into a function with no guard. Each
  // re-announces the release and arms another 5s force-close.
  //
  // WHAT THIS CASE DOES NOT PROVE, said plainly because the comment here used to
  // claim it did: the second entry cannot spawn a second successor IN THIS
  // SHAPE. `askForSuccessor` is `inheritedSocket && !releasing &&
  // !heldByLiveHolder`, and this fixture runs the child under a LIVE holder that
  // is its ppid — so heldByLiveHolder is true and the spawn half is gated off
  // before re-entry is even reachable. The "two proxies on one socket" outcome
  // belongs to the orphaned-child shape (holder gone), which this does not set
  // up. A comment that names an outcome the fixture cannot reach is how a
  // half-covered guard reads as fully covered.
  //
  // Counted on the announcement rather than on surviving processes: the line is
  // emitted once per entry into shutdown(), so it reports the re-entry directly
  // instead of through whatever the holder does about it — and the re-entry is
  // the defect this case exists to catch.
  it("announces its release exactly once, however many stop signals arrive", async () => {
    const port = await freePort();
    const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port),
                  CACHE_FIX_FORWARD_PROXY: "on", CACHE_FIX_SELF_HEAL: "off" };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID",
                     "CACHE_FIX_HOLD_PORT", "CACHE_FIX_WATCH_DEPLOY_MS"]) delete env[k];
    const holder = spawn(process.execPath, [launcherPath, "run-service"],
                         { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    holder.stdout.on("data", (d) => { out += d; });
    try {
      const up = Date.now() + 25_000;
      let body = await probe(port);
      while (body.startsWith("ERR:") && Date.now() < up) body = await probe(port);
      assert.equal(body, "ok", "the holder never came up, so nothing was measured");

      // The proxy CHILD, which is what a control-group signal reaches directly.
      const kid = listeners(port)
        .map(Number)
        .find((q) => /server\.mjs/.test(cmdOf(q)));
      assert.ok(kid, "premise: there must be a proxy child to signal");

      out = "";
      // A REQUEST MUST BE IN FLIGHT, and this is not decoration — it is the
      // window. With nothing to drain, close() resolves on the next tick and
      // process.exit() beats the second signal's delivery, so an unguarded
      // shutdown announces once and the case passes against the defect
      // (measured: guard removed, still 1). A live Claude session always has a
      // streaming response open — which is why the 5s watchdog is the NORMAL
      // exit under systemd — so the drain is the real condition, not the edge.
      const inflight = net.connect(port, "127.0.0.1");
      await new Promise((r) => inflight.on("connect", r));
      inflight.on("error", () => { });
      // Headers complete, body promised and never sent: the connection is
      // "sending a request", which is exactly what server.close() waits for.
      inflight.write("POST /v1/messages HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n");
      await new Promise((r) => setTimeout(r, 300));

      // Both signals, back to back, the way a control-group stop delivers them.
      try { process.kill(kid, "SIGTERM"); } catch { }
      try { process.kill(kid, "SIGHUP"); } catch { }
      await new Promise((r) => setTimeout(r, 3_000));
      try { inflight.destroy(); } catch { }

      const n = (out.match(/releasing the listening socket/g) || []).length;
      assert.equal(n, 1,
        `the proxy entered shutdown ${n} times for one stop — each entry re-announces ` +
        `the release and arms another 5s force-close (and where the successor spawn is ` +
        `NOT gated off — unlike here — each would also put another successor on the ` +
        `socket). saw: ${JSON.stringify(out.slice(-300))}`);
    } finally {
      try { holder.kill("SIGHUP"); } catch { }
      // SIGHUP, not SIGTERM: SIGHUP is the signal that GIVES THE ADDRESS AWAY,
      // so the standby lets go of the socket instead of sitting on the port.
      for (let i = 0; i < 6; i++) {
        const held = listeners(port);
        if (!held.length) break;
        for (const q of held) {
          const pid = Number(q);
          if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, "SIGHUP"); } catch { } }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  });

  // THE OTHER HALF OF THE SAME DECISION, and it had no test at all.
  //
  // Measured before writing this: `askForSuccessor = false` hard-coded, and 66
  // of 66 tests across proxy-holder-handover / proxy-shutdown-once /
  // proxy-held-port / proxy-server still passed. A guard nothing kills is a
  // guard the next person deletes — and this one is why a stop does not take
  // the address down under every session that baked it as HTTPS_PROXY.
  //
  // THE DECISION, NOT THE SPAWN, and that boundary is measured. The obvious
  // process-level fixture cannot be built: SIGKILLing the holder takes the child
  // with it (its stdout is a pipe to the holder, next write EPIPEs). Measured
  // t+0.4s..t+3.2s — the only listener left was the standby relay answering 503.
  // So the shape reaching this line is a supervisor handing fd 3 to a proxy it
  // does not parent, and what is worth pinning is how the three inputs resolve.
  // Lifted from source, so a hard-coded `false` fails the handover row below.
  it("asks for a successor only when nothing else owns the socket", () => {
    const src = readFileSync(serverPath, "utf8");
    const held = /const heldByLiveHolder = [\s\S]*?;\n/.exec(src)?.[0];
    const ask = /const askForSuccessor = [^\n]*\n/.exec(src)?.[0];
    assert.ok(held && ask,
      "the successor decision moved — this case no longer tests it");

    const decide = (env, active, releasing) =>
      // eslint-disable-next-line no-new-func
      Function("process", "active", "releasing",
        `${held}${ask}return askForSuccessor;`)({ env, ppid: 4242 }, active, releasing);

    const inherited = { inheritedSocket: true };

    // A LIVE HOLDER OWNS THE SOCKET, so exiting is safe and spawning is not:
    // the successor would be a proxy the holder never placed and does not
    // supervise, and cswap's pin measured that shape serving UNHELD on another
    // port for 76 minutes with every health signal green.
    assert.equal(decide({ CACHE_FIX_HELD_BY: "4242" }, inherited, false), false,
      "a child under its live holder asked for a successor the holder did not place");

    // NOBODY ABOVE US. A handover successor has HELD_BY cleared precisely so it
    // reads as unheld; exiting quietly here drops the last descriptor and the
    // address dies under sessions that cannot re-read HTTPS_PROXY.
    //
    // `{}` IS that shape — an absent HELD_BY is the whole of it. This row used
    // to pass a `CACHE_FIX_FROM_HANDOVER: "1"` key, which the decision never
    // read; it made the row look like it covered a variable it does not touch.
    // That variable has since been deleted as a dead wire. Name the input the
    // expression actually consumes.
    assert.equal(decide({}, inherited, false), true,
      "an unheld proxy on an inherited socket exited without handing it on — " +
      "the address goes with it, and every session baked to it is stranded");

    // HELD_BY SET BUT STALE: the holder died and we were reparented, so the name
    // it left behind no longer matches our parent. Comparing the marker to the
    // live ppid is what tells those apart — a bare `!!HELD_BY` reads this as
    // held and takes the address down.
    assert.equal(decide({ CACHE_FIX_HELD_BY: "999999" }, inherited, false), true,
      "a stale HELD_BY marker was read as a live holder");

    // Nothing to hand on: a proxy that bound its own port has no inherited
    // descriptor, and a `releasing` one is already yielding to a claimant.
    assert.equal(decide({}, { inheritedSocket: false }, false), false,
      "a proxy that bound its own port tried to hand it over");
    assert.equal(decide({}, inherited, true), false,
      "a proxy already releasing to a claimant spawned a rival for it as well");
  });

  // THE TWO EXIT PATHS MUST AGREE ABOUT WHAT OUR EXIT MEANS, and the file says
  // so in its own comment ("the two paths must not disagree"). They did: the
  // graceful close exits `handedOff ? 75 : 0` while the 5s watchdog exited 0
  // unconditionally — and this file calls the watchdog "the NORMAL exit under
  // systemd", because a live session always has a streaming response open. So
  // the ordinary stop of a proxy that HAD handed its socket on reported EX_OK,
  // and a supervisor keyed on 75 read "nothing to succeed to" for a lineage
  // that had a successor already serving.
  //
  // A SOURCE ASSERTION, and deliberately: driving the watchdog to 75 needs a
  // proxy on an INHERITED socket (fd 3, no HELD_BY) with a request in flight,
  // and the fixture for that has two acceptors on one descriptor — the test's
  // own listener and the proxy's — so the in-flight request lands on the wrong
  // one about half the time. The invariant here is "these two literals are the
  // same", which text can state exactly and a mutation can break, so text is
  // the honest instrument rather than a flaky process fixture.
  it("exits with the same code from the watchdog as from the graceful close", () => {
    const src = readFileSync(serverPath, "utf8").replace(/\/\/[^\n]*/g, "");
    const graceful = /process\.exit\((handedOff [^)]*)\)/.exec(src)?.[1];
    assert.ok(graceful, "the graceful close no longer exits on handedOff — this tests nothing");

    // Everything the watchdog can exit with: either the expression inline, or a
    // local it assigns from. Both forms must trace back to the same one.
    // ANCHOR AT THE START OF THE WATCHDOG BODY. This used to slice from the
    // literal "forcing close", which moved into forcedCloseLine() near the top
    // of the file when the forced path started reporting what it cut — so the
    // slice then covered the graceful close too and compared it against itself.
    // Anchoring on the ANNOUNCE instead fixed that and opened a new hole:
    // measured, an `if (...) process.exit(0)` inserted BEFORE the announce went
    // undetected. Anchoring on the first STATEMENT moved the hole rather than
    // closing it — also measured, a bail inserted above `let ended` stayed
    // green. Only the callback's opening brace is above everything the body can
    // contain, so that is where the region has to start.
    const anchor = src.indexOf("setTimeout(() => {", src.indexOf("active.close().finally"));
    assert.ok(anchor > 0, "the watchdog callback moved — re-anchor this test");
    const watchdogRegion = src.slice(anchor);
    const assigned = /const code = ([^;]+);/.exec(watchdogRegion)?.[1];
    const exits = [...watchdogRegion.matchAll(/process\.exit\(([^)]*)\)/g)].map((m) => m[1].trim());
    assert.ok(exits.length, "the watchdog no longer exits — this tests nothing");

    for (const e of exits) {
      const resolved = e === "code" ? assigned : e;
      assert.equal(resolved, graceful,
        `the watchdog exits ${JSON.stringify(e)}${e === "code" ? ` (= ${JSON.stringify(assigned)})` : ""} ` +
        `while the graceful close exits ${JSON.stringify(graceful)} — the watchdog IS the ` +
        `normal stop under systemd, so this is the code a supervisor actually sees, and a ` +
        `bare 0 tells it there is no successor when one is already serving`);
    }
  });
});

// LAST, so it cannot delete the dir out from under a sweep that reaps ports
// after the cases: node runs root hooks in registration order.
after(() => { try { rmSync(FILE_TMP, { recursive: true, force: true }); } catch { /* gone */ } });
