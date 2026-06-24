import { createHash } from "node:crypto";

// Opt-in env gate. Per the directive (docs/directives/proxy-read-dedupe.md),
// the only accepted truthy value is the literal "1" — no "on" / "true" /
// case-insensitive variants. Keeping the gate strict avoids accidental
// activation from an operator-set CACHE_FIX_READ_DEDUPE=on borrowed from
// the on/off-style extensions; if Codex review pushes back we widen here.
const ENV_VAR = "CACHE_FIX_READ_DEDUPE";

export function isEnabled(env = process.env) {
  return env[ENV_VAR] === "1";
}

// --- Pure helpers (exported for direct unit testing) ---

export function buildToolUseMap(messages) {
  const map = new Map();
  if (!Array.isArray(messages)) return map;
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || block.type !== "tool_use" || typeof block.id !== "string" || block.id.length === 0) continue;
      map.set(block.id, { msgIdx, name: block.name, input: block.input });
    }
  }
  return map;
}

// Case-sensitive: CC's tool registry uses TitleCase. A future renamed
// "read" or "ReadFile" tool would not be Read-classified — that's the
// safer default; tighten by extension rather than accidentally widening.
export function isReadToolUse(toolUse) {
  return !!toolUse && toolUse.name === "Read";
}

// Classify content shape per directive § "Eligible content shapes":
//   - string                                                  → "string"
//   - [{type:"text", text}]  (single element, text-only)      → "text-array"
//   - any array with >1 element OR any non-text element       → "skip-mixed-array"
//   - missing/null/other                                       → "skip"
// Skipping at detection (rather than text-only-keying) prevents two
// mixed arrays with identical text but different non-text items from
// colliding and being deduped — that's the Codex blocker fix from
// directive review #1.
export function extractContentText(content) {
  if (typeof content === "string") return { kind: "string", text: content };
  if (Array.isArray(content)) {
    if (content.length === 1) {
      const only = content[0];
      if (only && only.type === "text" && typeof only.text === "string") {
        return { kind: "text-array", text: only.text };
      }
      return { kind: "skip-mixed-array", text: null };
    }
    if (content.length > 1) return { kind: "skip-mixed-array", text: null };
    return { kind: "skip", text: null };
  }
  return { kind: "skip", text: null };
}

// sha256 over (file_path, content_text, offset, limit) with NUL separators.
// NUL separators prevent boundary ambiguity (e.g. file="a\nb=10" vs
// file="a" + content="\nb=10"). null and undefined collapse to the empty
// string, so the common Read-with-no-offset/limit case keys cleanly.
export function computeDedupeKey({ file_path, content_text, offset, limit }) {
  const parts = [
    String(file_path ?? ""),
    String(content_text ?? ""),
    offset === undefined || offset === null ? "" : String(offset),
    limit === undefined || limit === null ? "" : String(limit),
  ];
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

// Walk all user-message tool_result blocks. For each, look up the
// originating tool_use; classify Read vs non-Read vs missing; classify
// the content shape; and emit one Occurrence record per scanned block.
// Emitting skipped/non-Read occurrences (rather than dropping them) lets
// the caller increment the right telemetry counter without a second pass.
//
// Occurrence shape:
//   { msgIdx, blockIdx, itemIdx, classification, contentKind, key, fromToolUseId, fromMsgIdx, bytes }
// where:
//   classification ∈ "read-eligible" | "read-skip-mixed" | "read-skip-other" | "non-read" | "no-tool-use"
//   itemIdx        = null for string content, 0 for single-element text-array
//   key, bytes     populated only for "read-eligible"
export function walkReadToolResults(messages, toolUseMap) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let blockIdx = 0; blockIdx < msg.content.length; blockIdx++) {
      const block = msg.content[blockIdx];
      if (!block || block.type !== "tool_result") continue;
      const toolUseId = block.tool_use_id;
      const origin = typeof toolUseId === "string" ? toolUseMap.get(toolUseId) : undefined;
      if (!origin) {
        out.push({ msgIdx, blockIdx, itemIdx: null, classification: "no-tool-use", contentKind: null, key: null, fromToolUseId: toolUseId ?? null, fromMsgIdx: null, bytes: 0 });
        continue;
      }
      if (!isReadToolUse(origin)) {
        out.push({ msgIdx, blockIdx, itemIdx: null, classification: "non-read", contentKind: null, key: null, fromToolUseId: toolUseId, fromMsgIdx: origin.msgIdx, bytes: 0 });
        continue;
      }
      const input = origin.input || {};
      if (typeof input.file_path !== "string" || input.file_path.length === 0) {
        out.push({ msgIdx, blockIdx, itemIdx: null, classification: "read-skip-other", contentKind: null, key: null, fromToolUseId: toolUseId, fromMsgIdx: origin.msgIdx, bytes: 0 });
        continue;
      }
      const { kind, text } = extractContentText(block.content);
      if (kind === "skip-mixed-array") {
        out.push({ msgIdx, blockIdx, itemIdx: null, classification: "read-skip-mixed", contentKind: kind, key: null, fromToolUseId: toolUseId, fromMsgIdx: origin.msgIdx, bytes: 0 });
        continue;
      }
      if (kind === "skip") {
        out.push({ msgIdx, blockIdx, itemIdx: null, classification: "read-skip-other", contentKind: kind, key: null, fromToolUseId: toolUseId, fromMsgIdx: origin.msgIdx, bytes: 0 });
        continue;
      }
      const key = computeDedupeKey({
        file_path: input.file_path,
        content_text: text,
        offset: input.offset,
        limit: input.limit,
      });
      out.push({
        msgIdx,
        blockIdx,
        itemIdx: kind === "text-array" ? 0 : null,
        classification: "read-eligible",
        contentKind: kind,
        key,
        fromToolUseId: toolUseId,
        fromMsgIdx: origin.msgIdx,
        bytes: Buffer.byteLength(text, "utf8"),
      });
    }
  }
  return out;
}

// Conversation turn = user→assistant pair. messages[0] (first user) → turn 1.
// Computed from the tool_result's user-message msgIdx (the position we
// hold on every Occurrence record). Per directive § "Replacement contract":
// turn := Math.floor(msgIdx / 2) + 1. Whether the directive intended the
// user or assistant msgIdx is one of the open Qs flagged for Codex review;
// for well-formed pairs both forms agree on the integer result.
export function computeTurn(msgIdx) {
  return Math.floor(msgIdx / 2) + 1;
}

// Pointer text the keeper's later duplicates are rewritten to. Byte-stable
// because the keeper is the FIRST occurrence — keeperId and keeperTurn
// never change as new duplicates of the same key arrive, so the pointer
// bytes never churn. Em-dash is U+2014 literal; ASCII "--" would break
// byte-identity across runs and Codex flagged this in review.
export function buildReplacementText(keeperId, keeperTurn) {
  return `(unchanged — see tool_use_id=${keeperId} in turn ${keeperTurn})`;
}

// Build NEW messages array reflecting all the per-bucket replacements.
// Immutable-style: never mutate input. Shallow-clone affected messages
// and the affected tool_result blocks; everything else passes through
// by reference. Short-circuits to the original messages reference when
// zero replacements are scheduled, so the no-op path costs no allocation.
// Pattern mirrors thinking-block-sanitize.mjs::planSanitize.
export function applyReplacements(messages, occurrences, keeperByKey) {
  // Index replacements by msgIdx → blockIdx → { pointerText, itemIdx }
  const perMsg = new Map();
  let scheduled = 0;
  for (const occ of occurrences) {
    if (occ.classification !== "read-eligible") continue;
    const keeper = keeperByKey.get(occ.key);
    if (!keeper) continue;
    // The keeper itself is never rewritten.
    if (keeper.msgIdx === occ.msgIdx && keeper.blockIdx === occ.blockIdx) continue;
    const pointerText = buildReplacementText(keeper.fromToolUseId, computeTurn(keeper.msgIdx));
    if (!perMsg.has(occ.msgIdx)) perMsg.set(occ.msgIdx, new Map());
    perMsg.get(occ.msgIdx).set(occ.blockIdx, { pointerText, itemIdx: occ.itemIdx, contentKind: occ.contentKind, originalBytes: occ.bytes });
    scheduled++;
  }
  if (scheduled === 0) return { messages, replacements: [] };

  const out = messages.slice();
  const replacements = [];
  for (const [msgIdx, blockMap] of perMsg) {
    const msg = out[msgIdx];
    const newContent = msg.content.slice();
    for (const [blockIdx, plan] of blockMap) {
      const original = newContent[blockIdx];
      let newContentField;
      if (plan.contentKind === "string") {
        newContentField = plan.pointerText;
      } else {
        // text-array: preserve outer array + inner {type:"text"} shape; replace only `text`.
        const innerOriginal = original.content[plan.itemIdx];
        const newInner = { ...innerOriginal, text: plan.pointerText };
        newContentField = original.content.slice();
        newContentField[plan.itemIdx] = newInner;
      }
      newContent[blockIdx] = { ...original, content: newContentField };
      replacements.push({
        msgIdx,
        blockIdx,
        originalBytes: plan.originalBytes,
        pointerBytes: Buffer.byteLength(plan.pointerText, "utf8"),
      });
    }
    out[msgIdx] = { ...msg, content: newContent };
  }
  return { messages: out, replacements };
}

// Pure orchestrator. Takes a request body; returns the (possibly-new)
// messages array and a fully-populated stats object. Tests target this
// directly; onRequest only attaches it to ctx.
export function runReadDedupe(body) {
  const stats = {
    enabled: true,
    total_tool_results_scanned: 0,
    read_tool_results_classified: 0,
    read_tool_results_skipped: 0,
    read_tool_results_skipped_mixed_array: 0,
    unique_keys: 0,
    duplicate_keys: 0,
    replacements_written: 0,
    bytes_original: 0,
    bytes_after: 0,
    bytes_saved: 0,
  };
  if (!body || !Array.isArray(body.messages)) return { messages: body?.messages, stats };

  const toolUseMap = buildToolUseMap(body.messages);
  const occurrences = walkReadToolResults(body.messages, toolUseMap);

  for (const occ of occurrences) {
    stats.total_tool_results_scanned++;
    if (occ.classification === "read-eligible") {
      stats.read_tool_results_classified++;
    } else if (occ.classification === "read-skip-mixed") {
      stats.read_tool_results_skipped++;
      stats.read_tool_results_skipped_mixed_array++;
    } else if (occ.classification === "read-skip-other" || occ.classification === "non-read" || occ.classification === "no-tool-use") {
      stats.read_tool_results_skipped++;
    }
  }

  // Bucket by key. FIRST-by-(msgIdx, blockIdx) is the keeper; walkRead
  // yields occurrences in conversation order, so the first push for a
  // given key is already the earliest. This is the byte-stability fix
  // (directive Codex blocker from review #1): pointer bytes never churn
  // as new duplicates accumulate, because the keeper never moves.
  const buckets = new Map();
  for (const occ of occurrences) {
    if (occ.classification !== "read-eligible") continue;
    if (!buckets.has(occ.key)) buckets.set(occ.key, []);
    buckets.get(occ.key).push(occ);
  }
  stats.unique_keys = buckets.size;

  const keeperByKey = new Map();
  for (const [key, list] of buckets) {
    if (list.length >= 2) {
      stats.duplicate_keys++;
      keeperByKey.set(key, list[0]);
    }
  }

  const { messages: newMessages, replacements } = applyReplacements(body.messages, occurrences, keeperByKey);
  for (const r of replacements) {
    stats.replacements_written++;
    stats.bytes_original += r.originalBytes;
    stats.bytes_after += r.pointerBytes;
  }
  stats.bytes_saved = stats.bytes_original - stats.bytes_after;

  return { messages: newMessages, stats };
}

function emitSummary(stats, readsSeen) {
  if (stats.replacements_written > 0) {
    const pct = stats.bytes_original > 0
      ? Math.round((stats.bytes_saved / stats.bytes_original) * 1000) / 10
      : 0;
    process.stderr.write(
      `[read-dedupe] replaced=${stats.replacements_written} keys=${stats.duplicate_keys} bytes=${stats.bytes_original}->${stats.bytes_after} (saved=${pct}%) reads_seen=${readsSeen}\n`,
    );
  } else {
    process.stderr.write(`[read-dedupe] no-op reads_seen=${readsSeen} (no duplicates)\n`);
  }
}

export default {
  name: "read-dedupe",
  description: "Dedupe repeat Read-tool results: keep the first occurrence, replace later byte-identical (per file_path + content + offset + limit) tool_results with a stable pointer line.",
  enabled: true,
  order: 380,

  async onRequest(ctx) {
    // Always attach the stats stub so dashboards can observe the extension
    // is loaded; off-mode emits enabled:false and exits without scanning.
    const enabled = isEnabled();
    if (!enabled) {
      ctx.meta.readDedupeStats = {
        enabled: false,
        total_tool_results_scanned: 0,
        read_tool_results_classified: 0,
        read_tool_results_skipped: 0,
        read_tool_results_skipped_mixed_array: 0,
        unique_keys: 0,
        duplicate_keys: 0,
        replacements_written: 0,
        bytes_original: 0,
        bytes_after: 0,
        bytes_saved: 0,
      };
      return;
    }
    if (!ctx.body || !Array.isArray(ctx.body.messages)) {
      ctx.meta.readDedupeStats = {
        enabled: true,
        total_tool_results_scanned: 0,
        read_tool_results_classified: 0,
        read_tool_results_skipped: 0,
        read_tool_results_skipped_mixed_array: 0,
        unique_keys: 0,
        duplicate_keys: 0,
        replacements_written: 0,
        bytes_original: 0,
        bytes_after: 0,
        bytes_saved: 0,
      };
      return;
    }

    const { messages, stats } = runReadDedupe(ctx.body);
    ctx.body.messages = messages;
    ctx.meta.readDedupeStats = stats;
    emitSummary(stats, stats.read_tool_results_classified);
  },
};
