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
//
// `node --test` collects every .mjs under test/, this one included, and runs it
// bare. Only a spawner that sets STDIO_EPIPE_CHILD gets a proxy; a bare run
// would listen on stdin for ever and hang the suite.
if (!process.env.STDIO_EPIPE_CHILD) process.exit(0);
process.env.CACHE_FIX_FORWARD_PROXY = "on";

// The port is taken at bind (0) and announced, never chosen beforehand: a number
// picked by the parent is unowned until the child binds it, and a neighbour that
// takes it makes the proxy's self-heal swallow the EADDRINUSE and exit 0.
const { startProxy } = await import("../../proxy/server.mjs");
const handle = await startProxy({ port: 0, bind: "127.0.0.1", watch: false });

process.stdout.write(`listening ${handle.port}\n`);

process.stdin.on("data", () => {
  setImmediate(() => { throw new Error("stdio-epipe probe"); });
});
process.stdin.resume();
