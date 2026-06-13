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
// Binary-inspection finding (CC 2.1.177, sha256
// ff41753634b20c869ef6a32a20863521b33d4186ac0d6a49379ab48a48395ee7): CC's
// workflow factory (`Qy4` function) keeps every per-leg distinguishing
// field in IN-PROCESS state, NOT in the wire request body. The fields that
// would be ideal discriminators — CC's internal `agentId` UUID, the
// `agentType` of the spawned agent, the `spawnedByWorkflowRunId` workflow
// instance id, and the workflow phase index — are all consumed by CC's
// progress/journaling system before the message-stream loop builds the
// upstream HTTP request. The Anthropic Messages API has no slots for them
// either. From the proxy's wire vantage, the only Workflow-distinguishing
// content blocks are:
//   1. The system-prompt suffix marker (already used for DETECTION).
//   2. The user-supplied `agent(prompt)` argument, surfaced as
//      `body.messages[0].content`.
//
// Choice: sha256 hex of the first user-message text content. This is the
// only wire-visible discriminator that is stable across CC's stall-retry
// path (CC re-sends the same first user message on every retry of the
// same leg — `eH(..., L$+1, O$)` reuses the same prompt) AND leg-distinct
// for the realistic `parallel()` fan-out where each leg passes a different
// prompt.
//
// Known limit, surfaced in the PR body + CHANGELOG: a `parallel()`
// fan-out where every leg passes the SAME prompt collides on the
// discriminator. Operators get one bucketed id rather than wrong
// attribution. Identical-prompt fan-out is uncommon (the canonical use is
// "do thing X to file Y", "do thing X to file Z", ...); when it does
// happen, the directive's `cache_fix_derived` source flag tells dashboards
// the attribution is heuristic.
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
