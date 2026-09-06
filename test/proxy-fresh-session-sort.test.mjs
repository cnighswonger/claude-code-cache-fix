import { test } from "node:test";
import assert from "node:assert/strict";
import ext, {
  isSystemReminder,
  isHooksBlock,
  isSkillsBlock,
  isDeferredToolsBlock,
  isMcpBlock,
  isRelocatableBlock,
  isClearArtifact,
  stripSessionKnowledge,
  getBlockType,
  fixBlockText,
} from "../proxy/extensions/fresh-session-sort.mjs";

const SR = "<system-reminder>\n";

// --- Block classification helpers ---

test("isSystemReminder: matches system-reminder prefix", () => {
  assert.ok(isSystemReminder("<system-reminder>\nsome content\n</system-reminder>"));
  assert.ok(!isSystemReminder("not a reminder"));
  assert.ok(!isSystemReminder(null));
});

test("isHooksBlock: matches hook success text", () => {
  assert.ok(isHooksBlock("<system-reminder>\nSessionStart:startup hook success: output\n</system-reminder>"));
  assert.ok(!isHooksBlock(SR + "some other content\n</system-reminder>"));
});

test("isSkillsBlock: matches skills listing", () => {
  assert.ok(isSkillsBlock(SR + "The following skills are available\n- coffee\n</system-reminder>"));
  assert.ok(!isSkillsBlock(SR + "Not a skills block\n</system-reminder>"));
});

test("isDeferredToolsBlock: matches deferred tools", () => {
  assert.ok(isDeferredToolsBlock(SR + "The following deferred tools are now available:\ntool1\n</system-reminder>"));
  assert.ok(!isDeferredToolsBlock(SR + "Not deferred tools\n</system-reminder>"));
});

test("isMcpBlock: matches MCP server instructions", () => {
  assert.ok(isMcpBlock(SR + "# MCP Server Instructions\nserver config\n</system-reminder>"));
  assert.ok(!isMcpBlock(SR + "Not MCP\n</system-reminder>"));
});

test("isRelocatableBlock: detects all four block types", () => {
  assert.ok(isRelocatableBlock(SR + "The following skills are available\n- x\n</system-reminder>"));
  assert.ok(isRelocatableBlock(SR + "The following deferred tools are now available:\ny\n</system-reminder>"));
  assert.ok(isRelocatableBlock(SR + "# MCP Server Instructions\nz\n</system-reminder>"));
  assert.ok(isRelocatableBlock("<system-reminder>\nSessionStart:startup hook success: out\n</system-reminder>"));
  assert.ok(!isRelocatableBlock("just text"));
});

test("isClearArtifact: detects /clear artifacts", () => {
  assert.ok(isClearArtifact("<local-command-caveat>some caveat</local-command-caveat>"));
  assert.ok(isClearArtifact("<command-name>/clear</command-name>"));
  assert.ok(isClearArtifact("<local-command-stdout>output</local-command-stdout>"));
  assert.ok(!isClearArtifact("normal text"));
  assert.ok(!isClearArtifact(null));
});

test("getBlockType: returns correct type for each block kind", () => {
  assert.equal(getBlockType(SR + "The following skills are available\n- x\n</system-reminder>"), "skills");
  assert.equal(getBlockType(SR + "The following deferred tools are now available:\ny\n</system-reminder>"), "deferred");
  assert.equal(getBlockType(SR + "# MCP Server Instructions\nz\n</system-reminder>"), "mcp");
  assert.equal(getBlockType("<system-reminder>\nSessionStart:startup hook success: out\n</system-reminder>"), "hooks");
  assert.equal(getBlockType("plain text"), null);
});

// --- stripSessionKnowledge ---

test("stripSessionKnowledge: removes session_knowledge tags", () => {
  const input = "before\n<session_knowledge key=\"x\">data</session_knowledge>\nafter";
  const result = stripSessionKnowledge(input);
  assert.ok(!result.includes("session_knowledge"));
  assert.ok(result.includes("before"));
  assert.ok(result.includes("after"));
});

test("stripSessionKnowledge: no-op on text without session_knowledge", () => {
  const input = "no knowledge here";
  assert.equal(stripSessionKnowledge(input), input);
});

// --- onRequest: in-place sorting (no scattered blocks) ---

test("onRequest: sorts skills in first user message in-place", async () => {
  const skillsText = SR + "The following skills are available\n\n- zephyr: z\n- alpha: a\n</system-reminder>";
  const ctx = {
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: skillsText },
            { type: "text", text: "actual prompt" },
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);

  const result = ctx.body.messages[0].content[0].text;
  assert.ok(result.indexOf("alpha") < result.indexOf("zephyr"), "skills should be sorted");
});

test("onRequest: strips /clear artifacts from first user message", async () => {
  const ctx = {
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<command-name>/clear</command-name>" },
            { type: "text", text: "real content" },
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);

  const texts = ctx.body.messages[0].content.map((b) => b.text);
  assert.ok(!texts.some((t) => t.includes("command-name")), "clear artifacts should be removed");
  assert.ok(texts.includes("real content"));
});

// --- onRequest: scattered block relocation ---

test("onRequest: relocates scattered blocks to first user message", async () => {
  const skills = SR + "The following skills are available\n\n- alpha: a\n</system-reminder>";
  const deferred = SR + "The following deferred tools are now available:\ntool1\n</system-reminder>";

  const ctx = {
    body: {
      messages: [
        { role: "user", content: [{ type: "text", text: "first prompt" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        {
          role: "user",
          content: [
            { type: "text", text: skills },
            { type: "text", text: deferred },
            { type: "text", text: "second prompt" },
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);

  // Relocated blocks should be in first user message
  const first = ctx.body.messages[0].content;
  assert.ok(first.some((b) => b.text.includes("skills are available")), "skills should be relocated");
  assert.ok(first.some((b) => b.text.includes("deferred tools")), "deferred should be relocated");

  // Original location should have blocks removed
  const third = ctx.body.messages[2].content;
  assert.ok(!third.some((b) => b.text.includes("skills are available")), "skills should be removed from original");
});

test("onRequest: relocation order is deferred → mcp → skills → hooks", async () => {
  const skills = SR + "The following skills are available\n\n- a: x\n</system-reminder>";
  const hooks = "<system-reminder>\nSessionStart:startup hook success: ok\n</system-reminder>";
  const deferred = SR + "The following deferred tools are now available:\nt1\n</system-reminder>";
  const mcp = SR + "# MCP Server Instructions\nserver\n</system-reminder>";

  const ctx = {
    body: {
      messages: [
        { role: "user", content: [{ type: "text", text: "prompt" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        {
          role: "user",
          content: [
            { type: "text", text: hooks },
            { type: "text", text: skills },
            { type: "text", text: mcp },
            { type: "text", text: deferred },
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);

  const first = ctx.body.messages[0].content;
  const types = first.slice(0, 4).map((b) => getBlockType(b.text));
  assert.deepEqual(types, ["deferred", "mcp", "skills", "hooks"]);
});

test("onRequest: strips cache_control from relocated blocks", async () => {
  const skills = SR + "The following skills are available\n\n- a: x\n</system-reminder>";
  const ctx = {
    body: {
      messages: [
        { role: "user", content: [{ type: "text", text: "prompt" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        {
          role: "user",
          content: [
            { type: "text", text: skills, cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);

  const relocated = ctx.body.messages[0].content.find((b) => b.text.includes("skills"));
  assert.equal(relocated.cache_control, undefined, "cache_control should be stripped from relocated blocks");
});

// --- onRequest: freshSessionSortStats telemetry (relocate branch only) ---
//
// The extension reports what it did; replay's stability exemption reads
// this instead of re-deriving "was this relocation a first appearance" from
// output shape (dev-loop's "never a re-derived guess" — mirrors
// suppressedIndices in tools/replay.mjs). Two shapes matter: a type
// relocated because it is genuinely new to the array (firstAppearance:
// true) vs. a type that already existed elsewhere in the array and is now
// recurring (firstAppearance: false) — the checker must be able to tell
// them apart, not treat every relocation event alike.

test("onRequest: relocate branch reports freshSessionSortStats with firstAppearance:true for a genuinely new type", async () => {
  const skills = SR + "The following skills are available\n\n- alpha: a\n</system-reminder>";
  const ctx = {
    body: {
      messages: [
        { role: "user", content: [{ type: "text", text: "first prompt" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        {
          role: "user",
          content: [
            { type: "text", text: skills },
            { type: "text", text: "second prompt" },
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);

  assert.ok(ctx.meta.freshSessionSortStats, "relocate branch must report telemetry");
  assert.equal(ctx.meta.freshSessionSortStats.targetIndex, 0, "targetIndex is the message index content was prepended to");
  assert.deepEqual(ctx.meta.freshSessionSortStats.relocated, [{ type: "skills", firstAppearance: true }]);
});

test("onRequest: freshSessionSortStats reports firstAppearance:false when the type already appeared earlier in the array", async () => {
  const skillsA = SR + "The following skills are available\n\n- alpha: a\n</system-reminder>";
  const skillsB = SR + "The following skills are available\n\n- beta: b\n</system-reminder>";
  const deferred = SR + "The following deferred tools are now available:\ntool1\n</system-reminder>";
  const ctx = {
    body: {
      messages: [
        // skills already present at messages[0] — this type is NOT new.
        { role: "user", content: [{ type: "text", text: skillsA }, { type: "text", text: "first prompt" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        {
          // A scattered block elsewhere is required to enter the relocate
          // branch at all (hasScatteredBlocks); "deferred" is genuinely new
          // here, "skills" recurs.
          role: "user",
          content: [
            { type: "text", text: skillsB },
            { type: "text", text: deferred },
            { type: "text", text: "second prompt" },
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);

  const byType = Object.fromEntries(ctx.meta.freshSessionSortStats.relocated.map((r) => [r.type, r.firstAppearance]));
  assert.equal(byType.deferred, true, "deferred appears exactly once in the array — first appearance");
  assert.equal(byType.skills, false, "skills appeared twice (messages[0] and scattered) — not a first appearance");
});

test("onRequest: no freshSessionSortStats when the in-place branch runs (nothing scattered)", async () => {
  const skillsText = SR + "The following skills are available\n\n- zephyr: z\n- alpha: a\n</system-reminder>";
  const ctx = {
    body: {
      messages: [
        { role: "user", content: [{ type: "text", text: skillsText }, { type: "text", text: "prompt" }] },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);

  assert.equal(ctx.meta.freshSessionSortStats, undefined, "in-place branch must not emit relocate telemetry");
});

test("onRequest: no-op when no user messages", async () => {
  const ctx = {
    body: { messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.equal(ctx.body.messages.length, 1);
});
