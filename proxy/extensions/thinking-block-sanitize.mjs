// thinking-block-sanitize — request-path mitigation for the CC thinking-desync
// wedge (anthropics/claude-code#63147).
//
// v1 (CACHE_FIX_THINKING_SANITIZE=on): On replay paths (resume / --continue /
// auto-compaction / parallel-tool-cancel), CC re-sends prior assistant turns'
// thinking in the OMITTED shape `{ type:"thinking", thinking:"", signature }`.
// The API rejects modified thinking in the *latest* assistant message with a
// permanent 400, which wedges the session. v1 drops these omitted blocks
// before forwarding. Never touches non-empty thinking; never touches
// redacted_thinking (v1's empirical exclusion — zero observed in worst-case
// wedged transcripts).
//
// v2 (CACHE_FIX_THINKING_SANITIZE=v2): Additionally handles yurukusa's "13E"
// pattern — when ToolSearch dynamically loads a tool mid-conversation, the
// prior assistant turn's thinking signature is invalidated because it was
// computed over the now-stale tools surface. The API rejects + CC's harness
// strips-and-retries, paying a 400 + retry tax every turn. v2 detects
// cross-request tools-surface change via a per-session tools-hash baseline,
// and strips ALL prior-turn signed thinking (both `thinking` blocks with
// non-empty text AND `redacted_thinking` blocks — v2's scope is structural,
// not empirical) on hash mismatch. Same active-tool-continuation latest-turn
// guard as v1.
//
// Resolved turn-selection rule (v1 directive Open Question 1, empirical capture):
//   - drop omitted thinking from ALL prior assistant turns, AND
//   - from the LATEST assistant turn UNLESS it is an active tool-continuation
//     (last block is a tool_use with a following tool_result) — that case is
//     uncoverable by the proxy (the API needs the signed thinking for the
//     pending tool call; we can't restore the emptied text). No env var both
//     preserves thinking and avoids the wedge there — CLAUDE_CODE_DISABLE_THINKING=1
//     / MAX_THINKING_TOKENS=0 stop it only by disabling thinking entirely
//     (lossy); DISABLE_INTERLEAVED_THINKING=1 does NOT stop the 400 — so the
//     answer for that case is don't-resume + heal/retire.
//
// v2 state pattern (per directive proxy-thinking-block-sanitize-v2.md):
//   - In-memory per-session map keyed by canonical session filename, seeded
//     once from sessions/<sid>.json on first request that session. Mirrors
//     session-health's pattern. Lives at module scope.
//   - Baseline updates ONLY on response success (HTTP 2xx). 4xx/5xx leave
//     the baseline unchanged so a failed request's hash doesn't become the
//     new ground truth.
//   - First request observes-and-establishes (no strip; baseline is set
//     after the response succeeds).
//   - When canonical session id is "unknown" (raw id null/empty/whitespace),
//     v2 no-ops entirely. The shared sessions/unknown.json would cross-
//     contaminate baselines across unrelated agents otherwise.
//
// Modes via CACHE_FIX_THINKING_SANITIZE (as of v4.0.0 — v1 default-on flip):
//   unset (or "on")                       — v1 only (omitted-text drop). DEFAULT.
//   "off"                                 — extension no-ops (explicit disable)
//   "v2"                                  — v1 + v2 (omitted-text drop AND
//                                           tools-hash-mismatch drop). v2 is
//                                           strict superset of v1.
//   any other value                       — treated as v1 (the default), not off.
//                                           Matches the precedent of being
//                                           permissive about the on-path.
//
// v1 default-on rationale: 7-day prod dogfood across 37 sessions (2026-05-29
// → 2026-06-05) on `=on`: zero `cannot be modified` 400s, cache hit-rate
// aggregate 94.66% vs 92.44% baseline (no prefix degradation), sanitize fired
// on ~35% of sessions, ~800 blocks dropped per day, max 938K context healthy.
// v2 stays opt-in via `=v2` because the dogfood only ran v1.
//
// Order 550: after the request-body mutators (ttl-management 500) and before
// session-health (590), so #160's thinking_block_count reflects the forwarded
// body. The per-request drop counts are exposed via ctx.meta._thinkingSanitize
// (v1 counter) and ctx.meta._thinkingSanitizeV2 (v2 counter + baseline) for
// cache-telemetry (600) to merge into the per-session JSON.

import { readFileSync } from "node:fs";
import { resolveSessionId, sessionFilePath, sessionFilename } from "./cache-telemetry.mjs";
import { computeSignatureSurfaceHash } from "./signature-surface-hash.mjs";

// --- v1 predicates ---

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

// --- v2 predicate ---

// v2 strips signed `thinking` blocks (non-empty text) AND `redacted_thinking`
// blocks. v1's `isOmittedThinking` filter handles the empty-text case
// independently — when both flags are active, v1 drops the empty ones and v2
// drops the signed ones; predicates are non-overlapping.
export function isSignedThinkingForV2(block) {
  if (!block) return false;
  if (block.type === "redacted_thinking") return true;
  // Non-empty thinking with a signature — v1 leaves these alone by design.
  return (
    block.type === "thinking" &&
    typeof block.thinking === "string" &&
    block.thinking.trim() !== "" &&
    typeof block.signature === "string" &&
    block.signature.length > 0
  );
}

// --- Pure planner ---
//
// Returns { messages, dropped, droppedV2 }. Does not mutate input.
// `v2StripSigned` is the externally-determined boolean: should v2's
// signed-thinking drop fire this request? (Caller has already computed
// hash mismatch + session-state checks.)
export function planSanitize(messages, { v2StripSigned = false } = {}) {
  if (!Array.isArray(messages)) return { messages, dropped: 0, droppedV2: 0 };
  const latestAsst = latestAssistantIndex(messages);
  const protectLatest = latestAsst >= 0 && isActiveToolContinuation(messages, latestAsst);

  let dropped = 0;
  let droppedV2 = 0;
  let changed = false;
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    if (i === latestAsst && protectLatest) {
      // Active continuation — leave thinking intact (both v1 and v2 respect
      // this; the API needs the signed thinking for the pending tool call).
      out.push(msg);
      continue;
    }
    const kept = msg.content.filter((b) => {
      // v1 always-active drop predicate.
      if (isOmittedThinking(b)) {
        dropped++;
        return false;
      }
      // v2-only drop predicate. Predicates are mutually exclusive on a single
      // block: omitted thinking matches v1's predicate but not v2's, and
      // signed/redacted thinking matches v2's predicate but not v1's.
      if (v2StripSigned && isSignedThinkingForV2(b)) {
        droppedV2++;
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
  return { messages: changed ? out : messages, dropped, droppedV2 };
}

// --- v2 mode + state ---

// "off" | "on" | "v2". As of v4.0.0 the default flipped from "off" to "on" —
// v1 (omitted-text drop) is the new default behavior. Set
// CACHE_FIX_THINKING_SANITIZE=off to explicitly disable; =v2 to additionally
// enable the v2 tools-hash-mismatch drop (still opt-in pending its own
// prod-dogfood window after #200 closes the silent-load failure mode).
// Unknown values fall through to "on" — we are permissive about the on-path
// and only treat the literal "off" as a disable.
export function modeFromEnv(env = process.env) {
  const v = env.CACHE_FIX_THINKING_SANITIZE;
  if (v === "off") return "off";
  if (v === "v2") return "v2";
  return "on";
}

// Per-session state, in memory. Keyed by canonical session filename
// (sessionFilename(rawId)). Each entry: { tools_hash_baseline }.
// Mirrors session-health's pattern: seeded once from disk on first request
// that session, then maintained in memory + persisted via cache-telemetry's
// spread of ctx.meta._thinkingSanitizeV2.
const v2SessionState = new Map();

function seedV2FromFile(rawSid) {
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(sessionFilePath(rawSid), "utf8"));
  } catch {}
  return {
    tools_hash_baseline:
      typeof prev?.tools_hash_baseline === "string" ? prev.tools_hash_baseline : null,
  };
}

// Test-only reset (also useful for proxy-restart simulation in unit tests).
export function _resetV2State() {
  v2SessionState.clear();
}

// --- Extension default-export ---

export default {
  name: "thinking-block-sanitize",
  description:
    "Drop omitted (empty-text) thinking blocks from prior assistant turns and the latest non-continuation turn, to head off the CC thinking-desync 400 (#63147). v1 mode: omitted-text drop only. v2 mode: also drop signed thinking + redacted_thinking on cross-request tools-hash mismatch (ToolSearch surface). v1 is now ON by default as of v4.0.0; set CACHE_FIX_THINKING_SANITIZE=off to disable, =v2 to additionally opt into v2.",
  order: 550,

  async onRequest(ctx) {
    const mode = modeFromEnv();
    if (mode === "off") return;

    const body = ctx.body;
    if (!body || !Array.isArray(body.messages)) return;

    // v2 only fires when mode === "v2" AND we have a usable session id.
    let v2StripSigned = false;
    let stateKey = null;
    let currentHash = null;

    if (mode === "v2") {
      // Resolve session id inline — cache-telemetry's onRequest runs at order
      // 600, after us, so ctx.meta._sessionId is not yet set when we fire at
      // order 550. We import resolveSessionId from cache-telemetry to keep
      // canonicalization consistent.
      const rawSid = resolveSessionId(ctx.headers);
      stateKey = sessionFilename(rawSid);

      // "unknown" canonical id → no-op for v2 (cross-contamination risk on
      // the shared sessions/unknown.json baseline). v1's strip still runs
      // below regardless.
      if (stateKey !== "unknown") {
        currentHash = computeSignatureSurfaceHash({ tools: body.tools });

        // Seed in-memory state from disk on first encounter that session
        // (covers proxy restart — re-reads persisted baseline).
        let st = v2SessionState.get(stateKey);
        if (!st) {
          st = seedV2FromFile(rawSid);
          v2SessionState.set(stateKey, st);
        }

        const baseline = st.tools_hash_baseline;
        // Mismatch only fires when there IS a baseline AND it differs.
        // First request (baseline === null) observes-and-establishes — no strip.
        v2StripSigned = baseline !== null && baseline !== currentHash;

        // Stash for the onResponseStart hook to advance the baseline iff the
        // response succeeded. Stash BEFORE the plan + strip so the response
        // path has access regardless of whether anything was dropped.
        ctx.meta._thinkingSanitizeV2PendingHash = currentHash;
        ctx.meta._thinkingSanitizeV2StateKey = stateKey;
      }
    }

    const { messages, dropped, droppedV2 } = planSanitize(body.messages, {
      v2StripSigned,
    });
    if (dropped > 0 || droppedV2 > 0) body.messages = messages;

    // Counts only — never content. Exposed for cache-telemetry to persist and
    // for the #160 session-health signal.
    // v1 counter — unchanged, fires for both modes.
    ctx.meta._thinkingSanitize = { thinking_blocks_dropped: dropped };

    // v2 counter — fires only in v2 mode. Includes the post-mismatch baseline
    // value that cache-telemetry will persist (so consumers can see the
    // current baseline in the session JSON even on requests that didn't
    // strip). The actual advance only happens on response success below.
    if (mode === "v2" && stateKey && stateKey !== "unknown") {
      ctx.meta._thinkingSanitizeV2 = {
        thinking_blocks_dropped_v2: droppedV2,
        // Persist the SOON-TO-BE-NEW baseline (it'll be advanced on success).
        // On 4xx/5xx, the cache-telemetry write still happens but the
        // in-memory state isn't advanced — next request re-reads disk and
        // sees the persisted value, which may now disagree with in-memory.
        // We resolve that by NOT writing the new hash to disk on failure:
        // see onResponseStart below, which is the only thing that advances
        // both in-memory and (indirectly via cache-telemetry's spread) disk.
        // For now, leave tools_hash_baseline at the CURRENT baseline value;
        // onResponseStart will overwrite this in meta if the response is 2xx.
        tools_hash_baseline: v2SessionState.get(stateKey)?.tools_hash_baseline ?? null,
      };
    }
  },

  // Advance the baseline only on HTTP 2xx response. 4xx/5xx leaves the
  // in-memory state and the meta-stashed baseline untouched, so a failed
  // request's hash never becomes the new ground truth.
  async onResponseStart(ctx) {
    const stateKey = ctx.meta._thinkingSanitizeV2StateKey;
    const pendingHash = ctx.meta._thinkingSanitizeV2PendingHash;
    if (!stateKey || !pendingHash) return;
    if (typeof ctx.status !== "number") return;
    if (ctx.status < 200 || ctx.status >= 300) return;

    // Advance in-memory baseline.
    let st = v2SessionState.get(stateKey);
    if (!st) {
      st = { tools_hash_baseline: null };
      v2SessionState.set(stateKey, st);
    }
    st.tools_hash_baseline = pendingHash;

    // Update the meta-stashed baseline so cache-telemetry's spread writes
    // the new value to disk. If meta._thinkingSanitizeV2 wasn't stashed
    // (e.g. mode flip mid-request), construct it now.
    if (!ctx.meta._thinkingSanitizeV2) {
      ctx.meta._thinkingSanitizeV2 = { thinking_blocks_dropped_v2: 0 };
    }
    ctx.meta._thinkingSanitizeV2.tools_hash_baseline = pendingHash;
  },
};
