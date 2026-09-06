// The byte-gate riding the daily sweep: what it may and may not turn into a
// failing row.
//
// Definitions this pins, and the split between them is the whole point:
//
//   COVERAGE is the sweep's business. The migration byte-test is the gate
//   "every NORMALIZATION design must pass" (dev-loop.md), and its measured
//   failure mode was reporting clean over captures it never read — 79% of the
//   corpus by bytes. So a capture the byte-gate could not read, or a byte-gate
//   run that produced no verdict at all, makes the row NOT clean.
//
//   FINDINGS are not. A MISMATCH, an EXTENDED, an INTERIOR-DIVERGENT prune are
//   facts about Claude Code's traffic, not defects of this pipeline. Failing
//   the sweep on them would fire on non-defects daily and train its reader to
//   ignore red — the failure `gate 1` in output-guard.test.mjs and the safety
//   gate's 243 "corruptions" both already demonstrated here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { summarise, rowIsClean, summariseCensus, censusArgs, describeByteGate,
         CHILD_HEAP_CAP_MB } from "../tools/gate-live.mjs";

const json = (o) => ({ code: 0, out: JSON.stringify(o), err: "" });

/** A replay row with nothing wrong with it, so byteGate decides the verdict. */
const cleanRow = () => summarise("c.jsonl", 100, json({
  report: [{ n: 0 }, { n: 1 }],
  violations: [], safety: [], sequence: [], orderViolations: [],
  census: { pairs: 2 },
}));

const censusJson = (o) => json({
  tally: { EXACT: 0, EXTENDED: 0, DROPPED: 0, MISMATCH: 0 },
  extendedSub: { "MERGED-STANDALONE": 0, "NEW-TEXT": 0 },
  prunes: { pure: 0, interior: 0, unanchored: 0 },
  pairs: 10, considered: 1, unreadable: [], ...o,
});

test("summariseCensus carries the tallies the sweep is supposed to surface", () => {
  const g = summariseCensus(censusJson({
    tally: { EXACT: 3, EXTENDED: 2, DROPPED: 0, MISMATCH: 1 },
    extendedSub: { "MERGED-STANDALONE": 2, "NEW-TEXT": 0 },
    prunes: { pure: 11, interior: 1, unanchored: 0 },
  }));
  assert.equal(g.tally.MISMATCH, 1);
  assert.equal(g.extendedSub["MERGED-STANDALONE"], 2);
  assert.equal(g.prunes.interior, 1);
  assert.equal(g.unreadable, 0);
});

test("BITE — a capture the byte-gate could not READ fails the row", () => {
  // The defect this sweep now has to catch: a normalization gate reporting a
  // clean verdict over a corpus it never opened.
  const row = cleanRow();
  assert.equal(rowIsClean(row), true, "the row is otherwise clean");
  row.byteGate = summariseCensus(censusJson({
    unreadable: [{ path: "/big.jsonl", error: "Cannot create a string longer than 0x1fffffe8 characters" }],
  }));
  assert.equal(row.byteGate.unreadable, 1);
  assert.equal(rowIsClean(row), false, "unread bytes are a could-not-verify, not a pass");
  assert.match(describeByteGate(row.byteGate), /COULD NOT READ/);
});

test("BITE — a byte-gate run that produced no verdict fails the row", () => {
  const row = cleanRow();
  row.byteGate = summariseCensus({ code: 1, out: "", err: "RangeError: something\n  at x" });
  assert.ok(row.byteGate.error, "no JSON means no answer");
  assert.equal(rowIsClean(row), false);
  assert.match(describeByteGate(row.byteGate), /COULD NOT RUN/);
});

test("findings are CARRIED, not failed — a MISMATCH is not a sweep failure", () => {
  // A check that fires on a non-defect is broken too. MISMATCH blocks shipping
  // a normalization; it does not mean today's traffic was mishandled.
  const row = cleanRow();
  row.byteGate = summariseCensus(censusJson({
    tally: { EXACT: 5, EXTENDED: 1, DROPPED: 0, MISMATCH: 2 },
    prunes: { pure: 3, interior: 4, unanchored: 1 },
  }));
  assert.equal(rowIsClean(row), true, "findings about CC's traffic stay findings");
  const line = describeByteGate(row.byteGate);
  assert.match(line, /2 MISMATCH/, "but they must be VISIBLE in the sweep output");
  assert.match(line, /4 interior/);
  assert.match(line, /1 unanchored/);
});

test("a row with no byte-gate at all is unchanged", () => {
  // Backward compatibility with rows built before this rode along: absence of
  // the field must not silently fail every historical row.
  assert.equal(rowIsClean(cleanRow()), true);
});

test("the byte-gate child runs under the same heap cap as the replay child", () => {
  // The cap is a CHECK, not a tuning knob: a census that regressed into
  // retaining its input dies against it instead of OOMing years later.
  const args = censusArgs("/c.jsonl");
  assert.equal(args[0], `--max-old-space-size=${CHILD_HEAP_CAP_MB}`);
  assert.ok(args.includes("--json"), "the sweep parses JSON, never prose");
  assert.ok(args.some((a) => a.endsWith("reminder-migration-census.mjs")));
});
