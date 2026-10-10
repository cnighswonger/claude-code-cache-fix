// A FIXTURE THAT STOPPED LISTENING IS STILL A FIXTURE.
//
// Every held-port/handover case sweeps its ports through listeners(), which is
// `lsof -sTCP:LISTEN`. That finds a process only while it HOLDS THE LISTEN — and
// the standby's whole job is to hand the listen on and keep carrying the
// address. After a handover it is a live process that no sweep can see.
//
// Measured on this box, one orphan of each kind side by side:
//   pid=2404217 ppid=1 port=45855  lsof-sees-it=0   bin/gap-relay.mjs
//   pid=2406768 ppid=1 port=41031  lsof-sees-it=1   bin/gap-relay.mjs
// The invisible ones accumulate: ten at once, the oldest 788 s, across files and
// runs. They hold ports and CPU, and the next file's readiness assertions time
// out on them — which is the shape every "node 20 flake" on this PR has had.
//
// So cleanup must identify a fixture by something that survives handing the
// listen on. The port it was GIVEN is in its environment and stays there.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { freePort, listeners, onPorts, ours } from "./proc-helpers.mjs";


describe("fixture reaping", () => {
  it("finds a fixture that is no longer listening", async () => {
    assert.equal(typeof ours, "function",
      "proc-helpers exports no ours() — cleanup can still only see listeners, and a " +
      "standby that handed its listen on survives every sweep");

    // A stand-in that LIVES, carries the marker, and never listens: the end
    // state of a standby after it hands the listen on. gap-relay itself cannot
    // play this part — without CACHE_FIX_STANDBY_PARENT it refuses and exits 1,
    // which is the behaviour round 2 of the review verified, so a fixture built
    // on it is dead before the sweep runs (measured: alive=false).
    //
    // Under bin/*.mjs because OURS is a path predicate: a port number is not
    // ownership, and the sweep must keep refusing anything that is not ours.
    const dir = mkdtempSync(join(tmpdir(), "ccf-reap-"));
    mkdirSync(join(dir, "bin"), { recursive: true });
    const script = join(dir, "bin", "standin.mjs");
    writeFileSync(script, "setTimeout(() => {}, 20000);\n");

    const port = await new Promise((r) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); });
    });
    const env = { ...process.env, CACHE_FIX_HELD_PORT: String(port) };
    const kid = spawn(process.execPath, [script], { env, stdio: ["ignore", "ignore", "ignore"] });
    try {
      await new Promise((r) => setTimeout(r, 600));
      // PREMISE: it is alive, or "the sweep did not find it" is trivially true.
      assert.doesNotThrow(() => process.kill(kid.pid, 0),
        "the stand-in died before the sweep ran, so this case measures nothing");

      // PREMISE: the existing sweep really is blind to it, or this case would
      // pass against a listeners() that already covered the gap.
      assert.deepEqual(listeners(port), [],
        "listeners() found a process that is not listening — re-read this case, its premise is gone");

      assert.ok(ours(port).includes(String(kid.pid)),
        `ours(${port}) did not find pid ${kid.pid}, a live fixture carrying that port ` +
        `in its environment. Cleanup keyed on the listen leaves these behind, and they ` +
        `are what later files' readiness assertions time out on`);
    } finally {
      try { kid.kill("SIGKILL"); } catch { }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the pids lsof printed when it exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccf-reap-"));
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "idle.mjs"), "setTimeout(() => {}, 20000);\n");
    const kid = spawn(process.execPath, [join(dir, "bin", "idle.mjs")], { stdio: "ignore" });
    await once(kid, "spawn");
    writeFileSync(join(dir, "lsof"), `#!/bin/sh\necho ${kid.pid}\nexit 1\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      assert.deepEqual(listeners(1), [String(kid.pid)]);
    } finally {
      process.env.PATH = path;
      kid.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A file's after() sweeps every port it handed out. One lsof per port made 56
  // synchronous calls of ~490 ms each there, so the sweep takes the whole set.
  it("sweeps a set of ports in one call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccf-reap-"));
    mkdirSync(join(dir, "bin"), { recursive: true });
    const script = join(dir, "bin", "hold.mjs");
    writeFileSync(script, 'import net from "node:net";\n' +
      'if (process.argv[2]) net.createServer().listen(+process.argv[2], "127.0.0.1", () => console.log("up"));\n' +
      'else { console.log("up"); setTimeout(() => {}, 20000); }\n');
    const ports = new Set();
    while (ports.size < 4) ports.add(await freePort());
    const [a, b, c, outside] = ports;
    const kids = [];
    const start = async (args, env) => {
      const kid = spawn(process.execPath, [script, ...args],
        { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"] });
      kids.push(kid);
      // Racing the exit makes a child that dies before it prints fail the case, not hang it.
      await Promise.race([once(kid.stdout, "data"),
        once(kid, "exit").then(() => { throw new Error(`pid ${kid.pid} exited before it was ready`); })]);
      return String(kid.pid);
    };
    try {
      const listening = await start([b]);                                   // in the set, holds the listen
      const standby = await start([], { CACHE_FIX_HELD_PORT: String(c) });  // in the set, lists no listen
      const stranger = await start([outside], { CACHE_FIX_HELD_PORT: String(outside) }); // ours, outside the set
      const zero = await start([], { CACHE_FIX_PROXY_PORT: "0" });          // ours, given port 0
      assert.deepEqual(listeners([a, b, c]), [listening]);
      assert.deepEqual(onPorts([0, a, b, c]).sort(), [listening, standby].sort(),
        `onPorts must find the listener and the listen-less standby, and neither pid ${stranger} (port outside the set) nor ${zero} (port 0)`);
    } finally {
      for (const k of kids) try { k.kill("SIGKILL"); } catch { }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweeps nothing for an empty set or one that is only port 0", async () => {
    // lsof with no port list prints every listener on the box, and the empty set
    // handed to a single-port helper is `Number([]) === 0`, which matches a proxy
    // given port 0. The fake lsof and that proxy are both OURS, so either leak shows.
    const dir = mkdtempSync(join(tmpdir(), "ccf-reap-"));
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "idle.mjs"), "setTimeout(() => {}, 20000);\n");
    const kid = spawn(process.execPath, [join(dir, "bin", "idle.mjs")],
      { env: { ...process.env, CACHE_FIX_PROXY_PORT: "0" }, stdio: "ignore" });
    await once(kid, "spawn");
    writeFileSync(join(dir, "lsof"), `#!/bin/sh\necho ${kid.pid}\nexit 1\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      assert.deepEqual(onPorts([]), []);
      assert.deepEqual(onPorts([0]), []);
    } finally {
      process.env.PATH = path;
      kid.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
