import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFile, rm } from "node:fs/promises";
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, cpus } from "node:os";
import { join, dirname } from "node:path";

const launcherPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-via-proxy.mjs");

// EVERY variable that can give a child an outbound hop, in one list because six
// fixtures scrub it and a per-fixture copy is how one gets missed. It was: five
// of them dropped the four *_PROXY names and none dropped the two CACHE_FIX
// ones, which the relay reads FIRST (bin/gap-relay.mjs) — so a maintainer behind
// a corp proxy ran the suite, the relay carried to it, and its host:port went
// into the 503 body that a failure message now prints. This repo is public and
// that is the hostname-port class its hygiene rule bans.
const HOP_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                 "ALL_PROXY", "all_proxy",
                 "CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_FALLBACK_PROXIES"];

// WHAT A PROBE RESULT MEANS. One definition, because four hand-rolled ones is
// how the same lesson gets learned once per case and then goes red again in the
// next one.
//
// The holder's guarantee is that the ADDRESS ALWAYS HAS AN OWNER — a session
// bakes HTTPS_PROXY at exec, so one refusal strands it for good. It does not
// promise that a caching proxy is behind that address every instant, and three
// of the four buckets below are states where it is not and nothing is lost:
//
//   served     200. a proxy answered.
//   carrying   503 {"carrying":"gap-relay"}. THE HOLDER'S OWN MECHANISM. It
//              re-opens the gap on the child-death path and closes it as the
//              successor spawns, and through that window it carries real
//              traffic and 503s /health ONLY — a 200 there would announce a
//              proxy that does not exist. Measured with the window forced to
//              400ms: 19 of 20 probes, body {"carrying":"gap-relay"}. On a fast
//              box the window is ~0 and it never appears, which is why this
//              cost CI 31137828018 (node 18) and would not reproduce locally in
//              13 runs.
//   reset      the kernel tearing down a socket whose last owner was killed.
//              01a9b98 measured 0.046ms/0.880ms with holderAccepted=0 — no
//              holder that releases and reclaims can cover that instant.
//   refused    NOBODY OWNS THE PORT. the one thing that strands a session.
//   degraded   503 {"status":"degraded"}. a real proxy came up with extensions
//              broken. same status line as carrying, opposite meaning.
//
// Order matters: carrying and degraded are both 503 and only the body separates
// them, so the body is tested before the code.
const OUTAGE = { REFUSED: "refused", RESET: "reset", DEGRADED: "degraded" };
function classify(body) {
  if (!body.startsWith("ERR:")) return null;
  if (/"carrying"\s*:\s*"gap-relay"/.test(body)) return null;
  if (/"status"\s*:\s*"degraded"/.test(body)) return OUTAGE.DEGRADED;
  if (/ECONNREFUSED|ETIMEDOUT|HUNG/.test(body)) return OUTAGE.REFUSED;
  return OUTAGE.RESET;
}

// Whoever is LISTENING on a port, by port rather than by parentage. The
// self-heal spawns a DETACHED successor, so it is nobody's child and `pgrep -P`
// cannot see it — the only durable handle on it is the address it took.
function listeners(port) {
  try {
    return execFileSync("lsof", ["-nP", "-t", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"],
                        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter(Boolean);
  } catch { return []; }
}

// The command line of a pid, or "" if it is gone. Every case here has to tell
// a holder from a proxy from a standby relay, and they are only distinguishable
// by what they are running.
const cmdOf = (pid) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }); }
  catch { return ""; }
};

const usedPorts = [];
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  usedPorts.push(p);
  return p;
}

// Its own file: every case here drives a REAL launcher holding a REAL port, so
// a mis-signalled pid or a stuck child aborts the whole runner process. Node
// runs each test file in its own process, which keeps that blast radius here.
// Concurrent, but BOUNDED BY CORES: each case boots a real proxy under its own
// 10s startup budget, and unbounded concurrency blew that budget on CI's 2-core
// runner — measured, "Proxy failed to start within 10s" on every node, while a
// 48-core box passed every time. Serial, the file pays the sum of the waits; at
// cpus/2 it pays close to the longest one without starving any boot.
const CONCURRENCY = Math.max(2, Math.floor(cpus().length / 2));

describe("held port (CACHE_FIX_HOLD_PORT)", { concurrency: CONCURRENCY }, () => {
// The default is declared in proxy/config.mjs and repeated in the launcher.
// If they drift, an unset CACHE_FIX_PROXY_PORT binds one port while callers
// dial the other.
it("holds the same default port the proxy would bind, and only when unset", () => {
  const launcher = readFileSync(launcherPath, "utf8");
  const cfg = readFileSync(join(dirname(launcherPath), "..", "proxy", "config.mjs"), "utf8");
  const want = /envInt\("CACHE_FIX_PROXY_PORT",\s*(\d+)\)/.exec(cfg)?.[1];
  assert.ok(want, "proxy/config.mjs no longer declares a CACHE_FIX_PROXY_PORT default");
  // Anchored on the CONDITIONAL, not on the number: the comment beside it names
  // 9801 too, so a bare grep for the literal passes on the prose that explains
  // the bug. Not assert.match either — a failing match prints the whole launcher.
  const held = /\?\s*(\d+)\s*:\s*Number\(rawPort\)/.exec(launcher)?.[1];
  assert.equal(held, want, `the holder falls back to ${held}, the proxy to ${want}`);
  // AND THE DEFAULT MUST NOT SWALLOW AN EXPLICIT 0. `Number(env) || 9801` read
  // "take an ephemeral port" as "take the legacy port", so a holder asked for 0
  // bound 9801 — the address the fleet stopped dialling — while config.mjs read
  // the same variable with envInt and yielded 0. Measured: `run-service` with
  // CACHE_FIX_PROXY_PORT=0 listening on 127.0.0.1:9801.
  const decide = Function("rawPort",
    `${/const port = rawPort ===[\s\S]*?Number\(rawPort\);/.exec(launcher)?.[0]}\nreturn port;`);
  assert.equal(decide("0"), 0, "an explicit port 0 was rewritten to the default");
  assert.equal(decide(undefined), Number(want), "an unset port did not fall back to the default");
  assert.equal(decide(""), Number(want), "an empty port did not fall back to the default");
  assert.equal(decide("nonsense"), Number(want), "an unparseable port did not fall back to the default");
  assert.equal(decide("9901"), 9901, "an explicit port was not honoured");
});

// A launcher holding a real port, its /health probe, and its reaper. The
// held-port tests need all three; `get` answers "ERR:<code> <body>" rather than
// throwing so a caller can count failures instead of catching them — and the
// body is what names which of /health's two 503 authors replied.
async function withHeldPort(fn, { subcommand = "server", extraEnv = {} } = {}) {
  const port = await freePort();          // a real number: the holder owns the ADVERTISED port
  // Self-heal OFF by default. A proxy whose holder was SIGKILLed spawns a
  // REPLACEMENT holder about a second later, and nothing in a test tracks that
  // grandchild — measured, three leaked per run of this file, reparented to
  // init, accumulating until the box stalls. The cases that MEASURE self-heal
  // turn it back on through extraEnv, so the behaviour is still covered.
  // CACHE_FIX_WATCH_DEPLOY_MS and CACHE_FIX_SELF_HEAL are scrubbed for the same
  // reason as the proxy vars: an operator who exported one while debugging
  // would change what these cases measure. Each test sets what it needs
  // through extraEnv, so the ambient value must never reach the child —
  // measured, an exported WATCH_DEPLOY_MS turns "is off unless asked for"
  // into a failure about the shell rather than about the code.
  const env = { ...process.env };
  for (const k of [...HOP_ENV, "LISTEN_FDS", "LISTEN_PID", "CACHE_FIX_WATCH_DEPLOY_MS", "CACHE_FIX_SELF_HEAL"]) delete env[k];
  Object.assign(env, { CACHE_FIX_HOLD_PORT: "on", CACHE_FIX_PROXY_PORT: String(port),
                       CACHE_FIX_SELF_HEAL: "off",
                       // A SIGKILLed runner runs no cleanup, so ask the holder to
                       // notice and go. Production does the opposite on purpose:
                       // wire.zsh backgrounds it and the shell exits, so ppid 1 is
                       // the normal launch, not a death.
                       CACHE_FIX_EXIT_WITH_PARENT: "1", ...extraEnv });
  const launcher = spawn(process.execPath, [launcherPath, subcommand], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((r) => launcher.on("exit", () => r(true)));
  // 200 OR IT IS NOT THE PROXY. The gap relay answers /health too, with a 503
  // and a JSON body of its own, so a readiness loop that took any body finished
  // against the relay that covers a cold start — measured, six cases in this
  // file went red on `JSON.parse(body).status` being undefined, and which ones
  // depended on the race.
  //
  // THE BODY RIDES ALONG ON A FAILURE, because 503 has two authors and the
  // status line cannot tell them apart: the relay says {"carrying":"gap-relay"}
  // and a degraded proxy says {"status":"degraded","failed_extensions":[...]}.
  // Measured on CI run 31137828018 (node 18 only): "cut 6 connection(s) ...
  // ERR:503" named neither, and the case reproduces on no local run — 9 of 9
  // green, 8 of them under saturating load.
  const get = () => new Promise((res) => {
    http.get({ host: "127.0.0.1", port, path: "/health", timeout: 8_000 }, (r) => {
      let b = ""; r.on("data", (d) => (b += d));
      r.on("end", () => res(r.statusCode === 200 ? b : `ERR:${r.statusCode} ${b.slice(0, 160)}`));
    }).on("error", (e) => res(`ERR:${e.code}`));
  });
  // pgrep, never a pid arithmetic shortcut: `process.kill(0, ...)` signals the
  // caller's whole process group — the test runner included — and Number("")
  // and Number(undefined) are both 0.
  // THE PROXY child. A holder also parents a standby relay, so the first pid is
  // not reliably the one a case means to kill.
  const proxyPid = () => {
    let out = "";
    try { out = execFileSync("pgrep", ["-P", String(launcher.pid)]).toString(); } catch { return 0; }
    const pid = Number(out.trim().split("\n").filter(Boolean)
      .find((q) => /server\.mjs/.test(cmdOf(q))));
    return Number.isInteger(pid) && pid > 1 ? pid : 0;
  };
  const killProxy = () => {
    const pid = proxyPid();
    assert.ok(pid, "no proxy child to kill, so nothing was restarted");
    process.kill(pid, "SIGKILL");
  };
  try {
    const up = Date.now() + 20_000;
    let body = await get();
    while (body.startsWith("ERR:") && Date.now() < up) body = await get();
    assert.equal(JSON.parse(body).status, "ok", "the held port never came up");
    await fn({ get, killProxy, proxyPid, launcher, exited, port });
  } finally {
    // SIGTERM first: SIGKILL cannot be forwarded, so the proxy would outlive
    // its parent and keep this file's event loop alive on its pipes.
    launcher.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8_000))]);
    try { launcher.kill("SIGKILL"); } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2_000))]);
    // A handover successor is DETACHED and deliberately ignores exit-with-parent
    // — that guard is what makes a redeploy free — so nothing above reaps it. It
    // outlives the launcher still holding this runner's stdio, and the file then
    // finishes every case and never exits. Measured: 25 cases green in 10s, then
    // 8 minutes hung on one survivor, one leaked per run.
    //
    // SIGHUP, not SIGTERM: SIGTERM is the signal that means "hand the socket on",
    // so it would breed the next successor and this loop would never drain.
    for (let i = 0; i < 5 && !process.env.CCF_TEST_NO_REAP; i++) {
      const owners = listeners(port);
      if (!owners.length) break;
      let signalled = 0;
      for (const o of owners) {
        const pid = Number(o);
        if (!Number.isInteger(pid) || pid <= 1) continue;
        // ONLY an orphan. freePort() hands the same number out again once the
        // OS recycles it, so "whoever listens on my port" can be a NEIGHBOUR's
        // live launcher — measured: reaping by port alone killed the holder in
        // "gives the port up when the proxy never starts" mid-run, and it went
        // red having spawned 4 of the 5 proxies it counts. A leaked successor is
        // detached and always reparented to init; every live fixture's process
        // still has the test runner above it.
        let ppid = 0;
        try { ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()); }
        catch { continue; }
        if (ppid !== 1) continue;
        try { process.kill(pid, "SIGHUP"); signalled++; } catch {}
      }
      if (!signalled) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

// The launcher holds the advertised port and relays, so a proxy that dies
// never unbinds it — and a client that baked HTTPS_PROXY at exec, for which
// one refusal is fatal for good, keeps reaching it.
it("cuts nothing on the held port while the proxy restarts", async () => {
  await withHeldPort(async ({ get, killProxy }) => {
    killProxy();
    // Every failure counts, not just ECONNREFUSED: a holder that accepts then
    // drops turns a refusal into a reset while serving nobody. The one allowed
    // is the request in flight at the SIGKILL, which no holder can save.
    //
    // A CARRYING GAP IS NOT A CUT, and this is the one exception. The holder
    // re-opens the gap relay on the child-death path (claude-via-proxy.mjs, at
    // `holder.openGap()` before the restart ladder) and closes it again only as
    // the successor spawns, because two handles may bind one port but only one
    // may listen. Through that window the ADDRESS IS OWNED AND ANSWERING: the
    // relay carries real traffic and answers /health — and only /health — with
    // 503, since every readiness check in the tree reads that endpoint and a
    // 200 there would announce a proxy that does not exist.
    //
    // So a 503 whose body says gap-relay is this case's own probe meeting the
    // mechanism that exists to prevent the outage, not the outage. Measured on
    // CI 31137828018 (node 18, where the window is widest): six of them at 20ms
    // spacing, about 120ms of gap, counted as six cuts. 01a9b98 narrowed the
    // sibling case for exactly this reason a day earlier — "assert what the
    // holder guarantees, not what it cannot" — and this case was left behind.
    //
    // A DEGRADED PROXY'S 503 IS STILL A CUT. Same status line, different author:
    // {"status":"degraded","failed_extensions":[…]} means a real proxy came up
    // broken, which is a defect and must stay red. Telling them apart needs the
    // body, which is why the probe carries it.
    const cut = [];
    let served = false;
    const until = Date.now() + 10_000;
    while (!served && Date.now() < until) {
      const b = await get();
      if (b.startsWith("ERR:")) { if (classify(b)) cut.push(b); }
      else served = JSON.parse(b).status === "ok";
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(cut.length <= 1, `the held port cut ${cut.length} connection(s) during the restart: ` +
      `${[...new Set(cut)].join(", ")}`);
    assert.ok(served, "the proxy never came back on the held port");
  });
});

// NOTHING IS KILLED HERE. The holder and the proxy hold the SAME listening
// socket, and the kernel gives each connection to exactly one of them — so a
// holder that stays open eats a share of ordinary traffic, and a net.Server
// with no connection handler accepts and then hangs until the client's own
// timeout. There is no way to hold a bound socket without accepting: measured,
// net.Server has no pause(), maxConnections=0 accepts then RSTs 19 of 20, and
// nulling _handle.onconnection still hung 66 of 300.
//
// CONCURRENT, which is the whole point: one request at a time is always served
// by whichever process wins, so a serial probe reads 100% healthy against a
// holder losing a fifth of everything. Measured before the fix, 200 concurrent
// requests: hung=36 acceptedByHolder=36, exactly 1:1.
it("serves every concurrent request while nothing restarts", async () => {
  await withHeldPort(async ({ port }) => {
    const one = () => new Promise((res) => {
      const r = http.get({ host: "127.0.0.1", port, path: "/health", agent: false }, (q) => {
        let b = ""; q.on("data", (d) => (b += d));
        q.on("end", () => res(q.statusCode === 200 ? "ok" : `ERR:${q.statusCode} ${b.slice(0, 160)}`));
      });
      // Well under the 8s a hung accept would cost, and far above a served
      // request on loopback: the failure this catches is unbounded, not slow.
      r.setTimeout(3_000, () => { r.destroy(); res("HUNG"); });
      r.on("error", (e) => res(e.code || "ERR"));
    });
    const out = await Promise.all(Array.from({ length: 200 }, one));
    const bad = out.filter((r) => r !== "ok");
    assert.equal(bad.length, 0,
      `${bad.length} of 200 concurrent requests were not served: ` +
      `${[...new Set(bad)].join(", ")} — the holder is accepting connections it cannot answer`);
  });
});

// A client that aborts mid-request (Ctrl-C, a cancelled tool call) sends RST,
// and pipe() does not propagate destroy — so the upstream half would stay
// open. A holder that runs out of descriptors stops accepting on the very
// port it exists to keep alive.
it("leaks no descriptor when a client aborts", async () => {
  await withHeldPort(async ({ get, launcher, port }) => {
    const fds = () => readdirSync(`/proc/${launcher.pid}/fd`).length;
    let before;
    try { before = fds(); } catch { return; }   // /proc-less platform
    const abort = (port) => new Promise((done) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("error", () => done());
      s.on("connect", () => {
        s.write("GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
        // SO_LINGER 0: close sends RST, not FIN — the case pipe() drops.
        setTimeout(() => { s.resetAndDestroy?.() ?? s.destroy(); done(); }, 5);
      });
    });
    // Concurrent, and settled by POLLING rather than by a fixed grace: 60
    // serial round-trips plus a 1.5s wait is 2s of the file's runtime, and a
    // leak that is real never falls back under the ceiling, so the first
    // reading at-or-under it is the final answer.
    await Promise.all(Array.from({ length: 60 }, () => abort(port)));
    const settle = Date.now() + 5_000;
    while (fds() > before + 5 && Date.now() < settle) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fds() <= before + 5, `descriptors grew ${before} -> ${fds()} over 60 aborted clients`);
    // RETRIED, and parsed only once it is a body. `get()` reports transport
    // failures as "ERR:<code>" strings, and parsing one threw a SyntaxError that
    // named JSON instead of naming the holder — under full-file load a single
    // ECONNRESET here read as a broken test rather than as the thing this line
    // is asking about.
    let after = await get();
    const by = Date.now() + 5_000;
    while (after.startsWith("ERR:") && Date.now() < by) {
      await new Promise((r) => setTimeout(r, 200));
      after = await get();
    }
    assert.ok(!after.startsWith("ERR:"), `the holder stopped serving after the aborts: ${after}`);
    assert.equal(JSON.parse(after).status, "ok", "the holder stopped serving after the aborts");
  });
});

// A launcher whose proxy is a stand-in script, so a start failure can be
// driven on demand. The copy sits beside the real launcher for its relative
// imports; both files are removed again.
// Named per call, not per file: two cases running at once on one fixed name
// would each write the other's stand-in and delete it in their own cleanup.
let fakeSeq = 0;
async function withFakeProxy(serverSrc, fn, { watchMs, selfHeal = "" } = {}) {
  const tag = `${process.pid}-${++fakeSeq}`;
  // NO LEADING DOT. These have to sit inside bin/ — the copy resolves its
  // imports relative to the real launcher — but a hidden file inside the tree is
  // the worst of both: `git status` sees it, `ls bin/` does not. The finally
  // below removes them, so the only way they survive is a runner that was
  // KILLED, which is exactly the moment someone needs to see them. Measured:
  // ten of these sat in bin/ after an interrupted run and were invisible to
  // every listing that did not ask for dotfiles.
  const failing = join(dirname(launcherPath), `scratch-fake-server-${tag}.mjs`);
  const copy = join(dirname(launcherPath), `scratch-launcher-${tag}.mjs`);
  await writeFile(failing, serverSrc);
  await writeFile(copy, readFileSync(launcherPath, "utf8").replace(
    /const SERVER_PATH = .*/, `const SERVER_PATH = ${JSON.stringify(failing)};`));
  const port = await freePort();
  // The backoff ladder is what these cases measure, and at its 250ms default
  // they measure it by sleeping through it — 22s of the file's runtime. The
  // seam shrinks the RUNGS, not the count, so the shape under assertion (does
  // it back off? does it give up after 5?) is the shipped one.
  const env = { ...process.env };
  for (const k of [...HOP_ENV, "LISTEN_FDS", "LISTEN_PID", "CACHE_FIX_WATCH_DEPLOY_MS", "CACHE_FIX_SELF_HEAL"]) delete env[k];
  Object.assign(env, { CACHE_FIX_HOLD_PORT: "on", CACHE_FIX_PROXY_PORT: String(port),
                       CACHE_FIX_RESTART_BASE_MS: "25", CACHE_FIX_SELF_HEAL: selfHeal || "off",
                       ...(watchMs ? { CACHE_FIX_WATCH_DEPLOY_MS: String(watchMs) } : {}) });
  // An ambient LISTEN_FDS sends the launcher down the socket-activation path
  // instead of the holder, and an ambient proxy var routes its own requests
  // through a proxy that is not there.
  // CACHE_FIX_WATCH_DEPLOY_MS and CACHE_FIX_SELF_HEAL are scrubbed for the same
  // reason as the proxy vars: an operator who exported one while debugging
  // would change what these cases measure. Each test sets what it needs
  // through extraEnv, so the ambient value must never reach the child —
  // measured, an exported WATCH_DEPLOY_MS turns "is off unless asked for"
  // into a failure about the shell rather than about the code.
  const launcher = spawn(process.execPath, [copy, "server"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  launcher.stderr.on("data", (d) => (err += d));
  const bound = () => new Promise((r) => {
    const s = net.createServer();
    s.once("error", () => r(true));
    s.listen({ port, host: "127.0.0.1" }, () => s.close(() => r(false)));
  });
  try {
    await fn({ launcher, port, bound, stderr: () => err, serverFile: failing });
  } finally {
    // SIGTERM FIRST, and wait for it. SIGKILL cannot be forwarded, so a killed
    // launcher leaves its proxy running — and that grandchild holds the pipes
    // this runner is waiting on. Measured: every case here exited in about a
    // second while the FILE took 300s and then failed with "Promise resolution
    // is still pending but the event loop has already resolved". On the
    // personal Mac the same leak sat 29 minutes with holders still alive.
    launcher.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => launcher.on("close", r)),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    try { launcher.kill("SIGKILL"); } catch {}
    // AND THE STANDBY. It is detached and outlives a launcher that exited on
    // its own, which is the point of it — but a case that leaks one leaves an
    // ephemeral port held for the rest of the run. SIGHUP is the word it
    // answers; the fixture is the one place that knows every case is over.
    //
    // RETRIED, because a standby that has not armed yet holds a socket nobody
    // ever listened on, and `lsof -sTCP:LISTEN` cannot see it. It becomes
    // visible when it arms, which takes its poll plus its silence window —
    // measured, a single immediate pass left 14 of them alive across one run.
    for (let i = 0; i < 6; i++) {
      const held = listeners(port);
      if (i && !held.length) break;
      for (const q of held) { try { process.kill(Number(q), "SIGHUP"); } catch { } }
      await new Promise((r) => setTimeout(r, 600));
    }
    await rm(failing, { force: true });
    await rm(copy, { force: true });
  }
}

// Never served: no session is wired to this port, so nothing is stranded by
// letting it go — and a lineage that respawns a hopeless proxy forever is the
// defect. The ADDRESS is a separate question from the SUPERVISOR: a standby
// relay keeps the socket alive and carries, so what must end here is the
// respawning, and the port must still be takeable by anything that asks.
it("gives the port up when the proxy never starts", async () => {
  await withFakeProxy('process.stderr.write("simulated\\n"); process.exit(1);\n',
    async ({ launcher, port, bound, stderr }) => {
      // 30s, and the number is the cost of FIVE NODE STARTUPS — not of the
      // backoff, which the fixture already shrinks to 25ms rungs. Measured:
      // 5,943ms alone, 8,053ms inside the file, against a cap that was 8,000 —
      // so this went red on how many neighbours happened to be running, having
      // spawned 4 of the 5 it counts. The cap still has to exist, because the
      // defect it catches is "respawns forever"; it just must not be reachable
      // by load.
      // "close", NOT "exit". exit fires when the process ends, close when its
      // stdio has drained — and this case reads the LAST line the launcher
      // writes. Measured: exitCode=1, signal=null, stderr holding only the 4
      // "simulated" lines, with the give-up line still in the pipe. Alone it
      // drained in time and passed; in the full file it did not. The repo
      // already moved 15 forks off "exit" for exactly this; this one was missed.
      const exited = await Promise.race([
        new Promise((r) => launcher.on("close", () => r(true))),
        new Promise((r) => setTimeout(() => r(false), 30_000)),
      ]);
      assert.ok(exited, "the launcher respawned a hopeless proxy forever, holding the port");
      // ANCHORED ON THE FACT, not on the old wording. The launcher used to say
      // "releasing the port" here and it was not true once a standby stayed
      // behind carrying the address — the line a human reads while diagnosing
      // must not promise a free port that is still bound.
      assert.match(stderr(), /failed to start 5 times; stopping/);
      const lineage = listeners(port).filter((q) => /scratch-launcher-|scratch-fake-server-/.test(cmdOf(q)));
      assert.deepEqual(lineage, [],
        "the launcher gave up but its lineage is still on the port, so it never really let go");
      // AND THE ADDRESS STILL RETIRES, which is the other half of the same
      // harm: a standby that ignored the release word would hold every port a
      // failed launcher ever touched, forever.
      for (const q of listeners(port)) { try { process.kill(Number(q), "SIGHUP"); } catch { } }
      const gone = Date.now() + 5_000;
      while (await bound() && Date.now() < gone) await new Promise((r) => setTimeout(r, 100));
      assert.equal(await bound(), false, "the port survived SIGHUP, so it can never be reclaimed");
    });
});

// Served before: sessions ARE wired to this port, and releasing it strands
// them for good — so a proxy that breaks on a later restart must keep the
// port and keep retrying, backed off rather than spinning.
it("keeps the port and backs off when a proxy that had served stops starting", async () => {
  const flag = join(tmpdir(), `ccf-flip-${process.pid}-${++fakeSeq}`);
  await rm(flag, { force: true });
  await withFakeProxy(
    `import fs from "node:fs"; import net from "node:net";\n` +
    `if (fs.existsSync(${JSON.stringify(flag)})) { process.stderr.write("cannot start\\n"); process.exit(1); }\n` +
    `fs.writeFileSync(${JSON.stringify(flag)}, "1");\n` +
    `const s = net.createServer((c) => c.end("HTTP/1.1 200 OK\\r\\ncontent-length:2\\r\\n\\r\\nok"));\n` +
    `s.listen(0, "127.0.0.1", () => process.stdout.write("proxy listening on 127.0.0.1:" + s.address().port + "\\n"));\n`,
    async ({ launcher, bound, stderr }) => {
      // Let the one good generation come up, then kill it: every restart now
      // fails. Waited on the FLAG the fake proxy writes, not on a duration —
      // a fixed sleep has to cover the slowest box and still races on it.
      const started = Date.now() + 15_000;
      while (!existsSync(flag) && Date.now() < started) await new Promise((r) => setTimeout(r, 20));
      let out = "";
      try { out = execFileSync("pgrep", ["-P", String(launcher.pid)]).toString(); } catch {}
      // THE PROXY child. A holder also parents a standby relay, and taking the
      // first pid killed that instead — the fake proxy went on serving and the
      // case measured a backoff that never happened.
      const kid = Number(out.trim().split("\n").filter(Boolean)
        .find((q) => /scratch-fake-server-/.test(cmdOf(q))));
      assert.ok(Number.isInteger(kid) && kid > 1, "the fake proxy never started, so this measures nothing");
      process.kill(kid, "SIGKILL");
      // Long enough for an UNBACKED-OFF loop to blow the ceiling: at the 25ms
      // base the ladder tops out at 500ms, so ~1.2s admits at most a handful of
      // tries and a spinner would land dozens. Measured both ways below.
      await new Promise((r) => setTimeout(r, 1_200));

      assert.equal(launcher.exitCode, null, "the launcher gave the port up, stranding every wired session");
      // RELEASED means gone for good, not "not listening at the instant I
      // looked". Only ONE handle may listen on a port, so the gap listener has
      // to close before each respawn and the address genuinely does not accept
      // while the next child boots. A single sample lands in that window often
      // enough to matter — measured, 2 of 5 whole-file runs went red here on a
      // holder that had not released anything. Retried, so what fails is a port
      // that never comes back.
      const backUp = Date.now() + 8_000;
      let held = await bound();
      while (!held && Date.now() < backUp) {
        await new Promise((r) => setTimeout(r, 100));
        held = await bound();
      }
      assert.equal(held, true, "the port was released while sessions were still wired to it");
      // Backed off: an unbounded loop reaches ~40 in this window.
      const tries = (stderr().match(/cannot start/g) || []).length;
      assert.ok(tries <= 10, `respawned ${tries} times in 1.2s — the backoff is not applied`);
    });
  await rm(flag, { force: true });
});

// ...and it must still be stoppable. Holding a port across the proxy's death
// means a window with no child to forward a signal to; a stop arriving there
// must still be obeyed, or the holder keeps the port through a supervisor's
// shutdown — the original failure with one more process in the way.
it("stops when signalled between the proxy's death and its respawn", async () => {
  await withHeldPort(async ({ killProxy, launcher, exited }) => {
    killProxy();
    await new Promise((r) => setTimeout(r, 50));   // inside the restart delay
    launcher.kill("SIGTERM");
    const stopped = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 10_000))]);
    assert.ok(stopped, "the holder ignored SIGTERM and kept the port through a supervisor's stop");
  });
});

// SIGHUP means RELEASE, and a takeover is what depends on it. Node's default
// action for SIGHUP also ends the holder, so "did it exit" cannot tell the two
// apart — only the PORT can. A holder that goes without telling its child
// leaves the child holding the socket, and the claimant then waits out its
// deadline against a port that never frees.
it("frees the port when signalled SIGHUP, so a claimant can take it", async () => {
  await withHeldPort(async ({ launcher, exited, port }) => {
    launcher.kill("SIGHUP");
    // Wait for the holder to be GONE, then look once. A poll loop here would
    // call lsof over and over, and execFileSync BLOCKS this runner's event loop
    // for every one of them — the file already documents what that starvation
    // does to its neighbours. Measured: with the loop, "keeps the port and backs
    // off" went red in 2 of 5 whole-file runs on a check its own logic passes.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
    const free = !listeners(port).length;
    assert.ok(free,
      "SIGHUP left something still listening — the holder went without releasing, " +
      "so whoever claims this port waits out its deadline against an orphan");
  });
});

  describe("run-service", () => {
    // The whole point of the subcommand: it gives an unsupervised host what a
    // systemd unit gives a supervised one. Same holder, so the port survives a
    // proxy death — asserted here on the SUBCOMMAND, because a caller who types
    // `run-service` never sets CACHE_FIX_HOLD_PORT and must not have to.
    // A PLANNED RESTART MUST COST NOTHING. This is the whole point of the
    // holder, and until the handoff landed it was the one thing it could not
    // do: the holder gave the socket up and had to win it back, so every
    // request arriving in between was refused. Measured at 4 lost per 12,557.
    //
    // The outgoing proxy now spawns its successor on its OWN fd 3 before it
    // stops accepting, so the socket never changes owner and its accept queue
    // is never dropped. Measured after: 176,396 requests over 12 deploys, zero
    // lost. Removing the successor spawn and re-measuring under the same load
    // (8 deploys, 40 concurrent, 500 ms apart) puts 92 back — refused=71,
    // reset=21 — which is what makes this an assertion rather than a hope.
    //
    // SIGTERM, not the kill above: a killed proxy runs no shutdown and so hands
    // nothing on. This case is about the DELIBERATE restart — a deploy — and a
    // crash is the case beside it.
    it("a planned restart refuses nothing, because the socket is handed on", async () => {
      await withHeldPort(async ({ get, proxyPid, port }) => {
        const first = proxyPid();
        assert.ok(first, "no proxy to restart");
        // Traffic for the whole restart, so the window is actually sampled. A
        // single request before and after would pass with the port down between
        // them, which is precisely the defect.
        // agent:false — a FRESH connection per request, and this is a SCOPE
        // boundary, not a convenience. What this case measures is the port: is
        // anything ever refused while the proxy is replaced. Pooling adds a
        // second, still-unfixed failure on top — see below — and one assertion
        // cannot pin two defects without going red for whichever is not being
        // worked on.
        //
        // THE POOLED FAILURE IS REAL AND STILL OPEN. Exactly one ECONNRESET per
        // planned restart, 3 of 3 runs. Instrumented, the failing request is
        // {connected:true, sent:true, reused:true} — a REUSED keep-alive socket
        // with the request already written, owned by the outgoing proxy. Two
        // explanations were measured and refuted: closeIdleConnections() does
        // not help (it is in flight, not idle), and "the pool dies with the
        // process" fails its own control (a single idle pooled socket held
        // across a restart survives clean). The fix is to announce
        // `Connection: close` once shutdown starts so the client retires the
        // socket rather than racing for it. Until that lands, do not "fix" this
        // case by pooling — it would go red for a defect it was never about.
        let stop = false, ok = 0;
        const refused = [];
        const once = () => new Promise((res) => {
          http.get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 8_000 },
                   // 200, not merely a reply: a standby relay carrying this
                   // address answers 503, and counting that as served would
                   // hide exactly the loss this sampler exists to count.
                   (r) => { let b = ""; r.on("data", (d) => (b += d));
                            r.on("end", () => res(r.statusCode === 200 ? "ok" : `ERR:${r.statusCode} ${b.slice(0, 160)}`)); })
            .on("error", (e) => res(`ERR:${e.code}`));
        });
        // A pause between requests, and it is NOT politeness. This describe
        // runs at `concurrency: cpus/2` IN ONE PROCESS, so a loop that fires
        // the next request the instant the last resolves starves every timer
        // its neighbours are waiting on. Measured: without it, "stops when
        // signalled" took 10,629 ms against its own 10,000 ms deadline and
        // failed — the holder had not ignored SIGTERM, it just never got the
        // event-loop turn to answer. The file passed case-by-case and only
        // failed whole, which is exactly what that looks like.
        //
        // 2 ms, not setImmediate: setImmediate re-queues in the SAME loop phase
        // and still crowds out timers. The window this case measures is the
        // handover, hundreds of milliseconds wide, so a request every 2 ms
        // samples it many times over.
        const pump = (async () => {
          while (!stop) {
            const body = await once();
            if (body.startsWith("ERR:")) { if (classify(body)) refused.push(body); }
            else ok++;
            await new Promise((r) => setTimeout(r, 2));
          }
        })();
        process.kill(first, "SIGTERM");
        // Until a DIFFERENT pid owns the port: waiting a fixed time either
        // races the handover or pads the run.
        const deadline = Date.now() + 20_000;
        while (proxyPid() === first && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 50));
        await new Promise((r) => setTimeout(r, 300));   // sample past the swap
        stop = true; await pump;

        assert.notEqual(proxyPid(), first, "the proxy never restarted, so nothing was measured");
        assert.ok(ok > 0, "no request succeeded at all — the probe measured nothing");
        assert.deepEqual(refused, [],
          `a planned restart refused ${refused.length} of ${ok + refused.length} requests ` +
          `(${[...new Set(refused)].join(", ")}); the successor must be accepting before ` +
          `the outgoing proxy stops`);
      }, { subcommand: "run-service", extraEnv: { CACHE_FIX_HOLD_PORT: "" } });
    });

    it("holds the port across a proxy death without CACHE_FIX_HOLD_PORT", async () => {
      await withHeldPort(async ({ get, killProxy }) => {
        killProxy();
        const deadline = Date.now() + 20_000;
        let body = await get();
        while (body.startsWith("ERR:") && Date.now() < deadline) body = await get();
        assert.equal(JSON.parse(body).status, "ok", "the port did not come back under run-service");
      }, { subcommand: "run-service", extraEnv: { CACHE_FIX_HOLD_PORT: "" } });
    });

    // A supervisor that only ever runs `run-service` must still publish our CA,
    // or every sibling component builds a merged bundle without it and the
    // sessions those components wire cannot verify this proxy. Publishing was
    // reachable ONLY from --remote-control, the path that execs claude itself —
    // measured on the work Mac: ca-trust.d held cswap-pin.pem alone and the
    // bundle verifier answered "node loads no CA of ours from it".
    it("publishes its CA to ca-trust.d/ccf.pem", async () => {
      const cfg = mkdtempSync(join(tmpdir(), "ccf-runsvc-"));
      await withHeldPort(async () => {
        const published = join(cfg, "ca-trust.d", "ccf.pem");
        const deadline = Date.now() + 15_000;
        while (!existsSync(published) && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 100));
        assert.ok(existsSync(published),
          `run-service served without publishing ${published}, so no sibling can trust it`);
        // A path is not a certificate: an empty or torn file satisfies existsSync
        // and takes the whole merged bundle down when it sorts first.
        assert.match(readFileSync(published, "utf8"), /BEGIN CERTIFICATE/,
          "published a file that is not a PEM certificate");
      }, { subcommand: "run-service",
           extraEnv: { CACHE_FIX_HOLD_PORT: "", CLAUDE_CONFIG_DIR: cfg,
                       CACHE_FIX_FORWARD_PROXY: "on" } });
    });

    // Discoverable. An rc line must be able to ask whether this build has the
  // subcommand before using it — an older one reads `run-service` as a claude
  // argument and starts a proxy on its own default port instead.
  it("is advertised in --help", () => {
    const out = execFileSync(process.execPath, [launcherPath, "--help"], { encoding: "utf8" });
    assert.match(out, /run-service/, "a caller cannot detect the subcommand before using it");
  });

  // Idempotent, so an rc line can run on every shell. Without this the second
    // caller falls back to running its own proxy on a port someone else holds —
    // two proxies, split cache.
    // SIGKILL cannot be forwarded, so a holder that dies that way leaves its
    // proxy child running with an ephemeral port nobody will ever reclaim.
    // Measured before the fix: the child survived and was reparented to init,
    // and 37 such orphans had accumulated on one box. The triggers are ordinary
    // — OOM killer, a container stop, an operator's kill -9.
    it("leaves no orphan when the holder is killed outright", async () => {
      const port = await freePort();
      const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port), CACHE_FIX_FORWARD_PROXY: "on" };
      // SELF_HEAL too: this case MEASURES the self-heal, so an operator who
      // exported the off switch while debugging would turn it into a failure
      // about their shell. WATCH_DEPLOY_MS for the same reason.
      for (const k of [...HOP_ENV, "LISTEN_FDS", "LISTEN_PID", "CACHE_FIX_SELF_HEAL", "CACHE_FIX_WATCH_DEPLOY_MS"]) delete env[k];
      const holder = spawn(process.execPath, [launcherPath, "run-service"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let kid = 0;
      try {
        const up = Date.now() + 15_000;
        while (Date.now() < up) {
          const body = await new Promise((res) => {
            http.get({ host: "127.0.0.1", port, path: "/health", timeout: 3_000 }, (r) => {
              let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(b));
            }).on("error", (e) => res(`ERR:${e.code}`));
          });
          if (!body.startsWith("ERR:")) break;
        }
        try { kid = Number(execFileSync("pgrep", ["-P", String(holder.pid)]).toString().trim().split("\n")[0]); } catch {}
        assert.ok(kid > 1, "the holder never spawned a proxy, so this measures nothing");

        holder.kill("SIGKILL");
        // The child polls for its parent, so give it a beat past that interval.
        const gone = Date.now() + 10_000;
        const alive = () => { try { process.kill(kid, 0); return true; } catch { return false; } };
        while (alive() && Date.now() < gone) await new Promise((r) => setTimeout(r, 100));
        assert.ok(!alive(),
          `the proxy (pid ${kid}) outlived its holder and was reparented — it holds an ` +
          `ephemeral port nothing will reclaim`);
      } finally {
        try { holder.kill("SIGKILL"); } catch {}
        if (kid > 1) { try { process.kill(kid, "SIGKILL"); } catch {} }
        // THE SUCCESSOR THIS CASE CAUSED. A child whose holder dies does not
        // simply exit — it spawns a DETACHED replacement on the advertised port,
        // which is the whole point of the self-heal. That successor is nobody's
        // child, so nothing above reaps it: measured, this file left one holder
        // and one proxy behind on every run, and on a CI runner a leftover
        // process holds the job's stdout pipe and the job never finishes.
        //
        // THE SUCCESSOR THIS CASE CAUSES, and the ones IT causes. A child whose
        // holder dies spawns a DETACHED replacement on the advertised port —
        // the point of the self-heal — and that replacement is a full
        // run-service that will do the same again when killed. Nobody's child
        // (ppid 1), so nothing above reaps it.
        //
        // Measured: one holder and one proxy left behind per run. A 4 s watch
        // was too short, and a 20 s one still lost — the pair left behind was
        // 37 s and 17 s old, i.e. born DURING the sweep and again after it. On a
        // CI runner a leftover process holds the job's stdout pipe and the job
        // never finishes.
        //
        // So kill the holder FIRST and only then the listener: with the holder
        // gone there is nothing left to spawn another, and the sweep converges.
        for (let i = 0; i < 60; i++) {
          const live = listeners(port);
          if (!live.length) { if (i > 10) break; }
          for (const pid of live) {
            // The holder is the listener's parent when there is one; killing it
            // first stops the ladder that would replace what we are about to
            // kill.
            let parent = 0;
            try { parent = Number(execFileSync("ps", ["-p", pid, "-o", "ppid="],
                    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch {}
            if (parent > 1) { try { process.kill(parent, "SIGKILL"); } catch {} }
            try { process.kill(Number(pid), "SIGKILL"); } catch {}
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    });

    // THE OUTAGE THIS EXISTS FOR. On <linux-host> the 9901 holder died, nothing revived
    // it, and every session — HTTPS_PROXY baked at exec, so none of them can be
    // re-pointed — fell into `attempt N/300` until a human woke up and started
    // one by hand. Load reached 16,483 while the pin burned itself down retrying
    // a hop that was never coming back.
    //
    // The surviving proxy child is what notices: it already watches its parent
    // so it does not orphan a port, and the same tick puts a new holder on the
    // advertised address before it goes.
    it("puts a new holder back on the port when the old one is killed", async () => {
      const port = await freePort();
      const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port), CACHE_FIX_FORWARD_PROXY: "on" };
      for (const k of [...HOP_ENV, "LISTEN_FDS", "LISTEN_PID"]) delete env[k];
      // 200 OR IT IS NOT THE PROXY. A standby relay carrying this address answers
      // /health with a 503 and a JSON body of its own, and a helper that returned
      // any body let a readiness loop finish on it — measured, `JSON.parse(body)
      // .status` came back undefined against a relay that was working perfectly.
      // The body rides along on a failure for the reason withHeldPort's does.
      const get = () => new Promise((res) => {
        http.get({ host: "127.0.0.1", port, path: "/health", timeout: 3_000 }, (r) => {
          let b = ""; r.on("data", (d) => (b += d));
          r.on("end", () => res(r.statusCode === 200 ? b : `ERR:${r.statusCode} ${b.slice(0, 160)}`));
        }).on("error", (e) => res(`ERR:${e.code}`));
      });
      const first = spawn(process.execPath, [launcherPath, "run-service"], { env, stdio: ["ignore", "pipe", "pipe"] });
      try {
        const up = Date.now() + 15_000;
        let body = await get();
        while (body.startsWith("ERR:") && Date.now() < up) body = await get();
        assert.equal(JSON.parse(body).status, "ok", "the holder never came up");

        // SIGKILL, the shape a supervisor cannot catch: OOM, container stop, kill -9.
        first.kill("SIGKILL");
        const healed = Date.now() + 20_000;
        let back = false;
        while (!back && Date.now() < healed) {
          await new Promise((r) => setTimeout(r, 200));
          back = !(await get()).startsWith("ERR:");
        }
        assert.ok(back,
          "the port stayed unowned after its holder was killed — every session wired " +
          "to that address is stranded, which is the outage this guards");

        // SERVED IS NOT SUPERVISED, and only the second one survives the NEXT
        // kill. The orphaned proxy keeps the port by itself, so a health probe
        // passes with nothing left to restart it. Measured on the personal Mac:
        // 9901 answering 200 for 16h with its whole lineage reparented to init,
        // and every run-service since unable to take it back — the port looked
        // healthy the entire time.
        const ancestry = () => {
          let pid = 0;
          try {
            pid = Number(execFileSync("lsof", ["-nP", "-t", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"],
                                      { encoding: "utf8" }).trim().split("\n").filter(Boolean)[0]);
          } catch { return false; }
          for (let hop = 0; Number.isInteger(pid) && pid > 1 && hop < 4; hop++) {
            let line = "";
            try { line = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }); }
            catch { return false; }
            if (line.includes("run-service")) return true;
            try { pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()); }
            catch { return false; }
          }
          return false;
        };
        const byWhen = Date.now() + 25_000;
        let supervised = false;
        while (!supervised && Date.now() < byWhen) {
          await new Promise((r) => setTimeout(r, 300));
          supervised = ancestry();
        }
        assert.ok(supervised,
          "the port is served but no run-service supervises the listener — the heal " +
          "restored the ADDRESS and not the supervision, so the next crash is an outage");
      } finally {
        try { first.kill("SIGKILL"); } catch {}
        // Reap the HEALED holder, the one this test asked to be born.
        //
        // NOT by `pkill -f CACHE_FIX_PROXY_PORT=<port>`: that pattern matches
        // ARGV, and the port lives in the ENVIRONMENT — the healed holder's
        // command line is a bare `claude-via-proxy.mjs run-service` with no
        // port in it, so the sweep matched nothing and every run leaked two
        // holders that reparented to init. Verified on /proc/<pid>/cmdline.
        //
        // Find it by the port it OWNS instead, after the self-heal poll (~1s)
        // has had time to create it.
        await new Promise((r) => setTimeout(r, 2_000));
        for (let i = 0; i < 3; i++) {
          let owners = [];
          try {
            owners = execFileSync("lsof", ["-nP", "-t", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"],
                                  { encoding: "utf8" }).trim().split("\n").filter(Boolean);
          } catch { break; }                       // nobody owns it: done
          for (const o of owners) {
            const pid = Number(o);
            if (!Number.isInteger(pid) || pid <= 1) continue;
            // The holder ABOVE the listener, so killing the listener cannot
            // trigger another heal; the listener itself when it has no holder.
            let target = pid;
            try { target = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)],
                                               { encoding: "utf8" }).trim()) || pid; } catch {}
            if (target <= 1) target = pid;
            try { process.kill(target, "SIGTERM"); } catch {}
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    });

    // The rule that decides "is this incumbent one of ours". Asserted on the
    // REAL argv rather than by spawning a lookalike: the incumbent a deploy
    // meets is launched through the npm-global symlink, so `ps` reports
    //
    //     node /opt/homebrew/bin/cache-fix-proxy server
    //
    // and no fixture on this box reproduces that string — spawning a shim let
    // node rewrite argv[1] to server.mjs, which is the case that already worked.
    // Measured against the live process on the work Mac (pid 15060): the old
    // rule answered "holder, skip" and `cc-update --apply --force` therefore
    // relaunched six sessions onto a proxy carrying none of the deployed code.
    it("does not read a plain `cache-fix-proxy server` as one of its own holders", () => {
      const src = readFileSync(launcherPath, "utf8");
      // THE WHOLE FUNCTION, not a prefix cut at the first `return "holder"`.
      // That literal is not a landmark: gating the third of three returns on
      // runningOurCode() removed it, indexOf answered -1, and this case failed
      // against a change that did exactly what its own message asks for. A test
      // that parses source has to key on something the code cannot legitimately
      // stop containing.
      // COMMENTS STRIPPED BEFORE BOTH ASSERTIONS, and that is the load-bearing
      // half. This case is about what the CODE keys on, and the prose here says
      // `run-service` a dozen times — against the raw slice the first assertion
      // passes on the explanation of the rule rather than the rule, whatever the
      // slice boundary is.
      //
      // The brace cut is belt-and-braces on top: `\nfunction ` overshoots into
      // otherHolderOn's leading comment (5,505 -> 5,809 chars), which widens what
      // the raw text can match on. Measured after stripping, both landmarks
      // behave the same; the earlier version of this comment claimed the
      // landmark was what made the assertion failable, and it is not.
      const fn = src.slice(src.indexOf("function holderPidOn"));
      const rule = fn.slice(0, fn.indexOf("\n}\n") + 3);
      const code = rule.replace(/\/\/[^\n]*/g, "");
      // The distinguishing fact is the SUBCOMMAND. `cache-fix-proxy` is our own
      // bin name, so matching it identifies the package, not the role.
      assert.match(code, /run-service/,
        "holder detection does not key on the run-service subcommand, so a plain " +
        "`cache-fix-proxy server` reads as a holder and a deploy silently skips it");
      assert.ok(!/cache-fix-proxy\b(?!.*run-service)/.test(code),
        "detection still matches the bin name alone — that is what misread pid 15060");
    });

    // A takeover must leave ONE proxy, not one per bind attempt. Passing the
    // callback to listen() adds a `listening` listener per call and node fires
    // all of them on the bind that finally lands — measured standalone, 21
    // callbacks from a single success. On the work Mac one takeover left the
    // holder supervising 100 proxies, 72 of them holding ephemeral ports, with
    // a MaxListenersExceededWarning as the only clue.
    it("supervises exactly one proxy after taking the port over", async () => {
      const port = await freePort();
      const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port), CACHE_FIX_FORWARD_PROXY: "on",
                    CACHE_FIX_SELF_HEAL: "off" };
      for (const k of [...HOP_ENV, "LISTEN_FDS", "LISTEN_PID", "CACHE_FIX_HOLD_PORT"]) delete env[k];
      // 200 OR IT IS NOT THE PROXY. A standby relay carrying this address answers
      // /health with a 503 and a JSON body of its own, and a helper that returned
      // any body let a readiness loop finish on it — measured, `JSON.parse(body)
      // .status` came back undefined against a relay that was working perfectly.
      // The body rides along on a failure for the reason withHeldPort's does.
      const get = () => new Promise((res) => {
        http.get({ host: "127.0.0.1", port, path: "/health", timeout: 3_000 }, (r) => {
          let b = ""; r.on("data", (d) => (b += d));
          r.on("end", () => res(r.statusCode === 200 ? b : `ERR:${r.statusCode} ${b.slice(0, 160)}`));
        }).on("error", (e) => res(`ERR:${e.code}`));
      });
      const old = spawn(process.execPath, [launcherPath, "server"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let warned = "";
      let taker = null;
      try {
        const up = Date.now() + 15_000;
        let body = await get();
        while (body.startsWith("ERR:") && Date.now() < up) body = await get();
        assert.equal(JSON.parse(body).status, "ok", "nothing served the port");

        // TRAFFIC ACROSS THE TAKEOVER, started before the taker exists — the
        // whole window is between the incumbent letting go and the new child
        // listening, so a probe that begins afterwards measures nothing.
        // agent:false, a fresh connection each time: what is under test is
        // whether the ADDRESS ever refuses, and a pooled socket would not ask.
        let stop = false, served = 0;
        const refused = [];
        const once = () => new Promise((res) => {
          http.get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 8_000 },
                   // 200, not merely a reply: a standby relay carrying this
                   // address answers 503, and counting that as served would
                   // hide exactly the loss this sampler exists to count.
                   (r) => { let b = ""; r.on("data", (d) => (b += d));
                            r.on("end", () => res(r.statusCode === 200 ? "ok" : `ERR:${r.statusCode} ${b.slice(0, 160)}`)); })
            .on("error", (e) => res(`ERR:${e.code}`));
        });
        const pump = (async () => {
          while (!stop) {
            const b = await once();
            if (b.startsWith("ERR:")) { if (classify(b)) refused.push({ code: b, at: Date.now() }); }
            else served++;
            await new Promise((r) => setTimeout(r, 2));   // yield to neighbours
          }
        })();

        taker = spawn(process.execPath, [launcherPath, "run-service"], { env, stdio: ["ignore", "pipe", "pipe"] });
        taker.stderr.on("data", (d) => { warned += d.toString(); });
        // Past the retry ladder, so a per-attempt spawn would have happened.
        await new Promise((r) => setTimeout(r, 3_000));
        stop = true; await pump;

        assert.ok(served > 0, "no request succeeded at all — the probe measured nothing");

        // A CROSS-TREE TAKEOVER CANNOT BE FREE IN NODE, so this bounds the
        // outage rather than forbidding it — and the bound is what catches a
        // regression that turns a blip into an outage.
        //
        // Why zero is unreachable here. The socket survives its listener's
        // death (measured: parent binds, child listens, child SIGKILLed, port
        // still ACCEPTED/QUEUED) — so nothing is lost when a CHILD goes. What
        // costs is a NEW HOLDER: it cannot inherit the incumbent's fd across
        // process trees (node exposes no SCM_RIGHTS), so it must bind its own,
        // and cswap's pin measured on both platforms that it cannot:
        //   linux 6.8   incumbent LISTENING   -> second bind EADDRINUSE 98
        //   darwin 15.7 incumbent BOUND ONLY  -> second bind EADDRINUSE 48
        // So "spawn our child first and let it retry" is not available: the
        // incumbent must let go BEFORE we can bind at all, and the port is
        // unowned until our child boots. The zero-loss paths are the ones that
        // never change process tree — the holder restarting its own child, and
        // the proxy handing its socket to its own successor.
        const outage = refused.length
          ? refused[refused.length - 1].at - refused[0].at
          : 0;
        assert.ok(outage < 4_000,
          `the port was refusing for ${outage}ms across a takeover (${refused.length} of ` +
          `${served + refused.length} requests: ${[...new Set(refused.map((r) => r.code))].join(", ")}) ` +
          `— that is past a child's boot, so the takeover did not complete, it ` +
          `stranded the address`);
        assert.equal((await get()).startsWith("ERR:"), false,
          "the port never came back after the takeover");
        // PROXIES, which is what the sentence says. A holder also parents one
        // standby relay, so counting children counts something else.
        let kids = [];
        try { kids = execFileSync("pgrep", ["-P", String(taker.pid)], { encoding: "utf8" })
                       .trim().split("\n").filter(Boolean)
                       .filter((q) => /server\.mjs/.test(cmdOf(q))); } catch {}
        assert.equal(kids.length, 1,
          `the holder supervises ${kids.length} proxies; a bind retry spawned one per attempt`);
        assert.ok(!/MaxListenersExceeded/.test(warned),
          "listen() is still being handed a callback per attempt");
      } finally {
        // SIGTERM AND WAIT, before any SIGKILL. SIGKILL cannot be forwarded, so
        // a killed launcher strands its proxy — and that grandchild holds the
        // runner's pipes: measured, this one case alone took the file from 20s
        // to a 120s timeout, reported as "Promise resolution is still pending
        // but the event loop has already resolved".
        for (const p of [old, taker]) { try { p.kill("SIGTERM"); } catch {} }
        await Promise.all([old, taker].map((p) => Promise.race([
          new Promise((r) => p.on("close", r)),
          new Promise((r) => setTimeout(r, 5_000)),
        ])));
        for (const p of [old, taker]) { try { p.kill("SIGKILL"); } catch {} }
        // Reap the HEALED holder, the one this test asked to be born.
        //
        // NOT by `pkill -f CACHE_FIX_PROXY_PORT=<port>`: that pattern matches
        // ARGV, and the port lives in the ENVIRONMENT — the healed holder's
        // command line is a bare `claude-via-proxy.mjs run-service` with no
        // port in it, so the sweep matched nothing and every run leaked two
        // holders that reparented to init. Verified on /proc/<pid>/cmdline.
        //
        // Find it by the port it OWNS instead, after the self-heal poll (~1s)
        // has had time to create it.
        await new Promise((r) => setTimeout(r, 2_000));
        for (let i = 0; i < 3; i++) {
          let owners = [];
          try {
            owners = execFileSync("lsof", ["-nP", "-t", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"],
                                  { encoding: "utf8" }).trim().split("\n").filter(Boolean);
          } catch { break; }                       // nobody owns it: done
          for (const o of owners) {
            const pid = Number(o);
            if (!Number.isInteger(pid) || pid <= 1) continue;
            // The holder ABOVE the listener, so killing the listener cannot
            // trigger another heal; the listener itself when it has no holder.
            let target = pid;
            try { target = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)],
                                               { encoding: "utf8" }).trim()) || pid; } catch {}
            if (target <= 1) target = pid;
            try { process.kill(target, "SIGTERM"); } catch {}
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    });

    // NOTHING IS REFUSED when the proxy under the holder dies, and at most the
    // one connection the kernel resets as the socket's last owner disappears.
    //
    // That one is not a bug this holder can fix, and the measurement says so.
    // Instrumented at microsecond resolution across a SIGKILL, with the holder
    // counting its own accepts:
    //     0.046ms  ECONNRESET     <- kernel tears down the dying socket
    //     0.880ms  ECONNRESET
    //     2.324ms  ECONNREFUSED   <- nobody owns the port yet
    //     ...
    //     holderAccepted = 0
    // The holder accepted NOTHING; the resets come from the kernel closing a
    // socket whose only owner was killed. A holder that RELEASES the socket and
    // takes it back cannot cover that instant — the fix is a holder that never
    // releases it (keeps the listening fd, hands each child a dup), which is
    // cswap's pin's shape and measures 0. Until then this asserts what is
    // actually guaranteed: no REFUSALS, and at most one reset per death.
    //
    // Asserting 0 here instead would be asserting something no implementation
    // in this tree delivers — it failed 5 of 5 runs on two machines while the
    // holder was working exactly as designed.
    //
    // The relay this replaced was strictly worse: it held a client-side socket
    // outliving the upstream one, so a death cut requests mid-body, and
    // retrying made it WORSE (80 of 80 failed) because a request whose bytes
    // have reached the client cannot be replayed.
    it("refuses nothing when the proxy under it dies", async () => {
      await withFakeProxy(
        // Serves the INHERITED fd, the way the real proxy does under a holder.
        'import net from "node:net";\n' +
        'const s = net.createServer((c) => { c.on("error", () => {});\n' +
        '  c.end("HTTP/1.1 200 OK\\r\\ncontent-length:2\\r\\nconnection:close\\r\\n\\r\\nok"); });\n' +
        'const fd = Number(process.env.LISTEN_FDS) >= 1 ? 3 : null;\n' +
        'if (fd === null) { process.stderr.write("no LISTEN_FDS\\n"); process.exit(1); }\n' +
        's.listen({ fd }, () => process.stdout.write("proxy listening on 127.0.0.1:0\\n"));\n',
        async ({ launcher, port }) => {
          const get = () => new Promise((res) => {
            http.get({ host: "127.0.0.1", port, path: "/health", timeout: 3_000 }, (r) => {
              r.resume(); r.on("end", () => res(r.statusCode));
            }).on("error", (e) => res(e.code));
          });
          const up = Date.now() + 10_000;
          while (Date.now() < up && (await get()) !== 200) await new Promise((r) => setTimeout(r, 50));
          assert.equal(await get(), 200, "the stand-in never came up behind the holder");

          const seen = [];
          const hammer = (async () => {
            for (let i = 0; i < 40; i++) { seen.push(await get()); await new Promise((r) => setTimeout(r, 25)); }
          })();
          setTimeout(() => {
            let kid = 0;
            try { kid = Number(execFileSync("pgrep", ["-P", String(launcher.pid)], { encoding: "utf8" })
                                .trim().split("\n")[0]); } catch {}
            if (kid > 1) { try { process.kill(kid, "SIGKILL"); } catch {} }
          }, 250);
          await hammer;

          const cut = seen.filter((c) => c !== 200);
          // A REFUSAL means the address had no owner, and a session that baked
          // HTTPS_PROXY at exec is stranded. The holder exists to make that
          // rare — but on a FORCED kill it cannot make it zero, and asserting
          // zero asserted something the code does not do.
          //
          // The holder closes its socket when it spawns a child, because a
          // holder that stays open is an acceptor whether it wants to be or not
          // (net.Server has no pause(); maxConnections=0 accepts then RSTs, 19
          // of 20) and eats ~18% of STEADY-STATE traffic — measured, 200
          // concurrent, hung=36 acceptedByHolder=36, exactly 1:1. So it must
          // re-acquire when the child dies, and nothing owns the port in
          // between. Forwarding what it steals over IPC to stay open was built
          // and measured WORSE: 1543 req / 6 lost / max 5004 ms against
          // 5257 / 3 / 83 ms. Reverted.
          //
          // A PLANNED stop is different and still costs zero refusals: the
          // proxy announces its release, so the holder re-acquires before the
          // child is gone. Measured, 3 SIGTERMs under load: 5257 requests, 3
          // lost, all ECONNRESET, refused=0.
          //
          // cswap's pin measures refused=0 across the same forced kill because
          // its holder never calls accept() at all — a bare CPython socket with
          // nothing reading it does not accept, so it may stay open. Same
          // design, opposite runtime, different guarantee. Not a better
          // implementation of ours.
          //
          // A NUMBER, not a bare bound: CI observed 1 of 40 (run 31044769115).
          // 2 leaves room for a slower runner without letting a regression that
          // doubles the window pass unnoticed.
          const refused = cut.filter((c) => classify(c) === OUTAGE.REFUSED);
          assert.ok(refused.length <= 2,
            `the port had no owner for ${refused.length} of 40 requests across ONE ` +
            `forced kill — the re-acquire window is structural but bounded, and this ` +
            `is wider than measured (1 of 40)`);
          // Resets are bounded by the number of deaths (one here). Above that,
          // something is cutting connections it accepted, which no kernel
          // teardown explains.
          assert.ok(cut.length <= 1,
            `${cut.length} of 40 requests were cut across ONE death ` +
            `(${[...new Set(cut)].join(", ")}); at most the connection the kernel ` +
            `resets as the socket's last owner dies is expected`);
        });
    });

    // AN UPGRADE MUST UPGRADE. A holder from an OLDER deploy is still "one of
    // ours", so a rule that asks only that exits 0 and the new code never runs
    // — the fix sits on disk while the old process keeps serving. Measured on
    // the work Mac against 54 live sessions: rc=0, holder untouched, and a
    // human had to retire the old process by hand before anything changed.
    //
    // cswap's pin had the mirror defect (an upgrade that ACTED and moved the
    // port, stranding every session for 76 minutes). Both leave the outcome
    // depending on somebody knowing to intervene at the right moment.
    //
    // Driven against REAL FILES and a faked process tree. Real files because
    // the decision is a content hash and a stub cannot exercise hashing; a
    // faked tree because the surrounding rule is a pure function of what `ps`
    // reports, and the two-real-deploys version of this case starved two
    // timing-sensitive cases elsewhere by load alone.
    it("takes the port from a holder running an older deploy", async () => {
      const src = readFileSync(launcherPath, "utf8");
      const rule = /function holderPidOn[\s\S]*?\n}/.exec(src)?.[0];
      const fpFns = /function codeFingerprint[\s\S]*?\nfunction runningOurCode[\s\S]*?\n}/.exec(src)?.[0];
      // holderPidOn asks lsof about the address the proxy BINDS, not a literal
      // 127.0.0.1 — the two disagreed under CACHE_FIX_PROXY_BIND and the probe
      // then matched nothing. Lifted from source rather than stubbed, so this
      // keeps failing if the real one stops honouring the variable.
      const bindFn = /const bindAddr = [^\n]*\n/.exec(src)?.[0];
      assert.ok(rule && fpFns && bindFn,
        "holderPidOn/runningOurCode/bindAddr are gone — the upgrade decision moved and this no longer tests it");

      const dir = mkdtempSync(join(tmpdir(), "ccf-fp-"));
      const ours = join(dir, "server.mjs");
      writeFileSync(ours, "// build A\n");
      const record = join(dir, `cache-fix-proxy-${9901}.sha256`);
      const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

      // The incumbent published what IT booted with; we hash what WE would run.
      //
      // TWO SHAPES, because a one-pid stub only ever exercised one of the
      // branches that reach the fingerprint question.
      //   listener-only ("4242")      -> the LISTENER is the proxy child, so the
      //                                  answer comes from its PARENT.
      //   holder + child ("4241\n4242") -> what lsof actually reports, per this
      //                                  function's own comment: the holder keeps
      //                                  a bound descriptor while its child
      //                                  serves. The holder is found in the list
      //                                  itself, on the earlier branch.
      // The old stub returned one pid while the comment claimed the multi-pid
      // reality, so the branch that reads the list was never run by this case.
      const decide = (lsofOut = "4241\n4242\n") => {
        const fake = {
          execFileSync: (cmd, args) => {
            if (cmd === "lsof") return lsofOut;
            if (cmd === "pgrep") return "4243\n";
            if (cmd === "ps") {
              const pid = args[args.indexOf("-p") + 1];
              if (pid === "4242") return "4241 node /any/proxy/server.mjs\n";
              if (pid === "4241") return "node /usr/local/bin/cache-fix-proxy run-service\n";
              return "node /any/proxy/server.mjs\n";
            }
            throw new Error("unexpected " + cmd);
          },
        };
        // eslint-disable-next-line no-new-func
        return Function("execFileSync", "SERVER_PATH", "readFileSync", "createHash", "join", "tmpdir",
          `${bindFn}${fpFns}\n${rule}\nreturn holderPidOn(9901);`)(
            fake.execFileSync, ours, readFileSync, createHash, () => record, () => dir);
      };

      try {
        // Same bytes: nothing to do. A run-service that churned here would
        // restart a healthy proxy on every shell.
        writeFileSync(record, sha(ours));
        assert.equal(decide(), "holder",
          "a holder already running THIS build must be left alone");

        // The file is REPLACED IN PLACE — the shape a `git pull` produces, and
        // the one a path comparison cannot see (measured on this box: disk at
        // one commit, process at another, same path, run-service exited 0).
        writeFileSync(ours, "// build B\n");
        assert.equal(decide(), 4241,
          "an in-place upgrade left the older build serving — installing a fix " +
          "changes nothing until a human intervenes");

        // mtime moved, bytes identical: must NOT churn. `touch`, a rebuild that
        // reproduces, a restored backup. cswap's pin recycled a healthy daemon
        // on exactly this.
        writeFileSync(record, sha(ours));
        const t = Date.now() / 1000 + 3600;
        utimesSync(ours, t, t);
        assert.equal(decide(), "holder",
          "a newer mtime with identical bytes retired a healthy proxy");

        // No record at all (killed -9 mid-write, first boot, /tmp swept): leave
        // it alone. THIS IS THE ROW THAT INVERTS between the two callers —
        // otherHolderOn's copy of this state must answer "not surplus" instead,
        // because there the destructive move is exiting rather than signalling.
        rmSync(record, { force: true });
        assert.equal(decide(), "holder",
          "an unreadable record must mean LEAVE ALONE — guessing here signals a " +
          "process we cannot identify");

        // TWO OF THE THREE, on every row above — and the count matters, because
        // this used to read "BOTH BRANCHES" and claim a completeness the fixture
        // does not have. holderPidOn asks the fingerprint question at three call
        // sites: the loop over the lsof list, the listener-self branch, and the
        // parent lookup. Each assertion so far ran the two-pid shape (loop);
        // these replay them against the listener-only shape (parent).
        //
        // THE LISTENER-SELF BRANCH IS DRIVEN BY NEITHER, and it is the one this
        // change newly gated. That is deliberate and stated at its own line: it
        // is reachable only when `ps` throws for a pid inside the loop and then
        // succeeds — measured, reverting it leaves 65/65 green. Gated anyway,
        // because the cost is one comparison and the wrong answer is a silent
        // no-op deploy. Do not read the rows below as covering it.
        writeFileSync(record, sha(ours));
        assert.equal(decide("4242\n"), "holder",
          "via the parent lookup, a holder on THIS build was not left alone");
        writeFileSync(ours, "// build C\n");
        assert.equal(decide("4242\n"), 4241,
          "via the parent lookup, an in-place upgrade left the older build serving");
        rmSync(record, { force: true });
        assert.equal(decide("4242\n"), "holder",
          "via the parent lookup, an unreadable record did not mean LEAVE ALONE");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // THE OTHER HALF OF THE SAME DECISION, and the half that had no test at
    // all. holderPidOn() above answers "may I signal the incumbent"; this one
    // answers "am I the surplus copy and should I just leave" — and it ran
    // BEFORE the bind, on age alone. Every incumbent is older than a process
    // that just started, so the NEW code called itself surplus on every deploy,
    // exited 0, and the OLD holder kept serving with nothing saying so.
    //
    // Same sandbox as above and for the same two reasons: the decision is a
    // content hash (a stub cannot exercise hashing) and the rule around it is a
    // pure function of what `ps` and `lsof` report.
    it("leaves a surplus copy of the SAME build, and replaces an older one", () => {
      const src = readFileSync(launcherPath, "utf8");
      const rule = /function otherHolderOn[\s\S]*?\n}/.exec(src)?.[0];
      const fpFns = /function codeFingerprint[\s\S]*?\nfunction runningOurCode[\s\S]*?\n}/.exec(src)?.[0];
      const bindFn = /const bindAddr = [^\n]*\n/.exec(src)?.[0];
      assert.ok(rule && fpFns && bindFn,
        "otherHolderOn/runningOurCode/bindAddr are gone — this no longer tests the surplus rule");

      const dir = mkdtempSync(join(tmpdir(), "ccf-surplus-"));
      const ours = join(dir, "server.mjs");
      writeFileSync(ours, "// build A\n");
      const record = join(dir, "cache-fix-proxy-9901.sha256");
      const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
      const lsofArgs = [];
      // What the rule wrote to stderr. Captured rather than ignored: after the
      // end-to-end measurement below, the MESSAGE is the behaviour this row
      // protects, and a fixture that discards it would pass against silence.
      const said = [];

      // SERVER_PATH is a parameter so one row can point it at a file that is not
      // there — the second way runningOurCode answers "cannot tell", and the one
      // the message used to misattribute.
      const decideWith = (serverPath, lsofThrows) => {
        const fake = (cmd, args) => {
          if (cmd === "lsof") {
            lsofArgs.push(args.join(" "));
            if (lsofThrows) throw Object.assign(new Error("lsof"), lsofThrows);
            return "4242\n";
          }
          if (cmd === "ps") return "999999 node /usr/local/bin/cache-fix-proxy run-service\n";
          throw new Error("unexpected " + cmd);
        };
        // env and pid FORWARDED, not stubbed away: bindAddr() reads
        // process.env, and a fake without it throws inside otherHolderOn's own
        // try/catch, which swallows it and returns 0 — a fixture that silently
        // answers "no other holder" to every row. Caught only because the first
        // row asserts a positive 4242 rather than merely "not surplus".
        const proc = { env: process.env, pid: process.pid, uptime: () => 0,
                       stderr: { write: (s) => said.push(s) } };
        // eslint-disable-next-line no-new-func
        return Function("execFileSync", "SERVER_PATH", "readFileSync", "createHash", "join", "tmpdir", "process",
          `${bindFn}${fpFns}\n${rule}\nreturn otherHolderOn(9901);`)(
            fake, serverPath, readFileSync, createHash, () => record, () => dir, proc);
      };
      const decide = () => decideWith(ours);

      const priorBind = process.env.CACHE_FIX_PROXY_BIND;
      try {
        // Same bytes: a second run-service IS surplus and must go. Without this
        // an idempotent `run-service` would put a second holder on the address.
        writeFileSync(record, sha(ours));
        assert.equal(decide(), 4242,
          "a second run-service on the SAME build did not recognise itself as surplus");

        // A DEPLOY. Same age relationship, different bytes: the incumbent is
        // what we came to replace, so we are not surplus and must NOT leave.
        writeFileSync(ours, "// build B\n");
        assert.equal(decide(), 0,
          "the new code called itself surplus against an OLDER build — every " +
          "deploy a no-op, with the old holder still serving and nothing saying so");

        // NO RECORD (/tmp swept under a healthy long-lived holder). The answer
        // stays "surplus" because returning 0 was measured to change no outcome
        // — takeOver() reads the same unknown as "holder" and exits 0 anyway —
        // so what this row pins is the LINE, not the value.
        writeFileSync(record, sha(ours));
        said.length = 0;
        assert.equal(decide(), 4242, "premise: with a matching record this IS the surplus copy");
        assert.deepEqual(said, [],
          "a CONFIRMED duplicate must stay quiet — warning on every idempotent " +
          "re-run is how the one warning that matters gets ignored");

        rmSync(record, { force: true });
        said.length = 0;
        assert.equal(decide(), 4242,
          "an unreadable record must still read as surplus: returning 0 here changes " +
          "no outcome (the bind fails and takeOver exits 0 anyway) and opens a window " +
          "where this copy binds beside a live holder");
        assert.match(said.join(""), /cannot compare builds/,
          "the deploy no-opped in silence — an operator gets no way to tell " +
          "'already running your code' from 'could not tell, and did nothing'");

        // THE OTHER WAY TO REACH UNKNOWN, and the one the message used to lie
        // about: the record is present and valid, and OUR OWN server.mjs is
        // unreadable. Same null, opposite cause — a message that blames the
        // record sends an operator to /tmp to debug a broken install.
        writeFileSync(record, sha(ours));
        const gone = join(dir, "not-here.mjs");
        said.length = 0;
        assert.equal(decideWith(gone), 4242, "premise: an unreadable own build still reads as unknown");
        assert.match(said.join(""), new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          `the message named only the record: ${JSON.stringify(said.join(""))} — the ` +
          `fingerprint that could not be read was OURS, and the operator is sent to the wrong file`);

        // A PROBE THAT COULD NOT RUN IS NOT AN EMPTY PORT. lsof exits 1 when it
        // finds nothing — the ordinary case — AND when it cannot run the query,
        // with the same empty stdout. Measured here on lsof 4.93.2:
        //   nothing listening   status=1 stdout=0B stderr=0B
        //   bad flag / bad -i   status=1 stdout=0B stderr=568B / 561B
        //   binary missing      code=ENOENT status=null
        // Only stderr separates the first two, and this call used to DISCARD
        // stderr — so the instrument could not answer even in principle.
        //
        // Both still return 0 (there is no pid to report, and refusing to start
        // leaves the address unserved). What must differ is whether anyone is
        // told: on a box with no usable lsof, every launcher reads "no other
        // holder", none is surplus, and the pileup this rule exists to prevent
        // returns — in silence.
        writeFileSync(record, sha(ours));

        said.length = 0;
        assert.equal(decideWith(ours, { status: 1, stdout: "", stderr: "" }), 0,
          "premise: a genuinely empty port must read as no other holder");
        assert.deepEqual(said, [],
          "a true absence warned — then the warning means nothing, because it fires " +
          "on the ordinary case too");

        for (const [label, err] of [
          ["a bad query (lsof present, rejects argv)", { status: 1, stdout: "", stderr: "lsof: unsupported\n" }],
          ["no lsof on the box at all", { code: "ENOENT", status: null, stdout: "", stderr: "" }],
        ]) {
          said.length = 0;
          assert.equal(decideWith(ours, err), 0, `premise: ${label} still returns 0`);
          assert.match(said.join(""), /ownership probe could not run/,
            `${label} was reported as "no other holder is here", silently — that is a ` +
            `read failure translated into an absence, and it puts a second holder on a ` +
            `live address with nothing saying why`);
        }

        // THE PROBE MUST FOLLOW THE BIND ADDRESS. It asked lsof about
        // 127.0.0.1 while the proxy honoured CACHE_FIX_PROXY_BIND, so under any
        // other address lsof matched nothing and the rule silently answered
        // "no other holder" about a live one.
        lsofArgs.length = 0;
        process.env.CACHE_FIX_PROXY_BIND = "0.0.0.0";
        decide();
        assert.ok(lsofArgs.every((a) => a.includes("-iTCP@0.0.0.0:9901")),
          `the ownership probe ignored CACHE_FIX_PROXY_BIND: ${JSON.stringify(lsofArgs)}`);
      } finally {
        if (priorBind === undefined) delete process.env.CACHE_FIX_PROXY_BIND;
        else process.env.CACHE_FIX_PROXY_BIND = priorBind;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits 0 and starts nothing when a proxy is already serving", async () => {
      await withHeldPort(async ({ get, port, proxyPid }) => {
        const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port) };
        for (const k of [...HOP_ENV, "LISTEN_FDS", "LISTEN_PID"]) delete env[k];
        const incumbentPid = proxyPid();
        assert.ok(incumbentPid, "premise: the first run-service must have a proxy to protect");
        const second = spawn(process.execPath, [launcherPath, "run-service"], { env, stdio: ["ignore", "pipe", "pipe"] });
        // BOUNDED. Awaiting `exit` alone turns "it never exits" into an
        // infinite wait, and the runner reports nothing at all: measured, the
        // suite sat 29 minutes on this case while the defect it exists to catch
        // was live, with a childless holder and a rival proxy on another port.
        // A hang must FAIL, and fail with the timing named.
        const code = await Promise.race([
          new Promise((r) => second.on("exit", (c) => r(c))),
          new Promise((r) => setTimeout(() => r("HUNG"), 20_000)),
        ]);
        try { second.kill("SIGKILL"); } catch {}
        assert.equal(code, 0, "a second run-service must exit 0 rather than fail, hang, or fork a rival proxy");
        // The incumbent is still the one answering — and is the SAME process.
        //
        // Identity, not just health: the holder hands its socket down and stops
        // accepting, so the process holding the port is the proxy CHILD, whose
        // command line names server.mjs and never `run-service`. A takeover that
        // identifies the incumbent by the listener alone reads our own healthy
        // proxy as a stranger, SIGTERMs it, and takes the port. `status: ok`
        // passes right through that, because the replacement answers too.
        assert.equal(JSON.parse(await get()).status, "ok", "the second invocation disturbed the running proxy");
        assert.equal(proxyPid(), incumbentPid,
          "the second run-service replaced the running proxy instead of leaving it alone");
      }, { subcommand: "run-service", extraEnv: { CACHE_FIX_HOLD_PORT: "" } });
    });

    // A BIND THAT CAN NEVER WORK IS NOT "SOMEBODY ELSE HAS IT".
    //
    // bindFailed() read no error code, so every failure took the same path:
    // "the port is taken, go ask the incumbent to hand it over". With an
    // address that is not on this host there IS no incumbent, so takeOver()
    // reached "cannot identify it: leave it alone" and exited 0 — a deploy that
    // started nothing, reporting success, indistinguishable from a real no-op
    // to deploy.sh and to a human reading the log. The mislabelling upstream
    // made it worse: libuv's EADDRNOTAVAIL arrived here named "EACCES".
    it("fails loudly when the bind address can never work, rather than exiting 0", async () => {
      const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(await freePort()),
                    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): reserved for
                    // documentation, so it is never a live address on any host
                    // and the bind is guaranteed to fail for a reason that is
                    // NOT "in use".
                    CACHE_FIX_PROXY_BIND: "192.0.2.1" };
      for (const k of [...HOP_ENV, "LISTEN_FDS", "LISTEN_PID", "CACHE_FIX_HOLD_PORT"]) delete env[k];
      const p = spawn(process.execPath, [launcherPath, "run-service"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => { err += d; });
      const code = await Promise.race([
        new Promise((r) => p.on("exit", (c) => r(c))),
        new Promise((r) => setTimeout(() => r("HUNG"), 25_000)),
      ]);
      try { p.kill("SIGKILL"); } catch {}
      assert.equal(code, 1,
        `run-service exited ${code} with nothing bound — a deploy that started ` +
        `nothing must not report success. stderr: ${err.slice(-400)}`);
      assert.match(err, /cannot bind 192\.0\.2\.1:/,
        `the failure was not reported at all; stderr: ${err.slice(-400)}`);
      // The TRUE errno, not the catch-all. EACCES here sends whoever reads it
      // hunting for a permissions problem that does not exist.
      assert.match(err, /EADDRNOTAVAIL/,
        `the bind failure was mislabelled; stderr: ${err.slice(-400)}`);
    });

    // Two readers this case needs, kept local because nothing else wants them.
    // The child's ENVIRONMENT is the fact under test — not what the holder
    // printed — because the child's self-heal reads it, not the log.
    const childOf = (pid, re) => {
      try {
        return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n")
          .filter(Boolean)
          .find((q) => { try {
            return re.test(execFileSync("ps", ["-p", q, "-o", "command="], { encoding: "utf8" }));
          } catch { return false; } });
      } catch { return undefined; }
    };
    const heldPortOf = (pid) => {
      try {
        // Linux only; the case skips itself elsewhere rather than guessing.
        return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")
          .find((v) => v.startsWith("CACHE_FIX_HELD_PORT="))?.slice("CACHE_FIX_HELD_PORT=".length);
      } catch { return undefined; }
    };

    // AN EPHEMERAL PORT MUST BE CARRIED DOWNSTREAM, NOT THE 0 THAT ASKED FOR IT.
    //
    // Removing `Number(env) || 9801` made CACHE_FIX_PROXY_PORT=0 reachable, and
    // reachable is not the same as working: two sites below the bind still
    // passed the REQUESTED port where the BOUND one is required, while the gap
    // and standby a couple of hundred lines up already used this._port.
    //
    // Measured before the fix, with CACHE_FIX_PROXY_PORT=0 and 43557 bound:
    //   record written as cache-fix-proxy-0.sha256, so runningOurCode(43557)
    //     from any other launcher finds nothing and every port-0 install on the
    //     box collides on one file
    //   child told CACHE_FIX_HELD_PORT=0, so its self-heal would respawn on a
    //     DIFFERENT ephemeral port and strand every session on the served one,
    //     and successorServing("0") can never answer
    it("hands the BOUND port downstream when asked for an ephemeral one", async () => {
      // A PRIVATE TMPDIR. fingerprintPath() writes under os.tmpdir(), which is
      // shared with every other test in this run and with the whole box — the
      // first cut asserted on /tmp/cache-fix-proxy-0.sha256 and failed in the
      // full suite while passing alone, because something else had created it.
      // Asserting a global path can only ever measure the machine's history.
      const tmp = mkdtempSync(join(tmpdir(), "ccf-port0-"));
      const env = { ...process.env, CACHE_FIX_PROXY_PORT: "0", CACHE_FIX_SELF_HEAL: "off",
                    TMPDIR: tmp };
      for (const k of [...HOP_ENV, "LISTEN_FDS", "LISTEN_PID", "CACHE_FIX_HOLD_PORT"]) delete env[k];
      const p = spawn(process.execPath, [launcherPath, "run-service"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      const bound = await Promise.race([
        new Promise((r) => {
          const tick = setInterval(() => {
            const m = /listening on [\d.]+:(\d+)/.exec(out);
            if (m) { clearInterval(tick); r(Number(m[1])); }
          }, 100);
        }),
        new Promise((r) => setTimeout(() => r(0), 25_000)),
      ]);
      try {
        assert.ok(bound > 0, `the holder never reported a bound port; stdout: ${JSON.stringify(out.slice(-200))}`);
        assert.notEqual(bound, 9801,
          "an explicit 0 was rewritten to the legacy port — the whole point of removing `|| 9801`");

        // The record another launcher will look for is named after the address
        // that is actually being served.
        assert.equal(existsSync(join(tmp, `cache-fix-proxy-${bound}.sha256`)), true,
          `no fingerprint record for the bound port ${bound} — every other launcher's ` +
          `runningOurCode(${bound}) finds nothing and treats a live holder as unknown`);
        assert.equal(existsSync(join(tmp, "cache-fix-proxy-0.sha256")), false,
          "the record was named for the REQUESTED port, so every port-0 install on this " +
          "box shares one file and none of them describes the port it serves");

        // And the child is told the address it is serving, because its self-heal
        // reads this as "the advertised port" when the holder dies.
        const kid = await Promise.race([
          new Promise((r) => {
            const tick = setInterval(() => {
              const q = childOf(p.pid, /server\.mjs/);
              if (q) { clearInterval(tick); r(q); }
            }, 100);
          }),
          new Promise((r) => setTimeout(() => r(0), 15_000)),
        ]);
        assert.ok(kid, "premise: the holder never spawned a proxy child, so nothing was measured");
        const held = heldPortOf(kid);
        if (held === undefined) return;   // no /proc: the two assertions above still ran
        assert.equal(held, String(bound),
          `the child was told CACHE_FIX_HELD_PORT=${held} while ${bound} is being ` +
          `served — its self-heal would respawn on a different ephemeral port and strand ` +
          `every session on this one`);
      } finally {
        try { p.kill("SIGHUP"); } catch { }
        await new Promise((r) => setTimeout(r, 1_500));
        try { p.kill("SIGKILL"); } catch { }
        try { rmSync(tmp, { recursive: true, force: true }); } catch { }
      }
    });

    // THE HOLDER READS ITS CHILD'S ANNOUNCEMENTS AS LINES, NOT AS CHUNKS.
    //
    // Buffering was added for the port line, because a chunk boundary inside it
    // loses the port and every connection then waits out the relay's deadline.
    // The release test beside it kept reading the raw chunk, and that one is
    // worse: a boundary between "…listening socket" and "(handed off)" reads a
    // handover as a plain release, so the holder reclaims the port from the
    // successor that is already serving on it and spawns a second — the "one
    // extra proxy per deploy, 3 alive after 4" the (handed off) marker exists
    // to prevent, re-entered through the marker itself.
    //
    // The dispatch loop is lifted from source and driven at every boundary,
    // because the writes it must survive come from a real proxy's stdout and
    // cannot be forced from outside.
    it("reads the child's announcements as whole lines, at any chunk boundary", () => {
      const src = readFileSync(launcherPath, "utf8");
      const loop = /for \(let nl; \(nl = buf\.indexOf[\s\S]*?\n        \}/.exec(src)?.[0];
      assert.ok(loop, "the holder's stdout line-splitter is gone — this tests nothing");

      const announcements = [
        "proxy listening on 127.0.0.1:9901",
        "proxy releasing the listening socket (handed off)",
      ];
      const stream = announcements.join("\n") + "\n";
      // EVERY split, not a chosen one: the boundary that broke this sat inside
      // "(handed off)", and picking the split by hand is how a test agrees with
      // the bug it was written from.
      for (let cut = 0; cut <= stream.length; cut++) {
        const seen = [];
        const feed = Function("buf", "chunk", "onLine",
          `buf += chunk;\n${loop}\nreturn buf;`);
        let buf = "";
        buf = feed(buf, stream.slice(0, cut), (l) => seen.push(l));
        buf = feed(buf, stream.slice(cut), (l) => seen.push(l));
        assert.deepEqual(seen, announcements,
          `a chunk boundary at ${cut} split an announcement: ${JSON.stringify(seen)}`);
      }
      // AND THE DISPATCH, not only the splitter. The defect lives in WHERE
      // `(handed off)` is read, so moving that test back onto the raw chunk
      // passes everything above — the splitter still splits, nothing asks what
      // the holder concluded. I deleted the old source-text assertion calling it
      // "the appearance of a second guard"; measured, it was the only coverage
      // of this. Replaced with the behaviour rather than restored.
      const dispatch = /const onLine = \(line\) => \{[\s\S]*?\n      \};/.exec(src)?.[0];
      assert.ok(dispatch, "the holder's announcement dispatch is gone — this tests nothing");
      // What the holder DID, per chunk boundary: "reclaim+spawn" or "-".
      const drive = (text) => Array.from({ length: text.length + 1 }, (_, cut) => {
        // eslint-disable-next-line no-new-func
        const run = Function("chunkA", "chunkB", "reclaim", "spawnWhenReady", `
          let retired = false, child = null, childPort = 0, served = false, failures = 0;
          const me = null, process = { env: {} };
          const publishOurCA = () => {}, ourCAPath = () => "";
          ${dispatch}
          let buf = "";
          for (const chunk of [chunkA, chunkB]) {
            buf += chunk;
            for (let nl; (nl = buf.indexOf("\\n")) !== -1;) {
              const line = buf.slice(0, nl); buf = buf.slice(nl + 1); onLine(line);
            }
          }`);
        const at = [];
        run(text.slice(0, cut), text.slice(cut),
            () => at.push("reclaim"), () => at.push("spawn"));
        return at.join("+") || "-";
      });
      const firstOther = (rows, want) => rows.findIndex((r) => r !== want);

      // THE POSITIVE CONTROL FIRST, because the handover assertion below expects
      // "-" everywhere and "-" is also what a DEAD dispatch produces. Measured:
      // renaming the string onLine matches on leaves the holder never retiring,
      // reclaiming or spawning — and the handover assertion alone still passed.
      const plain = drive("proxy releasing the listening socket\n");
      assert.equal(firstOther(plain, "reclaim+spawn"), -1,
        `a plain release did not reclaim AND respawn at boundary ` +
        `${firstOther(plain, "reclaim+spawn")} (got "${plain[firstOther(plain, "reclaim+spawn")]}") — ` +
        `if that is "-", the dispatch is dead and the handover check below proves nothing`);

      // A HANDOVER MUST DO NEITHER. Reclaiming takes the port from the successor
      // already serving on it; spawning adds a second proxy — the "3 alive after
      // 4 deploys" this case exists to stop.
      const handed = drive(stream);
      assert.equal(firstOther(handed, "-"), -1,
        `a chunk boundary at ${firstOther(handed, "-")} made the holder ` +
        `"${handed[firstOther(handed, "-")]}" on a handover — it read "(handed off)" as a ` +
        `plain release and went after a live proxy's port`);
    });
  });

// A DEPLOY THAT NOBODY RELAUNCHES NEVER RUNS.
//
// Node reads the proxy source once at startup, so `git pull` updates files the
// live process is not executing — and the machine that most needs the upgrade
// is the one whose sessions never restart. cswap's pin served code replaced 19
// hours earlier for 22 hours with every health signal green; this fleet sat in
// the same state on all three hosts the day this was written.
//
// Driven through withFakeProxy so the file being "deployed over" is a per-call
// stand-in. Editing the real proxy/server.mjs here would deploy to every other
// case in the suite at the same time.
describe("deploy watcher (CACHE_FIX_WATCH_DEPLOY_MS)", () => {
  const serving = 'process.stdout.write(`proxy listening on 127.0.0.1:${process.env.CACHE_FIX_PROXY_PORT}\\n`); setInterval(() => {}, 1e9);\n';

  // THE PROXY child. A holder also parents a standby relay whose pid never
  // changes, and taking the first one made every restart look like no restart:
  // `settleFor` waited out its whole window for a pid that cannot move.
  const pidOn = (launcher) => {
    try {
      const out = execFileSync("pgrep", ["-P", String(launcher.pid)], { encoding: "utf8" });
      const p = Number(out.trim().split("\n").filter(Boolean)
        .find((q) => /scratch-fake-server-/.test(cmdOf(q))));
      return Number.isInteger(p) && p > 1 ? p : 0;
    } catch { return 0; }
  };
  const settleFor = async (launcher, was, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const now = pidOn(launcher);
      if (now && now !== was) return now;
      await new Promise((r) => setTimeout(r, 100));
    }
    return pidOn(launcher);
  };
  // Wait for the watcher's own announcement rather than for a pid, which can
  // change for reasons this suite is not about. Measured: under full-suite load
  // the pid moved at 625 ms while the announcement had not been written yet, so
  // asserting on the log straight after a pid change failed a working watcher.
  const saidWithin = async (stderr, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (/source changed/.test(stderr())) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return /source changed/.test(stderr());
  };

  it("restarts the proxy onto source whose BYTES changed", async () => {
    await withFakeProxy(serving, async ({ launcher, serverFile, stderr }) => {
      const before = await settleFor(launcher, 0, 8_000);
      assert.ok(before, "the stand-in proxy never started, so this measures nothing");
      await writeFile(serverFile, serving + "\n// deployed\n");
      // BOTH, in this order: the watcher said it acted, and only THEN is a
      // different process serving. The log alone would pass on a watcher that
      // announces and does nothing; the pid alone counts any restart, including
      // ones this case is not about.
      assert.ok(await saidWithin(stderr, 10_000),
        "the watcher never noticed a deploy that landed on disk. Launcher stderr: " +
        JSON.stringify(stderr().slice(-400)));
      const after = await settleFor(launcher, before, 8_000);
      assert.notEqual(after, before,
        "a deploy landed on disk and the running proxy kept serving the old bytes — " +
        "the state this exists to end, and the one a human has to notice today");
    }, { watchMs: 300, selfHeal: "on" });
  });

  it("leaves a healthy proxy alone when only the mtime moved", async () => {
    await withFakeProxy(serving, async ({ launcher, serverFile, stderr }) => {
      const before = await settleFor(launcher, 0, 8_000);
      assert.ok(before, "the stand-in proxy never started");
      // `touch` — what rsync -a, a rebuild that reproduces, or a restored backup
      // do. cswap's pin recycled a healthy daemon on exactly this.
      const t = Date.now() / 1000 + 3600;
      utimesSync(serverFile, t, t);
      await new Promise((r) => setTimeout(r, 2_000));
      assert.doesNotMatch(stderr(), /source changed/,
        "a newer mtime with identical bytes was read as a deploy");
    }, { watchMs: 300, selfHeal: "on" });
  });

  // "Do not act on your own" has to cover every path that acts on its own. The
  // switch predates this watcher and the proxy-side check honours it, so the
  // watcher LOOKED covered — measured, it was not: an operator editing the file
  // with the switch OFF still lost the proxy under them. cswap's pin had the
  // identical defect, found from the other side of the same conversation.
  it("honours CACHE_FIX_SELF_HEAL=off", async () => {
    await withFakeProxy(serving, async ({ launcher, serverFile, stderr }) => {
      const before = await settleFor(launcher, 0, 8_000);
      assert.ok(before, "the stand-in proxy never started");
      await writeFile(serverFile, serving + "\n// operator is editing\n");
      await new Promise((r) => setTimeout(r, 2_000));
      // Assert on what the WATCHER did, not on pid stability. A pid can change
      // for reasons this case is not about (the holder rebinding and spawning a
      // successor), and reading that as "the watcher acted" is a false failure —
      // measured on CI, green locally 5/5 and red on two node versions.
      // The announcement is the watcher's own account of itself.
      assert.doesNotMatch(stderr(), /source changed/,
        "the watcher acted while self-heal was OFF — the one thing that switch " +
        "exists to prevent");
    }, { watchMs: 300, selfHeal: "off" });
  });

  it("is off unless asked for", async () => {
    await withFakeProxy(serving, async ({ launcher, serverFile, stderr }) => {
      const before = await settleFor(launcher, 0, 8_000);
      assert.ok(before, "the stand-in proxy never started");
      await writeFile(serverFile, serving + "\n// deployed\n");
      await new Promise((r) => setTimeout(r, 2_000));
      assert.doesNotMatch(stderr(), /source changed/,
        "the watcher ran without being enabled — a restart is never free, so the " +
        "cost has to be opted into");
    }, { selfHeal: "on" });
  });
});
});

// ONE SWEEP FOR THE FILE, over the ports it handed out and nobody else's. A
// standby relay outlives a holder that was killed rather than released — that
// is the point of it — and while it has not armed yet it holds a socket nobody
// listened on, so a case's own cleanup cannot see it. Reaping by process name
// instead would reach into a neighbouring file's live fixture, since node runs
// test files concurrently in their own processes.
after(async () => {
  for (let i = 0; i < 6; i++) {
    let any = false;
    for (const port of usedPorts) {
      for (const q of listeners(port)) {
        // OURS ONLY. freePort() releases the port before handing it over, so by
        // sweep time the OS may have given it to something unrelated — and
        // signalling a stranger is exactly what holderPidOn's own comment
        // refuses to do.
        if (!/claude-via-proxy|gap-relay|server\.mjs|scratch-launcher-|scratch-fake-server-/.test(cmdOf(q))) continue;
        try { process.kill(Number(q), "SIGHUP"); any = true; } catch { }
      }
    }
    if (!any && i) break;
    await new Promise((r) => setTimeout(r, 700));
  }
});
