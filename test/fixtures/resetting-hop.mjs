// A forward (CONNECT) proxy that reproduces a hop dropping a live connection
// instead of answering it -- the shape a hop dropping the leg below it showed
// on 2026-09-06 (accept, CONNECT, then RST, no retry, no response). See CCF's
// proxy/upstream.mjs forwardRequest(), which this fixture's own tests exercise
// via resetFirstConnect / stallFirstConnect.
//
// Every CONNECT is relayed byte-for-byte to `forward` once accepted. With
// resetFirstConnect, the FIRST CONNECT REQUEST this process reads (a
// connection that actually sent "CONNECT ...", not merely one that connected)
// is destroyed right after being read, before any reply; every CONNECT after
// that is served normally. With stallFirstConnect, that same first CONNECT
// request is read and then never answered at all (the hop accepted it and
// went silent — measured 2026-09-07 05:45-05:48Z, 20s of nothing then a 0.6s
// answer); every CONNECT after that is served normally. Counting only a
// connection that sent request bytes -- not merely one CCF accepted -- matters
// because CCF's own hopAlive() probes a hop with a bytes-0 connect-and-close
// ahead of the real CONNECT whenever CACHE_FIX_FALLBACK_PROXIES is set (its
// one caller, forwardRequest -> resolveHop, is gated on that list being
// non-empty) -- true for the fleet's live config and the deployer's sandbox
// proof, not for this test file; that probe must never consume the injection
// meant for the real CONNECT that follows it.
//
// `hop.forward = "host:port"` re-points every CONNECT accepted from then on; a
// tunnel already relayed keeps the target it was built to. That is a blue/green
// switch behind one hop address: the old instance keeps answering the
// connections it already holds.
//
// Exports only, no top-level side effects (test/proc-helpers.mjs,
// test/child-deadline.mjs: same convention). Standalone, e.g. (run from the
// repo root):
//   node -e 'import("./test/fixtures/resetting-hop.mjs").then(m => m.startResettingHop({forward:"127.0.0.1:9000",resetFirstConnect:true}).listen(9100,"127.0.0.1",()=>console.log("up")))'
// `stallFirstConnect: true` instead of `resetFirstConnect`, for the silent-CONNECT mode.

import net from "node:net";

export function startResettingHop({ forward, resetFirstConnect = false, stallFirstConnect = false } = {}) {
  let seen = 0;   // CONNECT REQUESTS seen (bytes sent), not raw accepts.

  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.removeListener("data", onData);
      const head = buf.slice(0, end).toString();
      const rest = buf.slice(end + 4);
      const match = /^CONNECT (\S+)/.exec(head);
      if (!match) { client.destroy(); return; }
      seen += 1;

      if (resetFirstConnect && seen === 1) {
        console.error(`[resetting-hop] reset #1 on CONNECT ${match[1]}`);
        server.injected += 1;
        // No CONNECT reply, no relay: the request was read but never
        // answered.
        client.resetAndDestroy();
        return;
      }
      if (stallFirstConnect && seen === 1) {
        console.error(`[resetting-hop] stall #1 on CONNECT ${match[1]}`);
        server.injected += 1;
        // Read; never replied, never relayed. Nothing to clean up on close
        // (the caller destroys/aborts its own side).
        return;
      }

      const sep = String(server.forward).lastIndexOf(":");
      const target = net.connect(Number(server.forward.slice(sep + 1)), server.forward.slice(0, sep), () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) target.write(rest);
        client.pipe(target);
        target.pipe(client);
      });
      target.on("error", () => client.destroy());
      client.on("error", () => target.destroy());
    };
    client.on("data", onData);
  });
  server.forward = forward;
  server.injected = 0;   // count of reset/stall injections actually fired
  return server;
}
