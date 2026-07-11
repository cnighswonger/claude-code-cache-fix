import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../proxy/server.mjs";
import { startWatcher } from "../proxy/watcher.mjs";
import { loadExtensions, getRegistry } from "../proxy/pipeline.mjs";

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
