// workflow-agent-id-synthesis — derive a stable per-leg agent id for
// Workflow-tool subagent requests whose canonical x-claude-code-agent-id
// header CC does not set (per CC#66761).
//
// Directive: `docs/directives/proxy-workflow-agent-id-synthesis.md`.
// Issue:     #215.
//
// Three states the request can be in:
//
//   1. Canonical present — Task/Agent-tool subagent. Stash the canonical
//      id on ctx.meta._workflowAgentId with source: "cc_header".
//   2. Workflow-derived — canonical absent, marker matched, conditions met.
//      Derive a stable id from (sessionId, markerId, prompt-content digest)
//      and stash with source: "cache_fix_derived".
//   3. Neither — no stash, no event log (top-level conversation traffic).
//
// Downstream `usage-log.mjs` reads exactly one meta key
// (ctx.meta._workflowAgentId) and emits the agent_id + agent_id_source
// fields on its row when CACHE_FIX_USAGE_LOG_AGENT_ID=on. The derived ids
// never reach Anthropic upstream — this extension does not touch headers
// or body.
//
// Drift canary: when conditions 1+2 hold (sessionId present, canonical
// header absent) but no catalog marker matches, the extension emits a
// throttled drift_canary event so operators see the marker catalog has
// gone stale against a new CC version. Throttle: once per (sessionFilename,
// hour) to bound log growth during sustained drift.
//
// Master switch: CACHE_FIX_WORKFLOW_AGENT_DERIVATION=off disables both
// the derivation path AND the canonical pass-through stash AND the canary.
// (Default-on per directive — no behavior change for traffic that doesn't
// match conditions.)

import { appendFileSync, statSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import { resolveSessionId, sessionFilename } from "./cache-telemetry.mjs";
import { matchWorkflowMarker } from "../workflow-markers.mjs";
import { claudeHome } from "../claude-home.mjs";
import {
  deriveAgentId,
  deriveParentAgentId,
  extractPerLegDiscriminator,
} from "../workflow-agent-derivation.mjs";

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const SCHEMA_VERSION = 1;
const CC_VERSION_AT_DISCOVERY = "2.1.177";
const DRIFT_CANARY_THROTTLE_MS = 60 * 60 * 1000; // 1 hour per session

// Module-scope throttle map: sessionFilename → ms timestamp of last canary
// emission for that session. Bounded by the same time-based eviction the
// canary throttle implies (entries older than the throttle window are no
// longer load-bearing).
const _lastCanaryEmitMs = new Map();

function logPath() {
  return process.env.CACHE_FIX_WORKFLOW_DERIVATION_LOG_PATH
    || join(claudeHome(), "workflow-derivation-events.jsonl");
}

// Single-tier rotation precedent — see `bootstrap-defense.mjs:20-25`.
function rotateIfNeeded(path) {
  let size = 0;
  try { size = statSync(path).size; } catch { return; }
  if (size < LOG_ROTATE_BYTES) return;
  try { renameSync(path, `${path}.1`); } catch {}
}

function appendRecord(record) {
  const path = logPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, JSON.stringify(record) + "\n");
  } catch (err) {
    process.stderr.write(`[workflow-agent-id-synthesis] log write failed: ${err.message}\n`);
  }
}

// Drift canary throttle gate. Returns true on the first emit for a session
// in the throttle window; false thereafter until the window rolls.
function shouldEmitCanary(sessionKey, nowMs) {
  const last = _lastCanaryEmitMs.get(sessionKey);
  if (last !== undefined && nowMs - last < DRIFT_CANARY_THROTTLE_MS) return false;
  _lastCanaryEmitMs.set(sessionKey, nowMs);
  return true;
}

export default {
  name: "workflow-agent-id-synthesis",
  description: "Derive a stable per-leg agent id for Workflow-tool subagent requests whose canonical x-claude-code-agent-id header CC does not set (CC#66761).",
  order: 365,

  async onRequest(ctx) {
    if (process.env.CACHE_FIX_WORKFLOW_AGENT_DERIVATION === "off") return;
    if (!ctx || !ctx.headers) return;

    const sessionId = resolveSessionId(ctx.headers);
    if (!sessionId) return; // sessionless — out of scope

    // State 1: canonical header present. Pass-through stash.
    const canonical = ctx.headers["x-claude-code-agent-id"];
    if (canonical) {
      const parent = ctx.headers["x-claude-code-parent-agent-id"] || null;
      ctx.meta = ctx.meta || {};
      ctx.meta._workflowAgentId = {
        id: canonical,
        parentId: parent,
        source: "cc_header",
      };
      return;
    }

    // Canonical absent. Now we check the Workflow-marker condition.
    const markerMatch = matchWorkflowMarker(ctx.body);
    if (!markerMatch) {
      // Drift canary: conditions 1+2 hold (sessionId present, canonical
      // absent) but no marker matched. Either this is a legitimate top-
      // level conversation OR the catalog has gone stale against the
      // current CC version. We emit a throttled canary in the latter case
      // but can't distinguish the two without a marker, so we always emit
      // — operators looking at the canary count distinguish "expected
      // baseline rate" from "sudden spike post-CC-upgrade."
      const sessionKey = sessionFilename(sessionId);
      const nowMs = Date.now();
      if (shouldEmitCanary(sessionKey, nowMs)) {
        appendRecord({
          ts: new Date(nowMs).toISOString(),
          session_id: sessionId,
          agent_id_source: "drift_canary",
          cc_version: CC_VERSION_AT_DISCOVERY,
          schema_version: SCHEMA_VERSION,
        });
      }
      return;
    }

    // Marker matched. Compute derived id.
    const discriminator = extractPerLegDiscriminator(ctx.body);
    if (!discriminator) return; // body shape unparseable — degrade silently

    const agent_id = deriveAgentId({
      sessionId,
      markerId: markerMatch.marker_id,
      perLegDiscriminator: discriminator,
    });
    const parent_agent_id = deriveParentAgentId(sessionId);
    if (!agent_id || !parent_agent_id) return;

    ctx.meta = ctx.meta || {};
    ctx.meta._workflowAgentId = {
      id: agent_id,
      parentId: parent_agent_id,
      source: "cache_fix_derived",
    };

    appendRecord({
      ts: new Date().toISOString(),
      session_id: sessionId,
      agent_id_source: "cache_fix_derived",
      marker_id: markerMatch.marker_id,
      marker_position: markerMatch.position,
      agent_id,
      parent_agent_id,
      cc_version: CC_VERSION_AT_DISCOVERY,
      schema_version: SCHEMA_VERSION,
    });
  },

  // Test-only: reset module state between tests.
  __resetForTests() {
    _lastCanaryEmitMs.clear();
  },
};
