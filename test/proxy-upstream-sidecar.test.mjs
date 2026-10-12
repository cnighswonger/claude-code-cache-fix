// The proxy publishes the proxy it forwards to, for bin/shell-prefix.sh: one
// file per bound port under the config dir. Driven as a real process, since
// only the script-entry path writes it and the port is the one actually bound.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { exitWithin } from "./child-deadline.mjs";
import { freePort } from "./proc-helpers.mjs";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "proxy", "server.mjs");

// Boot the proxy on a private config dir and return what is left in the file for
// its port (null: none), after a clean SIGTERM so the file's survival is seen too.
// `stale` is a predecessor's file on that port.
async function published(env, stale) {
  const cfg = mkdtempSync(join(tmpdir(), "ccf-upstream-"));
  const port = await freePort();
  const file = join(cfg, "cache-fix-state", `upstream-${port}`);
  if (stale) { mkdirSync(dirname(file)); writeFileSync(file, stale); }
  const base = { ...process.env, HOME: cfg, CLAUDE_CONFIG_DIR: cfg, CACHE_FIX_PROXY_PORT: String(port),
    CACHE_FIX_UPDATE_SWEEP: "off" };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "CACHE_FIX_UPSTREAM_PROXY",
    "CACHE_FIX_FALLBACK_PROXIES", "LISTEN_FDS"]) delete base[k];
  const proc = spawn(process.execPath, [serverPath], { env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("proxy never reported listening")), 15_000);
      proc.stdout.on("data", (d) => { if (/listening/.test(String(d))) { clearTimeout(to); res(); } });
      proc.on("exit", (c) => rej(new Error(`proxy exited ${c} before listening`)));
    });
    proc.kill("SIGTERM");
    assert.equal(await exitWithin(proc, 20_000, "the proxy never exited"), 0);
    return existsSync(file) ? { body: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o777 } : null;
  } finally {
    proc.kill("SIGKILL");
    rmSync(cfg, { recursive: true, force: true });
  }
}

describe("upstream sidecar", { concurrency: true }, () => {
  it("holds CACHE_FIX_UPSTREAM_PROXY, readable by its owner only, and outlives the proxy", async () => {
    const url = "http://user:secret@up.invalid:3128";
    assert.deepEqual(await published({ CACHE_FIX_UPSTREAM_PROXY: url }), { body: `${url}\n`, mode: 0o600 });
  });
  it("falls back to the first configured fallback hop", async () => {
    const r = await published({ CACHE_FIX_FALLBACK_PROXIES: "http://fb1.invalid:3128,http://fb2.invalid:3128" });
    assert.equal(r.body, "http://fb1.invalid:3128\n");
  });
  it("publishes the hop CCF dials when only HTTP_PROXY is set", async () => {
    const url = "http://httponly.invalid:3128";
    assert.equal((await published({ HTTP_PROXY: url }))?.body, `${url}\n`);
  });
  it("holds an empty line when there is no upstream, over a predecessor's file", async () => {
    const empty = { body: "\n", mode: 0o600 };
    assert.deepEqual(await published({}), empty);
    assert.deepEqual(await published({}, "http://old.invalid:3128\n"), empty);
  });
});
