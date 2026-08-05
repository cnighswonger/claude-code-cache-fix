import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFile, rm } from "node:fs/promises";
import { readdirSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
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
  const env = { ...process.env, CACHE_FIX_HOLD_PORT: "on", CACHE_FIX_PROXY_PORT: String(port), ...extraEnv };
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
    await fn({ get, killProxy, launcher, exited, port });
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
async function withFakeProxy(serverSrc, fn) {
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
                CACHE_FIX_RESTART_BASE_MS: "25" };
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
    await fn({ launcher, port, bound, stderr: () => err });
  } finally {
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

    it("exits 0 and starts nothing when a proxy is already serving", async () => {
      await withHeldPort(async ({ get, port }) => {
        const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port) };
        for (const k of ["HTTPS_PROXY", "https_proxy", "LISTEN_FDS", "LISTEN_PID"]) delete env[k];
        const second = spawn(process.execPath, [launcherPath, "run-service"], { env, stdio: ["ignore", "pipe", "pipe"] });
        const code = await new Promise((r) => second.on("exit", (c) => r(c)));
        assert.equal(code, 0, "a second run-service must exit 0 rather than fail or fork a rival proxy");
        // The incumbent is still the one answering.
        assert.equal(JSON.parse(await get()).status, "ok", "the second invocation disturbed the running proxy");
      }, { subcommand: "run-service", extraEnv: { CACHE_FIX_HOLD_PORT: "" } });
    });
  });
});
