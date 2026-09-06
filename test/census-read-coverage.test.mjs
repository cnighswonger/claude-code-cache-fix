// The census's READ, as a coverage claim rather than a silent best effort.
//
// The defect these pin (measured 2026-07-31 over the live corpus): `census()`
// slurped every capture with readFileSync and swallowed the failure, so the
// four largest captures — 6.2 GB of 7.8 GB, 79% of the corpus by bytes — fell
// out of every verdict this "gate every NORMALIZATION must pass" ever
// produced, reported as "25 capture(s)" with no could-not-verify line.
//
// Two properties, and the split is deliberate. The MECHANISM (a read failure
// is named, never counted as zero findings) is what a fixture can pin, and it
// is what these tests assert. The SCALE trigger — a >512 MB capture, the
// RangeError itself — cannot live in a committed fixture at all: harvest
// curates for structural novelty, so the corpus is small by construction and
// blind along exactly that axis (dev-loop.md, "the corpus is blind along its
// own curation axis"). That half is verified by running the tool over the live
// captures, and only there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { census } from "../tools/reminder-migration-census.mjs";

const REM = (t) => `<system-reminder>\n${t}\n</system-reminder>`;

/** A host message: leading tool_result + trailing wrapped reminder blocks. */
const host = (id, reminders) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok" },
            ...reminders.map((t) => ({ type: "text", text: REM(t) }))],
});
const plain = (role, text) => ({ role, content: [{ type: "text", text }] });
const rec = (ts, messages) => JSON.stringify({ ts, body: { messages } });

function capture(lines) {
  const dir = mkdtempSync(join(tmpdir(), "census-read-"));
  const p = join(dir, "s-x-requests.jsonl");
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

test("a capture that cannot be read is NAMED, not counted as zero findings", async () => {
  const missing = join(tmpdir(), "census-read-does-not-exist", "s-nope-requests.jsonl");
  const r = await census([missing]);

  assert.equal(r.considered, 1, "the file must be counted in the denominator");
  assert.equal(r.unreadable.length, 1, "an unreadable capture is its own answer");
  assert.equal(r.unreadable[0].path, missing);
  assert.match(r.unreadable[0].error, /ENOENT|no such file/i, "the reason must survive");
  assert.equal(r.captures, 0, "an unread file cannot be counted as read");
});

test("an unreadable capture does not suppress the findings of a readable one", async () => {
  // A mixed run is the live shape: the verdict must carry BOTH the numbers it
  // measured and the population it could not measure. Reporting one without
  // the other is the absence-wearing-a-verdict's-clothes failure.
  const good = capture([
    rec("2026-07-31T10:00:00.000Z", [plain("user", "hi"), host("tu_1", ["R1"])]),
    rec("2026-07-31T10:00:10.000Z", [plain("user", "hi"), host("tu_1", []), plain("system", "R1")]),
  ]);
  const r = await census([join(tmpdir(), "nope", "gone.jsonl"), good]);

  assert.equal(r.considered, 2);
  assert.equal(r.unreadable.length, 1);
  assert.equal(r.tally.EXACT, 1, "the readable capture's migration is still measured");
  assert.equal(r.pairs, 1);
});

test("grouping stays per-conversation when the read is line by line", async () => {
  // Streaming the read must not silently become adjacent-line pairing: live
  // traffic interleaves tenants, so two requests of one conversation sit
  // several lines apart (dev-loop.md, "Never hand-roll identity in a probe").
  // Conversation A and B alternate; both pairs must be found, and no A/B
  // cross-pair may be.
  const a0 = plain("user", "conversation A");
  const b0 = plain("user", "conversation B");
  const p = capture([
    rec("2026-07-31T10:00:00.000Z", [a0, host("tu_a", ["RA"])]),
    rec("2026-07-31T10:00:01.000Z", [b0, host("tu_b", ["RB"])]),
    rec("2026-07-31T10:00:02.000Z", [a0, host("tu_a", []), plain("system", "RA")]),
    rec("2026-07-31T10:00:03.000Z", [b0, host("tu_b", []), plain("system", "RB")]),
  ]);
  const r = await census([p]);

  assert.equal(r.pairs, 2, "one pair per conversation, never four adjacent-line pairs");
  assert.equal(r.conversations, 2);
  assert.equal(r.tally.EXACT, 2);
  assert.equal(r.tally.MISMATCH, 0, "a cross-conversation pair would score as a rule failure");
});
