// Preloaded with `node --require` by self-heal-spawn.test.mjs. The self-heal
// spawns a real `run-service`, which the test must neither start nor leave
// behind: this reports the spawn's stdio and handover env on stderr and returns
// a stub, so what the proxy ASKED for is read instead of what a holder did.
//
// SPY_BUSY: a SIGWINCH then keeps this process's JS busy until its holder is gone
// (it never returns to the loop), so a signal sent meanwhile is still unread when
// the loop wakes, and the timers that came due run before it is.
const cp = require("node:child_process");
const real = cp.spawn;
cp.spawn = (cmd, args, opts) => {
  if (!/claude-via-proxy\.mjs$/.test(String(args?.[0]))) return real(cmd, args, opts);
  process.stderr.write(`SPAWN ${JSON.stringify({
    stdio: opts.stdio, handover: opts.env.CACHE_FIX_HOLDER_HANDOVER, fds: opts.env.LISTEN_FDS })}\n`);
  return { unref() {} };
};
// The proxy imports `spawn` by name, which is a snapshot until this refreshes it.
require("node:module").syncBuiltinESMExports();
if (process.env.SPY_BUSY) process.on("SIGWINCH", () => {
  require("node:fs").writeSync(2, "BUSY\n");
  const nap = new Int32Array(new SharedArrayBuffer(4));
  // At least 200 ms, however fast the holder goes: the heal tick must be DUE when the loop wakes.
  for (const t0 = Date.now(), now = () => Date.now() - t0;
       (String(process.ppid) === process.env.CACHE_FIX_HELD_BY || now() < 200) && now() < 30_000;) Atomics.wait(nap, 0, 0, 5);
});
