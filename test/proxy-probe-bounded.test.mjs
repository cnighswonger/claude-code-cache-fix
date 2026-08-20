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
  // ONE CASE PER HANGING COMMAND, because they sit at different depths of the
  // same decision and only the second one reaches past lsof. Parameterised so a
  // future third probe is one row, not one more copy of the fixture.
  for (const hang of ["ps", "lsof"]) {
  it(`finishes even when ${hang} never returns`, async (t) => {
    // A port somebody else already owns, so the launcher takes the path that
    // asks "who has this?" — which is the path that shells out.
    const squatter = net.createServer(() => {});
    await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
    const port = squatter.address().port;

    const dir = await mkdtemp(join(tmpdir(), "ccf-probe-"));
    // ONLY `ps` HANGS, and `lsof` answers with a pid list.
    //
    // Both hanging was the first cut, under a comment claiming "a fix that only
    // bounds one of them still hangs". That claim was false and the fixture is
    // why: holderPidOn opens `try { probe("lsof", …) } catch { return null }`,
    // so a timing-out lsof returns before any `ps` runs — otherHolderOn takes
    // the same shape and takeOver() then exits on `if (!incumbent)`. Measured:
    // the whole run finished in 2.07s, i.e. two lsof timeouts and not one ps.
    // The case passed while the `ps` sites it names were never executed, so an
    // unbounded ps would have shipped under a green test.
    //
    // Answering lsof with pids is what carries execution INTO the ps call
    // sites; hanging there is what this case is for. lsof stays bounded by the
    // sibling case below, which is the one that hangs it.
    const answers = {
      // A pid list, so execution reaches the `ps` sites below it.
      lsof: "#!/bin/sh\nprintf '%s\\n' 4241 4242\n",
      // Reached ONLY in the `ps` row, where lsof answers and ps hangs. In the
      // `lsof` row this is never executed: holderPidOn's `probe("lsof", …)` is
      // inside a try whose catch returns, so a timing-out lsof ends the call
      // before any ps runs — measured with touch markers, the lsof marker
      // appears and the ps marker never does, and that row completes in 2.06 s,
      // i.e. exactly two 1 s lsof timeouts. Kept as a real answer rather than a
      // stub so the `ps` row exercises the fingerprint branch behind it.
      ps: "#!/bin/sh\necho 'node /usr/local/bin/cache-fix-proxy run-service'\n",
    };
    for (const name of ["lsof", "ps"]) {
      const body = name === hang ? "#!/bin/sh\nexec sleep 600\n" : answers[name];
      await writeFile(join(dir, name), body);
      await chmod(join(dir, name), 0o755);
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
      // NO-STANDBY: this SIGKILL needs no port sweep. The hang under test is a
      // probe, and the launcher blocks in it before it ever binds, so there is
      // no detached standby to reparent. Measured with the deadline forced to
      // 200 ms, 3 s and 6 s: orphan delta 0 in all three.
      child.kill("SIGKILL");
      assert.fail(`the launcher was still running after ${DEADLINE}ms with a hanging ${hang} — ` +
                  "the probe is unbounded, and on a sick machine it would block here for ever");
    }
    // WHAT it decided is not this test's business — only that it decided. A
    // probe it cannot answer must become "cannot tell", never "wait for ever".
    assert.ok(true);
  });
  }
});
