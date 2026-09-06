// Edit positions carry their STRUCTURAL context — where the edit sits
// relative to the last human-typed message.
//
// Why this is load-bearing and not decoration: row 4 sat "re-opened" with 15
// unexplained mid-history edits while the census could say WHAT changed and
// WHERE, but not WHY — the WHY required relating the position to conversation
// structure, and that relation lived in a throwaway matcher script until it
// produced the verdict (2026-07-29: 20 of 22 human-anchored mid-history edits
// within ±2 of the anchor — the CC#78660 reminder-anchoring mechanism). The
// throwaway probe is the tell that a check is missing; this is the check.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isHumanTurn, findEditPositions } from "../tools/replay.mjs";

const text = (t) => ({ type: "text", text: t });
const human = (t = "typed by a person") => ({ role: "user", content: [text(t)] });
const reminderMsg = (t = "<system-reminder>injected</system-reminder>") => ({
  role: "user",
  content: [text(t)],
});
const toolResultMsg = () => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }],
});
const asst = (t = "answer") => ({ role: "assistant", content: [text(t)] });

test("isHumanTurn: typed text yes; injections, tool_results, assistants no", () => {
  assert.equal(isHumanTurn(human()), true);
  assert.equal(isHumanTurn({ role: "user", content: "plain string" }), true);
  assert.equal(isHumanTurn({ role: "user", content: "<local-command-stdout>x</local-command-stdout>" }), false);
  assert.equal(isHumanTurn(reminderMsg()), false);
  assert.equal(isHumanTurn(toolResultMsg()), false);
  assert.equal(isHumanTurn(asst()), false);
  // tool_result carrying an injected reminder block is still not a human turn
  assert.equal(
    isHumanTurn({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }, text("<system-reminder>note</system-reminder>")],
    }),
    false,
  );
});

test("BITE — a mid-history edit is annotated with its distance from the human anchor", () => {
  // History: [human, asst, human, asst, reminder-carrier, asst] — last human
  // turn at index 2. The reminder-carrier at index 4 gets re-stamped between
  // requests: anchorDelta must read +2 (the injected-block zone).
  const base = [human("q1"), asst("a1"), human("q2"), asst("a2"), reminderMsg("<system-reminder>v1</system-reminder>"), asst("a3")];
  const edited = base.slice();
  edited[4] = reminderMsg("<system-reminder>v2 — re-stamped</system-reminder>");
  const entry = (msgs, n) => ({ n, ts: "t", key: "k", inMsgs: msgs, outMsgs: msgs, inTools: [], outTools: [] });
  const rows = findEditPositions([entry(base, 0), entry(edited, 1)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].at, 4);
  assert.equal(rows[0].lastHumanAt, 2);
  assert.equal(rows[0].anchorDelta, 2, "edit position relative to the anchor is the causal signal");
});

test("a conversation with no human turn reports anchorDelta null, never a guess", () => {
  // Subagent shape: briefing arrives as an injected block, so no human turn
  // exists under the filter — 11 of 33 mid-history edits in the verifying
  // corpus were this shape, and they must be reported as unanchored rather
  // than matched against an invented index.
  const base = [reminderMsg("<briefing>do the thing</briefing>"), asst("a1"), reminderMsg(), asst("a2")];
  const edited = base.slice();
  edited[2] = reminderMsg("<system-reminder>changed</system-reminder>");
  const entry = (msgs, n) => ({ n, ts: "t", key: "k", inMsgs: msgs, outMsgs: msgs, inTools: [], outTools: [] });
  const rows = findEditPositions([entry(base, 0), entry(edited, 1)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lastHumanAt, null);
  assert.equal(rows[0].anchorDelta, null);
});

test("excerptMessage: local evidence line — text flattened, blocks named, capped", async () => {
  const { excerptMessage } = await import("../tools/replay.mjs");
  assert.equal(
    excerptMessage({ role: "user", content: [text("<system-reminder>\nnote\n</system-reminder>")] }),
    "user: <system-reminder> note </system-reminder>",
  );
  assert.equal(
    excerptMessage({ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "r" }] }),
    "user: [tool_result]",
  );
  const long = excerptMessage({ role: "user", content: "x".repeat(500) });
  assert.ok(long.length < 200 && long.endsWith("…"));
  assert.equal(excerptMessage(null), "(missing)");
});

// --- Succession classification: the cross-conversation blind spot, closed ---
import { findSuccessions } from "../tools/replay.mjs";

test("successions: compaction, resume and fork shapes classified; pricing carried", () => {
  const m = (t) => ({ role: "user", content: [text(t)] });
  const conv = (msgs, n) => ({ n, ts: "t", key: "k", inMsgs: msgs, outMsgs: msgs, inTools: [], outTools: [] });
  const a = [m("A0"), asst("a"), m("A2"), asst("b"), m("A4"), asst("c"), m("A6"), asst("d")];
  // resume-shaped: new head, deep opener, most bodies shared with predecessor
  const resumed = [m("A0-changed-head"), ...a.slice(1)];
  const rows = findSuccessions([conv(a, 0), conv(resumed, 1)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "resume-shaped");
  assert.ok(rows[0].shared >= 6);
  assert.ok(rows[0].rebilledBytes > 0, "a succession re-bills its whole opener");
  // compaction: tiny opener
  const compacted = [m("summary"), asst("ack")];
  assert.equal(findSuccessions([conv(a, 0), conv(compacted, 1)])[0].kind, "compaction/new-thread");
  // fork/other: deep opener, low overlap
  const fork = [m("F0"), m("F1"), asst("x"), m("F3"), asst("y"), m("F5"), asst("z")];
  assert.equal(findSuccessions([conv(a, 0), conv(fork, 1)])[0].kind, "fork/other");
});

test("BITE — sidecar interleaving is NOT a succession: a returning conversation reports nothing", () => {
  // Hundreds of sidecar switches per busy capture are the co-tenant normal;
  // classifying them as boundaries would fire on every switch and train the
  // reader to ignore the class — the check-fires-on-non-defect failure.
  const m = (t) => ({ role: "user", content: [text(t)] });
  const conv = (msgs, n) => ({ n, ts: "t", key: "k", inMsgs: msgs, outMsgs: msgs, inTools: [], outTools: [] });
  const mainA = [m("MAIN"), asst("a")];
  const side = [m("SIDECAR"), asst("s")];
  const mainB = [m("MAIN"), asst("a"), m("more"), asst("b")];
  const rows = findSuccessions([conv(mainA, 0), conv(side, 1), conv(mainB, 2)]);
  // main -> side is not a succession (main returns at n=2), and side -> main
  // is not one either: the sidecar ends but main CONTINUES — it opened at
  // n=0, so nothing new starts at n=2. First drafts of this test asserted
  // that handback as a succession; requiring the successor's FIRST
  // appearance is what keeps one-shot sidecars from minting phantoms.
  assert.equal(rows.length, 0);
});
