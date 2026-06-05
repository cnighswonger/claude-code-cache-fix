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

// --- onRequest gating (v4.0.0: v1 default-on) ---

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

test("onRequest (v4.0.0): default (envvar unset) runs v1 — body mutated, telemetry emitted", async () => {
  await withSanitize(undefined, async () => {
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
    assert.deepEqual(ctx.body.messages[0].content, [text("a1")], "v1 strips omitted on default-on");
    assert.deepEqual(ctx.body.messages[2].content, [text("a2")]);
    assert.deepEqual(ctx.meta._thinkingSanitize, { thinking_blocks_dropped: 2 });
  });
});

test("onRequest (v4.0.0): explicit =off is a no-op — body unchanged, no telemetry", async () => {
  await withSanitize("off", async () => {
    const ctx = {
      body: { messages: [{ role: "assistant", content: [omitted(), text("a")] }] },
      meta: {},
    };
    await ext.onRequest(ctx);
    assert.deepEqual(ctx.body.messages[0].content, [omitted(), text("a")], "body untouched when explicitly off");
    assert.equal(ctx.meta._thinkingSanitize, undefined, "no telemetry when off");
  });
});

test("onRequest: explicit =on matches the default (back-compat)", async () => {
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

// ==========================================================================
// v2 test suite — tools-hash-mismatch drop (directive proxy-thinking-block-sanitize-v2.md)
// ==========================================================================

import {
  isSignedThinkingForV2,
  modeFromEnv,
  _resetV2State,
} from "../proxy/extensions/thinking-block-sanitize.mjs";
import {
  canonicalStringify,
  computeSignatureSurfaceHash,
} from "../proxy/extensions/signature-surface-hash.mjs";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";

const redacted = () => ({ type: "redacted_thinking", data: "OPAQUE" });
const realSigned = () => ({ type: "thinking", thinking: "real", signature: "SIG==" });
const realThinkingNoSig = () => ({ type: "thinking", thinking: "real", signature: "" });
const sid = (id) => ({ "x-claude-code-session-id": id });

// --- modeFromEnv ---

// v4.0.0: v1 default-on flip. Unset/unknown → "on" (was "off"). Only the
// literal "off" is an explicit disable; "v2" stays as before.
test("modeFromEnv (v4.0.0 default-on): defaults to on; off is explicit; v2 unchanged", () => {
  assert.equal(modeFromEnv({ CACHE_FIX_THINKING_SANITIZE: undefined }), "on");
  assert.equal(modeFromEnv({}), "on");
  assert.equal(modeFromEnv({ CACHE_FIX_THINKING_SANITIZE: "off" }), "off");
  assert.equal(modeFromEnv({ CACHE_FIX_THINKING_SANITIZE: "on" }), "on");
  assert.equal(modeFromEnv({ CACHE_FIX_THINKING_SANITIZE: "v2" }), "v2");
  // Unknown values fall through to "on" (the default), not to "off".
  // We treat "off" as the sole explicit disable; everything else is on-path.
  assert.equal(modeFromEnv({ CACHE_FIX_THINKING_SANITIZE: "v3" }), "on");
  assert.equal(modeFromEnv({ CACHE_FIX_THINKING_SANITIZE: "true" }), "on");
  assert.equal(modeFromEnv({ CACHE_FIX_THINKING_SANITIZE: "" }), "on");
});

// --- isSignedThinkingForV2 ---

test("isSignedThinkingForV2: signed non-empty thinking → true", () => {
  assert.equal(isSignedThinkingForV2(realSigned()), true);
});

test("isSignedThinkingForV2: redacted_thinking → true", () => {
  assert.equal(isSignedThinkingForV2(redacted()), true);
});

test("isSignedThinkingForV2: omitted (empty-text) thinking → false (that's v1's case)", () => {
  assert.equal(isSignedThinkingForV2(omitted()), false);
});

test("isSignedThinkingForV2: non-empty thinking WITHOUT a signature → false", () => {
  assert.equal(isSignedThinkingForV2(realThinkingNoSig()), false);
});

test("isSignedThinkingForV2: text / tool_use / null → false", () => {
  assert.equal(isSignedThinkingForV2(text()), false);
  assert.equal(isSignedThinkingForV2(toolUse()), false);
  assert.equal(isSignedThinkingForV2(null), false);
});

// --- canonicalStringify ---

test("canonicalStringify: top-level key order doesn't affect output", () => {
  assert.equal(
    canonicalStringify({ b: 1, a: 2 }),
    canonicalStringify({ a: 2, b: 1 }),
  );
});

test("canonicalStringify: nested-key order doesn't affect output (recursive sort)", () => {
  assert.equal(
    canonicalStringify({ a: { y: 1, x: 2 } }),
    canonicalStringify({ a: { x: 2, y: 1 } }),
  );
});

test("canonicalStringify: array order IS load-bearing (preserves array order)", () => {
  assert.notEqual(
    canonicalStringify([1, 2]),
    canonicalStringify([2, 1]),
  );
});

test("canonicalStringify: primitives pass through", () => {
  assert.equal(canonicalStringify(null), "null");
  assert.equal(canonicalStringify(42), "42");
  assert.equal(canonicalStringify("s"), "\"s\"");
  assert.equal(canonicalStringify(true), "true");
});

// --- computeSignatureSurfaceHash ---

test("computeSignatureSurfaceHash: 16 hex chars", () => {
  const h = computeSignatureSurfaceHash({ tools: [{ name: "x", input_schema: {} }] });
  assert.match(h, /^[0-9a-f]{16}$/);
});

test("computeSignatureSurfaceHash: shuffled top-level keys → same hash", () => {
  const t1 = [{ name: "x", description: "d", input_schema: { type: "object" } }];
  const t2 = [{ input_schema: { type: "object" }, name: "x", description: "d" }];
  assert.equal(
    computeSignatureSurfaceHash({ tools: t1 }),
    computeSignatureSurfaceHash({ tools: t2 }),
  );
});

test("computeSignatureSurfaceHash: shuffled nested-schema keys → same hash", () => {
  const t1 = [{ name: "x", input_schema: { type: "object", properties: { a: {}, b: {} } } }];
  const t2 = [{ name: "x", input_schema: { properties: { b: {}, a: {} }, type: "object" } }];
  assert.equal(
    computeSignatureSurfaceHash({ tools: t1 }),
    computeSignatureSurfaceHash({ tools: t2 }),
  );
});

test("computeSignatureSurfaceHash: tools[] array reorder → different hash", () => {
  const t1 = [{ name: "a" }, { name: "b" }];
  const t2 = [{ name: "b" }, { name: "a" }];
  assert.notEqual(
    computeSignatureSurfaceHash({ tools: t1 }),
    computeSignatureSurfaceHash({ tools: t2 }),
  );
});

test("computeSignatureSurfaceHash: undefined/null/[] → 'none' sentinel (all same hash)", () => {
  const a = computeSignatureSurfaceHash({ tools: undefined });
  const b = computeSignatureSurfaceHash({ tools: null });
  const c = computeSignatureSurfaceHash({ tools: [] });
  assert.equal(a, b);
  assert.equal(b, c);
});

test("computeSignatureSurfaceHash: empty sentinel differs from a tools-array containing one empty object", () => {
  const empty = computeSignatureSurfaceHash({ tools: [] });
  const oneEmpty = computeSignatureSurfaceHash({ tools: [{}] });
  assert.notEqual(empty, oneEmpty);
});

test("computeSignatureSurfaceHash: forward-compat — passing system/anthropic_beta in v2 is silently ignored", () => {
  const a = computeSignatureSurfaceHash({ tools: [{ name: "x" }] });
  const b = computeSignatureSurfaceHash({
    tools: [{ name: "x" }],
    system: "anything",
    anthropic_beta: "context-1m",
  });
  assert.equal(a, b); // v2 ignores those inputs
});

// --- v2 onRequest predicate (integration) ---
//
// These tests use a temp HOME to keep the seed-from-file path isolated, and
// reset the in-memory v2 state between cases. Each test calls _resetV2State()
// at the start and clobbers HOME so seedV2FromFile reads from an empty disk.

function withV2(fn) {
  const oldEnv = process.env.CACHE_FIX_THINKING_SANITIZE;
  const oldHome = process.env.HOME;
  const dir = mkdtempSync(joinPath(tmpdir(), "thinking-v2-"));
  process.env.CACHE_FIX_THINKING_SANITIZE = "v2";
  process.env.HOME = dir;
  _resetV2State();
  return Promise.resolve(fn()).finally(() => {
    if (oldEnv === undefined) delete process.env.CACHE_FIX_THINKING_SANITIZE;
    else process.env.CACHE_FIX_THINKING_SANITIZE = oldEnv;
    process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
    _resetV2State();
  });
}

// Simulate a full request → response cycle with the given status code.
async function fireRequest({ ctx, status = 200 }) {
  await ext.onRequest(ctx);
  // onResponseStart receives a separate context object in the real pipeline,
  // but it shares the same `meta`. Simulate that by reusing meta.
  await ext.onResponseStart({ status, meta: ctx.meta });
}

test("v2 onRequest: first request in a session — observe-and-establish, no strip", async () => {
  await withV2(async () => {
    const ctx = {
      headers: sid("S1"),
      body: {
        tools: [{ name: "a" }],
        messages: [
          { role: "assistant", content: [realSigned(), text("hello")] },
          { role: "user", content: "hi" },
          { role: "assistant", content: [realSigned()] },
        ],
      },
      meta: {},
    };
    await fireRequest({ ctx, status: 200 });
    // No strip — signed thinking still present in BOTH assistant turns.
    assert.deepEqual(ctx.body.messages[0].content, [realSigned(), text("hello")]);
    assert.deepEqual(ctx.body.messages[2].content, [realSigned()]);
    // Counters present, both zero.
    assert.equal(ctx.meta._thinkingSanitize.thinking_blocks_dropped, 0);
    assert.equal(ctx.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 0);
    // Baseline now populated (post-2xx).
    assert.match(ctx.meta._thinkingSanitizeV2.tools_hash_baseline, /^[0-9a-f]{16}$/);
  });
});

test("v2 onRequest: same hash on next request — no strip, baseline unchanged", async () => {
  await withV2(async () => {
    const tools = [{ name: "a" }];
    const ctx1 = { headers: sid("S2"), body: { tools, messages: [] }, meta: {} };
    await fireRequest({ ctx: ctx1, status: 200 });
    const baseline = ctx1.meta._thinkingSanitizeV2.tools_hash_baseline;

    const ctx2 = {
      headers: sid("S2"),
      body: {
        tools,
        messages: [
          { role: "assistant", content: [realSigned(), text("a1")] },
        ],
      },
      meta: {},
    };
    await fireRequest({ ctx: ctx2, status: 200 });
    // Same hash → no strip.
    assert.deepEqual(ctx2.body.messages[0].content, [realSigned(), text("a1")]);
    assert.equal(ctx2.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 0);
    assert.equal(ctx2.meta._thinkingSanitizeV2.tools_hash_baseline, baseline);
  });
});

test("v2 onRequest: tools-hash mismatch — strip signed thinking + redacted_thinking from prior turns", async () => {
  await withV2(async () => {
    const ctx1 = {
      headers: sid("S3"),
      body: { tools: [{ name: "a" }], messages: [] },
      meta: {},
    };
    await fireRequest({ ctx: ctx1, status: 200 });

    const ctx2 = {
      headers: sid("S3"),
      body: {
        tools: [{ name: "a" }, { name: "b" }], // ToolSearch added a tool
        messages: [
          {
            role: "assistant",
            content: [realSigned(), redacted(), text("keep this")],
          },
          { role: "user", content: "next" },
          { role: "assistant", content: [realSigned(), text("latest")] },
        ],
      },
      meta: {},
    };
    await fireRequest({ ctx: ctx2, status: 200 });
    // Strip happened on both signed thinking + redacted_thinking; text preserved.
    assert.deepEqual(ctx2.body.messages[0].content, [text("keep this")]);
    // Latest assistant turn ALSO stripped (no active tool-continuation guard).
    assert.deepEqual(ctx2.body.messages[2].content, [text("latest")]);
    // Counter reflects 3 drops (signed + redacted + signed-latest).
    assert.equal(ctx2.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 3);
  });
});

test("v2 onRequest: active-tool-continuation latest turn protected even on mismatch", async () => {
  await withV2(async () => {
    const ctx1 = {
      headers: sid("S4"),
      body: { tools: [{ name: "a" }], messages: [] },
      meta: {},
    };
    await fireRequest({ ctx: ctx1, status: 200 });

    const ctx2 = {
      headers: sid("S4"),
      body: {
        tools: [{ name: "a" }, { name: "b" }],
        messages: [
          { role: "assistant", content: [realSigned(), text("prior")] },
          { role: "user", content: "next" },
          { role: "assistant", content: [realSigned(), toolUse("t1")] },
          { role: "user", content: [toolResult("t1")] },
        ],
      },
      meta: {},
    };
    await fireRequest({ ctx: ctx2, status: 200 });
    // Prior turn stripped, latest active-continuation turn preserved.
    assert.deepEqual(ctx2.body.messages[0].content, [text("prior")]);
    assert.deepEqual(ctx2.body.messages[2].content, [realSigned(), toolUse("t1")]);
    assert.equal(ctx2.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 1);
  });
});

test("v2 onRequest: 4xx response leaves baseline unchanged", async () => {
  await withV2(async () => {
    // Establish a baseline at hash(tools=[a]).
    const ctx1 = { headers: sid("S5"), body: { tools: [{ name: "a" }], messages: [] }, meta: {} };
    await fireRequest({ ctx: ctx1, status: 200 });
    const baseline = ctx1.meta._thinkingSanitizeV2.tools_hash_baseline;

    // Fire a request with a different tools hash, response 400.
    const ctx2 = {
      headers: sid("S5"),
      body: { tools: [{ name: "b" }], messages: [{ role: "assistant", content: [realSigned()] }] },
      meta: {},
    };
    await fireRequest({ ctx: ctx2, status: 400 });

    // Strip DID happen in the request body (the mismatch fires unconditionally).
    assert.equal(ctx2.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 1);

    // But the baseline should NOT have advanced — the next request should
    // still compare against the original baseline. Verify by firing a 3rd
    // request with the same hash as the original ctx1.
    const ctx3 = { headers: sid("S5"), body: { tools: [{ name: "a" }], messages: [] }, meta: {} };
    await fireRequest({ ctx: ctx3, status: 200 });
    // Same hash as ctx1 → no strip.
    assert.equal(ctx3.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 0);
    assert.equal(ctx3.meta._thinkingSanitizeV2.tools_hash_baseline, baseline);
  });
});

test("v2 onRequest: 5xx response leaves baseline unchanged (same as 4xx; HTTP 2xx is the gate)", async () => {
  await withV2(async () => {
    const ctx1 = { headers: sid("S6"), body: { tools: [{ name: "a" }], messages: [] }, meta: {} };
    await fireRequest({ ctx: ctx1, status: 200 });
    const baseline = ctx1.meta._thinkingSanitizeV2.tools_hash_baseline;

    const ctx2 = {
      headers: sid("S6"),
      body: { tools: [{ name: "b" }], messages: [{ role: "assistant", content: [realSigned()] }] },
      meta: {},
    };
    await fireRequest({ ctx: ctx2, status: 503 });

    const ctx3 = { headers: sid("S6"), body: { tools: [{ name: "a" }], messages: [] }, meta: {} };
    await fireRequest({ ctx: ctx3, status: 200 });
    assert.equal(ctx3.meta._thinkingSanitizeV2.tools_hash_baseline, baseline);
  });
});

test("v2 onRequest: oscillation-over-strip-is-deliberate — A → B → A both transitions strip", async () => {
  await withV2(async () => {
    const toolsA = [{ name: "a" }];
    const toolsB = [{ name: "a" }, { name: "b" }];

    // Establish at A.
    const ctx1 = { headers: sid("S7"), body: { tools: toolsA, messages: [] }, meta: {} };
    await fireRequest({ ctx: ctx1, status: 200 });

    // A → B: strip prior signed thinking (mismatch).
    const ctx2 = {
      headers: sid("S7"),
      body: { tools: toolsB, messages: [{ role: "assistant", content: [realSigned()] }] },
      meta: {},
    };
    await fireRequest({ ctx: ctx2, status: 200 });
    assert.equal(ctx2.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 1);

    // B → A (reversion): strip again, because Option C treats ANY hash change
    // as invalidating. This is the deliberate false-positive class — even
    // though A's prior signatures would have re-validated, the single-baseline
    // contract doesn't track history.
    const ctx3 = {
      headers: sid("S7"),
      body: { tools: toolsA, messages: [{ role: "assistant", content: [realSigned()] }] },
      meta: {},
    };
    await fireRequest({ ctx: ctx3, status: 200 });
    assert.equal(ctx3.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 1);
  });
});

test("v2 onRequest: 'unknown' canonical session id — extension no-ops for v2 (v1 still runs)", async () => {
  await withV2(async () => {
    // No session-id header → resolves to null → canonical "unknown".
    const ctx = {
      headers: {},
      body: {
        tools: [{ name: "a" }],
        messages: [
          {
            role: "assistant",
            content: [omitted(), realSigned(), redacted(), text("a")],
          },
        ],
      },
      meta: {},
    };
    await fireRequest({ ctx, status: 200 });
    // v1's omitted-text drop still ran.
    assert.equal(ctx.meta._thinkingSanitize.thinking_blocks_dropped, 1);
    // v2 did NOT run — signed + redacted are still present after the v1 strip.
    assert.equal(ctx.meta._thinkingSanitizeV2, undefined);
    assert.deepEqual(ctx.body.messages[0].content, [realSigned(), redacted(), text("a")]);
  });
});

test("v2 onRequest: first-strip-then-stable — baseline advances on success, subsequent same-hash request doesn't strip", async () => {
  await withV2(async () => {
    const ctx1 = { headers: sid("S8"), body: { tools: [{ name: "a" }], messages: [] }, meta: {} };
    await fireRequest({ ctx: ctx1, status: 200 });

    // Mismatch + 200 → strip + baseline advances to H1.
    const ctx2 = {
      headers: sid("S8"),
      body: { tools: [{ name: "b" }], messages: [{ role: "assistant", content: [realSigned()] }] },
      meta: {},
    };
    await fireRequest({ ctx: ctx2, status: 200 });
    assert.equal(ctx2.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 1);
    const newBaseline = ctx2.meta._thinkingSanitizeV2.tools_hash_baseline;

    // Next request with the SAME hash as ctx2 (= new baseline) → no strip.
    const ctx3 = {
      headers: sid("S8"),
      body: { tools: [{ name: "b" }], messages: [{ role: "assistant", content: [realSigned()] }] },
      meta: {},
    };
    await fireRequest({ ctx: ctx3, status: 200 });
    assert.equal(ctx3.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 0);
    assert.equal(ctx3.meta._thinkingSanitizeV2.tools_hash_baseline, newBaseline);
  });
});

test("v2 onRequest: two concurrent unknown-session requests don't cross-contaminate", async () => {
  await withV2(async () => {
    // Both requests have no session id → both canonicalize to "unknown" → no-op.
    // The shared in-memory state isn't touched, so neither leaks anything to the other.
    const ctx_a = {
      headers: {},
      body: { tools: [{ name: "a" }], messages: [{ role: "assistant", content: [realSigned()] }] },
      meta: {},
    };
    const ctx_b = {
      headers: {},
      body: { tools: [{ name: "b" }], messages: [{ role: "assistant", content: [realSigned()] }] },
      meta: {},
    };
    await fireRequest({ ctx: ctx_a, status: 200 });
    await fireRequest({ ctx: ctx_b, status: 200 });
    // Both kept their signed thinking — neither acted on the other's tools shape.
    assert.equal(ctx_a.meta._thinkingSanitizeV2, undefined);
    assert.equal(ctx_b.meta._thinkingSanitizeV2, undefined);
    assert.deepEqual(ctx_a.body.messages[0].content, [realSigned()]);
    assert.deepEqual(ctx_b.body.messages[0].content, [realSigned()]);
  });
});

test("v2 mode also runs v1's omitted drop (v2 is strict superset of on)", async () => {
  await withV2(async () => {
    const ctx1 = { headers: sid("S9"), body: { tools: [{ name: "a" }], messages: [] }, meta: {} };
    await fireRequest({ ctx: ctx1, status: 200 });

    const ctx2 = {
      headers: sid("S9"),
      body: {
        tools: [{ name: "a" }, { name: "b" }],
        messages: [
          {
            role: "assistant",
            content: [omitted(), realSigned(), text("a")],
          },
        ],
      },
      meta: {},
    };
    await fireRequest({ ctx: ctx2, status: 200 });
    // v1 dropped 1 (omitted), v2 dropped 1 (signed). text("a") preserved.
    assert.equal(ctx2.meta._thinkingSanitize.thinking_blocks_dropped, 1);
    assert.equal(ctx2.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 1);
    assert.deepEqual(ctx2.body.messages[0].content, [text("a")]);
  });
});

// --- Codex follow-ups: 3 directive-plan scenarios he manually verified in
// PR #192 review but asked us to pin in automated coverage. Adding here so
// behaviors are locked into the suite, not just spot-checked at review time.

// (1) Two pipelined requests with the same new hash — both should strip
// (the second sees the SAME pre-advance baseline as the first, because the
// baseline only advances on the first request's response success), and
// the final in-memory baseline ends at the new hash.
test("v2 pipelined: two requests with the same new hash both strip; baseline ends at new hash", async () => {
  await withV2(async () => {
    const initial = { headers: sid("PIPE"), body: { tools: [{ name: "a" }], messages: [] }, meta: {} };
    await fireRequest({ ctx: initial, status: 200 });

    // Now fire two requests with NEW hash, BEFORE either advances the baseline.
    // Real pipeline: both call onRequest before either's onResponseStart.
    const newTools = [{ name: "a" }, { name: "b" }];
    const ctxA = {
      headers: sid("PIPE"),
      body: { tools: newTools, messages: [{ role: "assistant", content: [realSigned()] }] },
      meta: {},
    };
    const ctxB = {
      headers: sid("PIPE"),
      body: { tools: newTools, messages: [{ role: "assistant", content: [realSigned()] }] },
      meta: {},
    };
    // Both onRequest's fire against the original baseline → both strip.
    await ext.onRequest(ctxA);
    await ext.onRequest(ctxB);
    assert.equal(ctxA.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 1);
    assert.equal(ctxB.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 1);

    // Now both responses complete in order — both advance to the SAME new hash.
    // Acceptable; the final baseline state matches what we want.
    await ext.onResponseStart({ status: 200, meta: ctxA.meta });
    await ext.onResponseStart({ status: 200, meta: ctxB.meta });

    // Verify: subsequent same-hash request → no strip (baseline now at newTools).
    const ctxC = {
      headers: sid("PIPE"),
      body: { tools: newTools, messages: [{ role: "assistant", content: [realSigned()] }] },
      meta: {},
    };
    await fireRequest({ ctx: ctxC, status: 200 });
    assert.equal(ctxC.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 0);
  });
});

// (2) Proxy-restart re-seed from disk: after _resetV2State() simulates a
// restart, the next request reads the persisted tools_hash_baseline from
// disk and uses it for comparison. Without re-seeding, a restart would
// silently lose the baseline and a same-hash next request would incorrectly
// be treated as a "first observe" → no strip on a real mismatch.
test("v2 restart re-seed: after _resetV2State, next request reads tools_hash_baseline from sessions/<sid>.json", async () => {
  await withV2(async () => {
    // Establish baseline at H1 via cache-telemetry's full write pipeline.
    const ctx1 = {
      headers: sid("RESTART"),
      body: { tools: [{ name: "a" }], messages: [] },
      meta: {},
    };
    await fireRequest({ ctx: ctx1, status: 200 });
    // Persist the session JSON to disk by running cache-telemetry's onRequest
    // (populates _sessionId), onResponseStart (populates _quotaData from a
    // synthetic response header set), and onStreamEvent (writes the file).
    const cacheTelExt = (await import("../proxy/extensions/cache-telemetry.mjs")).default;
    // Simulate cache-telemetry's request/response/stream cycle on the SAME meta.
    // cache-telemetry.onRequest reads `ctx.headers` to resolve session id.
    await cacheTelExt.onRequest({ headers: ctx1.headers, meta: ctx1.meta });
    // Synthetic response headers with the minimum fields parseHeaders needs.
    const respHeaders = {
      "anthropic-ratelimit-unified-5h-utilization": "0.1",
      "anthropic-ratelimit-unified-5h-reset": "1700000000",
      "anthropic-ratelimit-unified-7d-utilization": "0.05",
      "anthropic-ratelimit-unified-7d-reset": "1700100000",
    };
    await cacheTelExt.onResponseStart({ headers: respHeaders, meta: ctx1.meta });
    // Stream event sequence: message_start (cache stats), message_delta (writes file).
    await cacheTelExt.onStreamEvent({
      event: { type: "message_start", message: { usage: { cache_read_input_tokens: 1, cache_creation_input_tokens: 0, input_tokens: 0 } } },
      telemetry: {},
      meta: ctx1.meta,
    });
    await cacheTelExt.onStreamEvent({
      event: { type: "message_delta", usage: { output_tokens: 1 } },
      telemetry: {},
      meta: ctx1.meta,
    });

    const persistedBaseline = ctx1.meta._thinkingSanitizeV2.tools_hash_baseline;
    assert.match(persistedBaseline, /^[0-9a-f]{16}$/);

    // Now simulate a proxy restart: clear in-memory state. Disk persists.
    _resetV2State();

    // New request with the SAME tools hash. If re-seed didn't work, the
    // restart-cleared map would treat this as a fresh observe → no strip
    // even if we tried a mismatch. To prove the re-seed: fire a DIFFERENT
    // tools hash and verify the strip fires (which only happens if the
    // baseline was loaded from disk).
    const ctx2 = {
      headers: sid("RESTART"),
      body: { tools: [{ name: "different" }], messages: [{ role: "assistant", content: [realSigned()] }] },
      meta: {},
    };
    await fireRequest({ ctx: ctx2, status: 200 });
    // If re-seed worked: baseline was loaded as `persistedBaseline`, ctx2 has
    // a different hash → mismatch → strip fires.
    assert.equal(ctx2.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 1);
  });
});

// (3) End-to-end v2 session-file merge: drive a full request through both
// thinking-block-sanitize v2 AND cache-telemetry's write path. Verify that
// the on-disk sessions/<sid>.json contains BOTH the cache-telemetry fields
// (cache_read, cache_creation, etc.) AND the v2 spread fields
// (thinking_blocks_dropped_v2, tools_hash_baseline) — proves the spread
// block at cache-telemetry.mjs:247 is wired correctly.
test("v2 session-file merge: cache-telemetry spread writes v2 fields to sessions/<sid>.json", async () => {
  await withV2(async () => {
    const ctx = {
      headers: sid("MERGE-E2E"),
      body: {
        tools: [{ name: "a" }, { name: "b" }],
        messages: [{ role: "assistant", content: [realSigned()] }],
      },
      meta: {},
    };
    // Establish v2 baseline first so this request will actually strip.
    const seed = { headers: sid("MERGE-E2E"), body: { tools: [{ name: "a" }], messages: [] }, meta: {} };
    await fireRequest({ ctx: seed, status: 200 });
    // Now drive the test request through the full pipeline.
    await ext.onRequest(ctx);
    assert.equal(ctx.meta._thinkingSanitizeV2.thinking_blocks_dropped_v2, 1);

    const cacheTelExt = (await import("../proxy/extensions/cache-telemetry.mjs")).default;
    await cacheTelExt.onRequest({ headers: ctx.headers, meta: ctx.meta });
    const respHeaders = {
      "anthropic-ratelimit-unified-5h-utilization": "0.2",
      "anthropic-ratelimit-unified-5h-reset": "1700000000",
      "anthropic-ratelimit-unified-7d-utilization": "0.1",
      "anthropic-ratelimit-unified-7d-reset": "1700100000",
    };
    await cacheTelExt.onResponseStart({ headers: respHeaders, meta: ctx.meta });
    await ext.onResponseStart({ status: 200, meta: ctx.meta });
    await cacheTelExt.onStreamEvent({
      event: { type: "message_start", message: { usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 50, input_tokens: 10 } } },
      telemetry: {},
      meta: ctx.meta,
    });
    await cacheTelExt.onStreamEvent({
      event: { type: "message_delta", usage: { output_tokens: 5 } },
      telemetry: {},
      meta: ctx.meta,
    });

    // Read back the persisted file from the temp HOME.
    const { sessionFilePath: sfp } = await import("../proxy/extensions/cache-telemetry.mjs");
    const { readFileSync: rfs } = await import("node:fs");
    const sessionFileContents = JSON.parse(rfs(sfp("MERGE-E2E"), "utf8"));

    // Verify cache-telemetry fields are present.
    assert.equal(sessionFileContents.cache.cache_read, 100);
    assert.equal(sessionFileContents.cache.cache_creation, 50);

    // Verify v2 fields are present (the merge worked).
    assert.equal(sessionFileContents.thinking_blocks_dropped_v2, 1);
    assert.match(sessionFileContents.tools_hash_baseline, /^[0-9a-f]{16}$/);
    // The persisted baseline should equal the new hash (post-2xx advance).
    assert.equal(sessionFileContents.tools_hash_baseline, ctx.meta._thinkingSanitizeV2.tools_hash_baseline);
  });
});
