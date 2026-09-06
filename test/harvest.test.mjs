// harvest — sanitization and selection tests.
//
// The harvester exists because live captures are transient (677 MB/day
// against a 2 GB oldest-first cap, ~3 days retention) while ~95% of what
// they contain is structurally uninteresting. It keeps the novel ~5% as
// committable fixtures.
//
// Two properties have to hold or the tool is worse than useless:
//   - sanitization must remove real conversation content, because the output
//     is committed to a repo;
//   - it must remove it DETERMINISTICALLY, because identity matching across
//     requests is precisely what the fixtures test — a random placeholder
//     would destroy the structure being preserved.

import { test } from "node:test";
import assert from "node:assert/strict";

import { scrubMessage, scrubRecord, selectNovelPairs } from "../tools/harvest.mjs";

test("scrub: real text is replaced, and the same text always yields the same token", () => {
  const secret = "the operator's actual prompt about their private project";
  const a = scrubMessage({ role: "user", content: [{ type: "text", text: secret }] });
  const b = scrubMessage({ role: "user", content: [{ type: "text", text: secret }] });
  assert.equal(a.content[0].text, b.content[0].text, "deterministic — identity must survive scrubbing");
  assert.ok(!a.content[0].text.includes("operator"), "no source text leaks");
  assert.ok(a.content[0].text.startsWith("t_"));
});

test("scrub: different text yields different tokens", () => {
  const a = scrubMessage({ role: "user", content: "alpha" });
  const b = scrubMessage({ role: "user", content: "beta" });
  assert.notEqual(a.content, b.content);
});

test("scrub: system-reminder wrappers survive — the wrapper IS the class", () => {
  // The volatile-block detector matches on this wrapper. Scrubbing it away
  // would erase the property the flip/pin fixtures exist to exercise.
  const m = scrubMessage({
    role: "user",
    content: [{ type: "text", text: "<system-reminder>\nsecret detail\n</system-reminder>" }],
  });
  assert.match(m.content[0].text, /^<system-reminder>\n/);
  assert.ok(!m.content[0].text.includes("secret detail"));
});

test("scrub: message SHAPE is preserved exactly", () => {
  // Structure is the payload. Block count, types and order must be untouched
  // or every census class the fixture encodes is destroyed.
  const m = scrubMessage({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "output" },
      { type: "text", text: "note" },
    ],
  });
  assert.equal(m.role, "user");
  assert.equal(m.content.length, 2);
  assert.equal(m.content[0].type, "tool_result");
  assert.equal(m.content[0].tool_use_id, "t1", "structural ids must not be rewritten");
  assert.equal(m.content[1].type, "text");
});

test("scrub: string-content messages stay string-content", () => {
  // The shape flip (single text block <-> bare string) is itself a class;
  // normalizing shapes during scrubbing would hide it.
  const m = scrubMessage({ role: "system", content: "a harness note" });
  assert.equal(typeof m.content, "string");
});

test("scrub: thinking signatures and tool inputs are redacted", () => {
  const m = scrubMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning", signature: "AAAA-real-signature" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat ~/.ssh/id_rsa" } },
    ],
  });
  assert.ok(!JSON.stringify(m).includes("private reasoning"));
  assert.ok(!JSON.stringify(m).includes("id_rsa"));
  assert.equal(m.content[1].id, "t1", "tool ids stay — adjacency depends on them");
  assert.deepEqual(Object.keys(m.content[1].input), ["command"], "input SHAPE is kept");
});

test("scrub: record drops tool schemas but keeps tool names", () => {
  // tools[] add/remove/reorder is a real bust class, so names matter;
  // descriptions and parameter docs are content and do not.
  const rec = scrubRecord({
    ts: "2026-07-28T00:00:00Z",
    sid: "real-session-id",
    key: "s-real-session-id",
    headers: { "anthropic-beta": "context-management-2025-06-27", "session-id": "real-session-id" },
    body: {
      model: "claude-opus-5",
      tools: [{ name: "Bash", description: "runs shell commands", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hello" }],
    },
  });
  assert.deepEqual(rec.body.tools, [{ name: "Bash" }]);
  assert.ok(!JSON.stringify(rec).includes("real-session-id"), "session ids are hashed");
  assert.equal(rec.headers["anthropic-beta"], "context-management-2025-06-27", "betas are structural");
});

test("select: boring pairs are never harvested", () => {
  const msg = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
  const rec = (msgs) => ({ body: { messages: msgs } });
  const base = [msg("u0"), msg("u1")];
  const records = [rec(base), rec([...base, msg("u2")])]; // pure append
  assert.equal(selectNovelPairs(records, new Set()).length, 0);
});

test("select: a class already banked is not harvested twice", () => {
  const msg = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
  const rec = (msgs) => ({ body: { messages: msgs } });
  const a = [msg("u0"), msg("u1"), msg("u2")];
  const b = [msg("u0"), msg("u1"), msg("EDITED")];
  const records = [rec(a), rec(b)];
  assert.equal(selectNovelPairs(records, new Set()).length, 1, "novel the first time");
  assert.equal(selectNovelPairs(records, new Set(["replace/edit"])).length, 0, "not the second");
});

test("select: pairs are formed within a conversation, never across tenants", () => {
  // Co-tenant traffic shares a capture file. Comparing a subagent's request
  // against the main thread's is the sidecar-churn artifact, not a finding.
  const msg = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
  const rec = (msgs) => ({ body: { messages: msgs } });
  const records = [
    rec([msg("convA"), msg("a1")]),
    rec([msg("convB-entirely-different"), msg("b1")]),
    rec([msg("convA"), msg("a1"), msg("a2")]), // append within A
  ];
  assert.equal(selectNovelPairs(records, new Set()).length, 0, "A->B and B->A are not pairs");
});

// --- Shape watch: the dormant thinking classes must not reactivate unseen ---

import { scanCapture, completedThinkingTextCount, thinkingCountInPrefix } from "../tools/harvest.mjs";
import { writeFile as wf, mkdtemp as mkd, rm as rmr } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

const think = (text) => ({ type: "thinking", thinking: text, signature: "SIG==" });
const req = (msgs, extra = {}) => JSON.stringify({ ts: "t", body: { model: "m", messages: msgs, system: [{ type: "text", text: "sys" }], tools: [], ...extra } });

test("completedThinkingTextCount: stubs are not population; active continuations are exempt", () => {
  const stubOnly = [{ role: "assistant", content: [think(""), { type: "text", text: "done" }] }];
  assert.equal(completedThinkingTextCount(stubOnly), 0, "signature-only stubs are the measured-normal state");
  const fat = [{ role: "assistant", content: [think("real reasoning"), { type: "text", text: "done" }] }];
  assert.equal(completedThinkingTextCount(fat), 1);
  const continuation = [
    { role: "assistant", content: [think("real"), { type: "tool_use", id: "t1", name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] },
  ];
  assert.equal(completedThinkingTextCount(continuation), 0, "protected-by-contract thinking is not droppable population");
});

test("BITE — a capture where completed-turn thinking text reappears sets the shape counters", async () => {
  const dir = await mkd(pjoin(tmpdir(), "harvest-shape-"));
  const cap = pjoin(dir, "s-x-requests.jsonl");
  const u = { role: "user", content: [{ type: "text", text: "q" }] };
  const fatTurn = { role: "assistant", content: [think("REAL TEXT — the dormant population"), { type: "text", text: "a" }] };
  try {
    // Pair 2 also DROPS a thinking block from shared history (76253 shape):
    const msgs1 = [u, fatTurn];
    const msgs2 = [u, { role: "assistant", content: [{ type: "text", text: "a" }] }, { role: "user", content: [{ type: "text", text: "next" }] }];
    await wf(cap, req(msgs1) + "\n" + req(msgs2) + "\n");
    const { shape } = await scanCapture(cap, new Set());
    assert.equal(shape.pairs, 1);
    assert.equal(shape.thinkingDropPairs, 1, "the 76253 shape must be counted");
    assert.ok(shape.systemBytes > 0, "baseline prefix size recorded");
    // Population lives in the NEWEST request per conversation; msgs2 has no
    // fat thinking left, so the counter reads 0 here...
    assert.equal(shape.thinkingTextCompleted, 0);
    // ...and reads 1 when the newest request still carries it.
    await wf(cap, req(msgs1) + "\n");
    const again = await scanCapture(cap, new Set());
    assert.equal(again.shape.thinkingTextCompleted, 1, "the 69568 population must be counted when present");
  } finally {
    await rmr(dir, { recursive: true, force: true });
  }
});

// --- Growth-step snapshots: the evidence must outlive capture rotation ---

import { detectGrowthSteps, growthComponentSnapshot, GROWTH_STEP_FLOOR } from "../tools/harvest.mjs";

test("BITE — a +15% baseline step is detected; floor and shrinkage are not", () => {
  const prior = { systemBytes: 20000, toolsBytes: 40000 };
  const grown = { systemBytes: 38800, toolsBytes: 40000 };
  assert.deepEqual(detectGrowthSteps(prior, grown), [
    { field: "systemBytes", oldBytes: 20000, newBytes: 38800 },
  ]);
  assert.deepEqual(detectGrowthSteps(prior, { systemBytes: 21000, toolsBytes: 40000 }), [],
    "below threshold is not a step");
  assert.deepEqual(detectGrowthSteps(prior, { systemBytes: 9000, toolsBytes: 40000 }), [],
    "shrinkage is visible intent, never a step");
  assert.deepEqual(detectGrowthSteps({ systemBytes: 100 }, { systemBytes: 400 }), [],
    `percentages on values under the ${GROWTH_STEP_FLOOR}-byte floor are noise`);
  assert.deepEqual(detectGrowthSteps(undefined, grown), [], "no prior shape, no comparison");
});

test("growthComponentSnapshot: identity and sizes survive, content does not", () => {
  const secret = "the operator's private system prompt about their client project";
  const body = {
    system: [{ type: "text", text: secret }],
    tools: [{ name: "Bash", description: "secret tool description with paths", input_schema: { x: 1 } }],
  };
  const snap = growthComponentSnapshot(body);
  const raw = JSON.stringify(snap);
  assert.ok(!raw.includes("private") && !raw.includes("client") && !raw.includes("paths"),
    "no source content may reach a committable artifact");
  assert.equal(snap.tools[0].name, "Bash", "identity survives");
  assert.ok(snap.tools[0].bytes > 50, "per-item size survives — the attribution signal");
  assert.ok(snap.system[0].bytes > secret.length, "block size reflects the real serialization");
});
