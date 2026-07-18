// Shared synthesized-response builders for extensions that short-circuit a
// /v1/messages request at onRequest via { skip: true, ... }. Extracted from
// image-retry-circuit-breaker so the session-budget breaker (and any future
// local short-circuit) reuse one wire-format instead of forking it.
//
// The pipeline's skip handler (server.mjs) writes a string body verbatim and
// JSON-stringifies an object body, both before any upstream call — so:
//   stream:true  -> body: buildSseString(model, text)  + content-type text/event-stream
//   stream:false -> body: buildJsonBody(model, text)    + content-type application/json
//
// Both envelopes carry a zero usage block: the harness SDK expects a usage
// field, and no upstream tokens were spent on a locally-synthesized turn.

import { createHash } from "node:crypto";

export function synthMessageId() {
  // Date.now()/Math.random() are fine here — this runs on the live request path,
  // not in a resume-replayed context.
  return "msg_synth_" + createHash("sha256").update(String(Date.now()) + ":" + Math.random())
    .digest("hex").slice(0, 22);
}

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

// Minimal valid SSE event sequence the CC harness SDK consumes as a normal
// completed assistant turn. Omits `data: [DONE]` (per image-retry directive; sim
// validation governs whether upstream emits it on this surface).
export function buildSseString(model, text) {
  const msgId = synthMessageId();
  const startMsg = {
    type: "message_start",
    message: {
      id: msgId, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null, usage: { ...ZERO_USAGE },
    },
  };
  return (
    `event: message_start\ndata: ${JSON.stringify(startMsg)}\n\n` +
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
  );
}

export function buildJsonBody(model, text) {
  return {
    id: synthMessageId(),
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { ...ZERO_USAGE },
  };
}

// Build a full skip-result for a request. `text` is the short-circuit message.
export function buildSkipResult(request, text) {
  const model = typeof request?.model === "string" ? request.model : "claude-unknown";
  if (request?.stream === true) {
    return { skip: true, status: 200, headers: { "content-type": "text/event-stream" }, body: buildSseString(model, text) };
  }
  return { skip: true, status: 200, headers: { "content-type": "application/json" }, body: buildJsonBody(model, text) };
}
