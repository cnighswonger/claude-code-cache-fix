import { test } from "node:test";
import assert from "node:assert/strict";
import ext, {
  isOmittedThinking,
  isActiveToolContinuation,
  planSanitize,
} from "../proxy/extensions/thinking-block-sanitize.mjs";

const omitted = () => ({ type: "thinking", thinking: "", signature: "SIG==" });
const realThinking = () => ({ type: "thinking", thinking: "real reasoning", signature: "SIG==" });
const text = (t = "a") => ({ type: "text", text: t });
const toolUse = (id = "t1") => ({ type: "tool_use", id, name: "x", input: {} });
const toolResult = (id = "t1") => ({ type: "tool_result", tool_use_id: id, content: "r" });

// --- isOmittedThinking ---

test("isOmittedThinking: empty thinking text → true; non-empty / other types → false", () => {
  assert.equal(isOmittedThinking(omitted()), true);
  assert.equal(isOmittedThinking({ type: "thinking", thinking: "   ", signature: "S" }), true);
  assert.equal(isOmittedThinking(realThinking()), false);
  assert.equal(isOmittedThinking({ type: "redacted_thinking", data: "X" }), false);
  assert.equal(isOmittedThinking(text()), false);
  assert.equal(isOmittedThinking(null), false);
});

// --- isActiveToolContinuation ---

test("isActiveToolContinuation: latest ends tool_use with a following tool_result → true", () => {
  const messages = [
    { role: "assistant", content: [omitted(), toolUse("t1")] },
    { role: "user", content: [toolResult("t1")] },
  ];
  assert.equal(isActiveToolContinuation(messages, 0), true);
});

test("isActiveToolContinuation: latest ends in text (completed turn) → false", () => {
  const messages = [
    { role: "assistant", content: [omitted(), text("done")] },
    { role: "user", content: [text("next")] },
  ];
  assert.equal(isActiveToolContinuation(messages, 0), false);
});

test("isActiveToolContinuation: ends tool_use but no following tool_result → false", () => {
  const messages = [{ role: "assistant", content: [omitted(), toolUse("t1")] }];
  assert.equal(isActiveToolContinuation(messages, 0), false);
});

test("isActiveToolContinuation: later tool_result answers a DIFFERENT tool_use_id → false (must match the terminal call)", () => {
  const messages = [
    { role: "assistant", content: [omitted(), toolUse("t1")] },
    { role: "user", content: [toolResult("other")] }, // answers a different call, not t1
  ];
  assert.equal(isActiveToolContinuation(messages, 0), false);
});

// --- planSanitize ---

test("planSanitize: drops omitted thinking from a prior turn AND the latest completed turn", () => {
  const messages = [
    { role: "user", content: [text("q1")] },
    { role: "assistant", content: [omitted(), text("a1")] }, // prior
    { role: "user", content: [text("q2")] },
    { role: "assistant", content: [omitted(), text("a2")] }, // latest, completed (ends text)
  ];
  const r = planSanitize(messages);
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.messages[1].content, [text("a1")], "prior turn keeps text, loses omitted thinking");
  assert.deepEqual(r.messages[3].content, [text("a2")], "latest completed turn also stripped");
});

test("planSanitize: protects the latest assistant turn when it is an active tool-continuation", () => {
  const messages = [
    { role: "user", content: [text("q1")] },
    { role: "assistant", content: [omitted(), text("a1")] }, // prior → stripped
    { role: "user", content: [text("q2")] },
    { role: "assistant", content: [omitted(), toolUse("t1")] }, // latest → protected (continuation)
    { role: "user", content: [toolResult("t1")] },
  ];
  const r = planSanitize(messages);
  assert.equal(r.dropped, 1, "only the prior turn's thinking is dropped");
  assert.deepEqual(r.messages[1].content, [text("a1")]);
  assert.deepEqual(r.messages[3].content, [omitted(), toolUse("t1")], "continuation turn left byte-identical");
});

test("planSanitize: latest turn whose terminal tool_use is NOT answered (mismatched tool_result) is stripped, not protected", () => {
  const messages = [
    { role: "user", content: [text("q")] },
    { role: "assistant", content: [omitted(), toolUse("t1")] }, // latest assistant, terminal tool_use t1
    { role: "user", content: [toolResult("other")] }, // answers a different call → NOT the protected continuation
  ];
  const r = planSanitize(messages);
  assert.equal(r.dropped, 1, "latest-turn omitted thinking is stripped when its tool_use is unanswered");
  assert.deepEqual(r.messages[1].content, [toolUse("t1")], "thinking removed; tool_use kept");
});

test("planSanitize: keeps non-empty thinking and redacted_thinking (v1 scope = thinking-empty only)", () => {
  const messages = [
    { role: "assistant", content: [realThinking(), text("a1")] },
    { role: "user", content: [text("q")] },
    { role: "assistant", content: [{ type: "redacted_thinking", data: "X" }, text("a2")] },
  ];
  const r = planSanitize(messages);
  assert.equal(r.dropped, 0, "neither non-empty thinking nor redacted_thinking is dropped");
  assert.equal(r.messages, messages, "unchanged → same array reference");
});

test("planSanitize: drops an assistant message that becomes empty-content", () => {
  const messages = [
    { role: "user", content: [text("q1")] },
    { role: "assistant", content: [omitted()] }, // thinking-only prior turn → message dropped
    { role: "user", content: [text("q2")] },
    { role: "assistant", content: [text("a2")] }, // latest, no thinking
  ];
  const r = planSanitize(messages);
  assert.equal(r.dropped, 1);
  assert.equal(r.messages.length, 3, "the now-empty assistant message is removed");
  assert.equal(r.messages.some((m) => m.role === "assistant" && m.content.length === 0), false);
});

test("planSanitize: deterministic — same input twice yields identical output", () => {
  const mk = () => [
    { role: "assistant", content: [omitted(), text("a1")] },
    { role: "user", content: [text("q")] },
    { role: "assistant", content: [omitted(), text("a2")] },
  ];
  assert.deepEqual(planSanitize(mk()), planSanitize(mk()));
});

// --- onRequest (opt-in gating) ---

function withSanitize(value, fn) {
  const old = process.env.CACHE_FIX_THINKING_SANITIZE;
  if (value === undefined) delete process.env.CACHE_FIX_THINKING_SANITIZE;
  else process.env.CACHE_FIX_THINKING_SANITIZE = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.CACHE_FIX_THINKING_SANITIZE;
    else process.env.CACHE_FIX_THINKING_SANITIZE = old;
  }
}

test("onRequest: default (opt-in off) is a no-op — body unchanged, no telemetry", async () => {
  await withSanitize(undefined, async () => {
    const ctx = {
      body: { messages: [{ role: "assistant", content: [omitted(), text("a")] }] },
      meta: {},
    };
    await ext.onRequest(ctx);
    assert.deepEqual(ctx.body.messages[0].content, [omitted(), text("a")], "body untouched when off");
    assert.equal(ctx.meta._thinkingSanitize, undefined, "no telemetry when off");
  });
});

test("onRequest: opt-in on mutates the body and emits the drop count", async () => {
  await withSanitize("on", async () => {
    const ctx = {
      body: {
        messages: [
          { role: "assistant", content: [omitted(), text("a1")] },
          { role: "user", content: [text("q")] },
          { role: "assistant", content: [omitted(), text("a2")] },
        ],
      },
      meta: {},
    };
    await ext.onRequest(ctx);
    assert.deepEqual(ctx.body.messages[0].content, [text("a1")]);
    assert.deepEqual(ctx.body.messages[2].content, [text("a2")]);
    assert.deepEqual(ctx.meta._thinkingSanitize, { thinking_blocks_dropped: 2 });
  });
});

test("onRequest: opt-in on with nothing to drop emits a zero count and leaves the body intact", async () => {
  await withSanitize("on", async () => {
    const ctx = {
      body: { messages: [{ role: "assistant", content: [realThinking(), text("a")] }] },
      meta: {},
    };
    await ext.onRequest(ctx);
    assert.deepEqual(ctx.meta._thinkingSanitize, { thinking_blocks_dropped: 0 });
    assert.deepEqual(ctx.body.messages[0].content, [realThinking(), text("a")]);
  });
});
