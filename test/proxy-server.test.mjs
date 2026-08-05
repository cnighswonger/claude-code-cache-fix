import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { startProxy, upstreamPointsAtSelf } from "../proxy/server.mjs";
import { startWatcher } from "../proxy/watcher.mjs";
import { loadExtensions, getRegistry } from "../proxy/pipeline.mjs";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "proxy", "server.mjs");
const launcherPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-via-proxy.mjs");

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

let handle;
let proxyPort;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: proxyPort, method, path },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("proxy server", () => {
  before(async () => {
    // Port 0 → OS-assigned ephemeral port. Avoids the prior random-port
    // collision risk on parallel test runs and exercises the new factory's
    // resolved-port plumbing.
    handle = await startProxy({ port: 0, watch: false });
    proxyPort = handle.port;
  });

  after(async () => {
    await handle.close();
  });

  it("GET /health returns 200 with status ok", async () => {
    const res = await request("GET", "/health");
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, "ok");
    // https_proxy is always present; null outside forward-proxy mode (this
    // server runs in reverse-proxy mode, so forward_proxy is false here).
    assert.equal(parsed.forward_proxy, false);
    assert.equal(parsed.https_proxy, null);
  });

  it("GET /unknown returns 404", async () => {
    const res = await request("GET", "/unknown");
    assert.equal(res.status, 404);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, "not_found");
  });

  it("POST to non-messages path returns 404", async () => {
    const res = await request("POST", "/v1/completions", "{}");
    assert.equal(res.status, 404);
  });

  it("POST /v1/messages routes to upstream (may get auth error or 502)", async () => {
    const res = await request("POST", "/v1/messages", JSON.stringify({ model: "test", messages: [] }));
    // Without valid auth we expect either 401 from upstream or 502 if unreachable
    assert.ok([401, 502].includes(res.status));
  });
});

// #196 / #198: hot-reload is opt-in via CACHE_FIX_HOT_RELOAD=on. These tests
// exercise the new gate at the startProxy() seam plus the boot banner.

async function withHotReloadEnv(value, fn) {
  const prior = process.env.CACHE_FIX_HOT_RELOAD;
  if (value === undefined) delete process.env.CACHE_FIX_HOT_RELOAD;
  else process.env.CACHE_FIX_HOT_RELOAD = value;
  // Capture stderr around the work — the banner is emitted at startProxy()
  // time, so wrap the whole call site.
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    await fn(captured);
  } finally {
    process.stderr.write = origWrite;
    if (prior === undefined) delete process.env.CACHE_FIX_HOT_RELOAD;
    else process.env.CACHE_FIX_HOT_RELOAD = prior;
  }
}

async function withExtDir(fn) {
  const dir = join(tmpdir(), `hot-reload-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const cfg = join(dir, "extensions.json");
  await writeFile(cfg, JSON.stringify({}));
  try {
    await fn({ dir, cfg });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("hot-reload opt-in (#196)", () => {
  it("default (envvar unset): watcher does not start, file mutations do not reload", async () => {
    await withHotReloadEnv(undefined, async (captured) => {
      await withExtDir(async ({ dir, cfg }) => {
        // Use options.watch !== false to confirm the envvar gate is what
        // suppresses the watcher (not the explicit override).
        const handle = await startProxy({ port: 0, extensionsDir: dir, extensionsConfig: cfg });
        try {
          assert.ok(
            captured.some((s) => s.includes("hot-reload: off")),
            "expected off-mode banner in stderr",
          );
          assert.ok(
            !captured.some((s) => s.includes("hot-reload: on")),
            "off banner must not also claim on",
          );

          const initial = getRegistry().length;
          await writeFile(
            join(dir, "late-arrival.mjs"),
            `export default { name: "late", order: 1000, onRequest(ctx) {} };`,
          );
          // Wait well past the watcher's 100ms debounce.
          await new Promise((r) => setTimeout(r, 250));
          assert.equal(
            getRegistry().length,
            initial,
            "file mutation must NOT trigger reload when watcher is gated off",
          );
        } finally {
          await handle.close();
        }
      });
    });
  });

  it("CACHE_FIX_HOT_RELOAD=on: watcher starts and file mutations DO reload", async () => {
    await withHotReloadEnv("on", async (captured) => {
      await withExtDir(async ({ dir, cfg }) => {
        const handle = await startProxy({ port: 0, extensionsDir: dir, extensionsConfig: cfg });
        try {
          assert.ok(
            captured.some((s) => s.includes("hot-reload: on")),
            "expected on-mode banner in stderr",
          );

          // Drop a new extension and verify the watcher picks it up.
          await writeFile(
            join(dir, "hot-loaded.mjs"),
            `export default { name: "hot-loaded", order: 1000, onRequest(ctx) {} };`,
          );
          // Watcher debounces 100ms; allow generous slack for fs.watch.
          await new Promise((r) => setTimeout(r, 400));
          assert.ok(
            getRegistry().some((e) => e.name === "hot-loaded"),
            "watcher must reload after a file change when envvar=on",
          );
        } finally {
          await handle.close();
        }
      });
    });
  });

  it("options.watch:false wins even when envvar=on (embedded-caller escape hatch)", async () => {
    await withHotReloadEnv("on", async () => {
      await withExtDir(async ({ dir, cfg }) => {
        const handle = await startProxy({
          port: 0,
          watch: false,
          extensionsDir: dir,
          extensionsConfig: cfg,
        });
        try {
          const initial = getRegistry().length;
          await writeFile(
            join(dir, "should-not-load.mjs"),
            `export default { name: "nope", order: 1000, onRequest(ctx) {} };`,
          );
          await new Promise((r) => setTimeout(r, 250));
          assert.equal(
            getRegistry().length,
            initial,
            "options.watch:false must override envvar=on",
          );
        } finally {
          await handle.close();
        }
      });
    });
  });

  for (const v of ["true", "1", "yes", ""]) {
    it(`envvar=${JSON.stringify(v)} treated as off (strict === "on" gate)`, async () => {
      await withHotReloadEnv(v, async (captured) => {
        await withExtDir(async ({ dir, cfg }) => {
          const handle = await startProxy({
            port: 0,
            extensionsDir: dir,
            extensionsConfig: cfg,
          });
          try {
            assert.ok(
              captured.some((s) => s.includes("hot-reload: off")),
              `expected off-mode banner for envvar=${JSON.stringify(v)}`,
            );
            // Banner is observable; also assert the watcher actually didn't
            // start by dropping a file and confirming the registry is stable.
            const initial = getRegistry().length;
            await writeFile(
              join(dir, "strict-gate.mjs"),
              `export default { name: "strict-gate", order: 1000, onRequest(ctx) {} };`,
            );
            await new Promise((r) => setTimeout(r, 250));
            assert.equal(
              getRegistry().length,
              initial,
              `envvar=${JSON.stringify(v)} must NOT trigger reload (gate is === "on")`,
            );
          } finally {
            await handle.close();
          }
        });
      });
    });
  }

  it("banner is keyed off effective watch state — options.watch:false + envvar=on reports off", async () => {
    await withHotReloadEnv("on", async (captured) => {
      await withExtDir(async ({ dir, cfg }) => {
        const handle = await startProxy({
          port: 0,
          watch: false,
          extensionsDir: dir,
          extensionsConfig: cfg,
        });
        try {
          assert.ok(
            captured.some((s) => s.includes("hot-reload: off")),
            "banner must reflect effective watcher state, not raw envvar",
          );
          assert.ok(
            !captured.some((s) => s.includes("hot-reload: on")),
            "banner must not say 'on' when the watcher is suppressed",
          );
        } finally {
          await handle.close();
        }
      });
    });
  });

  // Direct startWatcher smoke test — codifies that the watcher itself still
  // works the same way it always did. Per Codex round-1 review, no direct
  // coverage of startWatcher existed in the suite before this directive.
  it("startWatcher: reloads extensions when a watched file changes (direct, no startProxy)", async () => {
    await withExtDir(async ({ dir, cfg }) => {
      await loadExtensions(dir, cfg);
      const watcher = startWatcher(dir, cfg);
      try {
        await writeFile(
          join(dir, "direct-watcher.mjs"),
          `export default { name: "direct-watcher", order: 1000, onRequest(ctx) {} };`,
        );
        await new Promise((r) => setTimeout(r, 400));
        assert.ok(
          getRegistry().some((e) => e.name === "direct-watcher"),
          "direct startWatcher must reload on file change",
        );
      } finally {
        watcher.close();
      }
    });
  });
});

// Regression coverage for #196: when extensions fail to load, /health must
// surface the degraded state so monitoring can page instead of the proxy
// silently running with a broken extension graph for 17 hours.
describe("proxy server /health degraded (#196)", () => {
  const extDir = join(tmpdir(), `server-health-degraded-${Date.now()}`);
  const extConfig = join(extDir, "extensions.json");
  let degradedHandle;
  let degradedPort;

  before(async () => {
    await mkdir(extDir, { recursive: true });
    await writeFile(extConfig, JSON.stringify({}));
    await writeFile(
      join(extDir, "broken.mjs"),
      `throw new Error("simulated load failure for #196 test");`
    );
    degradedHandle = await startProxy({
      port: 0,
      watch: false,
      extensionsDir: extDir,
      extensionsConfig: extConfig,
    });
    degradedPort = degradedHandle.port;
  });

  after(async () => {
    await degradedHandle.close();
    await rm(extDir, { recursive: true, force: true });
  });

  it("GET /health returns 503 + degraded when an extension failed to load", async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: degradedPort, method: "GET", path: "/health" },
        (r) => {
          const chunks = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
        }
      );
      req.on("error", reject);
      req.end();
    });

    assert.equal(res.status, 503);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, "degraded");
    assert.equal(parsed.failed_extensions.length, 1);
    assert.equal(parsed.failed_extensions[0].file, "broken.mjs");
    // Hint must point at "restart via supervisor" (supervisor-neutral wording —
    // operator runs systemd-user on Linux, launchd on macOS, etc.) and cite #196.
    assert.match(parsed.hint, /restart the proxy via your supervisor/);
    assert.match(parsed.hint, /#196/);
    // Guard against regression to a Linux-specific hint that would mislead
    // macOS operators (the round-1 Codex finding on this PR).
    assert.ok(!/cache-fix-proxy\.service/.test(parsed.hint), "hint must not be systemd-specific");
  });
});

describe("zero-downtime reload", () => {
  // A reload must not cut a response that is already streaming. Kill-then-respawn
  // does: the port is unbound between the two, and every in-flight body dies.
  //
  // Driven with two REAL server processes over a socket THIS test binds and
  // never closes, because the question is whether a successor can serve a
  // listener it did not bind — which an in-process test cannot ask.
  it("a successor serves the inherited socket while the old process is still streaming", async () => {
    // A deliberately slow upstream, so the response is still open at the reload.
    //
    // Ended on DEMAND, not on a chunk count: a fixed 12 x 250ms budget has to
    // outlast a whole second proxy boot, and on CI's 2-core runner it did not —
    // the stream finished first and the test's own premise check fired
    // ("it had already finished after 1 chunks"). Now it streams until this
    // test says stop, so the boot can take as long as the box needs.
    // EVERY open response, not "the last one to arrive". A single `stopStream`
    // variable was overwritten by the next request this upstream served — the
    // proxy's own boot probe reaches it too — so the 1.5s stop closed a
    // different response and the streaming one was cut by nothing the test
    // could see. It surfaced as the premise check firing with `ended` true,
    // which reads as "the upstream finished" and is the opposite of what
    // happened.
    const openStreams = new Set();
    const stopStream = () => { for (const s of openStreams) s(); openStreams.clear(); };
    const upstream = http.createServer((q, r) => {
      r.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const t = setInterval(() => r.write(`data: ${++n}\n\n`), 250);
      const stop = () => { clearInterval(t); try { r.end(); } catch {} };
      openStreams.add(stop);
      r.on("close", () => { clearInterval(t); openStreams.delete(stop); });
      q.resume();
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = upstream.address().port;

    // The supervisor's socket. Bound once here and never closed — that is the
    // whole mechanism, so nothing in this test may close it early.
    //
    // The real supervisor is a shell: it holds the fd and NEVER accepts. A node
    // server accepts unconditionally, and the kernel shares accepts with the
    // proxy that inherited the same socket — so one this fixture took was
    // answered with a 15-byte /health body, and the streaming client saw its
    // response END after one chunk. Measured under load: steals tracked the
    // failure 1:1, one steal per failing run and none in a passing one.
    //
    // `pause()` is the fix, not a bigger backlog: it stops this process pulling
    // from the accept queue while the socket stays bound, which is exactly what
    // a shell holding an fd does.
    const stolenSockets = new Set();
    const listener = net.createServer();
    // A steal is UNAVOIDABLE: a node server accepts, and there is no knob that
    // holds the fd without accepting (measured — net.Server has no pause(), and
    // maxConnections=0 accepts then RSTs 19 of 20). The kernel shares the accept
    // queue with the proxies that inherited this socket, so some connections
    // land here.
    //
    // So RESET a steal and let the caller retry. The two alternatives both
    // corrupt the measurement: ANSWERING it (the old `content-length: 15`
    // /health body) ended the streaming client after one chunk — steals tracked
    // the failure 1:1 under load — and holding it open with no reply hangs the
    // caller until its own deadline. A reset is the one answer a client can
    // tell apart from a served response, so the retry below is sound.
    let stolen = 0;
    listener.on("connection", (c) => {
      stolen++;
      c.on("error", () => {});
      c.resetAndDestroy?.() ?? c.destroy();
    });
    await new Promise((r) => listener.listen({ port: 0, host: "127.0.0.1" }, r));
    const PORT = listener.address().port;
    const fd = listener._handle.fd;
    assert.ok(fd >= 0, `no numeric fd for the listening socket on ${process.platform}`);

    const env = { ...process.env,
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upPort}`,
      LISTEN_FDS: "1" };
    // Ambient proxy vars would send this test's own requests through a real
    // proxy on the developer's box, which hangs forever.
    // ALL_PROXY too, not just the http/https pair: node consults it as a fallback,
    // so a developer whose shell exports one (an account-pinning MITM, say) sends
    // this test's own upstream traffic through it. Measured on such a box under
    // load — the relayed stream was ended after one chunk and the premise check
    // fired, describing a defect that only existed in the harness.
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) delete env[k];

    // Through the LAUNCHER, which is what a supervisor actually runs. `stdio:
    // "inherit"` there passes fds 0-2 only, so this is where a handed-down
    // socket is silently lost and the server binds its own port instead.
    const boot = () => spawn(process.execPath, [launcherPath, "server"], {
      env, stdio: ["ignore", "pipe", "pipe", fd] });
    const started = (p) => new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("proxy did not report listening")), 15_000);
      p.stdout.on("data", (d) => { if (/listening/.test(String(d))) { clearTimeout(to); res(); } });
      p.on("error", rej);
    });

    const older = boot();
    const kids = [older];
    try {
      await started(older);

      // Start streaming, and wait until bytes are actually flowing — a request
      // that has not been answered yet would prove nothing about in-flight.
      let chunks = 0, ended = false, failure = null;
      // Retried on a reset, because a steal RSTs (above). Only BEFORE any byte
      // arrives: once the proxy is streaming, a reset is the defect this test
      // exists to catch and must never be retried away.
      const openStream = () => {
        const r = http.request(
          { host: "127.0.0.1", port: PORT, path: "/v1/messages", method: "POST",
            headers: { "content-type": "application/json" } },
          (res) => {
            res.on("data", () => chunks++);
            res.on("end", () => { ended = true; });
            res.on("error", (e) => { failure = e.code || e.message; });
          });
        r.on("error", (e) => {
          if (chunks === 0 && Date.now() < flowing) return void openStream();
          failure = e.code || e.message;
        });
        r.end(JSON.stringify({ model: "x", messages: [], stream: true }));
        return r;
      };
      const flowing = Date.now() + 10_000;
      openStream();
      while (chunks === 0 && Date.now() < flowing) await new Promise((r) => setTimeout(r, 100));
      assert.ok(chunks > 0, `premise: the response must be streaming before the reload. failure=${failure}`);

      const newer = boot();
      kids.push(newer);
      await started(newer);

      // PRECONDITION, asserted rather than assumed: the stream must still be
      // OPEN at the reload, or "it completed" is satisfied by a response that
      // had already finished and the test measures nothing. An accidental
      // control is invisible until a slower box or a faster upstream turns this
      // green without exercising anything.
      assert.ok(!ended, `premise: the stream must still be open at the reload; it had already ` +
        `finished after ${chunks} chunks, so this run measured a completed response`);
      const midflight = chunks;

      older.kill("SIGTERM");
      // Let a few more chunks cross the handover, THEN end it. The assertions
      // below are "nothing was cut" and "chunks arrived after the reload";
      // both need the stream to outlive the signal, not the clock.
      setTimeout(() => stopStream(), 1_500);
      const done = Date.now() + 20_000;
      while (!ended && !failure && Date.now() < done) await new Promise((r) => setTimeout(r, 100));

      assert.equal(failure, null, `the reload cut a response that was already streaming (${failure})`);
      assert.ok(ended, "the streaming response never completed across the reload");
      // ...and it kept going AFTER the reload rather than having been complete
      // at the moment of it.
      assert.ok(chunks > midflight,
        `no chunk arrived after the reload (${midflight} before, ${chunks} total), ` +
        `so the handover was never exercised`);

      // The successor is serving, and it is the one still alive.
      //
      // RETRIED ON A RESET, the same rule the streaming request above follows
      // and for the same reason: this fixture's listener shares the accept
      // queue and RSTs whatever it takes (`resetAndDestroy`, ~40 lines up), so
      // a single probe that happens to be stolen fails on the harness rather
      // than on the proxy. The odds scale with how little CPU there is —
      // measured, this passed 2 of 2 full-file runs on 48 cores and failed 3 of
      // 3 pinned to 2 with `taskset -c 0,1`, which is CI's shape. The error was
      // always ERR:ECONNRESET, never a bad body.
      //
      // A reset is the ONE answer a client can tell apart from a served
      // response, which is what makes retrying sound here; a wrong body or a
      // refusal still fails, because those are the proxy's answers, not the
      // fixture's.
      const probe = () => new Promise((res) => {
        http.get({ host: "127.0.0.1", port: PORT, path: "/health" }, (r) => {
          let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(b));
        }).on("error", (e) => res(`ERR:${e.code}`));
      });
      let health = await probe();
      const settled = Date.now() + 10_000;
      while (health === "ERR:ECONNRESET" && Date.now() < settled) health = await probe();
      assert.ok(!health.startsWith("ERR:"),
        `the port answered nothing after the predecessor exited: ${health}`);
      assert.equal(JSON.parse(health).status, "ok",
        `nothing served the port after the predecessor exited (got ${JSON.stringify(health.slice(0, 120))})`);
    } finally {
      // SIGTERM, not SIGKILL: the launcher forwards it to the server it spawned.
      // SIGKILL cannot be forwarded, so the server would outlive its parent and
      // keep this test's event loop alive on its pipes.
      for (const k of kids) { try { k.kill("SIGTERM"); } catch {} }
      await Promise.all(kids.map((k) => new Promise((r) => {
        if (k.exitCode !== null || k.signalCode) return r();
        const t = setTimeout(() => { try { k.kill("SIGKILL"); } catch {} r(); }, 8_000);
        k.on("exit", () => { clearTimeout(t); r(); });
      })));
      // Before close(): it waits on every open response, and an assertion that
      // threw before the deliberate stop above leaves this one streaming
      // forever — the cleanup would hang rather than report the failure.
      stopStream();
      await new Promise((r) => upstream.close(r));
      for (const c of stolenSockets) c.destroy();
      await new Promise((r) => listener.close(r));
    }
  });


  // `LISTEN_FDS` reaches every descendant, so a proxy can be handed a claim for
  // a socket it does not have. Both doors: named for another pid, and named for
  // us but pointing at something unservable (fd 3 in an IPC-forked child is the
  // IPC channel — `listen({fd:3})` fails EEXIST there). Either way it must end
  // up serving a port of its own, never nothing.
  for (const [name, env] of [
    ["addressed to another process", { LISTEN_FDS: "1", LISTEN_PID: String(process.pid + 1) }],
    ["pointing at an unservable fd", { LISTEN_FDS: "1" }],
  ]) {
    it(`binds its own port when LISTEN_FDS is ${name}`, async () => {
      const saved = { fds: process.env.LISTEN_FDS, pid: process.env.LISTEN_PID };
      Object.assign(process.env, env);
      if (!("LISTEN_PID" in env)) delete process.env.LISTEN_PID;
      let handle = null;
      try {
        handle = await startProxy({ port: 0, bind: "127.0.0.1", watch: false });
        assert.ok(handle.port > 0, "bound nothing of its own, so the port is unserved");
        const body = await new Promise((res) => {
          http.get({ host: "127.0.0.1", port: handle.port, path: "/health" }, (r) => {
            let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(b));
          }).on("error", (e) => res(`ERR:${e.code}`));
        });
        assert.equal(JSON.parse(body).status, "ok", "the port it bound does not serve");
      } finally {
        for (const [k, v] of [["LISTEN_FDS", saved.fds], ["LISTEN_PID", saved.pid]]) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        if (handle) await handle.close();
      }
    });
  }

  // The upstream comes from HTTPS_PROXY, so it is chosen by whichever shell
  // launched us. Started from a shell that already exports the chain, this proxy
  // adopts a hop pointing back at itself and every request loops instead of
  // reaching the internet.
  //
  // Happened twice on one box in one day. Both times /health was fully green —
  // status ok, forward_proxy true, port bound — because those fields report what
  // is CONFIGURED. Only the VALUE of https_proxy showed it, which is why this
  // asserts a refusal to START rather than a health field.
  describe("upstream self-reference", () => {
    const self = (u, port = 9901, bind = "127.0.0.1") => upstreamPointsAtSelf(u, port, bind);

    it("refuses an upstream that is this proxy's own address", () => {
      // The incident verbatim: pin credentials, our own port.
      assert.ok(self("http://cswap:tok@127.0.0.1:9901"), "the measured loop was allowed");
      assert.ok(self("http://127.0.0.1:9901"), "bare self-reference was allowed");
      assert.ok(self("http://localhost:9901"), "a local alias of ourselves was allowed");
    });

    it("allows the hop below, and any remote host", () => {
      assert.equal(self("http://127.0.0.1:8118"), "",
        "refused the CORRECT next hop — this would break every healthy start");
      assert.equal(self("http://proxy.corp:9901"), "",
        "refused a remote upstream that merely shares our port number");
      assert.equal(self(""), "", "refused when there is no upstream at all");
    });

    it("does not echo credentials into the error", () => {
      assert.ok(!self("http://cswap:SECRET@127.0.0.1:9901").includes("SECRET"),
        "the refusal message would leak a token into every log that captures it");
    });

    it("startProxy actually refuses, not just the predicate", async () => {
      const saved = process.env.HTTPS_PROXY;
      process.env.HTTPS_PROXY = "http://127.0.0.1:19893";
      try {
        await assert.rejects(
          () => startProxy({ port: 19893, bind: "127.0.0.1", watch: false }),
          /refusing to start/,
          "the predicate is right but nothing calls it — a looping proxy still boots");
      } finally {
        if (saved === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = saved;
      }
    });

    // The self-loop guard only catches an upstream that is US. The process
    // measured during the outage pointed at the hop IN FRONT of us (the pin),
    // which is not our address and passes that guard — so the upstream must
    // stop being whatever the launching shell exported.
    it("a dedicated upstream variable outranks the session's wiring", async () => {
      const saved = { u: process.env.CACHE_FIX_UPSTREAM_PROXY, s: process.env.HTTPS_PROXY };
      process.env.CACHE_FIX_UPSTREAM_PROXY = "http://127.0.0.1:8118";
      process.env.HTTPS_PROXY = "http://127.0.0.1:36301";
      try {
        const { default: fresh } = await import(`../proxy/config.mjs?u=${Date.now()}`);
        assert.equal(fresh.httpsProxy, "http://127.0.0.1:8118",
          "an inherited HTTPS_PROXY beat the dedicated variable — this is the outage");
        assert.equal(fresh.httpProxy, "http://127.0.0.1:8118",
          "httpProxy ignored the dedicated variable, so the fallthrough still loops");
      } finally {
        for (const [k, v] of [["CACHE_FIX_UPSTREAM_PROXY", saved.u], ["HTTPS_PROXY", saved.s]]) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    });

    it("run-service drops inherited wiring, and says so in the source", () => {
      const src = readFileSync(new URL("../bin/claude-via-proxy.mjs", import.meta.url), "utf8");
      const branch = /SUBCOMMAND === "run-service"[\s\S]*?return holdPort/.exec(src)?.[0];
      assert.ok(branch, "the run-service branch moved — this no longer tests it");
      for (const k of ["HTTPS_PROXY", "ALL_PROXY", "HTTP_PROXY"]) {
        assert.match(branch, new RegExp(`"${k}"`),
          `run-service does not clear ${k}, so a wired shell still decides our upstream`);
      }
      assert.match(branch, /CACHE_FIX_UPSTREAM_PROXY/,
        "clearing without an escape hatch leaves an operator no way to set the upstream");
    });

    // Both outages had every health field green, because they all reported what
    // was CONFIGURED. These two report what IS: the port we took, and whether
    // our own upstream loops back to us.
    it("health reports the port it actually bound", async () => {
      const handle = await startProxy({ port: 0, bind: "127.0.0.1", watch: false });
      try {
        const body = await new Promise((res) => {
          http.get({ host: "127.0.0.1", port: handle.port, path: "/health" }, (r) => {
            let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(b));
          }).on("error", (e) => res(`ERR:${e.code}`));
        });
        const h = JSON.parse(body);
        assert.equal(h.listen_port, handle.port,
          "health did not name the bound port — a proxy on the wrong port reads as healthy");
        assert.notEqual(h.listen_port, 0,
          "port 0 was echoed back rather than the ephemeral port actually taken");
        assert.equal(h.upstream_is_self, false,
          "a proxy with no self-referencing upstream reported one");
      } finally {
        await handle.close();
      }
    });

    // A service binds an address sessions were ALREADY told to use, so the
    // built-in default is a wrong answer rather than a missing one: it binds a
    // port nobody dials while every health field reports a healthy proxy.
    // Measured — a run-service started without it took 9801 while the fleet was
    // on 9901, and that process was still sitting there 9 hours later.
    it("run-service refuses to guess its port", () => {
      const port = process.env.CACHE_FIX_PROXY_PORT;
      delete process.env.CACHE_FIX_PROXY_PORT;
      try {
        const r = execFileSync(process.execPath,
          [fileURLToPath(new URL("../bin/claude-via-proxy.mjs", import.meta.url)), "run-service"],
          { encoding: "utf8", env: { ...process.env, CACHE_FIX_FORWARD_PROXY: "on" },
            stdio: ["ignore", "pipe", "pipe"] });
        assert.fail(`run-service started without a port and printed: ${r.slice(0, 120)}`);
      } catch (e) {
        assert.match(String(e.stderr ?? e.message), /needs CACHE_FIX_PROXY_PORT/,
          "it did not refuse — a service bound a port nobody was told about");
      } finally {
        if (port === undefined) delete process.env.CACHE_FIX_PROXY_PORT;
        else process.env.CACHE_FIX_PROXY_PORT = port;
      }
    });

    // The polluted process had HTTPS_PROXY on the pin and HTTP_PROXY on itself.
    // selectProxyUrl falls through to httpProxy when httpsProxy is empty, so
    // that half alone still builds the loop.
    it("refuses when only HTTP_PROXY names us", async () => {
      const saved = { s: process.env.HTTPS_PROXY, p: process.env.HTTP_PROXY };
      delete process.env.HTTPS_PROXY;
      process.env.HTTP_PROXY = "http://127.0.0.1:19894";
      try {
        await assert.rejects(
          () => startProxy({ port: 19894, bind: "127.0.0.1", watch: false }),
          /refusing to start/,
          "HTTP_PROXY pointing at us was allowed — the loop forms through the fallthrough");
      } finally {
        for (const [k, v] of [["HTTPS_PROXY", saved.s], ["HTTP_PROXY", saved.p]]) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    });
  });

});
