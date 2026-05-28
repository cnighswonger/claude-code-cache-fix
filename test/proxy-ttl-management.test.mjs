import { test } from "node:test";
import assert from "node:assert/strict";
import ext, { detectRequestType, injectTtl } from "../proxy/extensions/ttl-management.mjs";

// --- Unit tests ---

test("detectRequestType: detects subagent by Agent SDK prefix", () => {
  const system = [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK. More text here." }];
  assert.equal(detectRequestType(system), "subagent");
});

test("detectRequestType: detects main thread", () => {
  const system = [{ type: "text", text: "You are Claude Code, Anthropic's CLI" }];
  assert.equal(detectRequestType(system), "main");
});

test("detectRequestType: returns main for empty system", () => {
  assert.equal(detectRequestType([]), "main");
  assert.equal(detectRequestType(null), "main");
});

test("injectTtl: adds ttl to existing ephemeral cache_control", () => {
  const block = { type: "text", text: "content", cache_control: { type: "ephemeral" } };
  const result = injectTtl(block, "1h");
  assert.deepEqual(result.cache_control, { type: "ephemeral", ttl: "1h" });
});

test("injectTtl: does not modify block without cache_control", () => {
  const block = { type: "text", text: "content" };
  const result = injectTtl(block, "1h");
  assert.equal(result, block);
});

test("injectTtl: does not overwrite existing ttl", () => {
  const block = { type: "text", text: "content", cache_control: { type: "ephemeral", ttl: "5m" } };
  const result = injectTtl(block, "1h");
  assert.equal(result, block);
});

// --- thinking-block guard (cache-fix #157) ---
// Thinking / redacted_thinking blocks must be returned byte-identical; injecting
// a ttl into a cache_control that landed on one would mutate the block and the
// API rejects with "thinking blocks ... cannot be modified". injectTtl must skip
// them even when they carry an ephemeral cache_control without a ttl.

test("injectTtl: does NOT modify a thinking block with ephemeral cache_control", () => {
  const block = { type: "thinking", thinking: "", signature: "SIG==", cache_control: { type: "ephemeral" } };
  const result = injectTtl(block, "1h");
  assert.equal(result, block, "must return the same block reference, untouched");
  assert.deepEqual(result.cache_control, { type: "ephemeral" }, "no ttl injected");
});

test("injectTtl: does NOT modify a redacted_thinking block with ephemeral cache_control", () => {
  const block = { type: "redacted_thinking", data: "OPAQUE==", cache_control: { type: "ephemeral" } };
  const result = injectTtl(block, "1h");
  assert.equal(result, block);
  assert.deepEqual(result.cache_control, { type: "ephemeral" });
});

test("injectTtl: still injects ttl into a non-thinking block (happy-path regression guard)", () => {
  const block = { type: "text", text: "content", cache_control: { type: "ephemeral" } };
  const result = injectTtl(block, "1h");
  assert.deepEqual(result.cache_control, { type: "ephemeral", ttl: "1h" });
});

// --- Integration test: onRequest ---

test("onRequest: injects TTL on system blocks with existing cache_control", async () => {
  const ctx = {
    body: {
      system: [
        { type: "text", text: "System prompt", cache_control: { type: "ephemeral" } },
      ],
      messages: [],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.deepEqual(ctx.body.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
});

test("onRequest: no-op on system blocks without cache_control", async () => {
  const ctx = {
    body: {
      system: [{ type: "text", text: "No markers here" }],
      messages: [],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.equal(ctx.body.system[0].cache_control, undefined);
});

test("onRequest: leaves a thinking block untouched but still injects ttl on a sibling text block", async () => {
  // Interleaved-thinking turn where a cache breakpoint landed on the thinking
  // block AND on a sibling text block. The thinking block must come out
  // byte-identical (preserving its signature); the text block gets the ttl.
  const ctx = {
    body: {
      system: [{ type: "text", text: "System prompt" }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "SIG==", cache_control: { type: "ephemeral" } },
            { type: "text", text: "answer", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    },
    headers: {},
    meta: { _ttlTier: "1h" },
  };

  await ext.onRequest(ctx);
  const [thinkBlock, textBlock] = ctx.body.messages[0].content;
  assert.deepEqual(thinkBlock.cache_control, { type: "ephemeral" }, "thinking block cache_control unchanged");
  assert.deepEqual(textBlock.cache_control, { type: "ephemeral", ttl: "1h" }, "sibling text block got ttl");
});

// --- Auto-detection consumption tests (directive #12-#17) ---

const SYSTEM_PROMPT = "You are Claude Code, Anthropic's CLI";
const SUBAGENT_PROMPT = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

async function withEnv(envOverrides, fn) {
  const keys = Object.keys(envOverrides);
  const original = {};
  for (const k of keys) {
    original[k] = process.env[k];
    if (envOverrides[k] === undefined) delete process.env[k];
    else process.env[k] = String(envOverrides[k]);
  }
  // ttl-management reads TTL_MAIN/TTL_SUBAGENT at module load. To honor env
  // overrides per-test we re-import the module. Use a cache-busting suffix.
  const mod = await import("../proxy/extensions/ttl-management.mjs?t=" + Date.now() + Math.random());
  try {
    await fn(mod.default);
  } finally {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  }
}

function mainCtx(meta = {}) {
  return {
    body: {
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    },
    headers: {},
    meta,
  };
}

function subagentCtx(meta = {}) {
  return {
    body: {
      system: [
        { type: "text", text: SUBAGENT_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [],
    },
    headers: {},
    meta,
  };
}

test("ttl-management: _ttlTier='5m' + default env → all blocks get 5m", async () => {
  await withEnv({ CACHE_FIX_TTL_MAIN: undefined, CACHE_FIX_TTL_SUBAGENT: undefined }, async (mod) => {
    const ctx = mainCtx({ _ttlTier: "5m" });
    await mod.onRequest(ctx);
    assert.deepEqual(ctx.body.system[0].cache_control, { type: "ephemeral", ttl: "5m" });
    assert.deepEqual(ctx.body.messages[0].content[0].cache_control, { type: "ephemeral", ttl: "5m" });
  });
});

test("ttl-management: _ttlTier='1h' (or undefined) + default env → all blocks get 1h", async () => {
  await withEnv({ CACHE_FIX_TTL_MAIN: undefined, CACHE_FIX_TTL_SUBAGENT: undefined }, async (mod) => {
    const ctx = mainCtx(); // no _ttlTier set
    await mod.onRequest(ctx);
    assert.deepEqual(ctx.body.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
    assert.deepEqual(ctx.body.messages[0].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
  });
});

test("ttl-management: env CACHE_FIX_TTL_MAIN=5m + _ttlTier='1h' → blocks get 5m (env wins)", async () => {
  await withEnv({ CACHE_FIX_TTL_MAIN: "5m", CACHE_FIX_TTL_SUBAGENT: undefined }, async (mod) => {
    const ctx = mainCtx({ _ttlTier: "1h" });
    await mod.onRequest(ctx);
    assert.deepEqual(ctx.body.system[0].cache_control, { type: "ephemeral", ttl: "5m" });
  });
});

test("ttl-management: env CACHE_FIX_TTL_MAIN=none + _ttlTier='5m' → no injection (none suppresses)", async () => {
  await withEnv({ CACHE_FIX_TTL_MAIN: "none", CACHE_FIX_TTL_SUBAGENT: undefined }, async (mod) => {
    const ctx = mainCtx({ _ttlTier: "5m" });
    await mod.onRequest(ctx);
    assert.deepEqual(ctx.body.system[0].cache_control, { type: "ephemeral" });
    assert.deepEqual(ctx.body.messages[0].content[0].cache_control, { type: "ephemeral" });
  });
});

test("ttl-management: subagent env=1h + _ttlTier='5m' → blocks get 5m (auto-upgrade applies to subagent too)", async () => {
  await withEnv({ CACHE_FIX_TTL_MAIN: undefined, CACHE_FIX_TTL_SUBAGENT: "1h" }, async (mod) => {
    const ctx = subagentCtx({ _ttlTier: "5m" });
    await mod.onRequest(ctx);
    assert.deepEqual(ctx.body.system[0].cache_control, { type: "ephemeral", ttl: "5m" });
  });
});

test("ttl-management: existing ttl='5m' marker is not overwritten", async () => {
  await withEnv({ CACHE_FIX_TTL_MAIN: undefined, CACHE_FIX_TTL_SUBAGENT: undefined }, async (mod) => {
    const ctx = {
      body: {
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "5m" } },
        ],
        messages: [],
      },
      headers: {},
      meta: { _ttlTier: "1h" },
    };
    await mod.onRequest(ctx);
    assert.deepEqual(ctx.body.system[0].cache_control, { type: "ephemeral", ttl: "5m" });
  });
});
