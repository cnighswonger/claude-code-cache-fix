// Child for proxy-stdio-epipe.test.mjs.
//
// Starts the proxy in forward mode — which is what installs the process-wide
// self-heal handlers — then throws from a CHECK-PHASE callback on command. That
// is the exact shape production hit: an uncaught exception raised at a moment
// when stderr has no reader left.
//
// The throw is triggered from stdin rather than a timer so the parent can break
// the stderr pipe FIRST. A race here would make the test pass for the wrong
// reason: a throw that lands while stderr is still readable never reaches the
// defect.
process.env.CACHE_FIX_FORWARD_PROXY = "on";

const port = Number(process.argv[2]);
const { startProxy } = await import("../../proxy/server.mjs");
await startProxy({ port, bind: "127.0.0.1", watch: false });

process.stdout.write(`listening ${port}\n`);

process.stdin.on("data", () => {
  setImmediate(() => { throw new Error("stdio-epipe probe"); });
});
process.stdin.resume();
