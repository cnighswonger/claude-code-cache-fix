// blockMigration — the reminder-swap shape self-identifies.
//
// The census reduces messages to semantic hashes and, for a
// system-reminder-wrapped text block, drops it outright as decoration
// (semanticCore's isVolatileTextBlock) — correct when the reminder really is
// noise, and exactly what makes the census blind to the case where the same
// bytes are NOT noise: they leave one message's content array and reappear
// as a message of their own (measured directly in capture
// s-4b6a435234bf, n=26->28, message[30]'s 5th block
// -> the new message[31]). blockMigration is the check for that shape; see
// tools/replay.mjs for the DEFINITION comment above findBlockMigrations.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findBlockMigrations } from "../tools/replay.mjs";

const text = (t) => ({ type: "text", text: t });
const human = (t) => ({ role: "user", content: [text(t)] });
const asst = (t) => ({ role: "assistant", content: [text(t)] });

// One capture entry as the replay loop builds it — same shape the other
// replay tests (replay-edit-anchor.test.mjs, replay-gate-selfcheck.test.mjs)
// pass to the checker functions, so findBlockMigrations's own asCompact call
// exercises the same compactEntry path production traffic goes through.
const conv = (msgs, n) => ({ n, ts: `t${n}`, key: "k", inMsgs: msgs, outMsgs: msgs, inTools: [], outTools: [] });

const REMINDER = "<system-reminder>\nPreToolUse:Edit hook additional context: do the thing\n</system-reminder>";
const INNER = "PreToolUse:Edit hook additional context: do the thing";

test("BITE — a hook reminder detaching from its host message into a standalone message is annotated inline->standalone", () => {
  // Real shape: a user message carries a tool-output block AND a
  // <system-reminder>-wrapped block; the next request drops the wrapped
  // block from that message and adds a new standalone system message
  // carrying the SAME bytes, wrapper stripped — exactly what
  // PreToolUse:Edit's hook context does on the wire.
  const prev = [human("q1"), asst("a1"), { role: "user", content: [text("tool output"), text(REMINDER)] }, asst("a2")];
  const cur = [
    human("q1"),
    asst("a1"),
    { role: "user", content: [text("tool output")] },
    { role: "system", content: INNER },
    asst("a2"),
  ];
  const rows = findBlockMigrations([conv(prev, 0), conv(cur, 1)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, "inline->standalone");
  assert.equal(rows[0].sourceIdx, 2, "the block's index in the message array where it was embedded");
  assert.equal(rows[0].targetIdx, 3, "the index of the new standalone message carrying the same bytes");
  assert.equal(rows[0].n, 1);
  assert.equal(rows[0].prevN, 0);
});

test("fires-on-non-defect guard: a genuinely NOVEL inserted message is not annotated", () => {
  // Same splice/insert-mid shape (a new message lands mid-history, later
  // messages shift by one) but the inserted content has no counterpart
  // anywhere in the predecessor — nothing migrated, something new arrived.
  // A detector that fires here would train its reader to ignore the class.
  const prev = [human("q1"), asst("a1"), { role: "user", content: [text("tool output")] }, asst("a2")];
  const cur = [
    human("q1"),
    asst("a1"),
    { role: "user", content: [text("tool output")] },
    { role: "system", content: "totally novel content with no counterpart in prev, never existed before" },
    asst("a2"),
  ];
  const rows = findBlockMigrations([conv(prev, 0), conv(cur, 1)]);
  assert.equal(rows.length, 0);
});

test("a block still present at the SAME position on the other side is not a migration", () => {
  // Sanity companion to the guard above: the reminder block is untouched,
  // sitting at the identical index on both sides — an unrelated insertion
  // elsewhere forces the pair to splice/insert-mid so the scan actually
  // runs; asserting 0 here would be trivial if the pair were "identical"
  // (skipped by the kind filter before the scan ever executes).
  const reminderMsg = { role: "user", content: [text("tool output"), text(REMINDER)] };
  const prev = [human("q1"), asst("a1"), reminderMsg, asst("a2")];
  const cur = [
    human("q1"),
    asst("a1"),
    reminderMsg,
    { role: "system", content: "unrelated novel content, forces splice/insert-mid" },
    asst("a2"),
  ];
  const rows = findBlockMigrations([conv(prev, 0), conv(cur, 1)]);
  assert.equal(rows.length, 0);
});
