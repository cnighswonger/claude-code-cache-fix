// census-output-hash — unit bites for the outHashSem strip added to
// findMitigationGaps' outputForm/outputPreserved/rebilledOutBytes.
// BACKLOG.md: "READY — census outputForm hashes must strip cache_control
// (mirror the input side)."
//
// DEFINITION under test (stated before the assertions, per dev-loop.md's
// "Adding a check" — a bite's expected value comes from the invariant's
// DEFINITION, never from the implementation): cache_control designates a
// cache breakpoint, it is not conversation content. A pair of forwarded
// messages that differ ONLY in whether/where a cache_control block is
// attached is not a content splice — the model-visible bytes are
// identical, only the cache metadata moved. A pair that differs in actual
// TEXT is a real edit regardless of any cache_control noise riding along,
// and must still be caught (a checker that stops firing on the marker
// case must not also stop firing on the real one — the "fires on a
// non-defect" and "misses a real defect" failures are both broken the
// same way, dev-loop.md).
//
// These are unit-level bites on findMitigationGaps directly (synthetic
// entries), the small-corpus sibling of the real-capture assertions in
// test/mitigation-output-form.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findMitigationGaps } from "../tools/replay.mjs";

const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const asst = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });

// One capture entry in the pre-compactEntry shape findMitigationGaps'
// caller (asCompact) accepts — same shape test/mitigation-output-form.test.mjs
// uses.
const entry = (n, inMsgs, outMsgs, extra = {}) => ({
  n,
  ts: `2026-07-30T00:00:${String(n).padStart(2, "0")}Z`,
  key: "k",
  inMsgs,
  outMsgs,
  action: null,
  resetReason: null,
  ...extra,
});

// --- red-first observation (recorded, not re-asserted): before the strip
// existed, this exact scenario ran through unpatched findMitigationGaps
// (outHash built from raw JSON.stringify(message), no cache_control strip)
// and returned outputForm: "edit@1", outputPreserved: false,
// rebilledOutBytes: 24 (the tail-only bytes) — the marker relocation read
// as a content splice. Observed by running this file against the
// pre-fix tree (git stash the outHashSem change, `node --test
// test/census-output-hash.test.mjs`): AssertionError, actual "edit@1" !==
// "append". That is the real defect this bite targets.

test("census output-hash: a cache_control-only relocation is not a splice (preserved)", () => {
  // message index 1 carries a cache_control breakpoint while it is the
  // tail in prevOut; curOut carries the SAME text at the same position
  // with no cache_control (the breakpoint moved off because the
  // conversation grew past it — the flap-probe's measured shape,
  // capture s-4b6a435234bf, n=678->681: identical 32,140-char text sent with
  // a cache_control block while tail, then as a bare string once it
  // wasn't) and one genuinely new message appended at the tail.
  const withMarker = {
    role: "user",
    content: [{ type: "text", text: "u1", cache_control: { type: "ephemeral", ttl: "1h" } }],
  };
  const withoutMarker = { role: "user", content: [{ type: "text", text: "u1" }] };

  const prevIn = [user("u0"), asst("a0"), user("u1")];
  const curIn = [user("u0"), asst("a0"), user("SPLICED"), user("u1")];
  const prevOut = [user("u0"), asst("a0"), withMarker];
  const curOut = [user("u0"), asst("a0"), withoutMarker, user("u2-new")];

  const rows = findMitigationGaps([
    entry(0, prevIn, prevOut, { action: "append-only" }),
    entry(1, curIn, curOut, { action: "normalized" }),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "splice/insert-mid", "input-side classification is unchanged");
  assert.equal(rows[0].outputForm, "append", "marker-only delta must not read as a splice/edit");
  assert.equal(rows[0].outputPreserved, true);
  assert.equal(rows[0].rebilledOutBytes, 0);
});

test("census output-hash: a real text delta beside a cache_control change is still caught", () => {
  // Same shape as above, but message index 1's TEXT also changes, not
  // just its cache_control. The checker must still fire — stripping
  // cache_control must not also blind it to a genuine edit riding
  // alongside one.
  const withMarker = {
    role: "user",
    content: [{ type: "text", text: "u1", cache_control: { type: "ephemeral", ttl: "1h" } }],
  };
  const editedNoMarker = { role: "user", content: [{ type: "text", text: "u1-EDITED" }] };

  const prevIn = [user("u0"), asst("a0"), user("u1")];
  const curIn = [user("u0"), asst("a0"), user("SPLICED"), user("u1")];
  const prevOut = [user("u0"), asst("a0"), withMarker];
  const curOut = [user("u0"), asst("a0"), editedNoMarker, user("u2-new")];

  const rows = findMitigationGaps([
    entry(0, prevIn, prevOut, { action: "append-only" }),
    entry(1, curIn, curOut, { action: "normalized" }),
  ]);

  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].outputForm, "append", "a genuine text edit must still be flagged");
  assert.equal(rows[0].outputPreserved, false);
  assert.ok(rows[0].rebilledOutBytes > 0);
});
