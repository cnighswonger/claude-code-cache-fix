import { resolveSessionId } from "./cache-telemetry.mjs";
import {
  shapeAssistantRecord,
  shapeUserRecord,
  shapeToolResultUserRecord,
  mergeUsage,
} from "../session-mirror-envelope.mjs";
import {
  writeRecordsSync,
  sweepRetentionThrottled,
  _resetWriterState,
  _appendEvent,
} from "../session-mirror-writer.mjs";

// Directive: docs/directives/proxy-jsonl-session-mirror.md (merged at 980026e)
// Upstream: anthropics/claude-code#66734 + anthropics/claude-code#66486
//
// Stream-event accumulator with one buffered file write at message_stop.
// Per-message state lives on ctx.meta._mirrorAccumulator (request-scoped) so
// aborted streams clean up for free via ctx GC. Module-scope state holds the
// per-session dedup high-water counts and the parentUuid chain.

const UNKNOWN_SESSION = "unknown";
const DEFAULT_MAX_SESSIONS = 1024;

function modeFromEnv() {
  return process.env.CACHE_FIX_SESSION_MIRROR === "on";
}

function includeThinking() {
  return process.env.CACHE_FIX_SESSION_MIRROR_INCLUDE_THINKING !== "false";
}

function maxSessions() {
  const raw = parseInt(process.env.CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_SESSIONS;
}

// Per-session dedup state. Insertion-order Map gives O(1) LRU via re-insert.
// Keys: sessionId. Values: {
//   mirroredUserMessageCount: number (count in user-role-message ordinal),
//   mirroredToolResultIds: Set<string>,
//   lastUuid: string | null (the most-recent record's uuid for the parentUuid chain),
// }
const mirrorState = {
  sessions: new Map(),
};

// Test seam — reset session state without touching writer state.
export function _resetSessionState() {
  mirrorState.sessions.clear();
  _resetWriterState();
}

function getSession(sessionId) {
  let entry = mirrorState.sessions.get(sessionId);
  if (!entry) {
    entry = {
      mirroredUserMessageCount: 0,
      mirroredToolResultIds: new Set(),
      lastUuid: null,
    };
    mirrorState.sessions.set(sessionId, entry);
    // Enforce the cap at session creation, NOT only at successful-write time.
    // Otherwise failed/aborted sessions accumulate past MAX_SESSIONS — Codex
    // round-1 blocker #2: the memory-bounded contract must hold even when the
    // sessions failing are exactly the ones the extension is meant to tolerate.
    evictIfOverCap();
  } else {
    // LRU bump on access — re-insert to advance insertion order.
    mirrorState.sessions.delete(sessionId);
    mirrorState.sessions.set(sessionId, entry);
  }
  return entry;
}

function evictIfOverCap() {
  const cap = maxSessions();
  while (mirrorState.sessions.size > cap) {
    const oldest = mirrorState.sessions.keys().next().value;
    if (oldest === undefined) break;
    mirrorState.sessions.delete(oldest);
  }
}

// ============================================================================
// User-record staging (in onRequest)
// ============================================================================

// Walk ctx.body.messages, filter to user-role entries, and stage any new ones
// per the dedup state machine. Tool-results inside user messages dedup
// independently by tool_use_id; if a user message contains only already-
// mirrored tool_results, the user message itself stages but with the
// duplicated blocks omitted.
function stageUserRecords(ctx, sessionId) {
  const body = ctx.body;
  if (!body || !Array.isArray(body.messages)) return null;

  const entry = getSession(sessionId);
  const userMessages = body.messages.filter((m) => m && m.role === "user");
  if (userMessages.length === 0) return null;

  // Tool-result IDs already seen across the whole session (for cross-message dedup).
  const pendingToolResultIds = new Set();
  const stagedRecords = [];
  const timestamp = new Date().toISOString();
  const baseOrdinal = entry.mirroredUserMessageCount;

  for (let k = baseOrdinal; k < userMessages.length; k++) {
    const userMsg = userMessages[k];
    const content = userMsg.content;

    // Tool-result block dedup: skip blocks whose tool_use_id is already seen.
    if (Array.isArray(content)) {
      const filteredBlocks = [];
      let hasToolResult = false;
      for (const block of content) {
        if (block && block.type === "tool_result" && typeof block.tool_use_id === "string") {
          hasToolResult = true;
          if (entry.mirroredToolResultIds.has(block.tool_use_id) ||
              pendingToolResultIds.has(block.tool_use_id)) {
            continue;
          }
          pendingToolResultIds.add(block.tool_use_id);
        }
        filteredBlocks.push(block);
      }
      // If after filtering, all the user message's content is empty, skip
      // staging this record entirely — nothing new to mirror.
      if (filteredBlocks.length === 0) continue;
      const isToolResultMsg = hasToolResult && filteredBlocks.every((b) => b && b.type === "tool_result");
      const shaper = isToolResultMsg ? shapeToolResultUserRecord : shapeUserRecord;
      stagedRecords.push(shaper({
        sessionId,
        timestamp,
        parentUuid: null, // filled at write time using the per-session chain
        promptId: typeof userMsg.promptId === "string" ? userMsg.promptId : null,
        permissionMode: typeof userMsg.permissionMode === "string" ? userMsg.permissionMode : null,
        content: filteredBlocks,
        ordinalSeed: `${k}`,
        includeThinking: includeThinking(),
      }));
    } else {
      // String content (plain user message).
      stagedRecords.push(shapeUserRecord({
        sessionId,
        timestamp,
        parentUuid: null,
        promptId: null,
        permissionMode: null,
        content,
        ordinalSeed: `${k}`,
        includeThinking: includeThinking(),
      }));
    }
  }

  ctx.meta._mirrorPendingUserRecords = stagedRecords;
  ctx.meta._mirrorPendingUserMessageCount = userMessages.length;
  ctx.meta._mirrorPendingToolResultIds = pendingToolResultIds;
  return stagedRecords;
}

// ============================================================================
// Assistant-record accumulator (in onStreamEvent)
// ============================================================================

function getAccumulator(ctx) {
  if (!ctx.meta._mirrorAccumulator) {
    ctx.meta._mirrorAccumulator = {
      messageId: null,
      model: null,
      contentBlocks: [], // partial blocks indexed by stream index
      startUsage: null,
      deltaUsage: null,
      stopReason: null,
      stopSequence: null,
      stopDetails: null,
      requestId: null,
    };
  }
  return ctx.meta._mirrorAccumulator;
}

function handleStreamEvent(ctx, sessionId) {
  const evt = ctx.event;
  if (!evt || !evt.type) return false;
  const acc = getAccumulator(ctx);
  switch (evt.type) {
    case "message_start": {
      const msg = evt.message || {};
      acc.messageId = msg.id || null;
      acc.model = msg.model || null;
      acc.startUsage = msg.usage || null;
      acc.requestId = ctx.responseHeaders?.["request-id"] || null;
      acc.contentBlocks = [];
      return false;
    }
    case "content_block_start": {
      const idx = evt.index;
      if (typeof idx === "number" && evt.content_block) {
        // Deep-copy the starting block so deltas mutate our buffer, not the
        // event object the rest of the pipeline still sees.
        acc.contentBlocks[idx] = JSON.parse(JSON.stringify(evt.content_block));
      }
      return false;
    }
    case "content_block_delta": {
      const idx = evt.index;
      const delta = evt.delta;
      if (typeof idx !== "number" || !delta || !acc.contentBlocks[idx]) return false;
      const block = acc.contentBlocks[idx];
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        block.text = (block.text || "") + delta.text;
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.thinking = (block.thinking || "") + delta.thinking;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        // tool_use blocks accumulate their JSON args as a string; the final
        // `input` field will be JSON.parse'd by consumers.
        block._partialJson = (block._partialJson || "") + delta.partial_json;
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        block.signature = (block.signature || "") + delta.signature;
      }
      return false;
    }
    case "content_block_stop": {
      const idx = evt.index;
      if (typeof idx !== "number" || !acc.contentBlocks[idx]) return false;
      const block = acc.contentBlocks[idx];
      // Resolve tool_use partial_json into block.input.
      if (block.type === "tool_use" && typeof block._partialJson === "string") {
        try {
          block.input = JSON.parse(block._partialJson);
        } catch {
          block.input = block._partialJson;
        }
        delete block._partialJson;
      }
      return false;
    }
    case "message_delta": {
      acc.stopReason = evt.delta?.stop_reason ?? acc.stopReason;
      acc.stopSequence = evt.delta?.stop_sequence ?? acc.stopSequence;
      acc.stopDetails = evt.delta?.stop_details ?? acc.stopDetails;
      if (evt.usage) acc.deltaUsage = evt.usage;
      return false;
    }
    case "message_stop": {
      return true; // signal: flush now
    }
    default:
      return false;
  }
}

function flushAccumulator(ctx, sessionId) {
  const acc = ctx.meta._mirrorAccumulator;
  if (!acc || !acc.messageId) return;
  const entry = getSession(sessionId);

  const staged = ctx.meta._mirrorPendingUserRecords || [];
  const records = [];

  // Wire the parentUuid chain across all records about to be written.
  let prevUuid = entry.lastUuid;
  for (const rec of staged) {
    rec.parentUuid = prevUuid;
    records.push(rec);
    prevUuid = rec.uuid;
  }

  const assistantRecord = shapeAssistantRecord({
    sessionId,
    timestamp: new Date().toISOString(),
    parentUuid: prevUuid,
    requestId: acc.requestId,
    messageId: acc.messageId,
    model: acc.model,
    content: acc.contentBlocks.filter(Boolean),
    stopReason: acc.stopReason,
    stopSequence: acc.stopSequence,
    stopDetails: acc.stopDetails,
    usage: mergeUsage(acc.startUsage, acc.deltaUsage),
    includeThinking: includeThinking(),
  });
  records.push(assistantRecord);

  try {
    writeRecordsSync(sessionId, records);
    // ONLY after a successful write: advance the dedup state and the chain.
    if (typeof ctx.meta._mirrorPendingUserMessageCount === "number") {
      entry.mirroredUserMessageCount = ctx.meta._mirrorPendingUserMessageCount;
    }
    if (ctx.meta._mirrorPendingToolResultIds instanceof Set) {
      for (const id of ctx.meta._mirrorPendingToolResultIds) {
        entry.mirroredToolResultIds.add(id);
      }
    }
    entry.lastUuid = assistantRecord.uuid;
  } catch (err) {
    // Failure isolation: writer error logged + reported, but never propagated
    // — the pipeline's try/catch (pipeline.mjs:91-96 etc.) will catch
    // anything we let escape, but we drop it cleanly here so the response
    // stream is unaffected.
    _appendEvent({
      event: "error",
      session_id: sessionId,
      error_class: err?.code || err?.name || "unknown",
    });
  } finally {
    // Clear the accumulator + staged user records; the request meta scopes
    // them naturally, but explicit reset helps with mid-request flushes.
    ctx.meta._mirrorAccumulator = null;
    ctx.meta._mirrorPendingUserRecords = null;
    ctx.meta._mirrorPendingUserMessageCount = null;
    ctx.meta._mirrorPendingToolResultIds = null;
  }
}

// ============================================================================
// Extension default export
// ============================================================================

export default {
  name: "jsonl-session-mirror",
  description:
    "Mirrors every assistant message + the tool results / user inputs it observes into a per-session JSONL file under user control. " +
    "Belt-and-suspenders backup against CC's stub-rewrite (CC#66734) and missing-transcript (CC#66486) regressions. " +
    "Read-only with respect to upstream traffic; no requests or responses modified.",
  order: 720,
  routes: ["messages"],

  async onRequest(ctx) {
    if (!modeFromEnv()) return;
    const sessionId = resolveSessionId(ctx.headers) || UNKNOWN_SESSION;
    ctx.meta._mirrorSessionId = sessionId;
    try {
      stageUserRecords(ctx, sessionId);
    } catch (err) {
      _appendEvent({
        event: "error",
        session_id: sessionId,
        error_class: err?.code || err?.name || "stage_error",
      });
    }
    // Lazy throttled sweep — runs at most every 60s per cache-telemetry
    // precedent. Cheap when throttled; bounded I/O when it fires.
    try { sweepRetentionThrottled(); } catch {}
  },

  async onStreamEvent(ctx) {
    if (!modeFromEnv()) return;
    const sessionId = ctx.meta?._mirrorSessionId || UNKNOWN_SESSION;
    let shouldFlush;
    try {
      shouldFlush = handleStreamEvent(ctx, sessionId);
    } catch (err) {
      _appendEvent({ event: "error", session_id: sessionId, error_class: err?.code || err?.name || "accumulate_error" });
      return;
    }
    if (shouldFlush) {
      flushAccumulator(ctx, sessionId);
    }
  },

  async onResponse(ctx) {
    if (!modeFromEnv()) return;
    // onResponse fires on the non-streaming branch. Body is already parsed.
    const sessionId = ctx.meta?._mirrorSessionId || resolveSessionId(ctx.headers) || UNKNOWN_SESSION;
    const body = ctx.body;
    if (!body || typeof body !== "object" || body.type !== "message") return;

    const acc = getAccumulator(ctx);
    acc.messageId = body.id || null;
    acc.model = body.model || null;
    acc.startUsage = body.usage || null;
    acc.contentBlocks = Array.isArray(body.content) ? [...body.content] : [];
    acc.stopReason = body.stop_reason || null;
    acc.stopSequence = body.stop_sequence || null;
    acc.stopDetails = body.stop_details || null;
    acc.requestId = ctx.headers?.["request-id"] || null;

    flushAccumulator(ctx, sessionId);
  },
};
