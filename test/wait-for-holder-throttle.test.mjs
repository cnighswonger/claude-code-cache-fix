// waitForHolder() polls a real readiness signal (probeHealth's /health 200),
// so the ceiling is a worst case, never a fixed timer — but the poll itself
// must be THROTTLED, or a holder that never binds spins the loop against a
// closed port for the whole ceiling instead of leaving it CPU to boot in.
//
// Behavioural, not textual: this drives waitForHolder against a probe that
// never comes up and counts ATTEMPTS over a short ceiling. A 100ms throttle
// over a 1s ceiling makes roughly 10 attempts; an unthrottled spin makes
// thousands in the same window.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForHolder } from "./proc-helpers.mjs";

describe("waitForHolder throttles its poll", () => {
  it("does not spin: attempts stay bounded over the ceiling, and it still returns the last ERR", async () => {
    let attempts = 0;
    // A VARYING body, so returning the FIRST probe result and returning the
    // LAST are distinguishable — a constant body cannot test pass-through-of-last.
    const neverUp = async () => { attempts++; return `ERR:${attempts}`; };
    const body = await waitForHolder(0, { ceilingMs: 1_000, probe: neverUp });
    assert.equal(body, `ERR:${attempts}`);
    assert.ok(attempts >= 2 && attempts < 50,
      `expected a throttled poll (2-49 attempts over 1s) — got ${attempts}, so the loop is either ` +
      `spinning unthrottled or not polling at all`);
  });

  it("defaults ceilingMs to exactly the pre-#369 budget (25s) — neither side", async () => {
    // Mock Date.now() with a fixed step sequence: 0 at "up" computation, then
    // a boundary value at the first loop check — the loop's `Date.now() < up`
    // is strict, so pinning BOTH sides needs two runs: a first check reading
    // 25_000 (the constant itself) must already have given up (any default
    // > 25_000 fires a second probe), and one reading 24_999 must still be
    // polling (any default < 25_000 exits after one). Infinity on every later
    // check, so an arbitrarily wrong default fails fast instead of hanging
    // the loop (and the case) forever.
    const origDateNow = Date.now;
    const probeCallsAt = async (firstCheck) => {
      const times = [0, firstCheck, Infinity];
      let n = -1;
      Date.now = () => times[Math.min(++n, times.length - 1)];
      let calls = 0;
      const neverUp = async () => { calls++; return "ERR:refused"; };
      try {
        await waitForHolder(0, { probe: neverUp });
      } finally {
        Date.now = origDateNow;
      }
      return calls;
    };
    assert.equal(await probeCallsAt(25_000), 1,
      `at the 25s mark itself the wait must already have given up (1 probe call) — ` +
      `got a second probe, so the default is greater than 25_000`);
    assert.equal(await probeCallsAt(24_999), 2,
      `one ms short of 25s the wait must still be polling (2 probe calls) — ` +
      `got only 1, so the default is less than 25_000`);
  });
});
