// Prune events: what a dropped message costs, and where the boundary sits.
//
// Definition, written before the assertions. A PRUNE is a same-conversation
// pair whose message count DECREASED. Its cost is positional — the API keys on
// the longest identical PREFIX — so the only question is where the prefix
// breaks relative to the LIVE TURN (the last human-typed message):
//
//   PURE-TAIL-PRUNE     nothing retained changed, or the first change sits at
//                       or after the live turn. The turn the user is producing
//                       is re-sent by every request anyway, so a prune
//                       confined to it invalidates nothing settled.
//   INTERIOR-DIVERGENT  the first change sits BEFORE the live turn: settled
//                       history moved and everything from there re-bills.
//   UNANCHORED          no human-typed message in the later array, so "live
//                       turn" has no referent and neither verdict is earned.
//
// The boundary is the anchor and NOT a distance, and that is the load-bearing
// choice: on the live corpus the same phenomenon (CC pruning a
// `[SUGGESTION MODE: …]` scaffolding block when the user actually types)
// produces live turns of one, two and three messages, and any
// message-count threshold splits identical events across the two verdicts.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyPrune } from "../tools/reminder-migration-census.mjs";

/** A human-typed turn: user role, plain text, no leading "<" tag. */
const human = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
/** A tool result: user role, never a human turn. */
const tool = (t) => ({ role: "user", content: [{ type: "tool_result", content: t }] });
const asst = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });
/** CC's injected scaffolding turn — tagged, so isHumanTurn rejects it. */
const suggestion = () => ({ role: "user", content: [{ type: "text", text: "<SUGGESTION MODE>" }] });

test("a drop whose retained prefix is byte-identical costs nothing", () => {
  const before = [human("start"), tool("a"), tool("b")];
  const after = [human("start"), tool("a")];
  const p = classifyPrune(before, after);
  assert.equal(p.kind, "PURE-TAIL-PRUNE");
  assert.equal(p.div, null, "no retained index differs at all");
  assert.equal(p.rebilled, 0);
});

test("scaffolding replaced by the real turn is a PURE tail prune", () => {
  // The row-22 shape: CC injected a suggestion block, the user typed, CC
  // pruned the block and the real message landed at the same index.
  const before = [human("start"), tool("a"), suggestion(), asst("suggested"), tool("s")];
  const after = [human("start"), tool("a"), human("what the user really typed")];
  const p = classifyPrune(before, after);
  assert.equal(p.kind, "PURE-TAIL-PRUNE");
  assert.equal(p.div, 2, "the break is at the live turn");
  assert.equal(p.anchor, 2);
});

test("the verdict does not depend on how long the live turn has grown", () => {
  // Measured pair of live events this pins: 2026-07-31 11:45:03 (live turn of
  // two messages) and 11:31:58 (three) are the same phenomenon, and a
  // "within N of the tail" threshold classifies them differently. The anchor
  // does not, so both must come back PURE.
  const before = [human("start"), tool("a"), suggestion(), asst("s1"), tool("s2"), asst("s3")];
  const short = [human("start"), tool("a"), human("typed"), asst("reply")];
  const long = [human("start"), tool("a"), human("typed"), asst("reply"), tool("r")];

  assert.equal(classifyPrune(before, short).kind, "PURE-TAIL-PRUNE");
  assert.equal(classifyPrune(before, long).kind, "PURE-TAIL-PRUNE");
  assert.equal(classifyPrune(before, short).rebilled, 2, "magnitude still reported");
  assert.equal(classifyPrune(before, long).rebilled, 3);
});

test("a change BEFORE the live turn is interior, and carries its magnitude", () => {
  const before = [human("start"), tool("a"), tool("b"), tool("c"), human("live")];
  const after = [human("start"), tool("CHANGED"), tool("c"), human("live")];
  const p = classifyPrune(before, after);
  assert.equal(p.kind, "INTERIOR-DIVERGENT");
  assert.equal(p.div, 1);
  assert.equal(p.anchor, 3);
  assert.equal(p.rebilled, 3, "everything from the break re-bills");
});

test("a drop with no human turn is UNANCHORED, not PURE by default", () => {
  // Answering PURE here would be a verdict without a basis: with no live turn
  // there is nothing to place the divergence against.
  const p = classifyPrune([tool("a"), tool("b"), tool("c")], [tool("a"), tool("ZZ")]);
  assert.equal(p.kind, "UNANCHORED");
  assert.equal(p.anchor, null);
});

test("only a shrinking array is a prune", () => {
  const a = [human("x"), tool("y")];
  assert.equal(classifyPrune(a, [...a, tool("z")]), null, "growth is not a prune");
  assert.equal(classifyPrune(a, [human("x"), tool("CHANGED")]), null, "equal length is not a prune");
});
