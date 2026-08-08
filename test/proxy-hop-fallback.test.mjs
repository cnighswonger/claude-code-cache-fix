// A hop that is OFF must be routed around, not answered with 502.
//
// A session bakes HTTPS_PROXY at exec and never re-reads it, so it cannot fail
// over itself: when the hop it names goes away, that session is stranded for
// its whole life. The proxy is the one process in the chain that can re-decide,
// because config.httpsProxy is read per request.
//
// Measured on <linux-host> before this: with the upstream hop refused, every request
// came back 502 and a live session saw the chain as dead.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

describe("hop fallback", () => {
  it("lists nothing by default, so an unconfigured proxy behaves exactly as before", async () => {
    const { fallbackProxyUrls } = await import("../proxy/upstream.mjs");
    const prior = process.env.CACHE_FIX_FALLBACK_PROXIES;
    delete process.env.CACHE_FIX_FALLBACK_PROXIES;
    try {
      assert.deepEqual(fallbackProxyUrls(), [],
        "an unset list must yield no hops — a default that routes around a hop " +
        "would silently change every existing deployment");
    } finally {
      if (prior === undefined) delete process.env.CACHE_FIX_FALLBACK_PROXIES;
      else process.env.CACHE_FIX_FALLBACK_PROXIES = prior;
    }
  });

  it("reads an ordered list, trimming and dropping empties", async () => {
    const { fallbackProxyUrls } = await import("../proxy/upstream.mjs");
    const prior = process.env.CACHE_FIX_FALLBACK_PROXIES;
    process.env.CACHE_FIX_FALLBACK_PROXIES =
      " http://127.0.0.1:8118 , ,http://127.0.0.1:9901 ";
    try {
      assert.deepEqual(fallbackProxyUrls(),
        ["http://127.0.0.1:8118", "http://127.0.0.1:9901"],
        "order is the routing order, so it must survive parsing verbatim");
    } finally {
      if (prior === undefined) delete process.env.CACHE_FIX_FALLBACK_PROXIES;
      else process.env.CACHE_FIX_FALLBACK_PROXIES = prior;
    }
  });

  it("calls a listening hop alive and a closed one dead, defaulting the port from the scheme", async () => {
    const { hopAlive } = await import("../proxy/upstream.mjs");
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const live = `http://127.0.0.1:${srv.address().port}`;
    const dead = `http://127.0.0.1:${await freePort()}`;
    try {
      assert.equal(await hopAlive(live), true, "a listening hop read as dead");
      // The control that matters: a probe that answers true for everything
      // would route around nothing and read as working.
      assert.equal(await hopAlive(dead), false, "a closed port read as alive");
      // A PORTLESS URL TAKES ITS SCHEME'S PORT, in BOTH readers. `|| 80` sent an
      // `https://hop` carrying no explicit port to :80 — which refuses, so a
      // live TLS hop read as dead and the chain fell through past it, and the
      // CONNECT that did go out went to the wrong port on the right host.
      //
      // Read from source and evaluated, not spied: hopAlive holds a live ESM
      // binding to net.connect, so reassigning the module's export patches
      // nothing (measured — the first version of this case collected zero dials
      // and would have passed against any port at all). Two files carry the same
      // expression and both must agree; a fix applied to one is the shape this
      // catches.
      const readFileSync = (await import("node:fs")).readFileSync;
      for (const [file, re] of [
        ["../proxy/upstream.mjs", /netConnect\(\{ host: u\.hostname, port: (Number\(u\.port\)[^}]*?) \}\)/],
        ["../proxy/forward-proxy.mjs", /port: (Number\(u\.port\)[^}]*?) \};/],
        // THREE copies, not two. bin/gap-relay.mjs carries its own because it
        // imports node:net and nothing else — it is what runs when the proxy is
        // DOWN, so depending on proxy/ modules would let a broken one take the
        // relay with it. The duplication is deliberate; leaving it unchecked was
        // not, and it was already correct here, which is why the other two read
        // as a regression against it.
        ["../bin/gap-relay.mjs", /const portOf = \(u\) => (Number\(u\.port\)[^;]*?);/],
      ]) {
        const src = readFileSync(new URL(file, import.meta.url), "utf8");
        const expr = re.exec(src)?.[1];
        assert.ok(expr, `${file} no longer chooses a hop port here — this case tests nothing`);
        const pick = Function("u", `return ${expr};`);
        assert.equal(pick(new URL("https://h")), 443, `${file}: a portless https hop did not dial 443`);
        assert.equal(pick(new URL("http://h")), 80, `${file}: a portless http hop did not dial 80`);
        assert.equal(pick(new URL("https://h:8443")), 8443, `${file}: an explicit port was overridden`);
      }
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  // THE FIELD /health PUBLISHES MUST BE THE HOP THAT WAS USED. The chain falls
  // THROUGH, so naming candidate #1 reports ":8118" while CONNECTs leave via
  // the second fallback — or via nothing at all. A confident wrong answer is
  // worse than no answer for anything that reads it to confirm the next hop.
  //
  // This comment used to say cswap's pin reads exactly this field. It does not,
  // and both projects believed it for an hour: their check dials pin's own
  // :36301 and reads chain/egress/direct_last, all produced by pin. The only
  // overlapping NAME with our :9901 is direct_last, and theirs is pin's. Two
  // sessions agreed on a dependency neither had measured because one field name
  // appeared on both endpoints — read the field SETS, never match on names.
  it("remembers the hop a resolve landed on, and empty when it fell through to direct", async () => {
    const mod = await import("../proxy/upstream.mjs");
    const { resolveHop, lastHop, directLast } = mod;
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const live = `http://127.0.0.1:${srv.address().port}`;
    const dead = `http://127.0.0.1:${await freePort()}`;
    // The PRIMARY comes from the ambient environment, and this box has a live
    // one — the first version of this case resolved to the operator's real pin
    // hop and asserted against it. Scrub every name config.httpsProxy reads.
    // Every name in BOTH getters: selectProxyUrl(true) falls through to
    // config.httpProxy, so scrubbing only the https ones left the live proxy on
    // :9901 as the primary and this case measured the operator's box.
    const PRIMARY_ENV = ["CACHE_FIX_UPSTREAM_PROXY", "HTTPS_PROXY", "https_proxy",
                         "HTTP_PROXY", "http_proxy",
                         "CACHE_FIX_FALLBACK_PROXIES", "CACHE_FIX_CHAIN_GRACE_MS"];
    const prior = Object.fromEntries(PRIMARY_ENV.map((k) => [k, process.env[k]]));
    for (const k of PRIMARY_ENV) delete process.env[k];
    // THE GRACE IS PAID, and the comment that used to sit here said it was not.
    // CHAIN_GRACE_MS is a module-level const captured at import, so setting the
    // env after upstream.mjs is already loaded changes nothing — measured, this
    // case runs 2,616 ms, which is one full 2,500 ms default window. Setting it
    // anyway and calling the retry loop "not under test" was a lie in a comment,
    // which is worse than the 2.5 s: it tells the next reader the wait is gone.
    // Not worth a production getter — an operator sets this before the proxy
    // starts, which is the only moment it is read, and that path works.
    try {
      // Dead first, live second: the answer must be the one that ANSWERED, not
      // the one that was configured first.
      process.env.CACHE_FIX_FALLBACK_PROXIES = `${dead},${live}`;
      assert.equal(await resolveHop(true), live, "the chain did not fall through to the live hop");
      assert.equal(lastHop(), live, "lastHop() named a candidate rather than the hop that answered");
      const beforeDirect = directLast();

      // Nothing reachable: resolveHop falls open to a direct dial, and the
      // record must say so rather than keep the last good value — a stale hop
      // published here is a chain confirmed by a probe that is no longer true.
      process.env.CACHE_FIX_FALLBACK_PROXIES = dead;
      assert.equal(await resolveHop(true), "", "an unreachable chain did not fall through to direct");
      assert.equal(lastHop(), "",
        "lastHop() kept the previous hop after the chain went to a direct dial");

      // AND IT MUST LEAVE A MARK THAT SURVIVES THE RECOVERY. The chain is back
      // within ~1s, so a point-in-time field reads green from the next probe on
      // and the outage is unfindable THROUGH /health. Not unfindable full stop:
      // resolveHop writes `hop <primary> unusable — ...` to stderr, and that log
      // is how the same event was reconstructed on the peer side. The precision
      // matters in the reader's direction — told nothing survives, nobody opens
      // the log, which is the one place the trace actually is.
      //
      // The degrade-to-a-LOWER-HOP case has no sticky mark at all, only that
      // stderr line, and `_lastHopReport` is cleared on recovery — so the
      // recovery erases even the in-memory trace. Known gap, deliberately not
      // fixed here: a new /health field does not belong in this PR.
      const mark = directLast();
      assert.notEqual(mark, beforeDirect, "a direct fall-through left no mark at all");
      assert.match(String(mark), /^\d{4}-\d{2}-\d{2}T.*Z$/, `direct_last is not an ISO instant: ${mark}`);

      // The recovery must NOT erase it — that is the whole point of sticky.
      process.env.CACHE_FIX_FALLBACK_PROXIES = live;
      assert.equal(await resolveHop(true), live, "premise: the chain must come back");
      assert.equal(directLast(), mark,
        "the chain coming back cleared the direct-dial mark — the flap is now invisible, " +
        "which is the state this field exists to make visible");

      // AND AN EMPTIED CHAIN MUST NOT LEAVE A HOP BEHIND. Both getters read the
      // env per call, so the list can go away under a running proxy — and the
      // early return for "no chain" used to skip _lastHop entirely, so /health
      // went on naming a hop no request could take. Measured before the fix:
      // resolved :40559, chain emptied, resolveHop returned "" and lastHop()
      // still said :40559.
      const beforeEmpty = directLast();
      process.env.CACHE_FIX_FALLBACK_PROXIES = "";
      assert.equal(await resolveHop(true), "", "premise: an empty chain must resolve to direct");
      assert.equal(lastHop(), "",
        "an emptied chain left the previous hop published — /health names an address " +
        "no request can take, which is the lie this field was fixed to stop telling");
      assert.equal(directLast(), beforeEmpty,
        "an unconfigured chain stamped direct_last — that field means the chain was " +
        "walked and nothing carried, not that there was never a chain");
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await new Promise((r) => srv.close(r));
    }
  });

  it("refuses fast rather than waiting out a timeout", async () => {
    const { hopAlive } = await import("../proxy/upstream.mjs");
    const dead = `http://127.0.0.1:${await freePort()}`;
    const t0 = Date.now();
    await hopAlive(dead, 5_000);
    const took = Date.now() - t0;
    // A refused dial returns immediately; if this ever waits out the timeout,
    // every request pays it and the fallback costs more than the outage.
    assert.ok(took < 500, `a refused dial took ${took}ms — the probe is waiting, not failing`);
  });

  it("never lists a hop that would route back into this proxy", async () => {
    const { fallbackProxyUrls } = await import("../proxy/upstream.mjs");
    const prior = process.env.CACHE_FIX_FALLBACK_PROXIES;
    const self = `http://127.0.0.1:${process.env.CACHE_FIX_PROXY_PORT || 9801}`;
    process.env.CACHE_FIX_FALLBACK_PROXIES = `${self},http://127.0.0.1:8118`;
    try {
      assert.ok(!fallbackProxyUrls().includes(self),
        "our own address survived in the fallback list — a request routed there " +
        "comes straight back and loops until the socket dies");
    } finally {
      if (prior === undefined) delete process.env.CACHE_FIX_FALLBACK_PROXIES;
      else process.env.CACHE_FIX_FALLBACK_PROXIES = prior;
    }
  });
});
