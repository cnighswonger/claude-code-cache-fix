import { describe, it } from "node:test";
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

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
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
it("holds the same default port the proxy would bind", () => {
  const launcher = readFileSync(launcherPath, "utf8");
  const cfg = readFileSync(join(dirname(launcherPath), "..", "proxy", "config.mjs"), "utf8");
  const want = /envInt\("CACHE_FIX_PROXY_PORT",\s*(\d+)\)/.exec(cfg)?.[1];
  assert.ok(want, "proxy/config.mjs no longer declares a CACHE_FIX_PROXY_PORT default");
  // Not assert.match: a failing match prints the whole launcher.
  const held = /Number\(process\.env\.CACHE_FIX_PROXY_PORT\) \|\| (\d+)/.exec(launcher)?.[1];
  assert.equal(held, want, `the holder falls back to ${held}, the proxy to ${want}`);
});

// A launcher holding a real port, its /health probe, and its reaper. The
// held-port tests need all three; `get` answers "ERR:<code>" rather than
// throwing so a caller can count failures instead of catching them.
async function withHeldPort(fn, { subcommand = "server", extraEnv = {} } = {}) {
  const port = await freePort();          // a real number: the holder owns the ADVERTISED port
  // Self-heal OFF by default. A proxy whose holder was SIGKILLed spawns a
  // REPLACEMENT holder about a second later, and nothing in a test tracks that
  // grandchild — measured, three leaked per run of this file, reparented to
  // init, accumulating until the box stalls. The cases that MEASURE self-heal
  // turn it back on through extraEnv, so the behaviour is still covered.
  const env = { ...process.env, CACHE_FIX_HOLD_PORT: "on", CACHE_FIX_PROXY_PORT: String(port),
                CACHE_FIX_SELF_HEAL: "off", ...extraEnv };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "LISTEN_FDS", "LISTEN_PID"]) delete env[k];
  const launcher = spawn(process.execPath, [launcherPath, subcommand], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((r) => launcher.on("exit", () => r(true)));
  const get = () => new Promise((res) => {
    http.get({ host: "127.0.0.1", port, path: "/health", timeout: 8_000 }, (r) => {
      let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(b));
    }).on("error", (e) => res(`ERR:${e.code}`));
  });
  // pgrep, never a pid arithmetic shortcut: `process.kill(0, ...)` signals the
  // caller's whole process group — the test runner included — and Number("")
  // and Number(undefined) are both 0.
  const proxyPid = () => {
    let out = "";
    try { out = execFileSync("pgrep", ["-P", String(launcher.pid)]).toString(); } catch { return 0; }
    const pid = Number(out.trim().split("\n")[0]);
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
    const cut = [];
    let served = false;
    const until = Date.now() + 10_000;
    while (!served && Date.now() < until) {
      const b = await get();
      if (b.startsWith("ERR:")) cut.push(b);
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
        q.resume();
        q.on("end", () => res("ok"));
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
    assert.equal(JSON.parse(await get()).status, "ok", "the holder stopped serving after the aborts");
  });
});

// A launcher whose proxy is a stand-in script, so a start failure can be
// driven on demand. The copy sits beside the real launcher for its relative
// imports; both files are removed again.
// Named per call, not per file: two cases running at once on one fixed name
// would each write the other's stand-in and delete it in their own cleanup.
let fakeSeq = 0;
async function withFakeProxy(serverSrc, fn, { watchMs } = {}) {
  const tag = `${process.pid}-${++fakeSeq}`;
  const failing = join(dirname(launcherPath), `.test-fake-server-${tag}.mjs`);
  const copy = join(dirname(launcherPath), `.test-launcher-${tag}.mjs`);
  await writeFile(failing, serverSrc);
  await writeFile(copy, readFileSync(launcherPath, "utf8").replace(
    /const SERVER_PATH = .*/, `const SERVER_PATH = ${JSON.stringify(failing)};`));
  const port = await freePort();
  // The backoff ladder is what these cases measure, and at its 250ms default
  // they measure it by sleeping through it — 22s of the file's runtime. The
  // seam shrinks the RUNGS, not the count, so the shape under assertion (does
  // it back off? does it give up after 5?) is the shipped one.
  const env = { ...process.env, CACHE_FIX_HOLD_PORT: "on", CACHE_FIX_PROXY_PORT: String(port),
                CACHE_FIX_RESTART_BASE_MS: "25", CACHE_FIX_SELF_HEAL: "off",
                ...(watchMs ? { CACHE_FIX_WATCH_DEPLOY_MS: String(watchMs) } : {}) };
  // An ambient LISTEN_FDS sends the launcher down the socket-activation path
  // instead of the holder, and an ambient proxy var routes its own requests
  // through a proxy that is not there.
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "LISTEN_FDS", "LISTEN_PID"]) delete env[k];
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
    await rm(failing, { force: true });
    await rm(copy, { force: true });
  }
}

// Never served: no session is wired to the port, so holding it in front of a
// proxy that cannot start only makes callers wait out the relay deadline
// instead of failing over at once.
it("gives the port up when the proxy never starts", async () => {
  await withFakeProxy('process.stderr.write("simulated\\n"); process.exit(1);\n',
    async ({ launcher, bound, stderr }) => {
      const exited = await Promise.race([
        new Promise((r) => launcher.on("exit", () => r(true))),
        new Promise((r) => setTimeout(() => r(false), 8_000)),
      ]);
      assert.ok(exited, "the launcher respawned a hopeless proxy forever, holding the port");
      assert.match(stderr(), /releasing the port/);
      assert.equal(await bound(), false, "the port was still bound after the launcher gave up");
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
      const kid = Number(out.trim().split("\n")[0]);
      assert.ok(Number.isInteger(kid) && kid > 1, "the fake proxy never started, so this measures nothing");
      process.kill(kid, "SIGKILL");
      // Long enough for an UNBACKED-OFF loop to blow the ceiling: at the 25ms
      // base the ladder tops out at 500ms, so ~1.2s admits at most a handful of
      // tries and a spinner would land dozens. Measured both ways below.
      await new Promise((r) => setTimeout(r, 1_200));

      assert.equal(launcher.exitCode, null, "the launcher gave the port up, stranding every wired session");
      assert.equal(await bound(), true, "the port was released while sessions were still wired to it");
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

  describe("run-service", () => {
    // The whole point of the subcommand: it gives an unsupervised host what a
    // systemd unit gives a supervised one. Same holder, so the port survives a
    // proxy death — asserted here on the SUBCOMMAND, because a caller who types
    // `run-service` never sets CACHE_FIX_HOLD_PORT and must not have to.
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
      for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                       "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID"]) delete env[k];
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
      for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                       "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID"]) delete env[k];
      const get = () => new Promise((res) => {
        http.get({ host: "127.0.0.1", port, path: "/health", timeout: 3_000 }, (r) => {
          let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(b));
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
      const fn = src.slice(src.indexOf("function holderPidOn"));
      const rule = fn.slice(0, fn.indexOf('return "holder"'));
      // The distinguishing fact is the SUBCOMMAND. `cache-fix-proxy` is our own
      // bin name, so matching it identifies the package, not the role.
      assert.match(rule, /run-service/,
        "holder detection does not key on the run-service subcommand, so a plain " +
        "`cache-fix-proxy server` reads as a holder and a deploy silently skips it");
      assert.ok(!/cache-fix-proxy\b(?!.*run-service)/.test(rule.replace(/\/\/[^\n]*/g, "")),
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
      for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                       "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID",
                       "CACHE_FIX_HOLD_PORT"]) delete env[k];
      const get = () => new Promise((res) => {
        http.get({ host: "127.0.0.1", port, path: "/health", timeout: 3_000 }, (r) => {
          let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(b));
        }).on("error", (e) => res(`ERR:${e.code}`));
      });
      const old = spawn(process.execPath, [launcherPath, "server"], { env, stdio: ["ignore", "pipe", "pipe"] });
      const taker = spawn(process.execPath, [launcherPath, "run-service"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let warned = "";
      taker.stderr.on("data", (d) => { warned += d.toString(); });
      try {
        const up = Date.now() + 15_000;
        let body = await get();
        while (body.startsWith("ERR:") && Date.now() < up) body = await get();
        assert.equal(JSON.parse(body).status, "ok", "nothing served the port");
        // Past the retry ladder, so a per-attempt spawn would have happened.
        await new Promise((r) => setTimeout(r, 3_000));
        let kids = [];
        try { kids = execFileSync("pgrep", ["-P", String(taker.pid)], { encoding: "utf8" })
                       .trim().split("\n").filter(Boolean); } catch {}
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
          // A REFUSAL is the failure the held port exists to prevent: it means
          // the address had no owner, and a session that baked HTTPS_PROXY at
          // exec is stranded for good. Zero, always.
          const refused = cut.filter((c) => c === "ECONNREFUSED" || c === "ETIMEDOUT");
          assert.deepEqual(refused, [],
            `the port had no owner for ${refused.length} of 40 requests — a session ` +
            `wired to that address is stranded, which is the outage this guards`);
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
      assert.ok(rule && fpFns,
        "holderPidOn/runningOurCode are gone — the upgrade decision moved and this no longer tests it");

      const dir = mkdtempSync(join(tmpdir(), "ccf-fp-"));
      const ours = join(dir, "server.mjs");
      writeFileSync(ours, "// build A\n");
      const record = join(dir, `cache-fix-proxy-${9901}.sha256`);
      const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

      // The incumbent published what IT booted with; we hash what WE would run.
      const decide = () => {
        const fake = {
          execFileSync: (cmd, args) => {
            if (cmd === "lsof") return "4242\n";
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
          `${fpFns}\n${rule}\nreturn holderPidOn(9901);`)(
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

        // No record at all (killed -9 mid-write, first boot): leave it alone.
        rmSync(record, { force: true });
        assert.equal(decide(), "holder",
          "an unreadable record must mean LEAVE ALONE — guessing here signals a " +
          "process we cannot identify");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits 0 and starts nothing when a proxy is already serving", async () => {
      await withHeldPort(async ({ get, port, proxyPid }) => {
        const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port) };
        for (const k of ["HTTPS_PROXY", "https_proxy", "LISTEN_FDS", "LISTEN_PID"]) delete env[k];
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

  const pidOn = (launcher) => {
    try {
      const out = execFileSync("pgrep", ["-P", String(launcher.pid)], { encoding: "utf8" });
      const p = Number(out.trim().split("\n")[0]);
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

  it("restarts the proxy onto source whose BYTES changed", async () => {
    await withFakeProxy(serving, async ({ launcher, serverFile }) => {
      const before = await settleFor(launcher, 0, 8_000);
      assert.ok(before, "the stand-in proxy never started, so this measures nothing");
      await writeFile(serverFile, serving + "\n// deployed\n");
      const after = await settleFor(launcher, before, 8_000);
      assert.notEqual(after, before,
        "a deploy landed on disk and the running proxy kept serving the old bytes — " +
        "the state this exists to end, and the one a human has to notice today");
    }, { watchMs: 300 });
  });

  it("leaves a healthy proxy alone when only the mtime moved", async () => {
    await withFakeProxy(serving, async ({ launcher, serverFile }) => {
      const before = await settleFor(launcher, 0, 8_000);
      assert.ok(before, "the stand-in proxy never started");
      // `touch` — what rsync -a, a rebuild that reproduces, or a restored backup
      // do. cswap's pin recycled a healthy daemon on exactly this.
      const t = Date.now() / 1000 + 3600;
      utimesSync(serverFile, t, t);
      await new Promise((r) => setTimeout(r, 2_000));
      assert.equal(pidOn(launcher), before,
        "a newer mtime with identical bytes restarted a healthy proxy");
    }, { watchMs: 300 });
  });

  it("is off unless asked for", async () => {
    await withFakeProxy(serving, async ({ launcher, serverFile }) => {
      const before = await settleFor(launcher, 0, 8_000);
      assert.ok(before, "the stand-in proxy never started");
      await writeFile(serverFile, serving + "\n// deployed\n");
      await new Promise((r) => setTimeout(r, 2_000));
      assert.equal(pidOn(launcher), before,
        "the watcher ran without being enabled — a restart is never free, so the " +
        "cost has to be opted into");
    });
  });
});
});
