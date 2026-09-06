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
    const neverUp = async () => { attempts++; return "ERR:ECONNREFUSED"; };
    const body = await waitForHolder(0, { ceilingMs: 1_000, probe: neverUp });
    assert.equal(body, "ERR:ECONNREFUSED");
    assert.ok(attempts >= 5 && attempts < 50,
      `expected a throttled poll (5-49 attempts over 1s) — got ${attempts}, so the loop is either ` +
      `spinning unthrottled or not polling at all`);
  });
});
