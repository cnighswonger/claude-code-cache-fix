// gate-live — the sweep that runs the real gate over live captures.
//
// It exists because two gate defects (a RangeError on a 955 MB capture, a
// 3.2 GB retention peak) were invisible to `npm test` by construction: the
// committed corpus is harvested for STRUCTURAL NOVELTY and sanitised, so it is
// small on purpose and can never contain a scale-shaped input.
//
// Which means this file cannot test the thing that matters either — only the
// scheduled run against real captures can. What it CAN pin is the reporting:
// that a gate which died is recorded as an error rather than smoothed into a
// clean row, and that a clean sweep needs actual captures behind it. Those are
// the two ways a green verdict could lie.

import { test } from "node:test";
import assert from "node:assert/strict";

import { summarise, rowIsClean, replayArgs, CHILD_HEAP_CAP_MB } from "../tools/gate-live.mjs";

const json = (o) => ({ code: 0, out: JSON.stringify(o), err: "" });

test("summarise: a clean gate run reads clean", () => {
  const row = summarise("c.jsonl", 100, json({
    report: [{ n: 0 }, { n: 1 }],
    violations: [], safety: [], sequence: [], orderViolations: [],
  }));
  assert.equal(row.requests, 2);
  assert.equal(rowIsClean(row), true);
});

// The case the job was built for. A gate that CRASHED produces no JSON; if
// that were treated as "no violations found", the sweep would report success
// precisely when the gate ran no checks at all — the exact false green that
// let the RangeError live.
test("BITE — a gate that died is an error, never a clean row", () => {
  const row = summarise("big.jsonl", 955_000_000, {
    code: 1,
    out: "",
    err: "replay failed: RangeError: Invalid string length\n    at readFileHandle",
  });
  assert.ok(row.error, "a crash must be recorded as an error");
  assert.match(row.error, /RangeError/, "the reason must survive into the status file");
  assert.equal(rowIsClean(row), false);
  assert.equal(row.stability, undefined, "no violation counts may be invented for a run that produced none");
});

test("BITE — a nonzero exit is not clean even if JSON parsed", () => {
  // replay exits non-zero on violations; the counts and the exit code must
  // agree, and if they ever disagree the stricter one wins.
  const res = json({ report: [{ n: 0 }], violations: [], safety: [], sequence: [], orderViolations: [] });
  res.code = 1;
  assert.equal(rowIsClean(summarise("c.jsonl", 10, res)), false);
});

test("BITE — each violation class alone is enough to fail the row", () => {
  for (const key of ["violations", "safety", "conservation", "sequence", "orderViolations"]) {
    const payload = {
      report: [{ n: 0 }], violations: [], safety: [], conservation: [], sequence: [], orderViolations: [],
    };
    payload[key] = [{ n: 0 }];
    const row = summarise("c.jsonl", 10, json(payload));
    assert.equal(rowIsClean(row), false, `${key} must fail the row on its own`);
  }
});

test("summarise: unparseable capture lines are counted, not hidden", () => {
  const row = summarise("c.jsonl", 10, json({
    report: [{ n: 0 }, { n: 1, error: "unparseable capture line" }],
    violations: [], safety: [], sequence: [], orderViolations: [],
  }));
  assert.equal(row.unparseable, 1);
});

test("spawn failure (no node, bad path) is an error row", () => {
  const row = summarise("c.jsonl", 10, { code: -1, out: "", err: "spawn ENOENT" });
  assert.equal(rowIsClean(row), false);
  assert.match(row.error, /ENOENT/);
});

// --- Replay fidelity in the sweep ---

test("BITE — a fidelity mismatch fails the row, whatever the four gates say", () => {
  // The four invariants can all be clean and still describe a system that
  // never ran, if the replay did not reproduce the real request.
  const row = summarise("c.jsonl", 10, json({
    report: [{ n: 0 }],
    violations: [], safety: [], sequence: [], orderViolations: [],
    fidelity: { comparable: 3, matched: 2, mismatches: [{ n: 1 }] },
  }));
  assert.equal(row.fidelityMismatch, 1);
  assert.equal(rowIsClean(row), false, "a mismatch invalidates the other numbers");
});

// The cap is the memory-regression check: a replay that retains its input
// dies against it (proven — the pre-8b7ed9e replay OOMs under it in 5 s on a
// 1.5 GB capture) and becomes an error row. Dropping the flag would disarm
// that check silently; the sweep would go back to passing on a replay whose
// memory grows with the corpus, until the machine's own ceiling ends it.
test("replay children run under the heap cap, before the script path", () => {
  const args = replayArgs("c.jsonl", ["CACHE_FIX_PREFIXDIFF=1"]);
  const capIdx = args.indexOf(`--max-old-space-size=${CHILD_HEAP_CAP_MB}`);
  assert.ok(capIdx >= 0, "heap cap flag missing from child argv");
  assert.ok(
    capIdx < args.findIndex((a) => a.endsWith("replay.mjs")),
    "cap must precede the script path or node passes it to the script instead",
  );
  assert.ok(args.includes("CACHE_FIX_PREFIXDIFF=1"), "gate env must survive");
  // Census rides every sweep: dropping it silently reverts the row-4
  // annotations to on-demand and the daily verdict stops carrying them.
  assert.ok(args.includes("--census"), "sweep must run the census annotations");
});

test("BITE — a row that compared zero pairs is marked proves-nothing, never padded into clean", () => {
  // c-empty (71 requests, all empty bodies) and single-request captures ran
  // ZERO cross-request checks; before this flag they counted toward
  // "9 captures clean". Absence of comparison must be visible.
  const row = summarise("c-empty.jsonl", 10, json({
    report: Array.from({ length: 71 }, (_, n) => ({ n })),
    violations: [], safety: [], sequence: [], orderViolations: [],
    census: { pairs: 0 },
  }));
  assert.equal(row.provesNothing, true);
  assert.equal(rowIsClean(row), true, "proves-nothing is not FAILING — it is not PROVING");
  const real = summarise("s.jsonl", 10, json({
    report: [{ n: 0 }, { n: 1 }],
    violations: [], safety: [], sequence: [], orderViolations: [],
    census: { pairs: 1 },
  }));
  assert.equal(real.provesNothing, false);
  assert.equal(real.pairs, 1);
});

test("nothing comparable is NOT a failure — it is an honest absence of evidence", () => {
  // 0 comparable must not fail the sweep; it also must not be mistaken for a
  // pass, which is why the counts are recorded rather than a bare ratio.
  const row = summarise("c.jsonl", 10, json({
    report: [{ n: 0 }],
    violations: [], safety: [], sequence: [], orderViolations: [],
    fidelity: { comparable: 0, matched: 0, mismatches: [] },
  }));
  assert.equal(row.fidelityComparable, 0);
  assert.equal(row.fidelityMismatch, 0);
  assert.equal(rowIsClean(row), true);
});

test("mutated fidelity is recorded but INFORMATIONAL — it can never fail a row", () => {
  // A mutated mismatch is legitimate (replay starts from empty state), so a
  // low mutatedMatched must not fail the sweep — but on busy sessions it is
  // the only fidelity signal there is, so losing the numbers would blind the
  // one instrument that could notice the replay modelling a different system.
  const row = summarise("c.jsonl", 10, json({
    report: [{ n: 0 }],
    violations: [], safety: [], sequence: [], orderViolations: [],
    fidelity: { comparable: 0, matched: 0, mutatedComparable: 40, mutatedMatched: 3, mismatches: [] },
  }));
  assert.equal(row.fidelityMutatedComparable, 40);
  assert.equal(row.fidelityMutatedMatched, 3);
  assert.equal(rowIsClean(row), true, "a poor mutated ratio is a hint, not a verdict");
});
