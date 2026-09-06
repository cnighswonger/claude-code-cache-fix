// bust-triage must see every event the statusline shows.
//
// Definition, taken from the statusline rather than from this tool: the ❄
// token advances on TWO paths in `claude-worktime` — `cold_hit`, written as
// k:"hit", and `cold_cost`, written as k:"cost" (plus legacy k:"resume"
// records, which its own `--cold --all` filter still lists). So the
// ❄-visible population is {hit, cost, resume}, and anything in it that
// `--list` cannot show is a blind spot by construction.
//
// The incident, 2026-07-31 ~13:53Z: the statusline showed `❄ 55k compact (8m)`
// (ledger k:"cost", t=1785505434) while `--list` showed nothing newer than
// 12:25 and the default run triaged an older, unrelated event without saying
// so. A controlled cost is not triageable — that is an ANSWER, and the
// three-answer rule is that it must be stated, never expressed as silence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { coldEvents, busts, listRows, fallbackNote } from "../tools/bust-triage.mjs";

function ledger(records) {
  const d = mkdtempSync(join(tmpdir(), "bt-controlled-"));
  const p = join(d, "activity.jsonl");
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

const HIT = { type: "cold", k: "hit", t: 1000, s: "S1", cc: 40000, cause: "messages_changed" };
const COST = { type: "cold", k: "cost", t: 2000, s: "S2", cc: 55000, cause: "compact" };
const RESUME = { type: "cold", k: "resume", t: 1500, s: "S3", cc: 51000,
                 cause: "previous_message_not_found" };

test("a controlled cost event is in the ledger read, classified apart from busts", () => {
  const events = coldEvents(ledger([HIT, RESUME, COST]));
  assert.deepEqual(events.map((e) => e.t), [2000, 1500, 1000], "newest first");
  assert.deepEqual(events.map((e) => e.cls), ["controlled", "controlled", "bust"]);
});

test("busts() still means busts — the triageable population is unchanged", () => {
  const b = busts(ledger([HIT, RESUME, COST]));
  assert.equal(b.length, 1);
  assert.equal(b[0].t, 1000);
});

test("BITE — a ❄-visible controlled event can never be absent from --list", () => {
  const rows = listRows(coldEvents(ledger([HIT, COST])));
  assert.equal(rows.length, 2, "both events listed");
  assert.ok(rows[0].includes("CONTROLLED(compact)"), `controlled label missing: ${rows[0]}`);
  assert.ok(rows[1].includes("messages_changed"), "the bust keeps its bare cause");
  assert.ok(!rows[1].includes("CONTROLLED"), "a bust must not be labelled controlled");
});

test("legacy k:\"resume\" records are listed too — the statusline counts them", () => {
  const rows = listRows(coldEvents(ledger([RESUME])));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].includes("CONTROLLED(previous_message_not_found)"));
});

test("BITE — when the newest event is controlled, the default run says so", () => {
  const note = fallbackNote(coldEvents(ledger([HIT, COST])));
  assert.ok(note.length, "silence is not an answer");
  const text = note.join("\n");
  assert.match(text, /Cannot triage/i, "the non-verdict must be stated as one");
  assert.match(text, /CONTROLLED\(compact\)/);
  assert.match(text, /Falling back/i, "and it must name what it triaged instead");
});

test("no note when the newest event IS a bust — the tool is not chatty", () => {
  // A note on every run is a note nobody reads; it fires only on substitution.
  const newerHit = { ...HIT, t: 3000 };
  assert.deepEqual(fallbackNote(coldEvents(ledger([newerHit, COST]))), []);
});

test("a controlled ledger with no busts at all still reports the event", () => {
  const events = coldEvents(ledger([COST]));
  assert.equal(events.length, 1);
  const text = fallbackNote(events).join("\n");
  assert.match(text, /No bust in the ledger to fall back to/i);
});

test("retraction and cause-upgrade markers are not themselves events", () => {
  // hit-retract / hit-cause are bookkeeping, never ❄ tokens of their own.
  const events = coldEvents(ledger([
    HIT,
    { type: "cold", k: "hit-cause", hit_t: 1000, s: "S1", cause: "tools_changed" },
    { type: "cold", k: "hit", t: 1200, s: "S1", cc: 9000, cause: "idle" },
    { type: "cold", k: "hit-retract", hit_t: 1200, s: "S1" },
    { type: "cold", k: "gauge", t: 1300, s: "S1", met: 0 },
    { type: "cold", k: "warn", t: 1400, s: "S1", gap: 90 },
  ]));
  assert.equal(events.length, 1, "one surviving event");
  assert.equal(events[0].cause, "tools_changed", "the late-bound cause wins");
});
