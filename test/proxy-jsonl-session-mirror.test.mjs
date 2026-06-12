import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ext, { _resetSessionState } from "../proxy/extensions/jsonl-session-mirror.mjs";

let tmpDir;

beforeEach(() => {
  _resetSessionState();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  tmpDir = mkdtempSync(join(tmpdir(), "mirror-ext-test-"));
  process.env.CACHE_FIX_SESSION_MIRROR_DIR = tmpDir;
  process.env.CACHE_FIX_SESSION_MIRROR_EVENT_LOG = join(tmpDir, "session-mirror-events.jsonl");
  process.env.CACHE_FIX_SESSION_MIRROR = "on";
  delete process.env.CACHE_FIX_SESSION_MIRROR_INCLUDE_THINKING;
  delete process.env.CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS;
});

function ctxFor({ body, sessionId = "sess-aaa", route = "messages" } = {}) {
  return {
    body,
    headers: sessionId ? { "x-claude-code-session-id": sessionId } : {},
    responseHeaders: {},
    meta: { route },
  };
}

function streamCtx({ event, meta, headers = {}, responseHeaders = {} }) {
  return { event, meta, headers, responseHeaders };
}

function readSessionRecords(sessionDirName) {
  const dir = join(tmpDir, sessionDirName);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const all = [];
  for (const f of files) {
    const content = readFileSync(join(dir, f), "utf8");
    for (const line of content.split("\n")) {
      if (line.trim()) all.push(JSON.parse(line));
    }
  }
  return all;
}

// Helper: drive a full streamed assistant message through the extension.
async function streamAssistantMessage(ext, requestCtx, sessionId, {
  messageId = "msg_synth",
  model = "claude-opus-4-7",
  text = "ok",
  startUsage = { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  deltaUsage = { output_tokens: 1 },
  stopReason = "end_turn",
} = {}) {
  const meta = requestCtx.meta;
  await ext.onStreamEvent(streamCtx({
    event: { type: "message_start", message: { id: messageId, role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: startUsage } },
    meta,
    responseHeaders: { "request-id": `req_${messageId}` },
  }));
  await ext.onStreamEvent(streamCtx({
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    meta,
  }));
  await ext.onStreamEvent(streamCtx({
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    meta,
  }));
  await ext.onStreamEvent(streamCtx({
    event: { type: "content_block_stop", index: 0 },
    meta,
  }));
  await ext.onStreamEvent(streamCtx({
    event: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: deltaUsage },
    meta,
  }));
  await ext.onStreamEvent(streamCtx({
    event: { type: "message_stop" },
    meta,
  }));
}

function userTextMsg(text, opts = {}) {
  return { role: "user", content: text, ...opts };
}

function userBlocks(blocks, opts = {}) {
  return { role: "user", content: blocks, ...opts };
}

function assistantTextMsg(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

// =============================================================================
// Basic single-turn — produces 1 user + 1 assistant record
// =============================================================================

test("single turn: request with one user message + streamed assistant → 2 records", async () => {
  const sessionId = "sess-single";
  const body = {
    model: "claude-opus-4-7",
    messages: [userTextMsg("hello")],
  };
  const reqCtx = ctxFor({ body, sessionId });
  await ext.onRequest(reqCtx);
  await streamAssistantMessage(ext, reqCtx, sessionId, { messageId: "msg_1", text: "hi back" });

  const records = readSessionRecords(sessionId);
  assert.equal(records.length, 2, `expected 2 records; got ${records.length}`);
  assert.equal(records[0].type, "user");
  assert.equal(records[1].type, "assistant");
});

// =============================================================================
// 3-turn replay (directive's load-bearing acceptance test)
// =============================================================================

test("3-turn replay: produces exactly 3 user + 3 assistant records (the directive's dedup acceptance)", async () => {
  const sessionId = "sess-3turn";
  const turn1 = { model: "claude-opus-4-7", messages: [userTextMsg("u1")] };
  const turn2 = { model: "claude-opus-4-7", messages: [userTextMsg("u1"), assistantTextMsg("a1"), userTextMsg("u2")] };
  const turn3 = {
    model: "claude-opus-4-7",
    messages: [userTextMsg("u1"), assistantTextMsg("a1"), userTextMsg("u2"), assistantTextMsg("a2"), userTextMsg("u3")],
  };

  for (const [i, body] of [turn1, turn2, turn3].entries()) {
    const reqCtx = ctxFor({ body, sessionId });
    await ext.onRequest(reqCtx);
    await streamAssistantMessage(ext, reqCtx, sessionId, { messageId: `msg_${i + 1}`, text: `a${i + 1}` });
  }

  const records = readSessionRecords(sessionId);
  const users = records.filter((r) => r.type === "user");
  const assistants = records.filter((r) => r.type === "assistant");
  assert.equal(users.length, 3, "expected 3 user records (one per turn), not 4 or 5");
  assert.equal(assistants.length, 3);
});

// =============================================================================
// Failed-request re-stage — turn 3 fails before message_stop → state unchanged
// → turn 4 retry re-stages and the records appear exactly once
// =============================================================================

test("failed-request re-stage: turn fails before message_stop → state preserved → retry mirrors exactly once", async () => {
  const sessionId = "sess-retry";
  const turn1 = { model: "claude-opus-4-7", messages: [userTextMsg("u1")] };
  const turn2 = { model: "claude-opus-4-7", messages: [userTextMsg("u1"), assistantTextMsg("a1"), userTextMsg("u2")] };

  // Turn 1: success
  const r1 = ctxFor({ body: turn1, sessionId });
  await ext.onRequest(r1);
  await streamAssistantMessage(ext, r1, sessionId, { messageId: "msg_1", text: "a1" });

  // Turn 2: stages but never reaches message_stop (upstream 529).
  const r2 = ctxFor({ body: turn2, sessionId });
  await ext.onRequest(r2);
  // No stream events — request aborted. Just garbage-collect r2.

  // Snapshot: only turn-1 records should be on disk.
  let records = readSessionRecords(sessionId);
  assert.equal(records.filter((r) => r.type === "user").length, 1);
  assert.equal(records.filter((r) => r.type === "assistant").length, 1);

  // Turn 2 retry: same body
  const r2retry = ctxFor({ body: turn2, sessionId });
  await ext.onRequest(r2retry);
  await streamAssistantMessage(ext, r2retry, sessionId, { messageId: "msg_2", text: "a2" });

  records = readSessionRecords(sessionId);
  const users = records.filter((r) => r.type === "user");
  const assistants = records.filter((r) => r.type === "assistant");
  // No duplicates: u1 mirrored once (turn 1), u2 mirrored once (turn 2 retry).
  // 2 assistants: turn-1's a1 (already mirrored) + turn-2 retry's a2.
  assert.equal(users.length, 2, "u1 + u2 exactly once each — no record loss + no duplicates");
  assert.equal(assistants.length, 2, "turn-1's a1 + turn-2 retry's a2 (no extra from the failed-turn attempt)");
});

// =============================================================================
// Legitimately-repeated user text — directive's position-based design choice
// =============================================================================

test("legitimately-repeated user text 'yes' at turns 2 and 9 produces two distinct mirror records", async () => {
  const sessionId = "sess-repeats";

  // Turn 1: "yes" not yet sent
  let prevMessages = [userTextMsg("first prompt")];
  let reqCtx = ctxFor({ body: { model: "claude-opus-4-7", messages: prevMessages }, sessionId });
  await ext.onRequest(reqCtx);
  await streamAssistantMessage(ext, reqCtx, sessionId, { messageId: "msg_1" });
  prevMessages = [...prevMessages, assistantTextMsg("a1")];

  // Turn 2: user says "yes"
  prevMessages = [...prevMessages, userTextMsg("yes")];
  reqCtx = ctxFor({ body: { model: "claude-opus-4-7", messages: prevMessages }, sessionId });
  await ext.onRequest(reqCtx);
  await streamAssistantMessage(ext, reqCtx, sessionId, { messageId: "msg_2" });
  prevMessages = [...prevMessages, assistantTextMsg("a2")];

  // Turns 3-8: filler user messages
  for (let i = 3; i <= 8; i++) {
    prevMessages = [...prevMessages, userTextMsg(`filler ${i}`)];
    reqCtx = ctxFor({ body: { model: "claude-opus-4-7", messages: prevMessages }, sessionId });
    await ext.onRequest(reqCtx);
    await streamAssistantMessage(ext, reqCtx, sessionId, { messageId: `msg_${i}` });
    prevMessages = [...prevMessages, assistantTextMsg(`a${i}`)];
  }

  // Turn 9: user says "yes" AGAIN
  prevMessages = [...prevMessages, userTextMsg("yes")];
  reqCtx = ctxFor({ body: { model: "claude-opus-4-7", messages: prevMessages }, sessionId });
  await ext.onRequest(reqCtx);
  await streamAssistantMessage(ext, reqCtx, sessionId, { messageId: "msg_9" });

  const records = readSessionRecords(sessionId);
  const yesRecords = records.filter((r) => r.type === "user" && r.message?.content === "yes");
  assert.equal(yesRecords.length, 2, "both 'yes' user records must be preserved (position-based dedup; hash-set would collapse them)");
});

// =============================================================================
// Tool-result dedup — independent of user-message position dedup
// =============================================================================

test("tool-result with already-mirrored tool_use_id is dropped from the staged record", async () => {
  const sessionId = "sess-tools";

  // Turn 1: user sends a tool_result with toolu_123
  const tr1 = { type: "tool_result", tool_use_id: "toolu_123", content: [{ type: "text", text: "result1" }] };
  const turn1 = {
    model: "claude-opus-4-7",
    messages: [userBlocks([{ type: "text", text: "task" }, tr1])],
  };
  const r1 = ctxFor({ body: turn1, sessionId });
  await ext.onRequest(r1);
  await streamAssistantMessage(ext, r1, sessionId, { messageId: "msg_1" });

  // Turn 2: history includes the same tool_result + a new one toolu_456
  const tr2 = { type: "tool_result", tool_use_id: "toolu_456", content: [{ type: "text", text: "result2" }] };
  const turn2 = {
    model: "claude-opus-4-7",
    messages: [
      userBlocks([{ type: "text", text: "task" }, tr1]),
      assistantTextMsg("a1"),
      userBlocks([tr2]),
    ],
  };
  const r2 = ctxFor({ body: turn2, sessionId });
  await ext.onRequest(r2);
  await streamAssistantMessage(ext, r2, sessionId, { messageId: "msg_2" });

  const records = readSessionRecords(sessionId);
  // We should see two user records (turn 1 and turn 2). The turn-2 user
  // record should contain only the NEW tool_result, not toolu_123.
  const users = records.filter((r) => r.type === "user");
  assert.equal(users.length, 2);
  const turn2UserBlocks = users[1].message.content;
  const toolResultIds = turn2UserBlocks.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
  assert.deepEqual(toolResultIds, ["toolu_456"], "duplicate tool_use_id should be filtered out");
});

// =============================================================================
// Failure isolation — writer error must not break the response
// =============================================================================

test("env-var off → no mirror writes occur", async () => {
  process.env.CACHE_FIX_SESSION_MIRROR = "off";
  const sessionId = "sess-off";
  const body = { model: "claude-opus-4-7", messages: [userTextMsg("hello")] };
  const reqCtx = ctxFor({ body, sessionId });
  await ext.onRequest(reqCtx);
  await streamAssistantMessage(ext, reqCtx, sessionId, { messageId: "msg_1" });
  assert.equal(readSessionRecords(sessionId).length, 0);
});

// =============================================================================
// Thinking exclusion via env var
// =============================================================================

test("thinking exclusion: env-var false strips thinking blocks from mirror records", async () => {
  process.env.CACHE_FIX_SESSION_MIRROR_INCLUDE_THINKING = "false";

  const sessionId = "sess-thinking";
  const body = { model: "claude-opus-4-7", messages: [userTextMsg("think hard")] };
  const reqCtx = ctxFor({ body, sessionId });
  await ext.onRequest(reqCtx);
  // Inject a thinking block in the stream.
  await ext.onStreamEvent(streamCtx({
    event: { type: "message_start", message: { id: "msg_t", role: "assistant", model: "claude-opus-4-7", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    meta: reqCtx.meta,
    responseHeaders: { "request-id": "req_t" },
  }));
  await ext.onStreamEvent(streamCtx({ event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, meta: reqCtx.meta }));
  await ext.onStreamEvent(streamCtx({ event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "internal" } }, meta: reqCtx.meta }));
  await ext.onStreamEvent(streamCtx({ event: { type: "content_block_stop", index: 0 }, meta: reqCtx.meta }));
  await ext.onStreamEvent(streamCtx({ event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, meta: reqCtx.meta }));
  await ext.onStreamEvent(streamCtx({ event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } }, meta: reqCtx.meta }));
  await ext.onStreamEvent(streamCtx({ event: { type: "content_block_stop", index: 1 }, meta: reqCtx.meta }));
  await ext.onStreamEvent(streamCtx({ event: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }, meta: reqCtx.meta }));
  await ext.onStreamEvent(streamCtx({ event: { type: "message_stop" }, meta: reqCtx.meta }));

  const records = readSessionRecords(sessionId);
  const asst = records.find((r) => r.type === "assistant");
  assert.ok(asst);
  // No thinking blocks in mirror; text block survives.
  assert.ok(!asst.message.content.some((b) => b.type === "thinking"), "thinking blocks must be excluded");
  assert.ok(asst.message.content.some((b) => b.type === "text" && b.text === "ok"));
});

// =============================================================================
// Failure isolation: writer error doesn't break anything client-visible
// =============================================================================

test("writer throw during flush does NOT propagate from onStreamEvent", async () => {
  // Force a writer failure: point the mirror dir at an EXISTING regular file,
  // so mkdirSync attempts a child-of-a-file path and throws ENOTDIR.
  const blocker = join(tmpDir, "block.file");
  rmSync(blocker, { force: true });
  // Create a regular file to occupy the path.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(blocker, "I am a file, not a directory.");
  process.env.CACHE_FIX_SESSION_MIRROR_DIR = blocker;

  const sessionId = "sess-fail";
  const body = { model: "claude-opus-4-7", messages: [userTextMsg("hello")] };
  const reqCtx = ctxFor({ body, sessionId });
  await ext.onRequest(reqCtx);
  // streamAssistantMessage triggers a final message_stop that triggers
  // flushAccumulator → writeRecordsSync → which will throw. The extension's
  // try/catch must swallow the error.
  await streamAssistantMessage(ext, reqCtx, sessionId, { messageId: "msg_fail" });
  // We made it past streamAssistantMessage without an exception → PASS.
  assert.ok(true);
});

// =============================================================================
// Non-streaming branch — onResponse fires + writes
// =============================================================================

test("onResponse (non-streaming branch) writes the assistant record", async () => {
  const sessionId = "sess-nonstream";
  const body = { model: "claude-opus-4-7", messages: [userTextMsg("hi")] };
  const reqCtx = ctxFor({ body, sessionId });
  await ext.onRequest(reqCtx);

  // Non-streaming response: ctx.body carries the parsed assistant envelope.
  await ext.onResponse({
    status: 200,
    headers: { "request-id": "req_ns" },
    body: {
      id: "msg_ns",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "non-streamed reply" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 3, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    meta: reqCtx.meta,
  });

  const records = readSessionRecords(sessionId);
  assert.equal(records.filter((r) => r.type === "user").length, 1);
  assert.equal(records.filter((r) => r.type === "assistant").length, 1);
});

// =============================================================================
// Parent-uuid chain wiring
// =============================================================================

// =============================================================================
// MAX_SESSIONS enforced at session creation (not only at successful-write time)
// — Codex round-1 blocker fix: failed/aborted sessions must not accumulate.
// =============================================================================

test("MAX_SESSIONS cap is enforced when sessions stage but never reach message_stop", async () => {
  process.env.CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS = "3";
  // Stage 5 different sessions; none of them ever sends a message_stop, so
  // no flush ever runs. The cap must still hold via getSession()'s eviction.
  for (let i = 0; i < 5; i++) {
    const body = { model: "claude-opus-4-7", messages: [userTextMsg(`turn-${i}`)] };
    const reqCtx = ctxFor({ body, sessionId: `sess-${i}` });
    await ext.onRequest(reqCtx);
    // No stream events — request aborted.
  }
  // We can introspect via the integration test: only the last 3 should still
  // be "in" the map. Verify by trying to stage on each: the older two should
  // have lost their dedup state (mirroredUserMessageCount back to 0).
  const probeBody = { model: "claude-opus-4-7", messages: [userTextMsg("turn-X")] };
  // sess-0 should have been evicted — staging gives 1 pending record.
  const probe = ctxFor({ body: probeBody, sessionId: "sess-0" });
  await ext.onRequest(probe);
  await streamAssistantMessage(ext, probe, "sess-0", { messageId: "msg_probe" });
  const records = readSessionRecords("sess-0");
  // Should be exactly 1 user record + 1 assistant — proving sess-0's prior
  // state (mirroredUserMessageCount=1 from the staged-but-never-flushed
  // first attempt) was evicted.
  assert.equal(records.filter((r) => r.type === "user").length, 1);
});

// =============================================================================
// Event-log scalar surface (Codex round-1 attention #2)
// =============================================================================

test("event log emits an 'open' event on first write per session", async () => {
  const sessionId = "sess-open";
  const body = { model: "claude-opus-4-7", messages: [userTextMsg("hi")] };
  const reqCtx = ctxFor({ body, sessionId });
  await ext.onRequest(reqCtx);
  await streamAssistantMessage(ext, reqCtx, sessionId, { messageId: "msg_open" });

  const eventLogPath = process.env.CACHE_FIX_SESSION_MIRROR_EVENT_LOG;
  const events = existsSync(eventLogPath)
    ? readFileSync(eventLogPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  assert.ok(events.some((e) => e.event === "open" && e.session_id === sessionId),
    "first write should emit an 'open' event");
});

test("event log scalar surface: contract proof — disallowed fields stripped from serialized events", async () => {
  // Codex round-2 attention: the prior version pointed the mirror root at an
  // invalid path so it never read an emitted line, making the test smoke not
  // contract. The fix forces a SUCCESSFUL event-log write and asserts that
  // sanitizer-stripped fields really are absent from the serialized JSONL.
  const sessionId = "sess-scalar-contract";
  // Drive a normal mirroring cycle so an `open` event lands.
  const body = { model: "claude-opus-4-7", messages: [userTextMsg("hi")] };
  const reqCtx = ctxFor({ body, sessionId });
  await ext.onRequest(reqCtx);
  await streamAssistantMessage(ext, reqCtx, sessionId, { messageId: "msg_scalar" });

  // Read the event log directly and assert all events are allow-list-only.
  const eventLogPath = process.env.CACHE_FIX_SESSION_MIRROR_EVENT_LOG;
  assert.ok(existsSync(eventLogPath), "event log must have been written");
  const events = readFileSync(eventLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(events.length > 0, "must have written at least one event");

  const allowedKeys = new Set([
    "timestamp", "event", "session_id", "rotation", "bytes", "unlinked", "error_class",
  ]);
  for (const evt of events) {
    for (const key of Object.keys(evt)) {
      assert.ok(allowedKeys.has(key),
        `event has disallowed field '${key}': ${JSON.stringify(evt)}`);
    }
    // Also belt-and-suspenders: the serialized event must not contain any
    // path-like or raw-error patterns even if a future caller spreads
    // something nonstandard.
    const serialized = JSON.stringify(evt);
    assert.ok(!serialized.includes("/tmp/"), "no file paths in serialized event");
    assert.ok(!serialized.match(/Error:|ENOENT|EACCES/i), "no raw error messages in serialized event");
  }
});

test("event log scalar surface: writer rejects out-of-allowlist fields when callers spread non-scalar payloads", async () => {
  // Direct test against the writer's sanitizer. Call _appendEvent with a
  // record that includes a path, a raw error message, an object, and a
  // null — assert only allow-list scalars survive.
  const { _appendEvent } = await import("../proxy/session-mirror-writer.mjs");
  _appendEvent({
    event: "open",
    session_id: "sess-direct-sanitize",
    file: "/etc/passwd",                // path → must drop
    message: "Error: ENOENT no such file or directory",  // raw → must drop
    bytes: 12345,                        // allowed scalar
    rotation: 2,                         // allowed scalar
    extra_object: { evil: "data" },      // object → must drop
    nullField: null,                     // null → must drop
  });

  const eventLogPath = process.env.CACHE_FIX_SESSION_MIRROR_EVENT_LOG;
  const lines = readFileSync(eventLogPath, "utf8").trim().split("\n").filter(Boolean);
  const evt = JSON.parse(lines[lines.length - 1]);
  assert.deepEqual(new Set(Object.keys(evt)).has("file"), false);
  assert.deepEqual(new Set(Object.keys(evt)).has("message"), false);
  assert.deepEqual(new Set(Object.keys(evt)).has("extra_object"), false);
  assert.deepEqual(new Set(Object.keys(evt)).has("nullField"), false);
  assert.equal(evt.bytes, 12345);
  assert.equal(evt.rotation, 2);
  assert.equal(evt.event, "open");
  assert.equal(evt.session_id, "sess-direct-sanitize");
});

test("parentUuid chain links each record to its predecessor in the session", async () => {
  const sessionId = "sess-chain";
  const turn1 = { model: "claude-opus-4-7", messages: [userTextMsg("u1")] };
  const turn2 = { model: "claude-opus-4-7", messages: [userTextMsg("u1"), assistantTextMsg("a1"), userTextMsg("u2")] };

  for (const [i, body] of [turn1, turn2].entries()) {
    const reqCtx = ctxFor({ body, sessionId });
    await ext.onRequest(reqCtx);
    await streamAssistantMessage(ext, reqCtx, sessionId, { messageId: `msg_${i + 1}`, text: `a${i + 1}` });
  }

  const records = readSessionRecords(sessionId);
  // First record's parentUuid is null; every subsequent record's parentUuid
  // matches the previous record's uuid.
  assert.equal(records[0].parentUuid, null);
  for (let i = 1; i < records.length; i++) {
    assert.equal(records[i].parentUuid, records[i - 1].uuid, `record[${i}].parentUuid should match record[${i - 1}].uuid`);
  }
});
