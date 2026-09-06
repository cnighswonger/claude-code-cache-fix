// census-dup-request — the CC#78420 falsifier, mechanized (BACKLOG.md
// "Duplicate-request probe -> census check (Q1)").
//
// The threat-matrix coverage note ("hidden duplicate request", #78420) was
// answered 2026-07-29 by a throwaway python scan over raw capture bytes —
// exactly the shape dev-loop.md calls out as the tell that a classification
// is missing from the tools. findDuplicateRequests re-answers the same
// question on every --census run instead of re-deriving it by hand.
//
// Also covers BACKLOG's "Row 6's isolating query is built and unread (Q3)":
// gate-live's status row now carries a toolsDeltas summary so the daily
// sweep's answer to threat-matrix row 6 is readable off the status file
// instead of re-run by hand.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findDuplicateRequests } from "../tools/replay.mjs";
import { summarise } from "../tools/gate-live.mjs";

const text = (t) => ({ type: "text", text: t });
const human = (t) => ({ role: "user", content: [text(t)] });
const asst = (t) => ({ role: "assistant", content: [text(t)] });

// One capture entry as the replay loop builds it — same shape
// census-block-migration.test.mjs and replay-gate-selfcheck.test.mjs pass to
// checker functions, so findDuplicateRequests' own asCompact call exercises
// the real compactEntry path.
const conv = (msgs, n) => ({ n, ts: `t${n}`, key: "k", inMsgs: msgs, outMsgs: msgs, inTools: [], outTools: [] });

test("BITE — adjacent byte-identical request bodies are counted as a duplicate", () => {
  const msgs = [human("q1"), asst("a1"), human("q2")];
  const a = conv(msgs, 0);
  // A genuine resend: the exact same message array crosses the wire twice.
  const b = conv(structuredClone(msgs), 1);
  const rows = findDuplicateRequests([a, b]);
  assert.equal(rows.length, 1, "an unchanged history across adjacent requests is a resend");
  assert.equal(rows[0].n, 1);
  assert.equal(rows[0].prevN, 0);
  assert.equal(rows[0].msgs, 3);
});

test("a normal turn (history grows) is NOT counted", () => {
  const a = conv([human("q1"), asst("a1")], 0);
  const b = conv([human("q1"), asst("a1"), human("q2")], 1);
  assert.equal(findDuplicateRequests([a, b]).length, 0, "every real turn changes something");
});

test("a mid-history edit (same length, different bytes) is NOT counted", () => {
  const a = conv([human("q1"), asst("a1"), human("q2")], 0);
  const b = conv([human("q1 EDITED"), asst("a1"), human("q2")], 1);
  assert.equal(findDuplicateRequests([a, b]).length, 0, "same length is not the same bytes");
});

test("NON-adjacent identical bodies (identical to n-2, not n-1) are not counted", () => {
  const msgs = [human("q1"), asst("a1")];
  const a = conv(structuredClone(msgs), 0);
  const b = conv([human("q1"), asst("a1"), human("q2")], 1);
  // c repeats a's exact bytes, but its ADJACENT predecessor is b, not a.
  const c = conv(structuredClone(msgs), 2);
  const rows = findDuplicateRequests([a, b, c]);
  assert.equal(rows.length, 0, "duplicate detection is pairwise-adjacent, never a lookback");
});

test("empty message arrays never count as a duplicate", () => {
  const a = conv([], 0);
  const b = conv([], 1);
  assert.equal(findDuplicateRequests([a, b]).length, 0, "no content sent is not a resend of content");
});

// --- gate-live: threat-matrix row 6's consumer path (BACKLOG Q3) ---

const json = (o) => ({ code: 0, out: JSON.stringify(o), err: "" });

test("BITE — a fixture row with census toolsDeltas present lands a compact summary in the status row", () => {
  const row = summarise("c.jsonl", 10, json({
    report: [{ n: 0 }, { n: 1 }, { n: 2 }],
    violations: [], safety: [], sequence: [], orderViolations: [],
    census: { pairs: 2 },
    toolsDeltas: [
      { n: 1, prevN: 0, kind: "reorder", msgKind: "identical", toolsOnly: true, forwardedStable: true },
      { n: 2, prevN: 1, kind: "membership+", msgKind: "append-only", toolsOnly: false, forwardedStable: false },
    ],
  }));
  assert.ok(row.toolsDeltas, "toolsDeltas summary must ride the status row");
  assert.equal(row.toolsDeltas.count, 2);
  assert.equal(row.toolsDeltas.toolsOnly, 1, "row 6's isolating case: tools moved, messages did not");
  assert.equal(row.toolsDeltas.forwardedStable, 1);
  assert.equal(row.toolsDeltas.leaked, 1);
});

test("no toolsDeltas in the parsed output (older replay, or census off) leaves the field absent, not zeroed", () => {
  const row = summarise("c.jsonl", 10, json({
    report: [{ n: 0 }],
    violations: [], safety: [], sequence: [], orderViolations: [],
  }));
  assert.equal(row.toolsDeltas, undefined, "absence must not be dressed up as a zeroed clean summary");
});
