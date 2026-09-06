// EXTENDED is two different phenomena, and only one of them is new information.
//
// Definition, written before the assertions (dev-loop.md, "Adding a check"):
// an EXTENDED finding is one where CC's later standalone message carries the
// canonical reconstruction as a strict PREFIX. Its remainder — everything
// after that prefix, with the joining "\n\n" removed — is
//
//   MERGED-STANDALONE  byte-identical to the text of a standalone role:"system"
//                      message the BEFORE request ALREADY carried. CC merged an
//                      existing message into the migrated one; nothing new
//                      crossed the wire, so the later form is computable from
//                      the predecessor alone.
//   NEW-TEXT           matches no such message: content that did not exist at
//                      the earlier request.
//
// The distinction is what decides a mitigation, and it was hand-derived once
// already (docs/code-reviews/extended-absorb-report.md §b1: 9 of 9 EXTENDED
// occurrences in the readable corpus were merged standalones, 0 genuinely new
// text) — a hand-classification the tool did not carry, so the next session
// would have re-derived it.
//
// Fixtures are synthetic because a unit test wants a minimal pair it fully
// controls — not because the class cannot be harvested. It can, as of bffcb05
// (same day): the scrub is a "\n\n"-homomorphism now, so the prefix/join
// relation that DEFINES this class survives sanitization. Executed against the
// shipped `scrubMessage` rather than read from its diff — scrub(a+"\n\n"+b)
// === scrub(a)+"\n\n"+scrub(b), and this file's own `subclassifyExtended`
// returns MERGED-STANDALONE on the scrubbed bytes. An earlier revision of this
// comment said the opposite, from report §c5, which was true when it was
// written and had already been fixed when this landed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { census } from "../tools/reminder-migration-census.mjs";

const REM = (t) => `<system-reminder>\n${t}\n</system-reminder>`;
const host = (id, reminders) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok" },
            ...reminders.map((t) => ({ type: "text", text: REM(t) }))],
});
const plain = (role, text) => ({ role, content: [{ type: "text", text }] });
const rec = (ts, messages) => JSON.stringify({ ts, body: { messages } });

/** One capture holding exactly one same-conversation pair. */
async function pairCensus(beforeMsgs, afterMsgs) {
  const dir = mkdtempSync(join(tmpdir(), "census-ext-"));
  const p = join(dir, "s-x-requests.jsonl");
  writeFileSync(p, [rec("2026-07-31T10:00:00.000Z", beforeMsgs),
                    rec("2026-07-31T10:00:05.000Z", afterMsgs)].join("\n") + "\n");
  return census([p]);
}

const anchor = plain("user", "the conversation's first message");

test("EXTENDED whose remainder the predecessor already sent is MERGED-STANDALONE", async () => {
  const r = await pairCensus(
    [anchor, host("tu_1", ["R1"]), plain("system", "S1")],
    [anchor, host("tu_1", []), plain("system", "R1\n\nS1")],
  );
  assert.equal(r.tally.EXTENDED, 1);
  const d = r.details.find((x) => x.verdict === "EXTENDED");
  assert.equal(d.sub, "MERGED-STANDALONE");
});

test("EXTENDED whose remainder is nowhere in the predecessor is NEW-TEXT", async () => {
  const r = await pairCensus(
    [anchor, host("tu_1", ["R1"])],
    [anchor, host("tu_1", []), plain("system", "R1\n\nnever sent before")],
  );
  assert.equal(r.tally.EXTENDED, 1);
  const d = r.details.find((x) => x.verdict === "EXTENDED");
  assert.equal(d.sub, "NEW-TEXT");
});

test("a remainder that only the LATER request carries is NEW-TEXT, not merged", async () => {
  // The absorbable claim is about information the predecessor ALREADY sent.
  // Matching against the after request's own standalones would make every
  // merge trivially true — the message being classified is one of them.
  const r = await pairCensus(
    [anchor, host("tu_1", ["R1"])],
    [anchor, host("tu_1", []), plain("system", "R1\n\nS-late"), plain("system", "S-late")],
  );
  const d = r.details.find((x) => x.verdict === "EXTENDED");
  assert.equal(d.sub, "NEW-TEXT");
});

test("an EXACT migration carries no sub-verdict", async () => {
  // The annotation belongs to EXTENDED alone; a sub-verdict on an EXACT row
  // would put a second, unearned claim into the absorbable population.
  const r = await pairCensus(
    [anchor, host("tu_1", ["R1"])],
    [anchor, host("tu_1", []), plain("system", "R1")],
  );
  assert.equal(r.tally.EXACT, 1);
  assert.equal(r.details[0].sub, null);
});
