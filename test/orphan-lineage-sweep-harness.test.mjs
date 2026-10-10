// EVENT #348, harness for the "leaves a standby for the file-level sweep to
// find" case in proxy-held-port.test.mjs. That case only runs its body under
// LEAK_PROBE_FILE — nothing else in the tree sets it, so this is what does:
// run the file scoped to that one case, wait for the whole process (its
// after() included) to exit, then check every pid it recorded is gone.
import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { withDeadline, exitWithin } from "./child-deadline.mjs";
import { HOP_ENV, OURS, reapStamped, stamped } from "./proc-helpers.mjs";

const testFile = join(dirname(fileURLToPath(import.meta.url)), "proxy-held-port.test.mjs");

it("reaps the standby the lineage sweep in proxy-held-port.test.mjs is meant to catch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leak-probe-"));
  const leakFile = join(dir, "pids");
  let lineage;
  try {
    // NODE_TEST_CONTEXT, deleted rather than left to inherit: this harness is
    // itself a test file, so under `node --test test/` a nested `--test` here
    // sees it set and silently declines to run at all ("running recursively"),
    // which would make every assertion below run against an empty leak file.
    const env = { ...process.env, LEAK_PROBE_FILE: leakFile };
    delete env.NODE_TEST_CONTEXT;
    for (const k of HOP_ENV) delete env[k];
    // 40s: above the WHOLE nested process's tolerated worst case, not the happy
    // path, and not just the case's own budget — this timeout waits for
    // after() too. The case (proxy-held-port.test.mjs) tolerates 15s to bind
    // (:2386) + 5s relay wait (:2389) + 500ms settle (:2401) = 20.5s, and CI
    // has really exceeded 10s on a boot (:83-84). Its file-level after()
    // (:2410) then runs two more retry loops before it can exit — a port
    // sweep and reapStamped (proc-helpers.mjs:126), each up to 6 * 700ms —
    // adding up to 8.4s more. ~28.9s tolerated end to end.
    const NESTED_CEILING_MS = 40_000;
    const r = spawnSync(process.execPath,
      ["--test", "--test-name-pattern", "leaves a standby for the file-level sweep", testFile],
      { env, encoding: "utf8", timeout: NESTED_CEILING_MS, killSignal: "SIGKILL" });

    // Read before asserting: a leak file the case wrote before a later hang
    // must still reach `lineage`, or the timeout path we're bounding above
    // skips the finally block's reapStamped and orphans the standby for real.
    let pids = [];
    try {
      const [markerLine, pidLine] = readFileSync(leakFile, "utf8").split("\n");
      lineage = markerLine;
      pids = (pidLine || "").trim().split(",").filter(Boolean);
    } catch { }

    assert.ok(!r.error, `the nested run did not complete within ${NESTED_CEILING_MS / 1000}s: ${r.error}`);
    assert.equal(r.status, 0, `the case itself failed:\n${r.stdout}\n${r.stderr}`);
    assert.ok(lineage && pids.length, "the case never recorded a lineage marker and standby pid — this measures nothing");

    for (const pid of pids) {
      const alive = stamped(lineage).includes(pid);
      assert.equal(alive, false,
        `pid ${pid} (a standby the case leaked on an unregistered port) is still alive after ` +
        `the whole test file exited — the lineage sweep did not reap it`);
    }
  } finally {
    // By marker, never a blind kill on the raw recorded pids: on the red path
    // (the case's own file-level sweep did not run) this is what actually
    // stops the leak from surviving the harness itself, and a recycled pid
    // must still pass the marker+OURS filter before it is worth signalling.
    if (lineage) await reapStamped(lineage);
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});

// shutdown-exit-code.test.mjs:32 and proxy-integration.test.mjs:75 both spawn
// `process.execPath` with the RELATIVE script path "proxy/server.mjs" — so
// the child's argv never has a `/` before `proxy/`. Measured argv, node
// v24.11.1 on <linux-host>: OURS required a leading `/`, so byEnv() (which
// every one of stamped()/ours()/armLineage()'s exit backstop routes through)
// never saw these proxies at all.
it("OURS matches our own script spawned by a relative path, not a same-named test file", () => {
  assert.equal(OURS.test("/usr/bin/node proxy/server.mjs"), true,
    "OURS must match the exact argv shutdown-exit-code.test.mjs and proxy-integration.test.mjs spawn with, " +
    "or byEnv() filters every proxy those files start out of stamped()/armLineage()'s exit backstop and reapStamped()");
  // The rule OURS exists to keep (proc-helpers.mjs:22-26): a bare filename
  // that only happens to share a name with one of ours is NOT ours.
  assert.equal(OURS.test("node test/proxy-server.test.mjs"), false,
    "a same-named test file must still not match OURS");
  // "proxy/server.mjs" is a literal substring of "notproxy/server.mjs" too —
  // this is what pins the (?:^|[\s/]) anchor itself: drop it, and the regex
  // starts matching a path segment that merely ends in "proxy".
  assert.equal(OURS.test("node notproxy/server.mjs"), false,
    "a path segment that only ends in \"proxy\" must not match OURS");
});

// Second half of the same gap: armLineage() installs only `process.on("exit")`,
// and a SIGTERM under the default disposition never fires "exit" — so even a
// working OURS reaps nothing on the path shutdown-exit-code.test.mjs's own
// `finally { proc.kill("SIGKILL") }` is what actually stops today. Reproduces
// the file child of `node --test` holding a lineage and dying to SIGTERM (or
// SIGHUP — how a killed tmux window or a dropped ssh session ends a run here).
const here = dirname(fileURLToPath(import.meta.url));
const driverPath = join(here, "fixtures", "lineage-sigterm-child.mjs");
const repoRoot = join(here, "..");

// The pid the driver's grandchild reports, once armLineage() + spawn() have
// run inside it. `ms` is the readiness ceiling only — not the marker: the
// marker is `armLineage()`'s own `${name}-${pid}` shape, known from the
// driver's pid alone, before any stdout is ever read.
function readyPid(driver, ms) {
  let out = "";
  const ready = new Promise((resolve) => {
    driver.stdout.on("data", (c) => {
      out += c.toString();
      const m = /PID:(\d+)/.exec(out);
      if (m) resolve(m[1]);
    });
  });
  return withDeadline(ready, ms, driver, "the driver never reported readiness");
}

// `alone` turns the out-of-process watchdog off (LINEAGE_NO_WATCHDOG, read by
// fixtures/lineage-watchdog.mjs), so a reaped lineage is the IN-PROCESS
// backstop's doing. Without it the watchdog sweeps the same lineage on the
// same signal and a case that deleted the in-process handlers would still pass.
async function driverSurvivesSignal(signal, { alone = false } = {}) {
  const driver = spawn(process.execPath, [driverPath], {
    cwd: repoRoot,
    env: { ...process.env, LINEAGE_SIGTERM_DRIVE: "1", ...(alone && { LINEAGE_NO_WATCHDOG: "1" }) },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const marker = `lineage-sigterm-child-${driver.pid}`;
  try {
    const pid = await readyPid(driver, 8000);

    // Positive control: the grandchild really is alive and OURS+marker
    // visible before the signal, so a later 0 means the backstop reaped it
    // rather than it never having existed.
    assert.ok(stamped(marker).includes(pid),
      `setup did not produce a live OURS-matching process carrying ${marker} — this test measures nothing`);

    driver.kill(signal);
    await exitWithin(driver, 5000, `the driver never exited after ${signal}`);

    // Polled: the watchdog sweeps after the driver is already gone.
    let survivors = stamped(marker);
    for (let t = Date.now(); survivors.length && Date.now() - t < 5000; survivors = stamped(marker)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(survivors.length, 0,
      `${survivors.length} process(es) carrying ${marker} survived the driver's ${signal} — ` +
      "its lineage backstop did not run");
  } finally {
    await reapStamped(marker);
    try { driver.kill("SIGKILL"); } catch { }
  }
}

it("armLineage()'s exit backstop reaps a lineage its own process leaves behind on SIGTERM",
  () => driverSurvivesSignal("SIGTERM", { alone: true }));

it("armLineage()'s exit backstop reaps a lineage its own process leaves behind on SIGHUP",
  () => driverSurvivesSignal("SIGHUP", { alone: true }));

// SIGKILL runs nothing in the dying process, so no in-process backstop can reap
// the lineage — bound_wait's SIGKILL right behind its group SIGTERM cancels
// them the same way (a standby relay and a successor holder outlived it). Only
// the watchdog, a separate session that sees the pipe close, can.
it("armLineage() reaps a lineage whose process is SIGKILLed",
  () => driverSurvivesSignal("SIGKILL"));

// A process whose own command line is OURS and carries the marker is in its own
// stamped() list.
it("killStamped() does not kill the process that calls it", () => {
  const marker = `killstamped-self-${process.pid}-${Date.now()}`;
  const r = spawnSync(process.execPath, ["-e",
    `import(${JSON.stringify(new URL("./proc-helpers.mjs", import.meta.url).href)})` +
    `.then((m) => { m.killStamped(${JSON.stringify(marker)}); console.log("alive"); })`,
    "proxy/self.mjs"],
    { env: { ...process.env, CACHE_FIX_TEST_LINEAGE: marker }, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
  assert.equal(r.stdout.trim(), "alive", `killStamped() killed its own caller (status=${r.status} signal=${r.signal})`);
});
