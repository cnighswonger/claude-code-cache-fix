import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveAgentId,
  deriveParentAgentId,
  extractPerLegDiscriminator,
} from "../proxy/workflow-agent-derivation.mjs";

// --- deriveAgentId ---

test("deriveAgentId: deterministic — same inputs produce same id", () => {
  const a = deriveAgentId({ sessionId: "sess-A", markerId: "marker-x", perLegDiscriminator: "disc-1" });
  const b = deriveAgentId({ sessionId: "sess-A", markerId: "marker-x", perLegDiscriminator: "disc-1" });
  assert.equal(a, b);
});

test("deriveAgentId: 16-hex output", () => {
  const id = deriveAgentId({ sessionId: "sess-A", markerId: "marker-x", perLegDiscriminator: "disc-1" });
  assert.match(id, /^[0-9a-f]{16}$/);
});

test("deriveAgentId: distinct per-leg discriminators → distinct ids", () => {
  const a = deriveAgentId({ sessionId: "sess-A", markerId: "marker-x", perLegDiscriminator: "disc-1" });
  const b = deriveAgentId({ sessionId: "sess-A", markerId: "marker-x", perLegDiscriminator: "disc-2" });
  const c = deriveAgentId({ sessionId: "sess-A", markerId: "marker-x", perLegDiscriminator: "disc-3" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

test("deriveAgentId: distinct sessions → distinct ids", () => {
  const a = deriveAgentId({ sessionId: "sess-A", markerId: "marker-x", perLegDiscriminator: "disc-1" });
  const b = deriveAgentId({ sessionId: "sess-B", markerId: "marker-x", perLegDiscriminator: "disc-1" });
  assert.notEqual(a, b);
});

test("deriveAgentId: marker_id (not raw text) is hashed — distinct markers, distinct ids", () => {
  const a = deriveAgentId({ sessionId: "sess-A", markerId: "marker-id-A", perLegDiscriminator: "disc-1" });
  const b = deriveAgentId({ sessionId: "sess-A", markerId: "marker-id-B", perLegDiscriminator: "disc-1" });
  assert.notEqual(a, b);
});

test("deriveAgentId: missing/empty inputs → null (no derivation)", () => {
  assert.equal(deriveAgentId({ sessionId: "", markerId: "x", perLegDiscriminator: "y" }), null);
  assert.equal(deriveAgentId({ sessionId: "a", markerId: "", perLegDiscriminator: "y" }), null);
  assert.equal(deriveAgentId({ sessionId: "a", markerId: "x", perLegDiscriminator: "" }), null);
  assert.equal(deriveAgentId({}), null);
});

// --- deriveParentAgentId ---

test("deriveParentAgentId: deterministic per-session, 16-hex", () => {
  const a = deriveParentAgentId("sess-A");
  const b = deriveParentAgentId("sess-A");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("deriveParentAgentId: distinct sessions → distinct parents", () => {
  assert.notEqual(deriveParentAgentId("sess-A"), deriveParentAgentId("sess-B"));
});

test("deriveParentAgentId: different from any agent id under the same session (sentinel separation)", () => {
  const parent = deriveParentAgentId("sess-A");
  // Pathological case: a leg whose discriminator happens to equal the
  // sentinel string. The two outputs must STILL differ because the agent
  // hash takes three inputs (session + markerId + discriminator) versus
  // the parent's two (session + sentinel).
  const leg = deriveAgentId({ sessionId: "sess-A", markerId: "any", perLegDiscriminator: "workflow-root" });
  assert.notEqual(parent, leg);
});

// --- extractPerLegDiscriminator ---

test("extractPerLegDiscriminator: string content shape → digest", () => {
  const d = extractPerLegDiscriminator({
    messages: [{ role: "user", content: "Find files in src/" }],
  });
  assert.match(d, /^[0-9a-f]{64}$/);
});

test("extractPerLegDiscriminator: block-array content shape → same digest as concatenated-text equivalent", () => {
  const d1 = extractPerLegDiscriminator({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Find files in src/" },
      ],
    }],
  });
  const d2 = extractPerLegDiscriminator({
    messages: [{ role: "user", content: "Find files in src/" }],
  });
  assert.equal(d1, d2);
});

test("extractPerLegDiscriminator: distinct prompts → distinct digests", () => {
  const a = extractPerLegDiscriminator({ messages: [{ role: "user", content: "alpha" }] });
  const b = extractPerLegDiscriminator({ messages: [{ role: "user", content: "beta" }] });
  assert.notEqual(a, b);
});

test("extractPerLegDiscriminator: malformed body → null", () => {
  assert.equal(extractPerLegDiscriminator({}), null);
  assert.equal(extractPerLegDiscriminator(null), null);
  assert.equal(extractPerLegDiscriminator({ messages: [] }), null);
  assert.equal(extractPerLegDiscriminator({ messages: [{ role: "assistant", content: "x" }] }), null);
  assert.equal(extractPerLegDiscriminator({ messages: [{ role: "user", content: "" }] }), null);
});

// --- Tools-list churn: the directive's key invariant ---

test("derived id is INVARIANT under tools-list churn", () => {
  // Two requests with the same session, same marker, same first-user-message
  // content, but DIFFERENT tools arrays (the deferred-tools-restore MCP
  // reconnect race scenario from the directive).
  const bodyA = {
    system: "doesn't matter for the derivation hash inputs",
    messages: [{ role: "user", content: "Review file X" }],
    tools: [{ name: "Read" }, { name: "Edit" }, { name: "Bash" }],
  };
  const bodyB = {
    system: "different system text",
    messages: [{ role: "user", content: "Review file X" }],
    tools: [{ name: "Read" }],  // MCP reconnect dropped Edit + Bash
  };
  const discA = extractPerLegDiscriminator(bodyA);
  const discB = extractPerLegDiscriminator(bodyB);
  assert.equal(discA, discB, "discriminator must be invariant under tools churn");
  const idA = deriveAgentId({ sessionId: "sess-X", markerId: "marker-x", perLegDiscriminator: discA });
  const idB = deriveAgentId({ sessionId: "sess-X", markerId: "marker-x", perLegDiscriminator: discB });
  assert.equal(idA, idB);
});
