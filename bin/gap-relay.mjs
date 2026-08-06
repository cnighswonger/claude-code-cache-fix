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
import net from "node:net";

// OUR OWN ADDRESS IS NEVER A HOP. `fallbackProxyUrls()` drops it for a reason
// the fallback suite pins — a request routed there comes straight back — and the
// shipped list can legitimately BEGIN with self. Taking `[0]` raw meant an armed
// relay forwarded to itself: measured on one CONNECT, the relay's descriptor
// count went 22 -> 8,195 -> 22,733 -> 29,814 and kept climbing, so the address
// is destroyed rather than degraded, in the one state where nothing else is left
// to serve it.
const mine = new Set();
{
  const held = process.env.CACHE_FIX_HELD_PORT;
  // The host we are BOUND to as well as loopback: a non-loopback bind plus a
  // fallback naming this box's own address is the same self-forward by another
  // name. And the bare host for 80/443, because `new URL` drops a default port
  // from `.host` and the comparison would never match.
  if (held) {
    for (const h of ["127.0.0.1", "localhost", "[::1]", process.env.CACHE_FIX_HELD_HOST].filter(Boolean)) {
      mine.add(`${h}:${held}`);
      if (held === "80" || held === "443") mine.add(h);
    }
  }
}
// Same precedence the proxy uses — config.httpsProxy first, then the fallback
// list — because a host wired with only CACHE_FIX_UPSTREAM_PROXY has a hop this
// would otherwise not see, and would dial origins direct, straight into a
// corporate MITM, while /health on that same host named the corp proxy.
//
// `new URL` and http(s) only, matching upstream.mjs: a value it rejects is not a
// hop there either, and the protocol check is what keeps `user:pass@host:port` —
// which URL reads as the scheme `user:` — from becoming one, or from reaching
// /health below.
const hopUrl = (() => {
  const candidates = [process.env.CACHE_FIX_UPSTREAM_PROXY,
                      process.env.HTTPS_PROXY, process.env.https_proxy,
                      ...(process.env.CACHE_FIX_FALLBACK_PROXIES || "").split(",")];
  for (const raw of candidates) {
    const v = (raw || "").trim();
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      if (mine.has(u.host)) continue;
      return u;
    } catch { /* not a hop; try the next */ }
  }
  return null;
})();
const hopPort = hopUrl ? Number(hopUrl.port) || (hopUrl.protocol === "https:" ? 443 : 80) : 0;
// Address only, never the credentials: a hop URL may carry them (cswap's pin
// publishes its own as cswap:<token>@127.0.0.1:53749) and this goes into a
// /health body that anything able to reach the port can read.
const hopAddress = hopUrl ? `${hopUrl.protocol}//${hopUrl.host}` : null;

const srv = net.createServer((client) => {
  // A client that connects and never speaks would hold a descriptor for as long
  // as this process lives. Cleared on the first byte, so an idle CONNECT tunnel
  // — normal, and legitimately long — is never touched by it.
  const mute = setTimeout(() => client.destroy(), 30_000);
  let up = null;
  const bail = () => { up?.destroy(); client.destroy(); };
  client.on("error", bail);
  // CLOSE, not just error, on both sides. `pipe()` does not end a destination
  // whose source was DESTROYED rather than ended, and between a CONNECT 200 and
  // the first TLS byte neither side is writing, so nothing errors either — the
  // shape where an upstream can be left behind. forward-proxy.mjs guards the
  // same hazard for the same reason ("dialling for a dead socket leaks the
  // upstream connection").
  //
  // A review reported 20 leaked descriptors from 20 aborted tunnels here. I
  // could NOT reproduce it, at this commit or with these two lines removed: the
  // relay's own fd table stayed at one socket, its listener. So these are a
  // guard against a shape that is real in principle, not the fix for a leak
  // measured in this code — and there is no case below that kills them.
  //
  // It is worth the three lines anyway: this process exits(1) on an accept
  // error, so at an EMFILE ceiling the standby would drop the last descriptor on
  // the socket and the ADDRESS would die, from the one process meant to be the
  // last line of defence.
  client.on("close", () => up?.destroy());
  client.once("data", (first) => {
    // PAUSE, or every byte after this chunk is lost. Removing the last `data`
    // listener does NOT stop a flowing stream, so whatever arrives between here
    // and the pipe below is emitted to nobody. Measured on this exact shape: a
    // request whose body followed its headers reached the hop with an empty
    // body and hung waiting for a Content-Length that never came. pipe()
    // resumes, so the buffered bytes go out in order.
    client.pause();
    const line = String(first).split("\r\n")[0];
    // /health, answered 503, and both halves are load-bearing.
    //
    // /health because the standby below has to ask a question a real proxy also
    // answers — a private path would be silence from a live proxy, and silence
    // is its cue to start accepting beside one. Measured: the proxy closes on an
    // unknown path without a byte.
    //
    // 503 because THIS ADDRESS IS NOT WELL, and every readiness check in the
    // tree reads /health. Answering 200 made a fixture take a relay for a proxy
    // and run 1.3s before one existed. `curl -sf` fails on 503, so the checks
    // that gate a deploy keep saying no, which is the truth: traffic is moving
    // and nothing is caching it.
    if (/^GET\s+\/health\b/.test(line)) {
      // The timer is deliberately NOT cleared on this path: `end()` half-closes,
      // and a peer that never closes back would hold this descriptor for the
      // life of the process — one per probe, and the standby probes forever.
      client.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"
                 + JSON.stringify({ carrying: "gap-relay", https_proxy: hopAddress }));
      return;
    }
    clearTimeout(mute);
    // Straight to the origin, terminating CONNECT ourselves: the route when no
    // hop is configured, and the route when the configured one is gone. CONNECT
    // ONLY — with no hop there is nothing to hand an absolute-form request to,
    // and every call this stands in for is HTTPS.
    const direct = () => {
      const c = /^CONNECT\s+([^\s:]+):(\d+)/i.exec(line);
      if (!c) return void client.destroy();
      up = net.connect(Number(c[2]), c[1]);
      up.on("error", bail);
      up.on("close", () => client.destroy());
      up.on("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(up); up.pipe(client);
      });
    };
    if (!hopUrl) return void direct();

    // A CONFIGURED HOP THAT IS DOWN IS NOT THE END OF THE LINE. The hop is read
    // once at startup, so "privoxy is off too" leaves this pointing at a port
    // that refuses — and refusing every request is the state we exist to
    // prevent. Measured before this fell through: CCF off and the hop stopped
    // gave ECONNRESET on every request, at 1ms, forever.
    //
    // Only BEFORE the tunnel opens. Once bytes are flowing the client is inside
    // an established tunnel and there is nothing to re-dial — a second attempt
    // would replay a request the hop may already have acted on.
    //
    // A hop speaks the same protocol we were handed, so CONNECT and
    // absolute-form both pass through untouched, including the chunk we had to
    // read to get here.
    const hopSock = net.connect(hopPort, hopUrl.hostname);
    up = hopSock;
    let carried = false;
    // A DEADLINE ON THE DIAL. The measured fall-through case was a hop that
    // REFUSED, which is instant; a hop that DROPS — VPN down, a firewalled corp
    // proxy — costs the kernel's own connect timeout instead, ~130s on linux and
    // ~75s on darwin. Waiting that out before falling through is the "worse than
    // a refusal" outcome this path exists to prevent, on the path that prevents
    // it. Same 2s the standby's own probe uses.
    hopSock.setTimeout(2_000, () => { if (!carried) hopSock.destroy(new Error("hop dial timed out")); });
    hopSock.on("error", () => { hopSock.destroy(); if (carried) client.destroy(); else direct(); });
    hopSock.on("close", () => { if (carried) client.destroy(); });
    hopSock.on("connect", () => {
      carried = true;
      hopSock.setTimeout(0);          // an established tunnel is allowed to idle
      hopSock.write(first);
      client.pipe(hopSock); hopSock.pipe(client);
    });
  });
});
srv.on("error", (e) => { process.stderr.write(`[cache-fix] gap-relay: ${e.code}\n`); process.exit(1); });

const carry = () => srv.listen({ fd: 3 }, () => process.stderr.write("[cache-fix] gap-relay carrying\n"));

// STANDBY — the same relay, spawned once by the holder and then left alone,
// accepting NOTHING until the holder is gone.
//
// A socket outlives every process that served it for as long as any descriptor
// remains. Measured: killing the holder and its child together left no
// descriptor at all and the address answered ECONNREFUSED, and a session's
// HTTPS_PROXY is fixed at exec, so that session is stranded for life. Holding
// the descriptor is what keeps the address alive; arming is what makes it work.
//
// Orphanhood says the holder that would respawn a proxy is gone, so nothing is
// coming back to compete. Against the parent we were BORN with, not against pid
// 1: an orphan is only reparented to init where nothing else claims it, and a
// host running a child-subreaper (systemd --user sets one) would leave this
// waiting for a 1 that never comes — and a standby that never arms still holds
// the descriptor, so the address would ACCEPT and hang, which is worse than the
// refusal it replaced.
//
// Silence says nothing is serving RIGHT NOW — which no descriptor scan can tell
// you, because the holder, the child and this process all hold the same socket
// and all read as LISTEN. Two acceptors on one descriptor take turns and drop
// connections (measured: 60 of 125 reset), so the guard has to ask whether
// anything ANSWERS rather than whether anything is attached. cswap's pin hit the
// same wall from the other side and wrote it down: a refused-versus-not probe
// cannot separate "served" from "accepted and queued behind nobody".
//
// THREE SHORT WINDOWS, not two long ones, and the difference is what a waiting
// caller feels. Arming is a one-way door, so it needs evidence; but the evidence
// is "nothing answered", and a live proxy answers /health in about a millisecond
// — the seconds were slack for a stalled event loop, not measurement. Three
// silences at 250ms cost more samples and less waiting than two at 2s: the
// user-visible stall for a request that arrives in the gap went from ~4.6s to
// under a second, measured, while the number of independent observations went up.
//
// The queue would have been better still — a socket whose acceptor is gone piles
// connections up, and that is the symptom itself rather than a proxy for it — but
// darwin reports Recv-Q as 0 for a listening socket, and two of three machines
// are macs. Measured before choosing this: linux /proc/net/tcp exposes it,
// `netstat -an` on the mac does not.
if (process.env.CACHE_FIX_STANDBY !== "1") carry();
else {
  const port = Number(process.env.CACHE_FIX_HELD_PORT);
  // The host the socket is BOUND to, not loopback by assumption: a holder on a
  // non-loopback bind would refuse every probe, leaving orphanhood as the only
  // guard and arming this beside a live proxy.
  const host = process.env.CACHE_FIX_HELD_HOST || "127.0.0.1";
  // The pid we were HANDED, not the one we can see: `process.ppid` is read tens
  // of milliseconds after spawn, and a holder that died inside that window has
  // already been replaced by init — so this would compare 1 against 1 forever
  // and never arm, while still holding a listening socket. Accept-and-hang.
  const bornOf = Number(process.env.CACHE_FIX_STANDBY_PARENT) || process.ppid;
  const answered = () => new Promise((res) => {
    const s = net.connect(port, host);
    let done = false;
    const end = (v) => { if (done) return; done = true; clearTimeout(t); s.destroy(); res(v); };
    // A hang IS the symptom: listening with nobody accepting reads exactly like
    // this, and it is the state we exist to end.
    const t = setTimeout(() => end(false), 250);
    s.on("connect", () => s.write(`GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    s.on("data", () => end(true));
    s.on("error", () => end(false));
    s.on("close", () => end(false));
  });
  let silent = 0;
  const tick = async () => {
    if (process.ppid === bornOf) { silent = 0; return void setTimeout(tick, 250); }
    // ORPHANED BUT ANSWERED is a steady state, not a transient: it is where every
    // machine sits once a holder has died and the lineage self-healed. Polling
    // it four times a second for ever costs the live proxy a connection every
    // 250ms and buys nothing — back off, and come back to 250ms the moment the
    // answer stops.
    if (await answered()) { silent = 0; return void setTimeout(tick, 2_000); }
    silent += 1;
    if (silent < 3) return void setTimeout(tick, 150);
    carry();
  };
  setTimeout(tick, 250);
}
