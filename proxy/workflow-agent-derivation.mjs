// Pure-function helpers for Workflow-tool agent-id derivation (issue #215).
//
// Derived agent ids are proxy-only attribution keys — never sent upstream.
// The directive's `proxy-workflow-agent-id-synthesis.md` § "Derivation
// algorithm" specifies the exact hash inputs:
//
//   derived_agent_id = sha256(session_id + marker_id + per_leg_discriminator).slice(0, 16)
//   derived_parent_agent_id = sha256(session_id + "workflow-root").slice(0, 16)
//
// 64-bit truncation matches the house precedent (hashOrgId, sessionFilename).
// Derived ids are NOT globally unique; cross-session aggregation must factor
// in the ~2^32 birthday bound.

import { createHash } from "node:crypto";

const SENTINEL_PARENT = "workflow-root";

// Stable 16-hex truncated sha256.
function sha16(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function deriveAgentId({ sessionId, markerId, perLegDiscriminator }) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof markerId !== "string" || markerId.length === 0) return null;
  if (typeof perLegDiscriminator !== "string" || perLegDiscriminator.length === 0) return null;
  return sha16(sessionId + markerId + perLegDiscriminator);
}

export function deriveParentAgentId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  return sha16(sessionId + SENTINEL_PARENT);
}

// Extract the per-leg discriminator from a request body. The directive's
// "Derivation algorithm" section requires this be sourced from a stable,
// leg-distinct context field that survives MCP tools-list churn.
//
// Choice: sha256 hex of the first user-message text content.
//
//   - Wire-visible. Survives MCP reconnects because the user prompt is in
//     the body, not the tools list.
//   - Deterministic — CC re-sends the same first user message on every
//     turn of the same Workflow leg.
//   - Leg-distinct in the realistic `parallel()` case where each leg
//     passes a different prompt.
//
// Known limit: a `parallel()` fan-out where every leg passes the same
// prompt collides on the discriminator. Documented in the directive as an
// accepted edge case (operators get one bucketed id rather than wrong
// attribution).
export function extractPerLegDiscriminator(body) {
  const text = firstUserMessageText(body);
  if (!text) return null;
  // Full sha256 — we want maximum entropy on the discriminator side; the
  // 16-hex truncation happens once in deriveAgentId on the composite hash.
  return createHash("sha256").update(text).digest("hex");
}

// Local copy of the body extractor (intentionally not shared with
// workflow-markers.mjs — see the directive's "Module layout" section
// preferring duplication of small helpers over a new abstraction layer).
function firstUserMessageText(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return "";
  const first = msgs[0];
  if (!first || first.role !== "user") return "";
  const c = first.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts = [];
  for (const block of c) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}
