// microcompact-stability — detect, optionally dump, and optionally normalize
// CC's `time_based_microcompact` sentinel string in tool_result content.
//
// Order 350: between `tool-input-normalize` (340) and `cache-control-normalize`
// (400). Runs BEFORE cache-control-normalize so the latter sees post-normalized
// content when computing sticky-marker hashes.
//
// Two independent runtime gates:
//   - CACHE_FIX_DUMP_MICROCOMPACT=<path>   → diagnostic JSONL dump (read-only).
//   - CACHE_FIX_NORMALIZE_MICROCOMPACT=1   → mutate matched sentinels to a
//                                            canonical byte-stable form.
//
// Two detection modes:
//   - Mode A (exact match against confirmed patterns) → eligible for
//     normalization. `sentinel_text` captured in full in dump records.
//   - Mode B (prefix-only match) → diagnostic-only, NEVER normalized. Records
//     redact to a configurable prefix length (default 64).
//
// The diagnostic dump always captures the **raw pre-normalization** bytes —
// this is the rule. Setting CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED=1
// additionally records the post-normalized form alongside the raw text.
//
// See `docs/directives/proxy-microcompact-cache-stability.md` for the full
// design (Mode A/B contract, privacy guarantees, Phase 2 deferral).

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

// --- Env gates (read per-call so tests can flip without re-importing) ---

function getDumpPath() {
  const v = process.env.CACHE_FIX_DUMP_MICROCOMPACT;
  return v && v.length > 0 ? v : null;
}
function isNormalizeEnabled() {
  return process.env.CACHE_FIX_NORMALIZE_MICROCOMPACT === "1";
}
function isIncludeNormalizedEnabled() {
  return process.env.CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED === "1";
}
function getCanonicalText() {
  const v = process.env.CACHE_FIX_MICROCOMPACT_NORMALIZED;
  return typeof v === "string" && v.length > 0 ? v : DEFAULT_CANONICAL_TEXT;
}
function getRedactLen() {
  const v = process.env.CACHE_FIX_MICROCOMPACT_REDACT_LEN;
  if (v === undefined || v === null || v === "") return DEFAULT_REDACT_LEN;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REDACT_LEN;
}
function getCustomPatterns() {
  // CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_<N>=<regex>  (1-indexed, sparse OK)
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_")) continue;
    if (typeof v !== "string" || v.length === 0) continue;
    try {
      out.push({ source: v, re: new RegExp(v) });
    } catch {
      process.stderr.write(`[microcompact] invalid regex in ${k}: ${v}\n`);
    }
  }
  return out;
}

// Custom Mode B literal prefixes, paired with custom Mode A regex patterns.
// A user who configures CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_<N> for a
// non-default sentinel family should also set CACHE_FIX_MICROCOMPACT_SENTINEL_PREFIX_<N>
// to the LITERAL string the family begins with — that's what enables Mode B
// (redacted prefix capture) for variants that don't exact-match the regex.
//
// We can't safely derive a prefix from an arbitrary regex, so we accept the
// prefix as a separate input. The two env-var families don't have to agree
// on numeric suffixes; we collect all prefixes regardless of index.
function getCustomPrefixes() {
  // CACHE_FIX_MICROCOMPACT_SENTINEL_PREFIX_<N>=<literal>  (1-indexed, sparse OK)
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CACHE_FIX_MICROCOMPACT_SENTINEL_PREFIX_")) continue;
    if (typeof v !== "string" || v.length === 0) continue;
    out.push(v);
  }
  return out;
}
function isDebug() {
  return process.env.CACHE_FIX_DEBUG === "1";
}
function debug(msg) {
  if (isDebug()) process.stderr.write(`[microcompact] DEBUG: ${msg}\n`);
}

// --- Constants ---

const DEFAULT_CANONICAL_TEXT = "[Old tool result content cleared]";
const DEFAULT_REDACT_LEN = 64;

// Default Mode A patterns (confirmed sentinel forms eligible for normalization).
// Adding a new exact form here promotes it from Mode B prefix capture to
// Mode A normalization-eligibility. Keep the list narrow.
const DEFAULT_EXACT_PATTERNS = [
  {
    source: "^\\[Old tool result content cleared\\]\\s*$",
    re: /^\[Old tool result content cleared\]\s*$/,
  },
  {
    source:
      "^\\[Old tool result content cleared at \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z\\]\\s*$",
    re: /^\[Old tool result content cleared at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\]\s*$/,
  },
];

// Mode B prefix — anything beginning with this is a candidate for redacted
// diagnostic capture, even if it doesn't match an exact pattern.
const SENTINEL_PREFIX = "[Old tool result content cleared";

// --- Pattern matching (pure) ---

// Returns the source string of the first matching exact pattern, or null.
// `extraPatterns` are user-supplied patterns from env vars; they're appended
// to the defaults so a custom regex doesn't silently disable a default.
export function matchesSentinelPattern(text, extraPatterns = []) {
  if (typeof text !== "string") return null;
  const all = DEFAULT_EXACT_PATTERNS.concat(extraPatterns);
  for (const p of all) {
    if (p.re.test(text)) return p.source;
  }
  return null;
}

function isPartialMatch(text, extraPrefixes = []) {
  if (typeof text !== "string") return false;
  if (text.startsWith(SENTINEL_PREFIX)) return true;
  for (const p of extraPrefixes) {
    if (text.startsWith(p)) return true;
  }
  return false;
}

// --- Walking tool_result content ---
//
// Returns { exact_matches, partial_matches, total_tool_results }.
//
// Match record shape (exact_matches[]):
//   { msg_idx, block_idx, content_kind: "string"|"array_item",
//     item_idx?, text, matched_pattern }
// Match record shape (partial_matches[]):
//   { msg_idx, block_idx, content_kind: "string"|"array_item",
//     item_idx?, text, byte_length }
//
// `text` on partial_matches is kept on the in-memory record for redaction at
// serialize time (the dump never persists the full text).

export function walkToolResultsForSentinels(messages, extraPatterns = [], extraPrefixes = []) {
  const exact_matches = [];
  const partial_matches = [];
  let total_tool_results = 0;
  if (!Array.isArray(messages)) {
    return { exact_matches, partial_matches, total_tool_results };
  }

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (!msg || !Array.isArray(msg.content)) continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (!block || block.type !== "tool_result") continue;
      total_tool_results++;

      const content = block.content;
      if (typeof content === "string") {
        classify(mi, bi, "string", undefined, content);
      } else if (Array.isArray(content)) {
        for (let ii = 0; ii < content.length; ii++) {
          const item = content[ii];
          if (!item || item.type !== "text" || typeof item.text !== "string") continue;
          classify(mi, bi, "array_item", ii, item.text);
        }
      }
    }
  }
  return { exact_matches, partial_matches, total_tool_results };

  function classify(msg_idx, block_idx, content_kind, item_idx, text) {
    const matched = matchesSentinelPattern(text, extraPatterns);
    if (matched !== null) {
      exact_matches.push({
        msg_idx,
        block_idx,
        content_kind,
        ...(item_idx !== undefined ? { item_idx } : {}),
        text,
        matched_pattern: matched,
      });
      return;
    }
    if (isPartialMatch(text, extraPrefixes)) {
      partial_matches.push({
        msg_idx,
        block_idx,
        content_kind,
        ...(item_idx !== undefined ? { item_idx } : {}),
        text,
        byte_length: Buffer.byteLength(text, "utf8"),
      });
    }
  }
}

// --- Normalization (mutates the message block in place) ---
//
// `match` is an entry from `exact_matches` (Mode A). We use its msg_idx /
// block_idx / content_kind / item_idx to find the exact place to rewrite.
// Mode B matches are NEVER passed to this function.

export function normalizeToolResultContent(messages, match, canonicalText) {
  const block = messages?.[match.msg_idx]?.content?.[match.block_idx];
  if (!block || block.type !== "tool_result") return false;
  if (match.content_kind === "string") {
    block.content = canonicalText;
    return true;
  }
  if (match.content_kind === "array_item" && Array.isArray(block.content)) {
    const item = block.content[match.item_idx];
    if (!item || item.type !== "text") return false;
    item.text = canonicalText;
    return true;
  }
  return false;
}

// --- Session ID hashing ---

function hashSessionId(reqCtx) {
  const sid =
    reqCtx?.meta?.session_id ||
    reqCtx?.headers?.["x-session-id"] ||
    reqCtx?.headers?.["x-anthropic-session-id"] ||
    null;
  if (!sid) return null;
  return createHash("sha256").update(String(sid)).digest("hex").slice(0, 8);
}

// --- Diagnostic record build (pure) ---

function serializeExactMatch(m, includeNormalizedText) {
  const rec = {
    msg_idx: m.msg_idx,
    block_idx: m.block_idx,
    content_kind: m.content_kind,
    matched_pattern: m.matched_pattern,
    sentinel_text: m.text,
    byte_length: Buffer.byteLength(m.text, "utf8"),
  };
  if (m.item_idx !== undefined) rec.item_idx = m.item_idx;
  if (typeof includeNormalizedText === "string") {
    rec.normalized_text = includeNormalizedText;
  }
  return rec;
}

function serializePartialMatch(m, redactLen) {
  const rec = {
    msg_idx: m.msg_idx,
    block_idx: m.block_idx,
    content_kind: m.content_kind,
    byte_length: m.byte_length,
  };
  if (m.item_idx !== undefined) rec.item_idx = m.item_idx;
  if (redactLen > 0) {
    rec.prefix_64 = m.text.slice(0, redactLen);
  }
  return rec;
}

export function buildDiagnosticRecord(reqCtx, exact_matches, partial_matches, totalToolResults, opts = {}) {
  const includeNormalized = opts.includeNormalized === true;
  const canonicalText = opts.canonicalText;
  const redactLen = typeof opts.redactLen === "number" ? opts.redactLen : DEFAULT_REDACT_LEN;
  return {
    ts: opts.ts || new Date().toISOString(),
    session_id_hash: hashSessionId(reqCtx),
    exact_matches: exact_matches.map((m) =>
      serializeExactMatch(m, includeNormalized && typeof canonicalText === "string" ? canonicalText : null),
    ),
    partial_matches: partial_matches.map((m) => serializePartialMatch(m, redactLen)),
    total_messages: Array.isArray(reqCtx?.body?.messages) ? reqCtx.body.messages.length : 0,
    total_tool_results: totalToolResults,
    model: reqCtx?.body?.model ?? null,
  };
}

// --- I/O ---

export async function appendDiagnosticRecord(path, record) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
}

// --- Stats shape ---

function initStats() {
  return {
    diagnostic_enabled: false,
    normalization_enabled: false,
    sentinel_pattern_used: null, // first matched pattern source (Mode A only)
    total_tool_results_scanned: 0,
    exact_matches_count: 0,
    partial_matches_count: 0,
    sentinels_matched: 0, // exact + partial
    sentinels_normalized: 0,
    bytes_original: 0,
    bytes_normalized: 0,
    bytes_saved: 0,
    diagnostic_records_written: 0,
  };
}

// --- Stderr summary ---

function emitStderrSummary(stats, dumpPath) {
  const parts = [`matched=${stats.sentinels_matched}`];
  if (stats.normalization_enabled) {
    parts.push(`normalized=${stats.sentinels_normalized}`);
    parts.push(`bytes=${stats.bytes_original}->${stats.bytes_normalized}`);
    if (stats.sentinel_pattern_used) {
      parts.push(`sentinel_pattern=${stats.sentinel_pattern_used === DEFAULT_EXACT_PATTERNS[0].source || stats.sentinel_pattern_used === DEFAULT_EXACT_PATTERNS[1].source ? "default" : "custom"}`);
    }
  }
  if (stats.diagnostic_enabled) {
    parts.push(`dump=${dumpPath}`);
    if (!stats.normalization_enabled) parts.push("(normalize disabled)");
  }
  process.stderr.write(`[microcompact] ${parts.join(" ")}\n`);
}

// --- Orchestrator ---

export async function runMicrocompactStability(reqCtx) {
  const stats = initStats();
  const dumpPath = getDumpPath();
  const normalize = isNormalizeEnabled();
  stats.diagnostic_enabled = !!dumpPath;
  stats.normalization_enabled = normalize;

  if (!dumpPath && !normalize) return stats;
  if (!reqCtx || !reqCtx.body || !Array.isArray(reqCtx.body.messages)) return stats;

  const extraPatterns = getCustomPatterns();
  const extraPrefixes = getCustomPrefixes();
  const { exact_matches, partial_matches, total_tool_results } = walkToolResultsForSentinels(
    reqCtx.body.messages,
    extraPatterns,
    extraPrefixes,
  );
  stats.total_tool_results_scanned = total_tool_results;
  stats.exact_matches_count = exact_matches.length;
  stats.partial_matches_count = partial_matches.length;
  stats.sentinels_matched = exact_matches.length + partial_matches.length;
  if (exact_matches.length > 0) {
    stats.sentinel_pattern_used = exact_matches[0].matched_pattern;
  }

  // Diagnostic dump runs FIRST (raw pre-normalization bytes). Mode B is
  // redacted to prefix_64 by the serializer; Mode A captures full text.
  if (dumpPath && (exact_matches.length > 0 || partial_matches.length > 0)) {
    try {
      const canonicalText = normalize ? getCanonicalText() : null;
      const record = buildDiagnosticRecord(reqCtx, exact_matches, partial_matches, total_tool_results, {
        includeNormalized: isIncludeNormalizedEnabled(),
        canonicalText,
        redactLen: getRedactLen(),
      });
      await appendDiagnosticRecord(dumpPath, record);
      stats.diagnostic_records_written = 1;
    } catch (err) {
      debug(`dump write failed: ${err?.message ?? err}`);
    }
  }

  // Normalization runs AFTER dump. Only Mode A matches are eligible.
  if (normalize && exact_matches.length > 0) {
    const canonicalText = getCanonicalText();
    for (const m of exact_matches) {
      stats.bytes_original += Buffer.byteLength(m.text, "utf8");
      const ok = normalizeToolResultContent(reqCtx.body.messages, m, canonicalText);
      if (ok) {
        stats.bytes_normalized += Buffer.byteLength(canonicalText, "utf8");
        stats.sentinels_normalized++;
      }
    }
    stats.bytes_saved = stats.bytes_original - stats.bytes_normalized;
  }

  return stats;
}

// --- Extension contract ---

export default {
  name: "microcompact-stability",
  description:
    "Phase 1 microcompact cache stability — diagnostic capture of CC's " +
    "time_based_microcompact sentinel + opt-in normalization to a canonical " +
    "byte-stable form. Phase 2 (snapshot/restore) deferred to v3.5.0+.",
  enabled: false, // overridden by extensions.json
  order: 350,

  async onRequest(ctx) {
    try {
      const stats = await runMicrocompactStability(ctx);
      // Only attach telemetry / emit summary if we did something observable.
      if (stats.diagnostic_enabled || stats.normalization_enabled) {
        ctx.meta = ctx.meta || {};
        ctx.meta.microcompactStats = stats;
        if (stats.sentinels_matched > 0 || stats.diagnostic_enabled) {
          // Summary on enabled invocations: always when we matched, or when
          // diagnostic is on (so users can verify it's running with no matches).
          if (stats.sentinels_matched > 0) {
            emitStderrSummary(stats, getDumpPath());
          }
        }
      }
    } catch (err) {
      debug(`onRequest unexpected: ${err?.message ?? err}`);
    }
  },
};
