// N REQUESTS IN FLIGHT MUST NOT MEAN N WALKS OF THE SAME CHAIN.
//
// Every /v1/messages goes through forwardRequest and every CONNECT through
// forward-proxy's hopFor(), both of which await resolveHop(). Each walk opens a
// TCP probe per hop — against a hop that, in the case this matters, is already
// unwell. Measured before, chain of two dead hops: 2616 / 2616 / 2615 ms for
// three sequential calls, every one paid in full.
//
// COUNT PROBES, NOT WALL-CLOCK. The first version of this case timed five
// concurrent callers and asserted the total stayed under 2x one walk — and it
// PASSED with coalescing removed, because concurrent walks overlap and the
// wall-clock is the same either way. Coalescing does not make the chain answer
// faster; it stops N callers each dialling it. The probe count is the quantity.
//
// COALESCING ONLY. The 2500 ms grace is matched to the pin's
// _CHAIN_HEAL_GRACE_S so both components wait the same amount; shortening it
// here would abandon a request the other is still hopeful about. A sequential
// caller still pays it, by design.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

describe("hop resolution coalescing", () => {
  it("dials the chain once for callers that arrive together", async () => {
    let probes = 0;
    const hop = net.createServer((s) => { probes++; s.destroy(); });
    await new Promise((r) => hop.listen(0, "127.0.0.1", r));
    const port = hop.address().port;

    const saved = {};
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "CACHE_FIX_FALLBACK_PROXIES"]) {
      saved[k] = process.env[k]; delete process.env[k];
    }
    process.env.CACHE_FIX_FALLBACK_PROXIES = `http://127.0.0.1:${port}`;
    try {
      const { resolveHop } = await import(`../proxy/upstream.mjs?coalesce=${Date.now()}`);

      // SETTLE BEFORE READING. A server's connection handler fires after the
      // client's own 'connect', so reading the counter straight after the
      // awaits counts whatever happened to have landed — measured, that read
      // returned 1 for five DIRECT hopAlive calls, and would have reported the
      // uncoalesced code as fixed.
      const settle = () => new Promise((r) => setTimeout(r, 250));

      // CONTROL FIRST, on the layer underneath: five direct dials must count
      // five. Without it, "five callers produced 1 probe" is equally the fix
      // working and the counter being blind.
      const { hopAlive } = await import(`../proxy/upstream.mjs?probe=${Date.now()}`);
      await Promise.all(Array.from({ length: 5 }, () => hopAlive(`http://127.0.0.1:${port}`)));
      await settle();
      assert.equal(probes, 5,
        `the probe counter saw ${probes} of five direct dials — it is not measuring ` +
        `what this case reads, so every assertion below would be meaningless`);

      probes = 0;
      await resolveHop(true);
      await settle();
      assert.equal(probes, 1, `one call produced ${probes} probes — the fixture is not being dialled`);

      probes = 0;
      await Promise.all(Array.from({ length: 5 }, () => resolveHop(true)));
      await settle();
      assert.equal(probes, 1,
        `five concurrent callers produced ${probes} probes — they are each walking ` +
        `the chain, so a hop that is already unwell gets one dial per in-flight request`);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await new Promise((r) => hop.close(r));
    }
  });
});
