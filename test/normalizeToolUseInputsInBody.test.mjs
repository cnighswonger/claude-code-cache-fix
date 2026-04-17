import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeToolUseInputsInBody } from "../preload.mjs";

// Helper: build a minimal body shape matching what CC sends to the API.
function makeBody({ tools = [], messages = [] } = {}) {
  return { tools, messages };
}

function makeTool(name, propertyKeys) {
  return {
    name,
    description: `${name} (test fixture)`,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(
        propertyKeys.map((k) => [k, { type: "string" }])
      ),
      required: [],
    },
  };
}

function makeAssistantToolUse(toolName, input, id = "toolu_test_1") {
  return {
    role: "assistant",
    content: [
      { type: "tool_use", id, name: toolName, input },
    ],
  };
}

test("normalizeToolUseInputsInBody: tool without schema → no-op", () => {
  const body = makeBody({
    tools: [{ name: "MysteryTool" /* no input_schema */ }],
    messages: [makeAssistantToolUse("MysteryTool", { a: 1, b: 2, extra: "x" })],
  });
  const count = normalizeToolUseInputsInBody(body);
  assert.equal(count, 0);
  assert.deepEqual(body.messages[0].content[0].input, { a: 1, b: 2, extra: "x" });
});

test("normalizeToolUseInputsInBody: tool with schema but no extra keys → no-op", () => {
  const body = makeBody({
    tools: [makeTool("Foo", ["a", "b"])],
    messages: [makeAssistantToolUse("Foo", { a: 1, b: 2 })],
  });
  const count = normalizeToolUseInputsInBody(body);
  assert.equal(count, 0);
  assert.deepEqual(body.messages[0].content[0].input, { a: 1, b: 2 });
});

test("normalizeToolUseInputsInBody: tool with schema + extra keys → extras stripped, schema keys preserved", () => {
  const body = makeBody({
    tools: [makeTool("Foo", ["a", "b"])],
    messages: [makeAssistantToolUse("Foo", { a: 1, b: 2, c: 3, d: 4 })],
  });
  const count = normalizeToolUseInputsInBody(body);
  assert.equal(count, 1);
  const input = body.messages[0].content[0].input;
  assert.deepEqual(Object.keys(input), ["a", "b"]);
  assert.equal(input.a, 1);
  assert.equal(input.b, 2);
  assert.ok(!("c" in input));
  assert.ok(!("d" in input));
});

test("normalizeToolUseInputsInBody: multiple tool_use blocks in one message", () => {
  const body = makeBody({
    tools: [makeTool("Foo", ["a"]), makeTool("Bar", ["x", "y"])],
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Foo", input: { a: 1, extra: "z" } },
          { type: "text", text: "thinking…" },
          { type: "tool_use", id: "t2", name: "Bar", input: { x: 1, y: 2, z: 3 } },
        ],
      },
    ],
  });
  const count = normalizeToolUseInputsInBody(body);
  assert.equal(count, 2);
  assert.deepEqual(body.messages[0].content[0].input, { a: 1 });
  assert.deepEqual(body.messages[0].content[2].input, { x: 1, y: 2 });
  // text block untouched
  assert.equal(body.messages[0].content[1].text, "thinking…");
});

test("normalizeToolUseInputsInBody: user messages with tool_use-shaped content untouched", () => {
  const body = makeBody({
    tools: [makeTool("Foo", ["a"])],
    messages: [
      {
        role: "user",
        content: [
          // This shouldn't happen in reality, but defensively: user-role
          // tool_use shapes must not be mutated.
          { type: "tool_use", id: "t1", name: "Foo", input: { a: 1, extra: "z" } },
        ],
      },
    ],
  });
  const count = normalizeToolUseInputsInBody(body);
  assert.equal(count, 0);
  assert.deepEqual(body.messages[0].content[0].input, { a: 1, extra: "z" });
});

test("normalizeToolUseInputsInBody: no body.tools → no-op (can't determine schemas)", () => {
  const body = {
    messages: [makeAssistantToolUse("Foo", { a: 1, b: 2, extra: "z" })],
    // no tools key
  };
  const count = normalizeToolUseInputsInBody(body);
  assert.equal(count, 0);
  assert.deepEqual(body.messages[0].content[0].input, { a: 1, b: 2, extra: "z" });
});

test("normalizeToolUseInputsInBody: key order preserved according to schema declaration order (NOT input's original order)", () => {
  const body = makeBody({
    tools: [makeTool("Foo", ["alpha", "beta", "gamma"])],
    messages: [
      // caller supplies keys in different order than schema declared
      makeAssistantToolUse("Foo", { gamma: 3, alpha: 1, beta: 2 }),
    ],
  });
  const count = normalizeToolUseInputsInBody(body);
  assert.equal(count, 1);
  assert.deepEqual(Object.keys(body.messages[0].content[0].input), [
    "alpha",
    "beta",
    "gamma",
  ]);
  // JSON.stringify should now be deterministic across turns regardless
  // of caller-side insertion order.
  assert.equal(
    JSON.stringify(body.messages[0].content[0].input),
    '{"alpha":1,"beta":2,"gamma":3}'
  );
});

test("normalizeToolUseInputsInBody: non-array content (role=user with string content) doesn't crash", () => {
  const body = makeBody({
    tools: [makeTool("Foo", ["a"])],
    messages: [
      { role: "user", content: "plain string content" },
      makeAssistantToolUse("Foo", { a: 1, extra: "z" }),
    ],
  });
  const count = normalizeToolUseInputsInBody(body);
  assert.equal(count, 1);
  assert.deepEqual(body.messages[0].content, "plain string content");
  assert.deepEqual(body.messages[1].content[0].input, { a: 1 });
});

test("normalizeToolUseInputsInBody: missing body / non-object → returns 0 without throwing", () => {
  assert.equal(normalizeToolUseInputsInBody(null), 0);
  assert.equal(normalizeToolUseInputsInBody(undefined), 0);
  assert.equal(normalizeToolUseInputsInBody("not-an-object"), 0);
  assert.equal(normalizeToolUseInputsInBody(42), 0);
  assert.equal(normalizeToolUseInputsInBody({}), 0);
  assert.equal(normalizeToolUseInputsInBody({ messages: [], tools: [] }), 0);
});

test("normalizeToolUseInputsInBody: idempotent (running twice equals running once)", () => {
  const body = makeBody({
    tools: [makeTool("Foo", ["a", "b"])],
    messages: [makeAssistantToolUse("Foo", { a: 1, b: 2, extra: "z" })],
  });
  const firstCount = normalizeToolUseInputsInBody(body);
  const snapshot = JSON.stringify(body);
  const secondCount = normalizeToolUseInputsInBody(body);
  assert.equal(firstCount, 1);
  assert.equal(secondCount, 0);
  assert.equal(JSON.stringify(body), snapshot);
});

test("normalizeToolUseInputsInBody: real captured-body regression — SendMessage with 6 caller keys, schema declares 3", () => {
  // Mirrors the observed 15:16:52 UTC miss: tool_use block on an assistant
  // message carried `{to, summary, message, type, recipient, content}`,
  // schema declared only `{to, summary, message}`. The 3 extras caused a
  // 2334-byte drift vs the pre-miss body, which serialized schema-only.
  const body = makeBody({
    tools: [makeTool("SendMessage", ["to", "summary", "message"])],
    messages: [
      makeAssistantToolUse(
        "SendMessage",
        {
          to: "alice",
          summary: "status update",
          message: "All services healthy.",
          type: "notification",
          recipient: "alice",
          content: "All services healthy.",
        },
        "toolu_01MissCaseSendMessage"
      ),
    ],
  });
  const count = normalizeToolUseInputsInBody(body);
  assert.equal(count, 1);
  const input = body.messages[0].content[0].input;
  assert.deepEqual(Object.keys(input), ["to", "summary", "message"]);
  assert.equal(input.to, "alice");
  assert.equal(input.summary, "status update");
  assert.equal(input.message, "All services healthy.");
  // The three extras are stripped — their presence was the sole cause of
  // the 2334-byte drift.
  assert.ok(!("type" in input));
  assert.ok(!("recipient" in input));
  assert.ok(!("content" in input));
});

test("normalizeToolUseInputsInBody: cross-turn byte stability — different caller key orders serialize identically", () => {
  // Validates the core mechanism: two callers of the same tool with
  // different insertion orders and different extras produce the same
  // stringified input after normalization.
  const tools = [makeTool("Foo", ["a", "b", "c"])];
  const turn1 = makeBody({
    tools,
    messages: [makeAssistantToolUse("Foo", { a: 1, b: 2, c: 3 })],
  });
  const turn2 = makeBody({
    tools,
    messages: [
      makeAssistantToolUse("Foo", { c: 3, extra1: "x", a: 1, extra2: "y", b: 2 }),
    ],
  });
  normalizeToolUseInputsInBody(turn1);
  normalizeToolUseInputsInBody(turn2);
  assert.equal(
    JSON.stringify(turn1.messages[0].content[0].input),
    JSON.stringify(turn2.messages[0].content[0].input)
  );
});

test("normalizeToolUseInputsInBody: missing input / array input skipped safely", () => {
  const body = makeBody({
    tools: [makeTool("Foo", ["a"])],
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Foo" /* no input */ },
          { type: "tool_use", id: "t2", name: "Foo", input: null },
          { type: "tool_use", id: "t3", name: "Foo", input: [1, 2, 3] },
          { type: "tool_use", id: "t4", name: "Foo", input: { a: 1, extra: "z" } },
        ],
      },
    ],
  });
  const count = normalizeToolUseInputsInBody(body);
  // Only t4 should be modified; t1/t2/t3 skipped as malformed.
  assert.equal(count, 1);
  assert.deepEqual(body.messages[0].content[3].input, { a: 1 });
});
