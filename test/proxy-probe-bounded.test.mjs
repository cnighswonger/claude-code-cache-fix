// A PROBE ON SOMEONE'S LAPTOP MUST BE BOUNDED.
//
// The launcher shells out to `lsof` and `ps` to decide who owns the port. Those
// walk the process table, so their cost scales with it — and the moment the
// table is in trouble is exactly when this code runs hardest: holderPidOn() is
// called from the takeover retry loop every 500 ms and from the deploy watcher
// on every tick.
//
// Measured on a user's laptop 2026-08-14: Chrome's crash reporter forked ~500
// processes/second for fifteen minutes (kernel: "Too many corpses being
// created", pid 48888 -> 54010 in ten seconds). Every process-enumerating call
// on that box became unbounded. An execFileSync with no timeout blocks this
// process for as long as the machine stays sick — a proxy that answers nothing
// while adding load to the machine it is waiting for.
//
// This test replaces `lsof` with one that never returns and asserts the
// launcher still finishes. Without a timeout on the probe it hangs forever.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const launcherPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-via-proxy.mjs");

describe("probe bounding", () => {
  it("finishes even when lsof never returns", async (t) => {
    // A port somebody else already owns, so the launcher takes the path that
    // asks "who has this?" — which is the path that shells out.
    const squatter = net.createServer(() => {});
    await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
    const port = squatter.address().port;

    const dir = await mkdtemp(join(tmpdir(), "ccf-probe-"));
    // `lsof` that hangs forever. `ps` too — both are on the same path and a fix
    // that only bounds one of them still hangs.
    for (const name of ["lsof", "ps"]) {
      const p = join(dir, name);
      await writeFile(p, "#!/bin/sh\nexec sleep 600\n");
      await chmod(p, 0o755);
    }
    t.after(async () => {
      await new Promise((r) => squatter.close(r));
      await rm(dir, { recursive: true, force: true });
    });

    const env = { ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CACHE_FIX_PROXY_PORT: String(port),
      CACHE_FIX_PROBE_TIMEOUT_MS: "1000",
      CACHE_FIX_SELF_HEAL: "off" };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID"]) delete env[k];

    const child = spawn(process.execPath, [launcherPath, "run-service"],
                        { env, stdio: ["ignore", "pipe", "pipe"] });

    // Generous: the probe bound is 1s and there are a handful of call sites, so
    // a bounded run finishes in seconds. An UNBOUNDED one never finishes at all,
    // which is the difference this asserts — not a millisecond budget.
    const DEADLINE = 25_000;
    const settled = await Promise.race([
      new Promise((res) => child.on("exit", (code, sig) => res({ code, sig }))),
      new Promise((res) => setTimeout(() => res(null), DEADLINE)),
    ]);

    if (!settled) {
      child.kill("SIGKILL");
      assert.fail(`the launcher was still running after ${DEADLINE}ms with a hanging lsof — ` +
                  "the probe is unbounded, and on a sick machine it would block here for ever");
    }
    // WHAT it decided is not this test's business — only that it decided. A
    // probe it cannot answer must become "cannot tell", never "wait for ever".
    assert.ok(true);
  });
});
