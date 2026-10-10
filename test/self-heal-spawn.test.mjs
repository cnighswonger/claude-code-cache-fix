import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HOP_ENV, OURS, cmdOf } from "./proc-helpers.mjs";

// WHAT AN ORPHANED PROXY ASKS FOR WHEN IT HEALS, read off the spawn itself.
// test/fixtures/spawn-spy.cjs stands in for the replacement holder, so nothing
// is started and nothing is left to reap. The holder is a throwaway parent of
// this file's own, killed to orphan the proxy under it.
//
// ONE SPAWN: before the interval's handle was cleared, every tick until the
// successor served spawned another holder, and an adopting one skips the
// surplus check, so a SIGKILLed holder ended with N of them.
//
// ADOPTION NEEDS A SOCKET THAT STILL LISTENS. A proxy asked to stop under a live
// holder unbinds at once and drains, and its heal tick keeps running. Its fd 3 is
// closed by then (or handed to something else), so passing it on as the adopted
// socket points the new holder at a descriptor that is not ours.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOLDER = `const c = require("child_process").spawn(process.execPath, [process.env.SPY_SERVER], {
  stdio: ["ignore", "inherit", "inherit", 3],
  env: { ...process.env, CACHE_FIX_HELD_BY: String(process.pid) } });
console.log("kid " + c.pid); setInterval(() => {}, 1e6);`;

const until = async (f, ms = 15_000) => {
  for (const by = Date.now() + ms; !f() && Date.now() < by;) await new Promise((r) => setTimeout(r, 25));
  return f();
};

// Starts the proxy under a holder, optionally with a stop in flight, kills the
// holder, and returns every SPAWN the orphan reported in the half second after
// its first.
//
// `deploy`: no kill. The holder reloads (SIGUSR2): it signals the proxy and exits
// at once, without waiting for the release, so the proxy is orphaned with the
// signal still unread. Done by holding the proxy's JS busy (SPY_BUSY) across both,
// so the loop wakes with the heal tick due and the SIGUSR2 not yet dispatched.
async function heal({ stopped, deploy }) {
  const sock = net.createServer();
  await new Promise((r) => sock.listen(0, "127.0.0.1", r));
  const open = [];
  const upstream = net.createServer((s) => open.push(s));   // accepts, never replies
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const env = { ...process.env, SPY_SERVER: join(root, "proxy", "server.mjs"),
    NODE_OPTIONS: `--require ${join(root, "test", "fixtures", "spawn-spy.cjs")}`,
    CACHE_FIX_PROXY_PORT: "0", CACHE_FIX_HELD_PORT: String(sock.address().port), LISTEN_FDS: "1",
    CACHE_FIX_SELF_HEAL_MS: "50", CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    ...(deploy && { SPY_BUSY: "1" }) };
  for (const k of [...HOP_ENV, "LISTEN_PID", "CACHE_FIX_SELF_HEAL"]) delete env[k];
  const holder = spawn(process.execPath, ["-e", HOLDER], { env, stdio: ["ignore", "pipe", "pipe", sock._handle.fd] });
  sock.close();   // the proxy and holder keep the listening socket; this copy must not accept
  let out = "", err = "", req, kid = 0;
  holder.stdout.on("data", (d) => { out += d; });
  holder.stderr.on("data", (d) => { err += d; });
  try {
    assert.ok(await until(() => /proxy listening on/.test(out)), `the proxy never came up: ${out}${err}`);
    kid = Number(/kid (\d+)/.exec(out)[1]);
    if (stopped) {
      req = http.request({ host: "127.0.0.1", port: env.CACHE_FIX_HELD_PORT, method: "POST", path: "/v1/messages",
        headers: { "content-type": "application/json" } });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));
      assert.ok(await until(() => open.length), "premise: the request must be in flight at the stop");
      process.kill(kid, "SIGTERM");
      assert.ok(await until(() => /releasing the listening socket/.test(out)), "premise: the proxy must have unbound");
    }
    if (deploy) {
      process.kill(kid, "SIGWINCH");
      assert.ok(await until(() => /^BUSY/m.test(err)), `premise: the proxy never went busy: ${err}`);
      process.kill(kid, "SIGUSR2");
      holder.kill("SIGKILL");
      assert.ok(await until(() => /releasing the listening socket/.test(out)), `premise: SIGUSR2 never landed: ${out}${err}`);
    } else {
      holder.kill("SIGKILL");
      assert.ok(await until(() => /^SPAWN /m.test(err)), `the orphan never healed: ${err}`);
    }
    await new Promise((r) => setTimeout(r, 500));
    return [...err.matchAll(/^SPAWN (.*)$/gm)].map((m) => JSON.parse(m[1]));
  } finally {
    try { req?.destroy(); } catch { }
    try { holder.kill("SIGKILL"); } catch { }
    // Only while still ours: the deploy case has it reaped ~500 ms earlier, and a gone pid can be reused.
    if (kid > 1 && OURS.test(cmdOf(kid))) { try { process.kill(kid, "SIGKILL"); } catch { } }
    for (const s of open) s.destroy();
    upstream.close();
  }
}

describe("an orphaned proxy's self-heal spawn", () => {
  it("adopts its own listening socket, once", async () => {
    const spawns = await heal({ stopped: false });
    assert.equal(spawns.length, 1, `one orphan spawned ${spawns.length} holders`);
    assert.deepEqual([spawns[0].stdio[3], spawns[0].handover, spawns[0].fds], [3, "1", "1"],
      "the heal did not hand the live socket down as an adoption");
  });

  it("does not adopt a socket it has already unbound", async () => {
    const spawns = await heal({ stopped: true });
    assert.equal(spawns.length, 1, `one orphan spawned ${spawns.length} holders`);
    assert.equal(spawns[0].stdio.length, 3, "the heal passed fd 3 on after the proxy had closed it");
    assert.equal(spawns[0].handover, undefined, "the heal claimed a handover with no socket to hand over");
  });

  // A DEPLOY'S ORPHAN IS NOT A DEAD HOLDER'S. Its holder left on purpose and its
  // SIGUSR2 hands the socket to a live successor; an adopting holder spawned in that
  // gap SIGHUPs the successor's standby, and two holders then run for good.
  it("does not heal while a deploy's SIGUSR2 is still unread", async () => {
    const spawns = await heal({ deploy: true });
    assert.deepEqual(spawns, [], `the orphan spawned ${spawns.length} holder(s) with a deploy's release pending`);
  });
});
