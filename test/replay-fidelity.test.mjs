// classifyFidelity — the population boundaries of the replay-models-proxy
// check. Each population exists because collapsing it into a neighbour hid
// something real:
//   - "0/0 comparable" printed exactly like "checked and clean" (the --cold
//     lesson) — hence counts, never a bare ratio;
//   - outcome records written before outSha existed sat inside noOutcome,
//     which reads as "will fill in over time" when that population can only
//     ever grow stale;
//   - on busy sessions EVERY request is mutated, so the failing check's
//     population is empty forever and the informational mutated pair is the
//     only signal recorded.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyFidelity } from "../tools/replay.mjs";

const entry = (n, over = {}) => ({ n, captureId: `id-${n}`, outBodySha: `body-${n}`, mutatedBy: [], ...over });

test("unmutated + outSha: matched or a gate-failing mismatch", () => {
  const outcomes = new Map([
    ["id-0", { outSha: "body-0" }],
    ["id-1", { outSha: "DIFFERENT" }],
  ]);
  const f = classifyFidelity([entry(0), entry(1)], outcomes);
  assert.equal(f.comparable, 2);
  assert.equal(f.matched, 1);
  assert.deepEqual(f.mismatches, [{ n: 1, recorded: "DIFFERENT", replayed: "body-1" }]);
});

test("mutated requests are informational: counted both ways, never a mismatch", () => {
  const outcomes = new Map([
    ["id-0", { outSha: "body-0" }],
    ["id-1", { outSha: "DIFFERENT" }],
  ]);
  const f = classifyFidelity(
    [entry(0, { mutatedBy: ["x"] }), entry(1, { mutatedBy: ["x"] })],
    outcomes,
  );
  assert.equal(f.comparable, 0);
  assert.equal(f.mutatedComparable, 2);
  assert.equal(f.mutatedMatched, 1);
  assert.equal(f.notComparableMutated, 2, "legacy name gate-live reads must keep counting");
  assert.equal(f.mismatches.length, 0, "a mutated divergence is legitimate — never a mismatch");
});

test("BITE — an outcome without outSha is its own population, not noOutcome", () => {
  // The pre-outSha recorder produced 14 of these in one capture. Inside
  // noOutcome they read as "records missing, will fill in"; they never will.
  const outcomes = new Map([["id-0", { /* old writer: no outSha */ }]]);
  const f = classifyFidelity([entry(0)], outcomes);
  assert.equal(f.outcomeWithoutSha, 1);
  assert.equal(f.noOutcome, 0, "must not be lumped into noOutcome");
  assert.equal(f.comparable, 0);
});

test("no outcome record at all, and unparseable entries, stay out of every ratio", () => {
  const f = classifyFidelity(
    [entry(0), { n: 1, error: "unparseable capture line" }],
    new Map(),
  );
  assert.equal(f.noOutcome, 1);
  assert.equal(f.comparable + f.mutatedComparable + f.outcomeWithoutSha, 0);
});
