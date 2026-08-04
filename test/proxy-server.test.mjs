import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { startProxy } from "../proxy/server.mjs";
import { startWatcher } from "../proxy/watcher.mjs";
import { loadExtensions, getRegistry } from "../proxy/pipeline.mjs";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "proxy", "server.mjs");

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// Can two listeners hold one port on THIS runtime and kernel? Asked by binding
// twice for real, because a version comparison answers a different question —
// it would skip on a new node over an old kernel and run on the reverse. Three
// answers seen: honoured (Linux, node >= 22.12), ignored so the second bind is
// EADDRINUSE (node 18/20), and ENOTSUP on the FIRST bind (macOS).
const canCoBind = await (async () => {
  const a = net.createServer(), b = net.createServer();
  try {
    await new Promise((res, rej) => { a.once("error", rej); a.listen({ port: 0, host: "127.0.0.1", reusePort: true }, res); });
    const ok = await new Promise((res) => {
      b.once("error", () => res(false));
      b.listen({ port: a.address().port, host: "127.0.0.1", reusePort: true }, () => res(true));
    });
    return ok;
  } catch { return false; }
  finally {
    try { b.close(); } catch {}
    await new Promise((r) => a.close(r)).catch(() => {});
  }
})();

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
  // A reload must not cut a response that is already streaming. This is not a
  // hypothetical: a reload on a shared host cut three live sessions, surfacing
  // as "Connection closed mid-response", because the only reload available was
  // kill-then-respawn — the successor could not bind the port until the old
  // process was gone, so every in-flight body died with it.
  //
  // Driven with two REAL server processes, not two `startProxy()` handles in
  // one process: the whole question is whether two separate processes can hold
  // the same port at once, which an in-process test cannot ask.
  // What a FAILING `reusePort` listen does. macOS throws ENOTSUP on the FIRST
  // one (measured, Darwin 23.5.0 and 24.6.0), so an unguarded option does not
  // cost the handover there — it costs the proxy. Run on every runtime by
  // making the option fail on the one under test; gating on `!canCoBind` would
  // leave it unrun exactly where it passes.
  //
  // Both rows, because the retry must be narrow: retrying EADDRINUSE without
  // `reusePort` would bind a port a mismatched proxy already holds, silently
  // dropping the option this change exists for.
  for (const [code, expect] of [["ENOTSUP", "serves"], ["EADDRINUSE", "throws"]]) {
    it(`a reusePort listen that fails ${code} ${expect}`, async () => {
      const realListen = net.Server.prototype.listen;
      let refused = false, retried = false;
      net.Server.prototype.listen = function (opts, ...rest) {
        if (opts && typeof opts === "object" && opts.reusePort) {
          refused = true;
          process.nextTick(() => {
            const e = new Error(`listen ${code}`);
            e.code = code;
            this.emit("error", e);
          });
          return this;
        }
        if (refused) retried = true;
        return realListen.call(this, opts, ...rest);
      };
      let handle = null, thrown = null;
      try {
        handle = await startProxy({ port: 0, bind: "127.0.0.1", watch: false });
      } catch (err) { thrown = err; }
      finally { net.Server.prototype.listen = realListen; }
      try {
        assert.ok(refused, "premise: the reusePort listen must have been the one that failed");
        if (expect === "throws") {
          assert.equal(thrown?.code, code,
            "a listen error that is not ENOTSUP was retried without reusePort, " +
            "so the successor co-bind this change exists for was silently dropped");
          assert.ok(!retried, "the failing listen must not have been retried at all");
          return;
        }
        assert.ok(retried, "premise: the fallback listen never ran");
        const body = await new Promise((res) => {
          http.get({ host: "127.0.0.1", port: handle.port, path: "/health" }, (r) => {
            let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(b));
          }).on("error", (e) => res(`ERR:${e.code}`));
        });
        assert.equal(JSON.parse(body).status, "ok",
          "the proxy did not serve after falling back — macOS gets no proxy at all");
      } finally { if (handle) await handle.close(); }
    });
  }

  it("a successor binds the same port while the old process is still serving", async (t) => {
    if (!canCoBind) {
      t.skip(`this runtime cannot hold one port from two listeners (${process.version}); ` +
             `reload stays kill-then-respawn here`);
      return;
    }

    // A deliberately slow upstream, so the response is still open when the
    // reload happens. 12 chunks at 250 ms is ~3 s of streaming against a
    // handover that takes well under one.
    const CHUNKS = 12;
    const upstream = http.createServer((q, r) => {
      r.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const t = setInterval(() => {
        r.write(`data: ${++n}\n\n`);
        if (n >= CHUNKS) { clearInterval(t); r.end(); }
      }, 250);
      q.resume();
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = upstream.address().port;

    // Port 0 cannot be used here — both processes must be told the SAME port,
    // and the point is that the second one binds it.
    const PORT = await freePort();

    const env = { ...process.env,
      CACHE_FIX_PROXY_PORT: String(PORT),
      CACHE_FIX_PROXY_BIND: "127.0.0.1",
      CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upPort}` };
    // The ambient proxy vars would send this test's own requests through a real
    // proxy on the developer's box, which hangs forever.
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];

    const started = (p) => new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("proxy did not report listening")), 15_000);
      p.stdout.on("data", (d) => { if (/listening/.test(String(d))) { clearTimeout(to); res(); } });
      p.on("error", rej);
    });
    const older = spawn(process.execPath, [serverPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    const kids = [older];
    try {
      await started(older);

      // Start streaming, and wait until bytes are actually flowing — a request
      // that has not been answered yet would prove nothing about in-flight.
      let chunks = 0, ended = false, failure = null;
      const req = http.request(
        { host: "127.0.0.1", port: PORT, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => {
          res.on("data", () => chunks++);
          res.on("end", () => { ended = true; });
          res.on("error", (e) => { failure = e.code || e.message; });
        });
      req.on("error", (e) => { failure = e.code || e.message; });
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));
      const flowing = Date.now() + 10_000;
      while (chunks === 0 && Date.now() < flowing) await new Promise((r) => setTimeout(r, 100));
      assert.ok(chunks > 0, `premise: the response must be streaming before the reload. failure=${failure}`);

      const newer = spawn(process.execPath, [serverPath], { env, stdio: ["ignore", "pipe", "pipe"] });
      kids.push(newer);
      // THE assertion: this resolves only if the successor bound a port the
      // predecessor still holds. Before SO_REUSEPORT it rejected with EADDRINUSE.
      await started(newer);

      // PRECONDITION, asserted rather than assumed: the stream must still be
      // OPEN when the reload happens, or "it completed" is satisfied by a
      // response that had already finished and the test measures nothing.
      // An accidental control is invisible until timing changes — a slower box
      // or a faster upstream turns this into a green that proves nothing, and
      // reading the numbers afterwards is not a mechanism.
      assert.ok(!ended, `premise: the stream must still be open at the reload; it had already ` +
        `finished after ${chunks} chunks, so this run measured a completed response`);
      const midflight = chunks;

      older.kill("SIGTERM");
      const done = Date.now() + 20_000;
      while (!ended && !failure && Date.now() < done) await new Promise((r) => setTimeout(r, 100));

      assert.equal(failure, null, `the reload cut a response that was already streaming (${failure})`);
      assert.ok(ended, "the streaming response never completed across the reload");
      // ...and it kept going AFTER the reload rather than having been complete
      // at the moment of it. Without this, a stream that delivered its last
      // chunk in the same tick as the SIGTERM would satisfy both assertions
      // above while proving nothing about the handover.
      assert.ok(chunks > midflight,
        `no chunk arrived after the reload (${midflight} before, ${chunks} total), ` +
        `so the handover was never exercised`);
    } finally {
      for (const k of kids) { try { k.kill("SIGKILL"); } catch {} }
      await new Promise((r) => upstream.close(r));
    }
  });

  // `reusePort` removes EADDRINUSE, which used to be the only thing stopping a
  // second proxy on this port. Losing it entirely is a real regression: a plain
  // proxy and a `--remote-control` forward proxy on one port make the kernel
  // round-robin CONNECT between a process that speaks it and one that does not
  // (measured: 17 of 40 attempts ECONNRESET).
  //
  // The guard keys on MODE, not occupancy, and this test is the pair that
  // proves it — refusing every occupied port would also refuse the handover
  // this change exists to enable, and a test for only the refusal would pass on
  // a guard that broke it.
  it("refuses a second proxy in the OTHER mode, and allows one in the same mode", async () => {
    const PORT = await freePort();

    const boot = (forward, port = PORT) => {
      const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port), CACHE_FIX_PROXY_BIND: "127.0.0.1" };
      for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
      if (forward) { env.CACHE_FIX_FORWARD_PROXY = "on"; env.CACHE_FIX_WIRED_BY_LAUNCHER = "1"; }
      else delete env.CACHE_FIX_FORWARD_PROXY;
      const proc = spawn(process.execPath, [serverPath], { env, stdio: ["ignore", "pipe", "pipe"] });
      const verdict = new Promise((res) => {
        let done = false;
        const settle = (v) => { if (!done) { done = true; res(v); } };
        proc.stdout.on("data", (d) => { if (/listening/.test(String(d))) settle("LISTENING"); });
        proc.stderr.on("data", (d) => { if (/already on|failed to start/.test(String(d))) settle("REFUSED"); });
        proc.on("exit", () => settle("EXITED"));
        setTimeout(() => settle("TIMEOUT"), 15_000);
      });
      return { proc, verdict };
    };

    const kids = [];
    try {
      const first = boot(false); kids.push(first.proc);
      assert.equal(await first.verdict, "LISTENING", "premise: the first proxy must come up");

      // SAME mode: this IS the handover, and it must be allowed — but only on a
      // runtime that can hold one port from two listeners. Where `reusePort` is
      // ignored (node < 22.12) the kernel refuses the co-bind with EADDRINUSE
      // before the guard is ever consulted, so asserting LISTENING there tests
      // the runtime, not this change. Measured on CI: node 18.20.8 and 20.20.2
      // fail this row for that reason while the mismatch row below still holds.
      if (canCoBind) {
        const same = boot(false); kids.push(same.proc);
        assert.equal(await same.verdict, "LISTENING",
          "the guard refused a same-mode co-bind, which is the handover this change exists to enable");
        same.proc.kill("SIGKILL");
        await new Promise((r) => setTimeout(r, 700));
      }

      // OTHER mode: the kernel would round-robin CONNECT between them.
      const other = boot(true); kids.push(other.proc);
      assert.equal(await other.verdict, "REFUSED",
        "a forward proxy co-bound with a plain one; CONNECT would round-robin between them");

      // NO OPINION is not a mismatch. The degraded `/health` (503) carries no
      // `forward_proxy`, and `undefined !== false` is true — so absence read as
      // a mismatch refused BOTH modes, blocking the restart that body's own hint
      // asks for. Pre-4.3.0 cache-fix predates the key and hits the same.
      // reusePort on the incumbent too, or the KERNEL refuses the successor
      // before the guard is asked — measured, and it reads as "the guard
      // refused" while the guard had passed.
      if (canCoBind) {
        const degraded = http.createServer((q, r) => {
          r.writeHead(503, { "content-type": "application/json" });
          r.end(JSON.stringify({ status: "degraded", failed_extensions: [{ file: "boom.mjs" }],
                                 hint: "restart the proxy via your supervisor to recover (#196)" }));
        });
        const P2 = await freePort();
        await new Promise((res, rej) => {
          degraded.once("error", rej);
          degraded.listen({ port: P2, host: "127.0.0.1", reusePort: true }, res);
        });
        try {
          const noOpinion = boot(false, P2); kids.push(noOpinion.proc);
          assert.notEqual(await noOpinion.verdict, "REFUSED",
            "an incumbent whose /health carries no forward_proxy was read as a mismatch, " +
            "so the port cannot be started in EITHER mode — including by the restart it asks for");
        } finally {
          await new Promise((r) => degraded.close(r));
        }
      }

      // ...and a REFUSAL must claim NOTHING process-wide. `startProxy` is an
      // exported API, so a caller survives the throw; the self-heal handler,
      // `_forwardActive` and the fs watcher all outlive it. Leaked, a later
      // reverse-only instance reports forward_proxy:true and relays paths it
      // should 404, and a dead startup keeps reloading extensions forever.
      const beforeHandlers = process.listenerCount("uncaughtException");
      const saved = { fwd: process.env.CACHE_FIX_FORWARD_PROXY, hot: process.env.CACHE_FIX_HOT_RELOAD };
      process.env.CACHE_FIX_FORWARD_PROXY = "on";
      process.env.CACHE_FIX_HOT_RELOAD = "on";
      const wdir = join(tmpdir(), `guard-leak-${process.pid}`);
      await mkdir(wdir, { recursive: true });
      await writeFile(join(wdir, "extensions.json"), "{}");
      let threw = false;
      try {
        await startProxy({ port: PORT, bind: "127.0.0.1",
                           extensionsDir: wdir, extensionsConfig: join(wdir, "extensions.json") });
      } catch { threw = true; }
      finally {
        for (const [k, v] of [["CACHE_FIX_FORWARD_PROXY", saved.fwd], ["CACHE_FIX_HOT_RELOAD", saved.hot]]) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
      assert.ok(threw, "premise: the guard must refuse in-process too, or this row measures nothing");
      assert.equal(process.listenerCount("uncaughtException"), beforeHandlers,
        "the self-heal handler outlived the refusal — a later reverse-only proxy inherits it");
      const seen = getRegistry().length;
      await writeFile(join(wdir, "post-refusal.mjs"),
        `export default { name: "post-refusal", order: 1000, onRequest(ctx) {} };`);
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(!getRegistry().some((e) => e.name === "post-refusal"),
        `the fs watcher outlived the refusal and reloaded (${seen} -> ${getRegistry().length})`);
      await rm(wdir, { recursive: true, force: true });
      const rev = await startProxy({ port: 0, bind: "127.0.0.1", watch: false });
      try {
        const body = await new Promise((res) => {
          http.get({ host: "127.0.0.1", port: rev.port, path: "/health" }, (r) => {
            let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(b));
          });
        });
        assert.equal(JSON.parse(body).forward_proxy, false,
          "a reverse-only proxy reported forward_proxy:true — the refused attach leaked its count");
      } finally { await rev.close(); }
    } finally {
      for (const k of kids) { try { k.kill("SIGKILL"); } catch {} }
    }
  });

});
