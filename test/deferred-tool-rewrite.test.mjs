import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ext, {
  resolveToolRewriteSessionKey,
  supportsToolAddition,
  toolFingerprint,
  classifyToolChange,
  buildToolAdditionMessage,
  injectAdditions,
  forwardedTools,
  anchorHash,
  addBetaToken,
} from "../proxy/extensions/deferred-tool-rewrite.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "toolload-1247.json");
const GC_FIXTURE_PATH = join(__dirname, "fixtures", "toolgc-1536.json");

async function newTmp() {
  return mkdtemp(join(tmpdir(), "deferred-tool-rewrite-test-"));
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function withEnvAsync(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// The announcement path is gated on MODEL support (see supportsToolAddition):
// a body without a model is "unknown", which is deliberately OFF. Most tests
// here predate that gate and exercise the announcement, so they default to a
// supported model; the tests that care about the gate set `model` explicitly.
async function runExt(body, { headers, dir } = {}) {
  const savedHome = process.env.CLAUDE_CONFIG_DIR;
  if (dir) process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const withModel = body && body.model === undefined ? { ...body, model: "claude-opus-5" } : body;
    const ctx = { body: withModel, meta: {}, headers: headers || {} };
    await ext.onRequest(ctx);
    return ctx;
  } finally {
    if (dir) {
      if (savedHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedHome;
    }
  }
}

function tool(name, extra = {}) {
  return { name, input_schema: { type: "object", properties: {} }, ...extra };
}

// =============================================================================
// GATE OFF = INERT
// =============================================================================

test("gate off (CACHE_FIX_TOOL_REWRITE unset) — onRequest is a no-op", async () => {
  const dir = await newTmp();
  try {
    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: undefined }, async () => {
      const body = { tools: [tool("Read"), tool("Bash")], messages: [] };
      const ctx = await runExt(body, { dir });
      assert.equal(ctx.meta.deferredToolRewriteStats, undefined);
      assert.deepEqual(ctx.body.tools, [tool("Read"), tool("Bash")]);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// PURE CLASSIFIER
// =============================================================================

test("classifyToolChange: no prior baseline → action no-baseline, knownTools = incoming", () => {
  const incoming = [tool("Read"), tool("Bash")];
  const result = classifyToolChange(incoming, null);
  assert.equal(result.action, "no-baseline");
  assert.deepEqual(result.knownTools, incoming);
});

test("classifyToolChange: identical tools[] → action unchanged", () => {
  const prior = [tool("Read"), tool("Bash")];
  const incoming = [tool("Read"), tool("Bash")];
  const result = classifyToolChange(incoming, prior);
  assert.equal(result.action, "unchanged");
});

test("classifyToolChange: pure addition (SendMessage added) → action rewrite, new tool marked defer_loading:true", () => {
  const prior = [tool("Read"), tool("Bash")];
  const incoming = [tool("Read"), tool("Bash"), tool("SendMessage")];
  const result = classifyToolChange(incoming, prior);
  assert.equal(result.action, "rewrite");
  assert.deepEqual(result.newNames, ["SendMessage"]);
  assert.equal(result.tools.length, 3);
  assert.equal(result.tools[0].name, "Read");
  assert.equal(result.tools[0].defer_loading, undefined, "existing tools are not marked defer_loading");
  assert.equal(result.tools[2].name, "SendMessage");
  assert.equal(result.tools[2].defer_loading, true);
});

test("classifyToolChange: existing tool removed → action rewrite, held in place at its first-seen position, byte-identical", () => {
  const prior = [tool("Read"), tool("Bash")];
  const incoming = [tool("Read")]; // Bash missing — harness GC'd it
  const result = classifyToolChange(incoming, prior);
  assert.equal(result.action, "rewrite");
  assert.deepEqual(result.heldNames, ["Bash"]);
  assert.equal(result.newNames.length, 0);
  assert.equal(result.tools.length, 2, "held tool is re-inserted");
  assert.deepEqual(result.tools[0], tool("Read"));
  assert.deepEqual(result.tools[1], tool("Bash"), "held tool is byte-identical to its known form");
});

test("classifyToolChange: pure reorder (no add/remove) → action rewrite, output pinned to first-seen order", () => {
  const prior = [tool("Read"), tool("Bash"), tool("SendMessage")];
  const incoming = [tool("SendMessage"), tool("Read"), tool("Bash")]; // reordered, nothing added/removed
  const result = classifyToolChange(incoming, prior);
  assert.equal(result.action, "rewrite");
  assert.deepEqual(result.heldNames, []);
  assert.deepEqual(result.newNames, []);
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["Read", "Bash", "SendMessage"],
    "output order is first-seen order, not the incoming array's order",
  );
});

test("classifyToolChange: existing tool's schema changed → action reset, reason tool-schema-changed", () => {
  const prior = [tool("Read", { input_schema: { type: "object", properties: { file_path: { type: "string" } } } })];
  const incoming = [tool("Read", { input_schema: { type: "object", properties: { path: { type: "string" } } } })];
  const result = classifyToolChange(incoming, prior);
  assert.equal(result.action, "reset");
  assert.equal(result.reason, "tool-schema-changed");
});

test("classifyToolChange: addition AND removal in the same request → composes (held removal + additive new tool), still rewrite", () => {
  const prior = [tool("Read"), tool("Bash")];
  const incoming = [tool("Read"), tool("SendMessage")]; // Bash removed, SendMessage added
  const result = classifyToolChange(incoming, prior);
  assert.equal(result.action, "rewrite");
  assert.deepEqual(result.heldNames, ["Bash"]);
  assert.deepEqual(result.newNames, ["SendMessage"]);
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["Read", "Bash", "SendMessage"],
    "held tool re-inserted at its first-seen position, new tool appended",
  );
  assert.equal(result.tools[2].defer_loading, true);
});

test("classifyToolChange: a tool carrying OUR OWN defer_loading marker from a prior rewrite is not misread as schema-changed", () => {
  // Simulates: prior known set was captured AFTER a rewrite had already
  // marked a tool defer_loading:true; toolFingerprint must ignore that
  // marker so re-comparing it against itself is still "unchanged".
  const priorWithMarker = [tool("Read"), { ...tool("SendMessage"), defer_loading: true }];
  const incoming = [tool("Read"), tool("SendMessage")]; // no marker this time — still the same tool
  const result = classifyToolChange(incoming, priorWithMarker);
  assert.equal(result.action, "unchanged");
});

test("toolFingerprint: order-independent on schema property keys", () => {
  const a = tool("Read", { input_schema: { type: "object", properties: { a: {}, b: {} } } });
  const b = tool("Read", { input_schema: { type: "object", properties: { b: {}, a: {} } } });
  assert.equal(toolFingerprint(a), toolFingerprint(b));
});

test("toolFingerprint: missing tool or missing name → null", () => {
  assert.equal(toolFingerprint(null), null);
  assert.equal(toolFingerprint({}), null);
});

// =============================================================================
// WIRE SHAPES
// =============================================================================

test("buildToolAdditionMessage: documented contract — system-role message with tool_addition/tool_reference blocks", () => {
  const msg = buildToolAdditionMessage(["SendMessage", "TaskCreate"]);
  assert.equal(msg.role, "system");
  assert.equal(msg.content.length, 2);
  assert.deepEqual(msg.content[0], {
    type: "tool_addition",
    tool: { type: "tool_reference", name: "SendMessage" },
  });
  assert.deepEqual(msg.content[1], {
    type: "tool_addition",
    tool: { type: "tool_reference", name: "TaskCreate" },
  });
});

test("injectAdditions: splices the persisted message after its anchor, byte-identical", () => {
  const u0 = { role: "user", content: [{ type: "text", text: "u0" }] };
  const a1 = { role: "assistant", content: [{ type: "text", text: "a1" }] };
  const u2 = { role: "user", content: [{ type: "text", text: "u2" }] };
  const addMsg = buildToolAdditionMessage(["SendMessage"]);
  const additions = [{ names: ["SendMessage"], anchorHash: anchorHash(u0), message: addMsg }];
  const { messages, reanchored } = injectAdditions([u0, a1, u2], additions);
  assert.equal(reanchored.length, 0);
  assert.equal(messages.length, 4);
  assert.equal(messages[1], addMsg, "injected immediately after the anchor");
  assert.equal(messages[0], u0);
  assert.equal(messages[2], a1);
});

test("injectAdditions: pruned anchor → re-anchor after last user message, reported", () => {
  const uNew = { role: "user", content: [{ type: "text", text: "new turn" }] };
  const addMsg = buildToolAdditionMessage(["SendMessage"]);
  const additions = [{ names: ["SendMessage"], anchorHash: "gone-hash", message: addMsg }];
  const { messages, reanchored } = injectAdditions([uNew], additions);
  assert.equal(messages.length, 2);
  assert.equal(messages[1], addMsg, "re-anchored after the last user message");
  assert.equal(reanchored.length, 1);
  assert.equal(reanchored[0].anchorHash, anchorHash(uNew));
});

test("injectAdditions: no user message at all → injection skipped, reported with null anchor", () => {
  const a = { role: "assistant", content: [{ type: "text", text: "only assistant" }] };
  const addMsg = buildToolAdditionMessage(["SendMessage"]);
  const additions = [{ names: ["SendMessage"], anchorHash: "gone", message: addMsg }];
  const { messages, reanchored } = injectAdditions([a], additions);
  assert.equal(messages.length, 1, "nothing injected");
  assert.equal(reanchored[0].anchorHash, null);
});

// BITE — the LIFO bug (BACKLOG "READY — fix injectAdditions' LIFO stacking").
// A real capture, n=372-397: an MCP-tool-discovery cascade produces
// one new `additions` entry per request, all anchored to the SAME message
// (the real conversation stays at 1 message the whole burst). The buggy
// implementation re-finds the anchor fresh on every iteration (the search
// excludes role==="system", so already-injected additions are invisible to
// it) and always splices at anchorIdx+1 — so the newest addition always
// lands closest to the anchor, pushing every earlier addition one slot
// further back: a LIFO stack that reorders the already-forwarded prefix on
// every new addition. Fix: a shared anchor's run stays in discovery order
// (FIFO) — a new addition appends AFTER the additions already injected
// there, so the forwarded prefix is a byte-stable prefix of every
// subsequent output and only the tail of the run grows.
test("injectAdditions: three additions sharing one anchor → output is discovery order (FIFO), not LIFO", () => {
  const u0 = { role: "user", content: [{ type: "text", text: "u0" }] };
  const sharedAnchor = anchorHash(u0);
  const addA = buildToolAdditionMessage(["ToolA"]);
  const addB = buildToolAdditionMessage(["ToolB"]);
  const addC = buildToolAdditionMessage(["ToolC"]);

  // additions array is in DISCOVERY order (oldest first), matching how
  // onRequest concatenates them across successive requests.
  const additions = [
    { names: ["ToolA"], anchorHash: sharedAnchor, message: addA },
    { names: ["ToolB"], anchorHash: sharedAnchor, message: addB },
    { names: ["ToolC"], anchorHash: sharedAnchor, message: addC },
  ];

  const { messages } = injectAdditions([u0], additions);
  assert.deepEqual(
    messages.map((m) => m.content?.[0]?.tool?.name ?? "u0"),
    ["u0", "ToolA", "ToolB", "ToolC"],
    "run stays in discovery order — ToolA first (oldest), ToolC last (newest), never reordered",
  );
});

test("injectAdditions: shared-anchor prefix stability — output N is a byte-prefix of output N+1", () => {
  const u0 = { role: "user", content: [{ type: "text", text: "u0" }] };
  const sharedAnchor = anchorHash(u0);
  const addA = buildToolAdditionMessage(["ToolA"]);
  const addB = buildToolAdditionMessage(["ToolB"]);

  // Simulates two successive requests: first only ToolA has been discovered,
  // then ToolB arrives too (additions accumulate, oldest first — as onRequest
  // does via `additions.concat([...])`).
  const afterFirst = injectAdditions([u0], [{ names: ["ToolA"], anchorHash: sharedAnchor, message: addA }]);
  const afterSecond = injectAdditions(
    [u0],
    [
      { names: ["ToolA"], anchorHash: sharedAnchor, message: addA },
      { names: ["ToolB"], anchorHash: sharedAnchor, message: addB },
    ],
  );

  const prefixBytes = JSON.stringify(afterFirst.messages);
  const nextBytes = JSON.stringify(afterSecond.messages.slice(0, afterFirst.messages.length));
  assert.equal(
    nextBytes,
    prefixBytes,
    "the already-forwarded prefix must be byte-identical once a new addition arrives — only the tail grows",
  );
  assert.equal(afterSecond.messages.length, 3, "the new addition appends at the tail of the run");
});

test("forwardedTools: names covered by additions get defer_loading, others stay untouched", () => {
  const known = [tool("Read"), tool("SendMessage")];
  const additions = [{ names: ["SendMessage"], anchorHash: "h", message: {} }];
  const fwd = forwardedTools(known, additions);
  assert.deepEqual(fwd[0], tool("Read"));
  assert.equal(fwd[1].defer_loading, true);
});

test("addBetaToken: adds the token when header absent", () => {
  const headers = {};
  addBetaToken(headers);
  assert.equal(headers["anthropic-beta"], "mid-conversation-tool-changes-2026-07-01");
});

test("addBetaToken: appends to an existing anthropic-beta header without duplicating", () => {
  const headers = { "anthropic-beta": "other-beta-2026-01-01" };
  addBetaToken(headers);
  assert.equal(headers["anthropic-beta"], "other-beta-2026-01-01, mid-conversation-tool-changes-2026-07-01");
  addBetaToken(headers); // idempotent
  assert.equal(headers["anthropic-beta"], "other-beta-2026-01-01, mid-conversation-tool-changes-2026-07-01");
});

test("addBetaToken: case-insensitive header key lookup (Anthropic-Beta)", () => {
  const headers = { "Anthropic-Beta": "x" };
  addBetaToken(headers);
  assert.equal(headers["Anthropic-Beta"], "x, mid-conversation-tool-changes-2026-07-01");
  assert.equal(headers["anthropic-beta"], undefined, "must mutate the existing key, not add a duplicate");
});

// =============================================================================
// EXTENSION CONTRACT — full onRequest round trip
// =============================================================================

test("onRequest: first request (no prior state) → tools forwarded unchanged, baseline persisted", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-first" };
  try {
    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      const body = { tools: [tool("Read"), tool("Bash")], system: [{ type: "text", text: "sys" }], messages: [] };
      const ctx = await runExt(body, { headers, dir });
      assert.equal(ctx.meta.deferredToolRewriteStats.action, "no-baseline");
      assert.deepEqual(ctx.body.tools, [tool("Read"), tool("Bash")]);
      assert.equal(ctx.body.system.length, 1, "no tool_addition appended on the baseline-establishing request");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("onRequest: second request adds SendMessage → tools[] byte-stable for known tools + defer_loading on the new one + tool_addition system block + beta header", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-add" };
  try {
    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      // Same conversation across both requests: msgs[0] is what identifies
      // one, so an empty first request would now be a DIFFERENT conversation
      // (and no real first request is empty).
      const u1 = { role: "user", content: [{ type: "text", text: "turn 1" }] };
      const body1 = { tools: [tool("Read"), tool("Bash")], system: [{ type: "text", text: "sys" }], messages: [u1] };
      await runExt(body1, { headers, dir });

      const body2 = {
        tools: [tool("Read"), tool("Bash"), tool("SendMessage")],
        system: [{ type: "text", text: "sys" }],
        messages: [u1],
      };
      const ctx2 = await runExt(body2, { headers, dir });

      assert.equal(ctx2.meta.deferredToolRewriteStats.action, "rewrite");
      assert.deepEqual(ctx2.meta.deferredToolRewriteStats.newNames, ["SendMessage"]);

      // Known tools byte-stable (no defer_loading marker added to them).
      assert.deepEqual(ctx2.body.tools[0], tool("Read"));
      assert.deepEqual(ctx2.body.tools[1], tool("Bash"));
      // New tool additively marked.
      assert.equal(ctx2.body.tools[2].name, "SendMessage");
      assert.equal(ctx2.body.tools[2].defer_loading, true);

      // Top-level system UNTOUCHED (Phase A appended here — wrong location).
      assert.equal(ctx2.body.system.length, 1);
      // The announcement is a system-ROLE message injected into messages[],
      // after the anchor (the last message at addition time).
      assert.equal(ctx2.body.messages.length, 2);
      const injected = ctx2.body.messages[1];
      assert.equal(injected.role, "system");
      assert.deepEqual(injected.content[0], {
        type: "tool_addition",
        tool: { type: "tool_reference", name: "SendMessage" },
      });

      // Beta header added.
      assert.equal(headers["anthropic-beta"], "mid-conversation-tool-changes-2026-07-01");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("onRequest: subsequent requests re-inject byte-identically at the same anchor (statelessness handled)", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-stable" };
  try {
    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      const u1 = { role: "user", content: [{ type: "text", text: "turn 1" }] };
      const body1 = { tools: [tool("Read"), tool("Bash")], system: [{ type: "text", text: "sys" }], messages: [u1] };
      await runExt(body1, { headers, dir });

      const body2 = {
        tools: [tool("Read"), tool("Bash"), tool("SendMessage")],
        system: [{ type: "text", text: "sys" }],
        messages: [u1],
      };
      const ctx2 = await runExt(body2, { headers, dir });
      const injectedAt2 = JSON.stringify(ctx2.body.messages[1]);

      // Requests 3 and 4: CC sends its own view (no injected message, no
      // defer_loading markers) with the conversation advancing. The proxy
      // must re-inject at the SAME anchor, byte-identically, and re-apply
      // the frozen tools[] with the marker — every request.
      for (const extra of [
        [{ role: "assistant", content: [{ type: "text", text: "a2" }] }],
        [
          { role: "assistant", content: [{ type: "text", text: "a2" }] },
          { role: "user", content: [{ type: "text", text: "turn 3" }] },
        ],
      ]) {
        const body = {
          tools: [tool("Read"), tool("Bash"), tool("SendMessage")],
          system: [{ type: "text", text: "sys" }],
          messages: [u1, ...extra],
        };
        const ctx = await runExt(body, { headers, dir });
        assert.equal(ctx.meta.deferredToolRewriteStats.action, "unchanged");
        assert.equal(ctx.meta.deferredToolRewriteStats.injected, 1);
        // Injection sits right after the anchor (u1), byte-identical.
        assert.equal(JSON.stringify(ctx.body.messages[1]), injectedAt2);
        // Frozen tools[] with defer_loading re-applied.
        assert.equal(ctx.body.tools[2].defer_loading, true);
        // Top-level system never touched.
        assert.equal(ctx.body.system.length, 1);
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("onRequest: pruned anchor → re-anchor once, stable thereafter", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-prune" };
  try {
    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      // msgs[0] identifies the conversation, so it must SURVIVE the prune for
      // this to exercise re-anchoring rather than a new conversation. The
      // addition anchors to the LAST message, so anchor and msgs[0] are
      // deliberately different messages here.
      const u0 = { role: "user", content: [{ type: "text", text: "turn 0" }] };
      const u1 = { role: "user", content: [{ type: "text", text: "turn 1" }] };
      await runExt({ tools: [tool("Read")], system: [], messages: [u0] }, { headers, dir });
      await runExt(
        { tools: [tool("Read"), tool("SendMessage")], system: [], messages: [u0, u1] },
        { headers, dir },
      );

      // Context management pruned the ANCHOR message while msgs[0] survives —
      // the same conversation, minus the turn the addition was anchored to.
      // (Replacing msgs[0] instead would be a different conversation by
      // design: the prefix died at index 0, so no cache survives it and a
      // fresh state costs nothing. The re-anchor path is for this case.)
      const uNew = { role: "user", content: [{ type: "text", text: "post-prune turn" }] };
      const ctx3 = await runExt(
        { tools: [tool("Read"), tool("SendMessage")], system: [], messages: [u0, uNew] },
        { headers, dir },
      );
      assert.equal(ctx3.meta.deferredToolRewriteStats.reanchored, 1);
      assert.equal(ctx3.body.messages[2].role, "system", "re-anchored after the last user message");

      // Next request: the new anchor holds — no further re-anchor.
      const ctx4 = await runExt(
        {
          tools: [tool("Read"), tool("SendMessage")],
          system: [],
          messages: [u0, uNew, { role: "assistant", content: [{ type: "text", text: "a" }] }],
        },
        { headers, dir },
      );
      assert.equal(ctx4.meta.deferredToolRewriteStats.reanchored, 0);
      // Anchored after uNew, which is now index 1 — so the injection is at 2.
      assert.equal(ctx4.body.messages[2].role, "system");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("onRequest BITE: MCP-discovery cascade — same 1-message conversation, tools[] grows 3x → additions stack in discovery order, prefix stable", async () => {
  // Mirrors that real capture (n=372-397): CC's own progressive
  // MCP-tool-discovery cascade at session boot sends one new tool batch per
  // request while the real conversation never grows past 1 message, so every
  // addition shares the identical anchor (messages[0]).
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-cascade" };
  try {
    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      const u0 = { role: "user", content: [{ type: "text", text: "u0" }] };
      const base = { system: [], messages: [u0], model: "claude-opus-5" };

      await runExt({ ...base, tools: [tool("Read"), tool("Bash")] }, { headers, dir }); // no-baseline
      const ctx1 = await runExt(
        { ...base, tools: [tool("Read"), tool("Bash"), tool("ToolA")] },
        { headers, dir },
      );
      const ctx2 = await runExt(
        { ...base, tools: [tool("Read"), tool("Bash"), tool("ToolA"), tool("ToolB")] },
        { headers, dir },
      );
      const ctx3 = await runExt(
        { ...base, tools: [tool("Read"), tool("Bash"), tool("ToolA"), tool("ToolB"), tool("ToolC")] },
        { headers, dir },
      );

      const names = (ctx) =>
        ctx.body.messages
          .filter((m) => m.role === "system" && Array.isArray(m.content) && m.content[0]?.type === "tool_addition")
          .flatMap((m) => m.content.map((b) => b.tool.name));

      assert.deepEqual(names(ctx1), ["ToolA"]);
      assert.deepEqual(names(ctx2), ["ToolA", "ToolB"], "ToolA stays first — discovery order, not LIFO");
      assert.deepEqual(names(ctx3), ["ToolA", "ToolB", "ToolC"], "run grows only at the tail");

      // The forwarded prefix already produced must be a byte-prefix of the
      // next request's output — this is the "reorders the already-forwarded
      // prefix" bust the probe measured.
      const prefixOf = (ctx, n) => JSON.stringify(ctx.body.messages.slice(0, n));
      assert.equal(prefixOf(ctx2, ctx1.body.messages.length), JSON.stringify(ctx1.body.messages));
      assert.equal(prefixOf(ctx3, ctx2.body.messages.length), JSON.stringify(ctx2.body.messages));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("onRequest: a tool removed after an addition → HELD (rewrite, passthrough of held tool), no beta header (nothing new to defer)", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-hold" };
  try {
    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      const body1 = { tools: [tool("Read"), tool("Bash")], system: [{ type: "text", text: "sys" }], messages: [] };
      await runExt(body1, { headers, dir });

      const body2 = { tools: [tool("Read")], system: [{ type: "text", text: "sys" }], messages: [] };
      const ctx2 = await runExt(body2, { headers, dir });

      assert.equal(ctx2.meta.deferredToolRewriteStats.action, "rewrite");
      assert.deepEqual(ctx2.meta.deferredToolRewriteStats.heldNames, ["Bash"]);
      assert.deepEqual(ctx2.body.tools, [tool("Read"), tool("Bash")], "Bash held in place, byte-identical");
      assert.equal(ctx2.body.system.length, 1, "a hold announces nothing — no tool_addition block appended");
      assert.equal(headers["anthropic-beta"], undefined, "no defer_loading tool this turn -> no beta token needed");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("onRequest: a known tool's SCHEMA changing (not removal) → still resets (honest content change, never served stale)", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-schema-reset" };
  try {
    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      const body1 = { tools: [tool("Read"), tool("Bash")], system: [{ type: "text", text: "sys" }], messages: [] };
      await runExt(body1, { headers, dir });

      const body2 = {
        tools: [tool("Read", { input_schema: { type: "object", properties: { path: { type: "string" } } } }), tool("Bash")],
        system: [{ type: "text", text: "sys" }],
        messages: [],
      };
      const ctx2 = await runExt(body2, { headers, dir });

      assert.equal(ctx2.meta.deferredToolRewriteStats.action, "reset");
      assert.equal(ctx2.meta.deferredToolRewriteStats.reason, "tool-schema-changed");
      assert.equal(headers["anthropic-beta"], undefined);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("onRequest: state persists across a simulated restart (fresh dynamic import) via disk", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-restart" };
  try {
    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      const body1 = { tools: [tool("Read"), tool("Bash")], system: [{ type: "text", text: "sys" }], messages: [] };
      await runExt(body1, { headers, dir });

      // Simulate restart: fresh module import, empty in-memory state — the
      // classifier must reload the persisted baseline from disk.
      const { pathToFileURL } = await import("node:url");
      const modPath = join(__dirname, "..", "proxy", "extensions", "deferred-tool-rewrite.mjs");
      const reloaded = await import(pathToFileURL(modPath).href + "?restart-probe=" + Date.now());

      const savedHome = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = dir;
      try {
        const body2 = {
          tools: [tool("Read"), tool("Bash"), tool("SendMessage")],
          system: [{ type: "text", text: "sys" }],
          messages: [],
        };
        const ctx2 = { body: body2, meta: {}, headers };
        await reloaded.default.onRequest(ctx2);
        assert.equal(ctx2.meta.deferredToolRewriteStats.action, "rewrite", "post-restart module reloaded baseline from disk");
        assert.deepEqual(ctx2.meta.deferredToolRewriteStats.newNames, ["SendMessage"]);
      } finally {
        if (savedHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = savedHome;
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// SYNTHETIC FIXTURE (ledger SHAPE, 2026-07-27 12:47:56 — tools[SendMessage:added])
// =============================================================================

test("fixture toolload-1247.json: prior → incoming reproduces the ledger's tools[SendMessage:added] shape as a rewrite", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-fixture" };
  try {
    const raw = await readFile(FIXTURE_PATH, "utf-8");
    const fixture = JSON.parse(raw);

    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      const ctx1 = await runExt(structuredClone(fixture.prior), { headers, dir });
      assert.equal(ctx1.meta.deferredToolRewriteStats.action, "no-baseline");

      const ctx2 = await runExt(structuredClone(fixture.incoming), { headers, dir });
      assert.equal(ctx2.meta.deferredToolRewriteStats.action, "rewrite");
      assert.deepEqual(ctx2.meta.deferredToolRewriteStats.newNames, ["SendMessage"]);

      // Known tools (Read, Bash) byte-identical to the fixture's prior entries.
      assert.deepEqual(ctx2.body.tools[0], fixture.prior.tools[0]);
      assert.deepEqual(ctx2.body.tools[1], fixture.prior.tools[1]);
      // New tool present — but NOT marked, and this is the uncomfortable part.
      //
      // This fixture is the real 12:47:56 event that motivated the whole
      // extension (threat-matrix rows 6 and 13, the 175k and 766k busts), and
      // its model is `claude-sonnet-4-6`. The mid-conversation-tool-changes
      // contract is not supported there — a sonnet-5 request carrying it
      // returned `400 tool_addition/tool_removal is not supported on this
      // model` on 2026-07-28 — so the announcement path is gated off for this
      // model family and the new tool is forwarded plainly.
      //
      // Which means the mitigation does NOT apply to the traffic it was
      // designed for. Recorded in the matrix rather than papered over here:
      // holding tools[] stable and pinning ORDER still work on every model
      // (they need no beta), but ADDITIONS on sonnet remain an honest bust.
      const sendMsgTool = ctx2.body.tools.find((t) => t.name === "SendMessage");
      assert.ok(sendMsgTool, "the new tool is still forwarded — degrade, never drop");
      assert.ok(
        !("defer_loading" in sendMsgTool),
        "defer_loading belongs to a contract this model rejects with a 400",
      );
      // tools[] count did not shrink or reorder the known prefix.
      assert.equal(ctx2.body.tools.length, 3);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// SYNTHETIC FIXTURE (ledger SHAPE, 2026-07-27 15:36 — tools:REMOVE + reorder,
// threat-matrix row 13)
// =============================================================================

test("fixture toolgc-1536.json: CronCreate removed + DeferredToolPlaceholder reordered -> held in place, first-seen order pinned", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-gc-fixture" };
  try {
    const raw = await readFile(GC_FIXTURE_PATH, "utf-8");
    const fixture = JSON.parse(raw);

    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      const ctx1 = await runExt(structuredClone(fixture.prior), { headers, dir });
      assert.equal(ctx1.meta.deferredToolRewriteStats.action, "no-baseline");

      const ctx2 = await runExt(structuredClone(fixture.incoming), { headers, dir });
      assert.equal(ctx2.meta.deferredToolRewriteStats.action, "rewrite");
      assert.deepEqual(ctx2.meta.deferredToolRewriteStats.heldNames, ["CronCreate"]);
      assert.deepEqual(ctx2.meta.deferredToolRewriteStats.newNames, []);

      // Output order is first-seen order from the baseline request, not the
      // incoming (reordered, CronCreate-missing) array's order.
      assert.deepEqual(
        ctx2.body.tools.map((t) => t.name),
        ["Read", "Bash", "CronCreate", "DeferredToolPlaceholder"],
      );
      // Held tool is byte-identical to its baseline form.
      assert.deepEqual(
        ctx2.body.tools.find((t) => t.name === "CronCreate"),
        fixture.prior.tools.find((t) => t.name === "CronCreate"),
      );
      // No addition -> no tool_addition block, no beta header.
      assert.equal(ctx2.body.system.length, 1);
      assert.equal(headers["anthropic-beta"], undefined);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// SESSION KEY RESOLUTION
// =============================================================================

// Volatile session URL inside a tool DESCRIPTION. CC embeds the per-session
// console URL in Bash's description (it is the commit trailer the model is
// told to write) and does not embed it consistently: measured over 652
// same-key request pairs, it flipped twice. tools[] renders BEFORE system and
// messages, so no breakpoint survives a tools[] byte change — one such flip
// cost 705k creation tokens. Nothing about what Bash DOES changes across it.
test("toolFingerprint: the per-session console URL does not count as a schema change", () => {
  const withUrl = {
    name: "Bash",
    description:
      "Run a command.\n\nCo-Authored-By: X\nClaude-Session: https://claude.ai/code/session_01ABC\n" +
      "- End PR bodies with:\n\nhttps://claude.ai/code/session_01ABC",
    input_schema: { type: "object" },
  };
  const without = {
    name: "Bash",
    description: "Run a command.\n\nCo-Authored-By: X\n- End PR bodies with:",
    input_schema: { type: "object" },
  };
  assert.equal(toolFingerprint(withUrl), toolFingerprint(without));
});

// The narrowness is the safety property: serving a stale schema for a tool
// whose contract actually changed is the one failure this extension must
// never produce.
test("toolFingerprint: a genuine description change IS still a schema change", () => {
  const a = { name: "Bash", description: "Run a command.", input_schema: { type: "object" } };
  const b = { name: "Bash", description: "Run a DIFFERENT command.", input_schema: { type: "object" } };
  assert.notEqual(toolFingerprint(a), toolFingerprint(b));
  // input_schema changes too, obviously.
  const c = { name: "Bash", description: "Run a command.", input_schema: { type: "object", required: ["x"] } };
  assert.notEqual(toolFingerprint(a), toolFingerprint(c));
});

test("resolveToolRewriteSessionKey: prefers session-id header, falls back to model string", () => {
  // Header path is sub-keyed by system-prompt hash (threat-matrix row 14) —
  // "nosys" when the body carries no system prompt.
  const withHeader = resolveToolRewriteSessionKey({ "x-claude-code-session-id": "abc-123" }, { model: "x" });
  assert.equal(withHeader, "s-abc-123-nosys-empty");
  const withoutHeader = resolveToolRewriteSessionKey(null, { model: "claude-sonnet-4-6" });
  assert.equal(withoutHeader, "c-claude-sonnet-4-6-empty");
});

// Regression guard for the row-14 collision this extension shipped with:
// one session-id header, several tenants (main thread, subagents, CC's own
// sidecar calls), each with a DIFFERENT system prompt and a different tools
// array. Keyed on the bare session id they shared one baseline, so every
// alternation classified as "schema changed" and re-baselined — measured on
// real traffic as tools[] churn RISING when the extension was enabled.
test("resolveToolRewriteSessionKey: sidecars sharing a session-id get distinct keys", () => {
  const headers = { "x-claude-code-session-id": "abc-123" };
  const main = resolveToolRewriteSessionKey(headers, {
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI." }],
  });
  const sidecar = resolveToolRewriteSessionKey(headers, {
    system: [{ type: "text", text: "You are a Claude agent, built on Anthropic's API." }],
  });
  assert.notEqual(main, sidecar);
  // Same system prompt → same bucket, so the main thread stays on one baseline.
  const mainAgain = resolveToolRewriteSessionKey(headers, {
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI." }],
  });
  assert.equal(main, mainAgain);
});

// --- Model gate (the 400 that killed a live dispatch) ---
//
// 2026-07-28: a sonnet-5 subagent dispatch died with
// `API Error: 400 tool_addition/tool_removal is not supported on this model`.
// The contract is a documented beta but support is per-MODEL, and this
// extension applied it to whatever came through. A cache mitigation that can
// HARD-FAIL a request is worse than no mitigation, so the gate is opt-IN:
// unknown models degrade to forwarding the new tool normally.

test("supportsToolAddition: opt-IN, so an unknown model is OFF", () => {
  assert.equal(supportsToolAddition("claude-opus-5"), true);
  assert.equal(supportsToolAddition("claude-opus-5-20260101"), true, "date-suffixed ids must match by prefix");
  // Wire evidence 2026-07-29 (probe session c05a754c: block forwarded
  // byte-identically, API streamed 200).
  assert.equal(supportsToolAddition("claude-fable-5"), true);
  // The measured failure.
  assert.equal(supportsToolAddition("claude-sonnet-5"), false);
  // Everything unknown is off — a new model must not be able to break a
  // request just by existing.
  assert.equal(supportsToolAddition("claude-haiku-4-5"), false);
  assert.equal(supportsToolAddition("some-future-model"), false);
  assert.equal(supportsToolAddition(undefined), false);
  assert.equal(supportsToolAddition(null), false);
});

test("supportsToolAddition: EXTRA override admits a candidate for the live probe, per call", () => {
  // The override serves the throwaway acceptance-probe proxy only (it is how
  // fable-5 earned its baseline entry on 2026-07-29); it must be read per
  // call (a long-lived process picks up the change without a module reload)
  // and must not disturb the baseline list.
  const prev = process.env.CACHE_FIX_TOOL_ADDITION_EXTRA;
  try {
    process.env.CACHE_FIX_TOOL_ADDITION_EXTRA = "claude-candidate-x, claude-candidate-y";
    assert.equal(supportsToolAddition("claude-candidate-x"), true);
    assert.equal(supportsToolAddition("claude-candidate-y-20260101"), true);
    assert.equal(supportsToolAddition("claude-sonnet-5"), false, "override must not widen beyond its prefixes");
    delete process.env.CACHE_FIX_TOOL_ADDITION_EXTRA;
    assert.equal(supportsToolAddition("claude-candidate-x"), false, "cleared override must clear per call");
  } finally {
    if (prev === undefined) delete process.env.CACHE_FIX_TOOL_ADDITION_EXTRA;
    else process.env.CACHE_FIX_TOOL_ADDITION_EXTRA = prev;
  }
});

test("BITE — an unsupported model gets NO tool_addition, no beta header, tools passed through", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-sonnet" };
  try {
    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      const u1 = { role: "user", content: [{ type: "text", text: "turn 1" }] };
      const base = { system: [], messages: [u1], model: "claude-sonnet-5" };
      await runExt({ ...base, tools: [tool("Read")] }, { headers, dir });
      const ctx = await runExt(
        { ...base, tools: [tool("Read"), tool("SendMessage")] },
        { headers, dir },
      );
      // No injected system message anywhere in messages[].
      const injected = (ctx.body.messages || []).filter(
        (m) => m.role === "system" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_addition"),
      );
      assert.equal(injected.length, 0, "no tool_addition may reach a model that 400s on it");
      // No beta token.
      const beta = Object.entries(ctx.headers || {}).find(([k]) => k.toLowerCase() === "anthropic-beta");
      assert.ok(
        !beta || !String(beta[1]).includes("mid-conversation-tool-changes"),
        "beta token must not be sent to an unsupported model",
      );
      // And no defer_loading marker smuggled onto the new tool.
      const sm = (ctx.body.tools || []).find((t) => t.name === "SendMessage");
      assert.ok(sm, "the new tool is still forwarded — degrade, do not drop");
      assert.ok(!("defer_loading" in sm), "defer_loading belongs to the contract the model rejects");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a suppressed announcement is LOUD: stderr once per model, telemetry every time", async () => {
  // The silent version of this path is the failure mode: a new model family
  // (documented rule is "Opus onward", so it likely supports the beta) pays
  // a full-prefix bust per tool load with nothing anywhere saying so, until
  // someone probes it by accident. The warning names the probe; telemetry
  // records every occurrence for counting.
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-new-family" };
  const warnings = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (s, ...rest) => {
    if (String(s).includes("not allowlisted for tool_addition")) {
      warnings.push(String(s));
      return true;
    }
    return origWrite.call(process.stderr, s, ...rest);
  };
  try {
    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      const u1 = { role: "user", content: [{ type: "text", text: "turn 1" }] };
      const base = { system: [], messages: [u1], model: "claude-new-family-7" };
      await runExt({ ...base, tools: [tool("Read")] }, { headers, dir });
      await runExt({ ...base, tools: [tool("Read"), tool("SendMessage")] }, { headers, dir });
      assert.equal(warnings.length, 1, "the first suppression must warn");
      assert.match(warnings[0], /claude-new-family-7/);
      assert.match(warnings[0], /probe/i, "the warning must name the way out");
      // A second suppressed load on the same model: telemetry yes, stderr no.
      await runExt(
        { ...base, tools: [tool("Read"), tool("SendMessage"), tool("Monitor")] },
        { headers, dir },
      );
      assert.equal(warnings.length, 1, "once per model per process");
      const { readdir: rd, readFile: rf } = await import("node:fs/promises");
      const snapDir = join(dir, "cache-fix-snapshots");
      const evFile = (await rd(snapDir)).find((f) => f.endsWith("-deferred-tool-events.jsonl"));
      assert.ok(evFile, "telemetry file must exist");
      const events = (await rf(join(snapDir, evFile), "utf-8")).trim().split("\n").map(JSON.parse);
      const sup = events.filter((e) => e.suppressed);
      assert.equal(sup.length, 2, "every suppressed occurrence is recorded");
      assert.equal(sup[0].model, "claude-new-family-7");
      assert.equal(sup[0].injected, 0);
    });
  } finally {
    process.stderr.write = origWrite;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a SUPPORTED model still gets the announcement (the gate is not a kill switch)", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-opus" };
  try {
    await withEnvAsync({ CACHE_FIX_TOOL_REWRITE: "1" }, async () => {
      const u1 = { role: "user", content: [{ type: "text", text: "turn 1" }] };
      const base = { system: [], messages: [u1], model: "claude-opus-5" };
      await runExt({ ...base, tools: [tool("Read")] }, { headers, dir });
      const ctx = await runExt(
        { ...base, tools: [tool("Read"), tool("SendMessage")] },
        { headers, dir },
      );
      const injected = (ctx.body.messages || []).filter(
        (m) => m.role === "system" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_addition"),
      );
      assert.equal(injected.length, 1, "opus must keep the mitigation");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
