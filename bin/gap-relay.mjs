#!/usr/bin/env node
// Accept on the socket handed down as fd 3 and CARRY, for as long as nothing
// better is serving that address.
//
// Its own file, and a separate PROCESS, for one measured reason each. A process
// because a second socket cannot be had: binding a port again is refused while
// anything is listening on it (EADDRINUSE on linux and darwin alike), and that
// is exactly the state a dead child leaves behind — socket listening, nobody
// accepting, every client waiting out its own timeout. Inheriting the
// descriptor has no bind in it, so it works in every state the port can be in.
// Its own file because the launcher treats an unrecognised subcommand as
// arguments for claude, so a dispatch branch there is never reached.
//
// It carries rather than merely answering: to the fallback hop when there is
// one, and straight to the origin by terminating CONNECT when there is not.
// "Everything off" is a real state on these machines, and a session's
// HTTPS_PROXY is fixed at exec — so this address has to finish the request.
// CONNECT only: every call this stands in for is HTTPS.
import net from "node:net";

const hop = (process.env.CACHE_FIX_FALLBACK_PROXIES || "").split(",")[0].trim();
const m = /^(?:https?:\/\/)?(?:[^@/]*@)?([^:/]+):(\d+)/.exec(hop);

const join = (client, up, onReady) => {
  const bail = () => { up.destroy(); client.destroy(); };
  up.on("error", bail);
  client.on("error", bail);
  up.on("connect", onReady);
};

const srv = net.createServer((client) => {
  if (m) {
    const up = net.connect(Number(m[2]), m[1]);
    join(client, up, () => { client.pipe(up); up.pipe(client); });
    return;
  }
  client.once("data", (first) => {
    const c = /^CONNECT\s+([^\s:]+):(\d+)/i.exec(String(first).split("\r\n")[0]);
    if (!c) { client.destroy(); return; }
    const up = net.connect(Number(c[2]), c[1]);
    join(client, up, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.pipe(up); up.pipe(client);
    });
  });
});
srv.on("error", (e) => { process.stderr.write(`[cache-fix] gap-relay: ${e.code}\n`); process.exit(1); });
srv.listen({ fd: 3 }, () => process.stderr.write("[cache-fix] gap-relay carrying\n"));
