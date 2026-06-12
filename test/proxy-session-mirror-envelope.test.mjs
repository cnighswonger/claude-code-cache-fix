import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  shapeAssistantRecord,
  shapeUserRecord,
  shapeToolResultUserRecord,
  syntheticUuid,
  dereferenceImageBlock,
  mergeUsage,
} from "../proxy/session-mirror-envelope.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/cc-transcript-shape-snapshot.json", import.meta.url), "utf8"));

const SESSION = "00000000-0000-4000-8000-c4f1efb22220";

// ---------------------------------------------------------------------------
// syntheticUuid
// ---------------------------------------------------------------------------

test("syntheticUuid is deterministic from (sessionId, timestamp, messageId)", () => {
  const a = syntheticUuid("sess-1", "2026-06-12T00:00:00.000Z", "msg_123");
  const b = syntheticUuid("sess-1", "2026-06-12T00:00:00.000Z", "msg_123");
  assert.equal(a, b);
});

test("syntheticUuid produces the 8-4-4-4-12 dashed shape", () => {
  const u = syntheticUuid("sess-1", "2026-06-12T00:00:00.000Z", "msg_123");
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("syntheticUuid varies on different inputs", () => {
  const a = syntheticUuid("sess-1", "2026-06-12T00:00:00.000Z", "msg_a");
  const b = syntheticUuid("sess-1", "2026-06-12T00:00:00.000Z", "msg_b");
  const c = syntheticUuid("sess-2", "2026-06-12T00:00:00.000Z", "msg_a");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

// ---------------------------------------------------------------------------
// Assistant envelope shape parity
// ---------------------------------------------------------------------------

test("shapeAssistantRecord matches CC 2.1.148 verified top-level key set + source marker", () => {
  const rec = shapeAssistantRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    parentUuid: null,
    requestId: "req_abc",
    messageId: "msg_x",
    model: "claude-opus-4-7",
    content: [{ type: "text", text: "hello" }],
    stopReason: "end_turn",
    stopSequence: null,
    stopDetails: null,
    usage: { input_tokens: 5, output_tokens: 12 },
  });

  const ourTopKeys = new Set(Object.keys(rec));
  // Every CC-side top-level key the fixture documents MUST be present.
  for (const k of FIXTURE.assistant_record_top_level_keys) {
    assert.ok(ourTopKeys.has(k), `missing top-level key '${k}' required for CC envelope parity`);
  }
  // Plus our additive provenance marker.
  assert.equal(rec.source, "cache-fix-proxy-mirror");
});

test("shapeAssistantRecord's message nesting matches CC 2.1.148 verified message-keys set", () => {
  const rec = shapeAssistantRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    parentUuid: null,
    requestId: "req_abc",
    messageId: "msg_x",
    model: "claude-opus-4-7",
    content: [{ type: "text", text: "hello" }],
    stopReason: "end_turn",
    usage: { input_tokens: 5 },
  });

  const msgKeys = new Set(Object.keys(rec.message));
  for (const k of FIXTURE.assistant_message_keys) {
    assert.ok(msgKeys.has(k), `missing message-nested key '${k}' for CC envelope parity`);
  }
  assert.equal(rec.message.role, "assistant");
  assert.equal(rec.message.type, "message");
});

test("shapeAssistantRecord echoes model and id; sets stop_reason from input", () => {
  const rec = shapeAssistantRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    parentUuid: null,
    messageId: "msg_my_id",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text: "ok" }],
    stopReason: "tool_use",
    usage: { input_tokens: 1 },
  });
  assert.equal(rec.message.id, "msg_my_id");
  assert.equal(rec.message.model, "claude-haiku-4-5");
  assert.equal(rec.message.stop_reason, "tool_use");
});

// ---------------------------------------------------------------------------
// User envelope shape parity (plain user record)
// ---------------------------------------------------------------------------

test("shapeUserRecord produces a plain user record matching CC 2.1.148 verified user-record key set", () => {
  const rec = shapeUserRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    parentUuid: null,
    promptId: "pid_xyz",
    permissionMode: "default",
    content: "hello world",
    ordinalSeed: "0",
  });

  // Iterate the captured fixture's user_record_top_level_keys (same way the
  // assistant parity test does) — plain user records must carry every CC
  // top-level key the fixture documents, EXCEPT the tool-result-only fields
  // (toolUseResult + sourceToolAssistantUUID) which are explicitly omitted
  // per directive caveat.
  const toolResultOnly = new Set(["toolUseResult", "sourceToolAssistantUUID"]);
  const ourKeys = new Set(Object.keys(rec));
  for (const k of FIXTURE.user_record_top_level_keys) {
    if (toolResultOnly.has(k)) continue;
    assert.ok(ourKeys.has(k), `missing top-level key '${k}' required for CC user-record parity`);
  }
  // message-nested keys must match too.
  const msgKeys = new Set(Object.keys(rec.message));
  for (const k of FIXTURE.user_message_keys) {
    assert.ok(msgKeys.has(k), `missing message-nested key '${k}' for CC user-record parity`);
  }
  assert.equal(rec.type, "user");
  assert.equal(rec.message.role, "user");
  assert.equal(rec.message.content, "hello world");
  assert.equal(rec.permissionMode, "default");
});

test("shapeUserRecord omits requestId (user records do not carry one)", () => {
  const rec = shapeUserRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    content: "hi",
    ordinalSeed: "0",
  });
  assert.ok(!("requestId" in rec));
});

test("shapeUserRecord omits permissionMode when null/undefined", () => {
  const rec = shapeUserRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    content: "hi",
    ordinalSeed: "0",
  });
  assert.ok(!("permissionMode" in rec));
});

// ---------------------------------------------------------------------------
// Tool-result user records
// ---------------------------------------------------------------------------

test("shapeToolResultUserRecord omits toolUseResult + sourceToolAssistantUUID (CC-internal enriched objects)", () => {
  const rec = shapeToolResultUserRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    parentUuid: null,
    content: [{ type: "tool_result", tool_use_id: "toolu_123", content: [{ type: "text", text: "output" }] }],
    ordinalSeed: "1",
  });
  assert.ok(!("toolUseResult" in rec), "directive caveat: proxy cannot reconstruct toolUseResult");
  assert.ok(!("sourceToolAssistantUUID" in rec), "directive caveat: proxy cannot reconstruct sourceToolAssistantUUID");
  assert.equal(rec.message.content[0].type, "tool_result");
});

// ---------------------------------------------------------------------------
// Image-block dereferencing — PII discipline
// ---------------------------------------------------------------------------

test("dereferenceImageBlock replaces base64 data with sha256 reference", () => {
  const bytes = Buffer.from("fake-image-bytes");
  const b64 = bytes.toString("base64");
  const block = { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } };
  const out = dereferenceImageBlock(block);
  assert.equal(out.source.type, "reference");
  assert.match(out.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(out.source.media_type, "image/png");
  // The bytes themselves MUST be gone.
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes(b64), "image bytes must not appear in mirror record");
});

test("dereferenceImageBlock returns non-image blocks unchanged", () => {
  const text = { type: "text", text: "hello" };
  assert.deepEqual(dereferenceImageBlock(text), text);
});

test("shapeAssistantRecord dereferences image content blocks", () => {
  const bytes = Buffer.from("image-bytes-xyz");
  const b64 = bytes.toString("base64");
  const rec = shapeAssistantRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    messageId: "msg_x",
    model: "claude-opus-4-7",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
      { type: "text", text: "describe" },
    ],
    stopReason: "end_turn",
    usage: { input_tokens: 1 },
  });
  const serialized = JSON.stringify(rec);
  assert.ok(!serialized.includes(b64), "image bytes must not be persisted in mirror");
  assert.equal(rec.message.content[0].source.type, "reference");
});

// ---------------------------------------------------------------------------
// Thinking exclusion
// ---------------------------------------------------------------------------

test("shapeAssistantRecord includes thinking blocks by default", () => {
  const rec = shapeAssistantRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    messageId: "msg_x",
    model: "claude-opus-4-7",
    content: [
      { type: "thinking", thinking: "internal reasoning" },
      { type: "text", text: "out" },
    ],
    stopReason: "end_turn",
    usage: {},
  });
  assert.equal(rec.message.content.length, 2);
  assert.equal(rec.message.content[0].type, "thinking");
});

test("shapeAssistantRecord excludes thinking blocks when includeThinking=false", () => {
  const rec = shapeAssistantRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    messageId: "msg_x",
    model: "claude-opus-4-7",
    content: [
      { type: "thinking", thinking: "internal reasoning" },
      { type: "text", text: "out" },
    ],
    stopReason: "end_turn",
    usage: {},
    includeThinking: false,
  });
  assert.equal(rec.message.content.length, 1);
  assert.equal(rec.message.content[0].type, "text");
});

// ---------------------------------------------------------------------------
// Usage merge
// ---------------------------------------------------------------------------

test("mergeUsage prefers delta values over start values for numeric fields", () => {
  const start = { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 100 };
  const delta = { output_tokens: 42 };
  const merged = mergeUsage(start, delta);
  assert.equal(merged.input_tokens, 5);
  assert.equal(merged.output_tokens, 42);
  assert.equal(merged.cache_read_input_tokens, 100);
});

test("mergeUsage handles missing delta cleanly", () => {
  const start = { input_tokens: 5, output_tokens: 0 };
  const merged = mergeUsage(start, null);
  assert.deepEqual(merged, start);
});

// ---------------------------------------------------------------------------
// cwd is null + version present (directive caveats)
// ---------------------------------------------------------------------------

test("cwd is always null in mirror records (proxy does not know caller cwd)", () => {
  const a = shapeAssistantRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    messageId: "msg_x",
    model: "claude-opus-4-7",
    content: [],
    stopReason: "end_turn",
    usage: {},
  });
  const u = shapeUserRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    content: "hi",
    ordinalSeed: "0",
  });
  assert.equal(a.cwd, null);
  assert.equal(u.cwd, null);
});

test("entrypoint is 'cache-fix-proxy-mirror' (proxy is the writer, not CC's cli)", () => {
  const rec = shapeAssistantRecord({
    sessionId: SESSION,
    timestamp: "2026-06-12T00:00:00.000Z",
    messageId: "msg_x",
    model: "claude-opus-4-7",
    content: [],
    stopReason: "end_turn",
    usage: {},
  });
  assert.equal(rec.entrypoint, "cache-fix-proxy-mirror");
});
