// thinking-block-sanitize — request-path mitigation for the CC thinking-desync
// wedge (anthropics/claude-code#63147). On replay paths (resume / --continue /
// auto-compaction / parallel-tool-cancel), CC re-sends prior assistant turns'
// thinking in the OMITTED shape `{ type:"thinking", thinking:"", signature }`.
// The API rejects modified thinking in the *latest* assistant message with a
// permanent 400, which wedges the session. This extension drops the omitted
// thinking blocks the API treats as optional, before the request is forwarded.
//
// Resolved turn-selection rule (directive Open Question 1, empirical capture):
//   - drop omitted thinking from ALL prior assistant turns, AND
//   - from the LATEST assistant turn UNLESS it is an active tool-continuation
//     (last block is a tool_use with a following tool_result) — that case is
//     uncoverable by the proxy (the API needs the signed thinking for the
//     pending tool call; we can't restore the emptied text) → user-side
//     DISABLE_INTERLEAVED_THINKING=1.
// Never touches non-empty thinking, and never touches redacted_thinking (v1).
//
// OPT-IN for v1: only runs when CACHE_FIX_THINKING_SANITIZE=on (default off) —
// it mutates request bodies and its coverage is not yet live-validated.
//
// Order 550: after the request-body mutators (ttl-management 500) and before
// session-health (590), so #160's thinking_block_count reflects the forwarded
// body. The per-request drop count is exposed via ctx.meta._thinkingSanitize
// for cache-telemetry (600) to merge into the per-session JSON.

export function isOmittedThinking(block) {
  return (
    !!block &&
    block.type === "thinking" &&
    typeof block.thinking === "string" &&
    block.thinking.trim() === ""
  );
}

function answersToolUse(msg, toolUseId) {
  return (
    !!msg &&
    Array.isArray(msg.content) &&
    msg.content.some(
      (b) => b && b.type === "tool_result" && b.tool_use_id === toolUseId,
    )
  );
}

// The latest assistant message is an active tool-continuation when its terminal
// block is a `tool_use` that is *paired with* — i.e. answered by — a following
// `tool_result` carrying the same `tool_use_id`. Only then does the API require
// that turn's thinking intact, so only then must we leave it untouched. Matching
// the id (not merely the presence of any later tool_result) keeps the guard as
// narrow as the approved rule: an unanswered terminal tool_use, or a later
// tool_result that answers a *different* call, is not the protected case.
export function isActiveToolContinuation(messages, idx) {
  const msg = messages[idx];
  if (!msg || !Array.isArray(msg.content) || msg.content.length === 0) return false;
  const last = msg.content[msg.content.length - 1];
  if (!last || last.type !== "tool_use" || !last.id) return false;
  for (let j = idx + 1; j < messages.length; j++) {
    if (answersToolUse(messages[j], last.id)) return true;
  }
  return false;
}

function latestAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "assistant") return i;
  }
  return -1;
}

// Pure planner: returns { messages, dropped }. Does not mutate the input.
// `messages` is the new array (a message that loses all content is dropped).
export function planSanitize(messages) {
  if (!Array.isArray(messages)) return { messages, dropped: 0 };
  const latestAsst = latestAssistantIndex(messages);
  const protectLatest = latestAsst >= 0 && isActiveToolContinuation(messages, latestAsst);

  let dropped = 0;
  let changed = false;
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    if (i === latestAsst && protectLatest) {
      out.push(msg); // active continuation — leave its thinking intact
      continue;
    }
    const kept = msg.content.filter((b) => {
      if (isOmittedThinking(b)) {
        dropped++;
        return false;
      }
      return true;
    });
    if (kept.length === msg.content.length) {
      out.push(msg); // unchanged
    } else if (kept.length === 0) {
      changed = true; // message became empty → drop it entirely
    } else {
      out.push({ ...msg, content: kept });
      changed = true;
    }
  }
  return { messages: changed ? out : messages, dropped };
}

export default {
  name: "thinking-block-sanitize",
  description:
    "Drop omitted (empty-text) thinking blocks from prior assistant turns and the latest non-continuation turn, to head off the CC thinking-desync 400 (#63147). Opt-in via CACHE_FIX_THINKING_SANITIZE=on.",
  order: 550,

  async onRequest(ctx) {
    if (process.env.CACHE_FIX_THINKING_SANITIZE !== "on") return;
    const body = ctx.body;
    if (!body || !Array.isArray(body.messages)) return;

    const { messages, dropped } = planSanitize(body.messages);
    if (dropped > 0) body.messages = messages;

    // Counts only — never content. Exposed for cache-telemetry to persist and
    // for the #160 session-health signal.
    ctx.meta._thinkingSanitize = { thinking_blocks_dropped: dropped };
  },
};
