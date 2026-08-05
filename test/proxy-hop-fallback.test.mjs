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

  it("calls a listening hop alive and a closed one dead", async () => {
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
    } finally {
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
