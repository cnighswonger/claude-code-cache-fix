import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSseString, buildJsonBody, synthMessageId } from "../proxy/synth-response.mjs";

// Wire format for locally short-circuited responses, shared by every extension
// that returns without an upstream call (image-retry-circuit-breaker,
// session-budget-breaker). Tested here, at the module that owns it, rather than
// through whichever extension happens to import it.

test("buildSseString emits the full event sequence (no [DONE] by default)", () => {
  const out = buildSseString("claude-opus-4-7", "hi");
  assert.match(out, /^event: message_start/);
  assert.ok(out.indexOf("event: content_block_start") > 0);
  assert.ok(out.indexOf("event: content_block_delta") > 0);
  assert.ok(out.indexOf("event: content_block_stop") > 0);
  assert.ok(out.indexOf("event: message_delta") > 0);
  assert.ok(out.indexOf("event: message_stop") > 0);
  assert.ok(!out.includes("[DONE]"), "[DONE] sentinel is deferred to sim validation per directive N1");
});

test("buildSseString event payloads are valid JSON and carry the required structural fields", () => {
  const out = buildSseString("claude-opus-4-7", "delta-text");
  const events = out
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const dataLine = lines.find((l) => l.startsWith("data:"));
      return dataLine ? JSON.parse(dataLine.slice("data: ".length)) : null;
    })
    .filter(Boolean);

  assert.equal(events.length, 6);
  const start = events[0];
  assert.equal(start.type, "message_start");
  assert.equal(start.message.role, "assistant");
  assert.equal(start.message.model, "claude-opus-4-7");
  assert.equal(typeof start.message.usage.input_tokens, "number");

  assert.equal(events[1].type, "content_block_start");
  assert.equal(events[1].index, 0);
  assert.equal(events[2].type, "content_block_delta");
  assert.equal(events[2].delta.text, "delta-text");
  assert.equal(events[3].type, "content_block_stop");
  assert.equal(events[4].type, "message_delta");
  assert.equal(events[4].delta.stop_reason, "end_turn");
  assert.equal(events[5].type, "message_stop");
});

test("buildJsonBody produces the upstream non-streaming envelope shape", () => {
  const out = buildJsonBody("claude-opus-4-7", "the text");
  assert.equal(out.type, "message");
  assert.equal(out.role, "assistant");
  assert.equal(out.model, "claude-opus-4-7");
  assert.equal(out.content[0].type, "text");
  assert.equal(out.content[0].text, "the text");
  assert.equal(out.stop_reason, "end_turn");
  assert.equal(typeof out.usage.input_tokens, "number");
});

test("synthMessageId is unique per call and shaped like an upstream id", () => {
  const a = synthMessageId();
  const b = synthMessageId();
  assert.match(a, /^msg_/);
  assert.notEqual(a, b, "a synthesized id must not repeat across responses");
});
