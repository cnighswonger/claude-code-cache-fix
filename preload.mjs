// claude-code-cache-fix — Node.js fetch interceptor for Claude Code prompt cache bugs.
//
// Fixes three bugs that cause prompt cache misses in Claude Code, resulting in
// up to 20x cost increase on resumed sessions:
//
// Bug 1: Partial block scatter on resume
//   On --resume, attachment blocks (hooks, skills, deferred-tools, MCP) land in
//   later user messages instead of messages[0]. This breaks the prompt cache
//   prefix match. Fix: relocate them to messages[0] on every API call.
//   (github.com/anthropics/claude-code/issues/34629)
//
// Bug 2: Fingerprint instability
//   The cc_version fingerprint in the attribution header is computed from
//   messages[0] content INCLUDING meta/attachment blocks. When those blocks
//   change between turns, the fingerprint changes, busting cache within the
//   same session. Fix: stabilize the fingerprint from the real user message.
//   (github.com/anthropics/claude-code/issues/40524)
//
// Bug 3: Image carry-forward in conversation history
//   Images read via the Read tool persist as base64 in conversation history
//   and are sent on every subsequent API call. A single 500KB image costs
//   ~62,500 tokens per turn in carry-forward. Fix: strip base64 image blocks
//   from tool_result content older than N user turns.
//   Set CACHE_FIX_IMAGE_KEEP_LAST=N to enable (default: 0 = disabled).
//   (github.com/anthropics/claude-code/issues/40524)
//
// Monitoring:
//   - GrowthBook flag dump on first API call (CACHE_FIX_DEBUG=1)
//   - Microcompact / budget enforcement detection (logs cleared tool results)
//   - False rate limiter detection (model: "<synthetic>")
//   - Quota utilization tracking (writes ~/.claude/quota-status.json)
//   - Prefix snapshot diffing across process restarts (CACHE_FIX_PREFIXDIFF=1)
//
// Based on community fix by @VictorSun92 / @jmarianski (issue #34629),
// enhanced with fingerprint stabilization, image stripping, and monitoring.
// Bug research informed by @ArkNill's claude-code-hidden-problem-analysis.
//
// Load via: NODE_OPTIONS="--import $HOME/.claude/cache-fix-preload.mjs"

import { createHash } from "node:crypto";

// --------------------------------------------------------------------------
// Fingerprint stabilization (Bug 2)
// --------------------------------------------------------------------------

// Must match src/utils/fingerprint.ts exactly.
const FINGERPRINT_SALT = "59cf53e54c78";
const FINGERPRINT_INDICES = [4, 7, 20];

/**
 * Recompute the 3-char hex fingerprint the same way the source does:
 *   SHA256(SALT + msg[4] + msg[7] + msg[20] + version)[:3]
 * but using the REAL user message text, not the first (possibly meta) message.
 */
function computeFingerprint(messageText, version) {
  const chars = FINGERPRINT_INDICES.map((i) => messageText[i] || "0").join("");
  const input = `${FINGERPRINT_SALT}${chars}${version}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

/**
 * Find the first REAL user message text (not a <system-reminder> meta block).
 * The original bug: extractFirstMessageText() grabs content from messages[0]
 * which may be a synthetic attachment message, not the actual user prompt.
 */
function extractRealUserMessageText(messages) {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (!Array.isArray(content)) {
      if (typeof content === "string" && !content.startsWith("<system-reminder>")) {
        return content;
      }
      continue;
    }
    // Find first text block that isn't a system-reminder
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && !block.text.startsWith("<system-reminder>")) {
        return block.text;
      }
    }
  }
  return "";
}

/**
 * Extract text from messages[0] the way CC's original fingerprint code does —
 * including meta/attachment blocks. Used only for round-trip verification.
 */
function extractFirstMessageText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const first = messages[0];
  if (!first || first.role !== "user") return "";
  const content = first.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

/**
 * Extract current cc_version from system prompt blocks and recompute with
 * stable fingerprint. Returns { oldVersion, newVersion, stableFingerprint }.
 */
function stabilizeFingerprint(system, messages) {
  if (!Array.isArray(system)) return null;

  // Find the attribution header block
  const attrIdx = system.findIndex(
    (b) => b.type === "text" && typeof b.text === "string" && b.text.includes("x-anthropic-billing-header:")
  );
  if (attrIdx === -1) return null;

  const attrBlock = system[attrIdx];
  const versionMatch = attrBlock.text.match(/cc_version=([^;]+)/);
  if (!versionMatch) return null;

  const fullVersion = versionMatch[1]; // e.g. "2.1.87.a3f"
  const dotParts = fullVersion.split(".");
  if (dotParts.length < 4) return null;

  const baseVersion = dotParts.slice(0, 3).join("."); // "2.1.87"
  const oldFingerprint = dotParts[3]; // "a3f"

  // --- SAFETY: Round-trip verification ---
  // Verify our salt/indices reproduce CC's fingerprint for the ORIGINAL
  // message text that CC used.
  //
  // Prior to v2.1.108, CC computed the fingerprint from messages[0] content
  // (including meta/attachment blocks). Starting in v2.1.108, CC switched to
  // an internal `!isMeta` filter (HoY function), which skips synthetic
  // system-reminder blocks. In the API payload, this is equivalent to finding
  // the first text block that doesn't start with "<system-reminder>".
  //
  // We try both extraction methods: the new "real user message" first (v2.1.108+),
  // then fall back to the legacy "first message text" for older versions.
  // This keeps the safety check working across CC versions.
  //
  // Discovered by @ArkNill via mitmproxy + CC source analysis on v2.1.108.
  const realText = extractRealUserMessageText(messages);
  const realVerification = computeFingerprint(realText, baseVersion);
  const legacyText = extractFirstMessageText(messages);
  const legacyVerification = computeFingerprint(legacyText, baseVersion);

  let verificationPassed = false;
  if (realVerification === oldFingerprint) {
    verificationPassed = true;
    debugLog("FINGERPRINT VERIFY: matched via real user message text (v2.1.108+ path)");
  } else if (legacyVerification === oldFingerprint) {
    verificationPassed = true;
    debugLog("FINGERPRINT VERIFY: matched via legacy messages[0] text (pre-v2.1.108 path)");
  }

  if (!verificationPassed) {
    debugLog(
      "FINGERPRINT SAFETY: round-trip verification failed.",
      `CC sent '${oldFingerprint}', real='${realVerification}', legacy='${legacyVerification}'.`,
      "Salt/indices may have changed in this CC version. Skipping rewrite."
    );
    recordFixResult("fingerprint", "safety_blocked");
    return null;
  }
  // --- END SAFETY ---

  // Compute stable fingerprint from real user text (already extracted above)
  const stableFingerprint = computeFingerprint(realText, baseVersion);

  if (stableFingerprint === oldFingerprint) return null; // already correct

  const newVersion = `${baseVersion}.${stableFingerprint}`;
  const newText = attrBlock.text.replace(
    `cc_version=${fullVersion}`,
    `cc_version=${newVersion}`
  );

  return { attrIdx, newText, oldFingerprint, stableFingerprint };
}

// --------------------------------------------------------------------------
// Resume message relocation (Bug 1)
// --------------------------------------------------------------------------

function isSystemReminder(text) {
  return typeof text === "string" && text.startsWith("<system-reminder>");
}
// FIX: Match block headers with startsWith to avoid false positives from
// quoted content (e.g. "Note:" file-change reminders embedding debug logs).
const SR = "<system-reminder>\n";
function isHooksBlock(text) {
  // Hooks block header varies; fall back to head-region check
  return isSystemReminder(text) && text.substring(0, 200).includes("hook success");
}
function isSkillsBlock(text) {
  return typeof text === "string" && text.startsWith(SR + "The following skills are available");
}
function isDeferredToolsBlock(text) {
  return typeof text === "string" && text.startsWith(SR + "The following deferred tools are now available");
}
function isMcpBlock(text) {
  return typeof text === "string" && text.startsWith(SR + "# MCP Server Instructions");
}
function isRelocatableBlock(text) {
  return (
    isHooksBlock(text) ||
    isSkillsBlock(text) ||
    isDeferredToolsBlock(text) ||
    isMcpBlock(text)
  );
}
/**
 * Detect /clear command artifacts that bleed into the next session's messages[0].
 * These blocks break prefix cache because a post-/clear session has different
 * messages[0] content than a truly fresh session.
 * Bug: anthropics/claude-code#47756
 */
function isClearArtifact(text) {
  if (typeof text !== "string") return false;
  return (
    text.startsWith("<local-command-caveat>") ||
    text.startsWith("<command-name>") ||
    text.startsWith("<local-command-stdout>")
  );
}

/**
 * Sort skill listing entries for deterministic ordering (prevents cache bust
 * from non-deterministic iteration order).
 */
function sortSkillsBlock(text) {
  const match = text.match(
    /^([\s\S]*?\n\n)(- [\s\S]+?)(\n<\/system-reminder>\s*)$/
  );
  if (!match) {
    debugLog("SKILLS SORT: regex did NOT match — block passed through unsorted",
      `(length=${text.length}, starts=${JSON.stringify(text.slice(0, 80))})`);
    return text;
  }
  const [, header, entriesText, footer] = match;
  const entries = entriesText.split(/\n(?=- )/);
  const preSort = entries.map(e => (e.match(/^- ([^:]+)/) || [])[1] || "?");
  entries.sort();
  const postSort = entries.map(e => (e.match(/^- ([^:]+)/) || [])[1] || "?");
  const orderChanged = preSort.some((name, i) => name !== postSort[i]);
  debugLog(`SKILLS SORT: ${entries.length} entries, order ${orderChanged ? "CHANGED" : "unchanged"}`,
    `footer=${JSON.stringify(footer)}`);
  return header + entries.join("\n") + footer;
}

/**
 * Sort deferred tools listing for deterministic ordering. The block format is:
 *   <system-reminder>
 *   The following deferred tools are now available via ToolSearch:
 *   ToolName1
 *   ToolName2
 *   ...
 *   </system-reminder>
 *
 * When MCP tools register asynchronously, new tools can appear between API
 * calls, changing the block content and busting cache. Sorting ensures that
 * once a tool appears, its position is deterministic.
 */
function sortDeferredToolsBlock(text) {
  const match = text.match(
    /^(<system-reminder>\nThe following deferred tools are now available[^\n]*\n)([\s\S]+?)(\n<\/system-reminder>\s*)$/
  );
  if (!match) return text;
  const [, header, toolsList, footer] = match;
  const tools = toolsList.split("\n").map(t => t.trim()).filter(Boolean);
  tools.sort();
  return header + tools.join("\n") + footer;
}

// --------------------------------------------------------------------------
// Content pinning for MCP registration jitter (Bug 4)
// --------------------------------------------------------------------------
//
// When MCP tools register asynchronously, the skills and deferred tools blocks
// can change between consecutive API calls as new tools finish registering.
// This causes repeated cache busts even though the final tool set is stable.
//
// Fix: track the content hash of each block type. When content changes, accept
// one cache miss (the new tool needs to be visible), then pin the new content.
// If the SAME content appears on consecutive calls, use the pinned version
// with normalized whitespace to prevent trivial diffs.
//
// Reported by @bilby91 on #44045 (Agent SDK with MCP tools).
// --------------------------------------------------------------------------

const _pinnedBlocks = new Map(); // blockType → { hash, text }

/**
 * Normalize a block's trailing whitespace and pin its content. Returns the
 * normalized text. On first call for a block type, pins the content. On
 * subsequent calls, if the content hash matches the pin, returns the pinned
 * version (byte-identical). If content changed, updates the pin and returns
 * the new content (accepts one cache bust).
 */
function pinBlockContent(blockType, text) {
  // Normalize: trim trailing whitespace inside the </system-reminder> tag
  const normalized = text.replace(/\s+(<\/system-reminder>)\s*$/, "\n$1");

  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  const pinned = _pinnedBlocks.get(blockType);

  if (pinned && pinned.hash === hash) {
    // Content matches pin — return pinned version (byte-identical)
    return pinned.text;
  }

  // Content changed or first call — update pin
  if (pinned && pinned.hash !== hash) {
    debugLog(`CONTENT PIN: ${blockType} changed (${pinned.hash} → ${hash}) — accepting one cache bust`);
  }
  _pinnedBlocks.set(blockType, { hash, text: normalized });
  return normalized;
}

/**
 * Strip session_knowledge from hooks blocks — ephemeral content that differs
 * between sessions and would bust cache.
 */
function stripSessionKnowledge(text) {
  return text.replace(
    /\n<session_knowledge[^>]*>[\s\S]*?<\/session_knowledge>/g,
    ""
  );
}

// --------------------------------------------------------------------------
// SessionStart:resume → :startup rewrite (Bug: anthropics/claude-code#43657)
// --------------------------------------------------------------------------
//
// On `claude --continue`, CC fires processSessionStartHooks('resume', …) at
// src/utils/sessionStart.ts:35. The resulting attachment text wraps the
// hook's stdout in `<system-reminder>\nSessionStart:resume hook success: …`.
// The original (pre-resume) session sent the same block as
// `SessionStart:startup hook success: …`. Byte difference at msg[0] content[N]
// → whole message prefix re-caches → full-session-cost miss.
//
// Some SessionStart hooks additionally embed `<session-id>` tags or
// `Last active: <timestamp>` lines inside the reminder body, both of which
// carry UUID/date volatility on top of the event-name flip.
//
// This helper rewrites the outbound text to match the originally-cached
// form. Runs on both standalone text blocks and tool_result.content strings
// (covers the case where the SessionStart reminder got smooshed by CC's
// smooshSystemReminderSiblings pass before we see it).
//
// Agent behavior is unaffected — CC does not condition behavior on the
// event-name text, and session-id / timestamps are ephemeral runtime
// metadata, not semantic inputs.
// --------------------------------------------------------------------------

const SESSION_START_RESUME_MARKER = /SessionStart:resume hook success:/g;
const SESSION_START_ID_TAG = /\n?<session-id>[^<]*<\/session-id>/g;
const SESSION_START_LAST_ACTIVE_LINE = /\nLast active:[^\n]*/g;

/**
 * Normalize a single text payload (a text block's .text or a tool_result's
 * string .content) to remove SessionStart-resume volatility. Returns
 * [newText, mutationCount]. Callers only need the text, but the count is
 * exposed for stats. The function is a pure string-to-string transform
 * (idempotent: running twice produces the same output as running once).
 */
function normalizeSessionStartText(text) {
  if (typeof text !== "string" || !text.includes("SessionStart:")) return [text, 0];
  let count = 0;
  let out = text;
  if (SESSION_START_RESUME_MARKER.test(out)) {
    SESSION_START_RESUME_MARKER.lastIndex = 0;
    out = out.replace(SESSION_START_RESUME_MARKER, "SessionStart:startup hook success:");
    count++;
  }
  if (SESSION_START_ID_TAG.test(out)) {
    SESSION_START_ID_TAG.lastIndex = 0;
    out = out.replace(SESSION_START_ID_TAG, "");
    count++;
  }
  if (SESSION_START_LAST_ACTIVE_LINE.test(out)) {
    SESSION_START_LAST_ACTIVE_LINE.lastIndex = 0;
    out = out.replace(SESSION_START_LAST_ACTIVE_LINE, "");
    count++;
  }
  return [out, count];
}

// --------------------------------------------------------------------------
// Continue-trailer strip (Bug: anthropics/claude-code#12 / resume UX)
// --------------------------------------------------------------------------
//
// On `claude --continue`, CC appends a text block whose text is EXACTLY
// "Continue from where you left off." to the last user message before
// firing the first post-resume request. The pre-exit body did not carry
// that block, so its presence in the resumed body creates a tail-of-last-
// user-message drift (~40 bytes plus JSON framing) that breaks cache at
// that position.
//
// The trailer is a semantic no-op — the agent already has the full prior
// conversation as context. Removing it makes the post-resume body byte-
// match what the pre-exit body cached at the tail.
//
// Match is intentionally narrow (exact string equality on the block's
// .text) so mentions of the phrase inside a longer user sentence don't
// get caught.
// --------------------------------------------------------------------------

const CONTINUE_TRAILER_TEXT = "Continue from where you left off.";

/**
 * Returns true iff the block is an exact-match Continue-trailer text block
 * (a `{type: "text", text: "Continue from where you left off."}` shape —
 * cache_control field on the same block is allowed and ignored). Pure
 * predicate; exported for unit tests.
 */
function isContinueTrailerBlock(block) {
  return (
    !!block &&
    typeof block === "object" &&
    block.type === "text" &&
    block.text === CONTINUE_TRAILER_TEXT
  );
}

// --------------------------------------------------------------------------
// Deferred-tools restore (MCP reconnect race)
// --------------------------------------------------------------------------
//
// Observed empirically: on `claude --continue`, if MCP servers haven't
// finished reconnecting by the time CC fires the first post-resume
// request, the `<system-reminder>The following deferred tools are now
// available via ToolSearch…` block at msg[0] (or wherever the attachment
// lands post-compaction) shrinks dramatically. A full list of ~40 tools
// collapses to a handful of CC built-ins (AskUserQuestion, EnterPlanMode,
// ExitPlanMode, PushNotification) and CC injects a trailing
// `The following deferred tools are no longer available (their MCP server
// disconnected). Do not search for them — ToolSearch will return no match:`
// notice.
//
// That block change at the root of the message array breaks cache at the
// very top — the entire ~940K prompt re-caches. By the time the second
// post-resume request fires, MCPs are usually reconnected and the block is
// full again, but the cache is already committed to the shrunk version
// for this session.
//
// This extension snapshots the block to
// `~/.claude/cache-fix-state/deferred-tools-<sha1(key)>.txt` every time
// it's sent in its full form (no UNAVAILABLE marker), keyed by a caller-
// supplied project key (default: cwd). On a subsequent request where the
// block is shorter AND contains the UNAVAILABLE marker, the persisted
// full bytes are substituted so the on-wire body matches the server's
// cached prefix.
//
// Trade-off: the restored block may reference MCP tools that haven't
// actually reconnected yet. Agent calls ToolSearch → no match → one retry.
// Tiny cost versus a full-prompt cache miss on every resume.
// --------------------------------------------------------------------------

const DEFERRED_TOOLS_AVAILABLE_MARKER =
  "The following deferred tools are now available via ToolSearch";
const DEFERRED_TOOLS_UNAVAILABLE_MARKER =
  "The following deferred tools are no longer available";
const DEFERRED_TOOLS_SNAPSHOT_DIR = join(homedir(), ".claude", "cache-fix-state");

/**
 * Build the absolute snapshot path for a given key. Exported for tests so
 * they can assert on path derivation without duplicating the hash logic.
 */
function deferredToolsSnapshotPath(key) {
  const hash = createHash("sha1").update(String(key)).digest("hex").slice(0, 16);
  return join(DEFERRED_TOOLS_SNAPSHOT_DIR, `deferred-tools-${hash}.txt`);
}

/**
 * Locate the deferred-tools reminder block anywhere in `body.messages`.
 * The block's position varies by session shape (pre-compaction it often
 * sits at `msg[0].content[0]`; post-compaction it can land at
 * `msg[1].content[N]` next to other attachments). Returns
 * `{ msgIdx, blockIdx, text } | null`.
 *
 * Assistant messages are skipped so that if the agent happens to mention
 * the AVAILABLE_MARKER phrase verbatim in its own output, we don't
 * misidentify it as a real deferred-tools block.
 */
function findDeferredToolsBlockInBody(body) {
  if (!body || !Array.isArray(body.messages)) return null;
  for (let m = 0; m < body.messages.length; m++) {
    const msg = body.messages[m];
    if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let i = 0; i < msg.content.length; i++) {
      const b = msg.content[i];
      if (
        b?.type === "text" &&
        typeof b.text === "string" &&
        b.text.includes(DEFERRED_TOOLS_AVAILABLE_MARKER)
      ) {
        return { msgIdx: m, blockIdx: i, text: b.text };
      }
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// cache_control_sticky — preserve historical marker positions across turns
// --------------------------------------------------------------------------
//
// Covers a cache-miss class that cache_control_normalize can't reach by
// itself. CC maintains at most one user-side cache_control marker at a time:
// as conversation grows, CC moves the marker from the tail of one user turn
// to the tail of the next, DROPPING it from the previous position. The
// dropped position's block loses the ~43 bytes of `"cache_control":{"type":
// "ephemeral","ttl":"1h"}` framing — a tail-of-message byte diff that
// invalidates every downstream cached block (~600K tokens' worth on a
// long-running session).
//
// Observed instance: at 16:27:13 UTC today, a 1284-message session emitted
// cw=804,428 (hit=2.3%). Diff of main-session bodies 585 → 587 showed ONE
// message diverged — msg[1281] — which lost its cache_control marker (43
// bytes) because CC had moved the marker to the new last user msg[1283].
//
// cache_control_normalize places exactly ONE canonical marker at the last
// block of the last user message on every outbound body. That solves the
// current-marker-drift class but cannot preserve historical markers — CC
// has already dropped them by the time the payload reaches this extension.
//
// This sticky extension maintains per-session state tracking where markers
// have appeared in prior turns, and reinstates them on future turns as
// additive preservation. Up to 3 historical message-level markers are
// tracked (Anthropic's hard limit is 4 cache_control markers total — 1 for
// system[2] + 3 for message-level breakpoints). When a historical position
// would exceed the cap, the oldest tracked entry is dropped (LRU).
//
// Messages are identified by a stable hash so that compaction rewrites /
// index shifts don't confuse the tracker:
//   - If the message has a tool_use or tool_result block with an `id` or
//     `tool_use_id`, hash `role|id`.
//   - Otherwise hash `role|firstTextContent.slice(0, 256)`.
//
// Pipeline order: runs AFTER cache_control_normalize (when it's present) so
// normalize first pins the canonical marker at the last user msg, then
// sticky re-adds historical markers on their hashed messages. Skips any
// message already carrying a marker (fast no-op when sticky fires first).
//
// Opt-out via CACHE_FIX_SKIP_CACHE_CONTROL_STICKY=1 (defaults ON).
// --------------------------------------------------------------------------

const CACHE_CONTROL_STICKY_DIR = join(homedir(), ".claude", "cache-fix-state");
const CACHE_CONTROL_STICKY_MAX_POSITIONS = 3;
const CACHE_CONTROL_STICKY_DEFAULT_MARKER = { type: "ephemeral", ttl: "1h" };

/**
 * Build the absolute state-file path for a given project key. Exported so
 * tests can assert on path derivation without duplicating hash logic.
 */
function cacheControlStickyStatePath(key) {
  const hash = createHash("sha1").update(String(key)).digest("hex").slice(0, 16);
  return join(CACHE_CONTROL_STICKY_DIR, `cache-control-sticky-${hash}.json`);
}

/**
 * Compute a stable hash identifier for a message that survives content-
 * block insertions (e.g. smoosh_split peeling a reminder into a new block
 * but the first text block's first 256 bytes don't change) and index shifts
 * (e.g. compaction). Returns null if the message has no identifiable
 * content. Pure; exported for unit tests.
 */
function computeStickyMessageHash(msg) {
  if (!msg || typeof msg !== "object") return null;
  const role = typeof msg.role === "string" ? msg.role : "";
  if (!Array.isArray(msg.content) || msg.content.length === 0) return null;
  // Prefer tool_use/tool_result identifiers when present — they're the
  // most stable anchors.
  for (const b of msg.content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "tool_use" && typeof b.id === "string" && b.id) {
      return createHash("sha1").update(`${role}|tool_use|${b.id}`).digest("hex").slice(0, 16);
    }
    if (b.type === "tool_result" && typeof b.tool_use_id === "string" && b.tool_use_id) {
      return createHash("sha1").update(`${role}|tool_result|${b.tool_use_id}`).digest("hex").slice(0, 16);
    }
  }
  // Fallback: first text block's first 256 bytes.
  for (const b of msg.content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      const prefix = b.text.slice(0, 256);
      return createHash("sha1").update(`${role}|text|${prefix}`).digest("hex").slice(0, 16);
    }
  }
  return null;
}

/**
 * Read persisted sticky state for a project key. Returns a fresh empty
 * state on missing file, unreadable file, or corrupt JSON — never throws.
 * Shape: `{ version: 1, positions: [{msg_hash, position_hint, marker}] }`.
 */
function readCacheControlStickyState(key) {
  const path = cacheControlStickyStatePath(key);
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { version: 1, positions: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.positions)) {
      debugLog("cache_control_sticky: state file malformed shape — resetting");
      return { version: 1, positions: [] };
    }
    const positions = [];
    for (const p of parsed.positions) {
      if (!p || typeof p !== "object") continue;
      if (typeof p.msg_hash !== "string" || !p.msg_hash) continue;
      positions.push({
        msg_hash: p.msg_hash,
        position_hint: p.position_hint === "last_block" ? "last_block" : "last_block",
        marker:
          p.marker && typeof p.marker === "object" && typeof p.marker.type === "string"
            ? { ...p.marker }
            : { ...CACHE_CONTROL_STICKY_DEFAULT_MARKER },
      });
    }
    return { version: 1, positions };
  } catch (e) {
    debugLog(`cache_control_sticky: state JSON parse error (${e?.message}) — resetting`);
    return { version: 1, positions: [] };
  }
}

/**
 * Atomic-write persisted sticky state. Best-effort; silent on I/O errors.
 */
function writeCacheControlStickyState(key, state) {
  const path = cacheControlStickyStatePath(key);
  try {
    mkdirSync(CACHE_CONTROL_STICKY_DIR, { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, path);
  } catch (e) {
    debugLog(`cache_control_sticky: state write error (${e?.message})`);
  }
}

/**
 * Pure core: given a body and the currently-persisted state, compute the
 * next state and the list of marker mutations to apply to the body. No
 * I/O, no body mutation — the wrapper is responsible for applying results.
 *
 * Algorithm:
 *  1. Walk user-role messages; for each block-with-cache_control, record
 *     `{msg_hash, marker}` into `observed`. Duplicate hashes keep the
 *     first (most recent in message order).
 *  2. Merge `observed` into the prior `state.positions`: newly-observed
 *     hashes are appended (or moved to the front if re-seen); absent-from-
 *     this-body hashes are kept so they persist across turns.
 *  3. For each hash in the new state, locate the corresponding message in
 *     the body (by hash match). If found AND the message's last block
 *     does NOT already carry a marker, emit a mutation to set it.
 *  4. Cap the new state at CACHE_CONTROL_STICKY_MAX_POSITIONS (oldest
 *     entries dropped first — LRU keyed on most-recent touch).
 *
 * Returns `{newState, mutations}` where mutations =
 * `[{msgIdx, blockIdx, marker}]`. Pure; exported for unit tests.
 */
function updateCacheControlStickyState(body, priorState) {
  const empty = { newState: { version: 1, positions: [] }, mutations: [] };
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return empty;
  const prior =
    priorState && Array.isArray(priorState.positions)
      ? { version: 1, positions: priorState.positions.slice() }
      : { version: 1, positions: [] };

  // Build hash → msgIdx index for this body's user messages.
  const hashToMsgIdx = new Map();
  const observed = []; // [{msg_hash, marker}] in message order
  for (let m = 0; m < body.messages.length; m++) {
    const msg = body.messages[m];
    if (!msg || msg.role !== "user" || !Array.isArray(msg.content) || msg.content.length === 0) continue;
    const h = computeStickyMessageHash(msg);
    if (!h) continue;
    if (!hashToMsgIdx.has(h)) hashToMsgIdx.set(h, m);
    // Observe any existing marker on this message (any block).
    for (const b of msg.content) {
      if (b && typeof b === "object" && b.cache_control && typeof b.cache_control === "object") {
        observed.push({ msg_hash: h, marker: { ...b.cache_control } });
        break;
      }
    }
  }

  // Merge observed into prior: move observed hashes to the end (most
  // recent), refresh their marker. Unobserved prior entries stay in place.
  const priorIndex = new Map(prior.positions.map((p, i) => [p.msg_hash, i]));
  const nextPositions = prior.positions.slice();
  for (const ob of observed) {
    if (priorIndex.has(ob.msg_hash)) {
      const i = priorIndex.get(ob.msg_hash);
      nextPositions[i] = { msg_hash: ob.msg_hash, position_hint: "last_block", marker: ob.marker };
    } else {
      nextPositions.push({ msg_hash: ob.msg_hash, position_hint: "last_block", marker: ob.marker });
      priorIndex.set(ob.msg_hash, nextPositions.length - 1);
    }
  }

  // Cap at MAX_POSITIONS: keep the NEWEST (end of array) entries.
  let capped = nextPositions;
  if (capped.length > CACHE_CONTROL_STICKY_MAX_POSITIONS) {
    capped = capped.slice(capped.length - CACHE_CONTROL_STICKY_MAX_POSITIONS);
  }

  // Compute mutations: for each tracked hash present in this body, if the
  // message doesn't already have any marker, add one at its last block.
  const mutations = [];
  for (const pos of capped) {
    const msgIdx = hashToMsgIdx.get(pos.msg_hash);
    if (msgIdx === undefined) continue;
    const msg = body.messages[msgIdx];
    if (!msg || !Array.isArray(msg.content) || msg.content.length === 0) continue;
    const hasMarker = msg.content.some(
      (b) => b && typeof b === "object" && b.cache_control && typeof b.cache_control === "object"
    );
    if (hasMarker) continue;
    mutations.push({
      msgIdx,
      blockIdx: msg.content.length - 1,
      marker: { ...pos.marker },
    });
  }

  return { newState: { version: 1, positions: capped }, mutations };
}

/**
 * Wrapper: read state, compute mutations via
 * updateCacheControlStickyState, apply mutations to `body` in place, write
 * next state. Returns the count of marker mutations applied. Silent on
 * any I/O error (best-effort).
 */
function applyCacheControlSticky(body, key) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return 0;
  const prior = readCacheControlStickyState(key);
  const { newState, mutations } = updateCacheControlStickyState(body, prior);
  for (const mut of mutations) {
    const msg = body.messages[mut.msgIdx];
    if (!msg || !Array.isArray(msg.content)) continue;
    const newContent = msg.content.slice();
    const target = newContent[mut.blockIdx];
    if (!target || typeof target !== "object") continue;
    newContent[mut.blockIdx] = { ...target, cache_control: { ...mut.marker } };
    body.messages[mut.msgIdx] = { ...msg, content: newContent };
  }
  writeCacheControlStickyState(key, newState);
  return mutations.length;
}

/**
 * Core fix: on EVERY call, scan the entire message array for the LATEST
 * relocatable blocks (skills, MCP, deferred tools, hooks) and ensure they
 * are in messages[0]. This matches fresh session behavior where attachments
 * are always prepended to messages[0] on every API call.
 *
 * The original community fix only checked the last user message, which
 * broke on subsequent turns because:
 *   - Call 1: skills in last msg → relocated to messages[0] (3 blocks)
 *   - Call 2: in-memory state unchanged, skills now in a middle msg,
 *     last msg has no relocatable blocks → messages[0] back to 2 blocks
 *   - Prefix changed → cache bust
 *
 * This version scans backwards to find the latest instance of each
 * relocatable block type, removes them from wherever they are, and
 * prepends them to messages[0]. Idempotent across calls.
 */
function normalizeResumeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  // NOTE: We used to return early here for messages.length < 2 (fresh sessions)
  // because there's nothing to relocate. But this left the first call's blocks
  // in CC's raw, non-deterministic order. On call 2+, sorting/pinning would run
  // and produce DIFFERENT bytes — busting cache on the first resume turn.
  // Fix: always run sort+pin, even on single-message calls, so the first call
  // establishes a deterministic baseline. (@bilby91 #44045)

  let firstUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      firstUserIdx = i;
      break;
    }
  }
  if (firstUserIdx === -1) return messages;

  const firstMsg = messages[firstUserIdx];
  if (!Array.isArray(firstMsg?.content)) return messages;

  // FIX: Strip /clear command artifacts from messages[0] (anthropics/claude-code#47756).
  // After /clear, CC leaves <local-command-caveat>, <command-name>/clear, and
  // <local-command-stdout> blocks in messages[0] of the new session, breaking
  // prefix match vs a truly fresh session.
  const beforeClearStrip = firstMsg.content.length;
  firstMsg.content = firstMsg.content.filter((block) => !isClearArtifact(block.text || ""));
  if (firstMsg.content.length < beforeClearStrip) {
    const stripped = beforeClearStrip - firstMsg.content.length;
    debugLog(`APPLIED: stripped ${stripped} /clear artifact block(s) from messages[0]`);
    recordFixResult("relocate", "applied");
  }

  // FIX: Check if ANY relocatable blocks are scattered outside first user msg.
  // The old check (firstAlreadyHas → skip) missed partial scatter where some
  // blocks stay in messages[0] but others drift to later messages (v2.1.89+).
  let hasScatteredBlocks = false;
  for (let i = firstUserIdx + 1; i < messages.length && !hasScatteredBlocks; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (isRelocatableBlock(block.text || "")) {
        hasScatteredBlocks = true;
        break;
      }
    }
  }

  // Even when blocks aren't scattered, apply sorting and content pinning to
  // blocks in messages[0]. This handles MCP registration jitter where block
  // CONTENT changes between calls (new tool registers) without scattering.
  // (Reported by @bilby91 — Agent SDK with async MCP tools, #44045)
  if (!hasScatteredBlocks) {
    let contentModified = false;
    const newContent = firstMsg.content.map((block) => {
      const text = block.text || "";
      if (!isRelocatableBlock(text)) return block;

      let fixedText = text;
      if (isSkillsBlock(text)) fixedText = sortSkillsBlock(text);
      else if (isDeferredToolsBlock(text)) fixedText = sortDeferredToolsBlock(text);
      else if (isHooksBlock(text)) fixedText = stripSessionKnowledge(text);

      // Determine block type for pinning
      let blockType;
      if (isSkillsBlock(text)) blockType = "skills";
      else if (isDeferredToolsBlock(text)) blockType = "deferred";
      else if (isMcpBlock(text)) blockType = "mcp";
      else if (isHooksBlock(text)) blockType = "hooks";

      if (blockType) fixedText = pinBlockContent(blockType, fixedText);

      if (fixedText !== text) {
        contentModified = true;
        const { cache_control, ...rest } = block;
        return { ...rest, text: fixedText };
      }
      return block;
    });

    if (contentModified) {
      return messages.map((msg, idx) =>
        idx === firstUserIdx ? { ...msg, content: newContent } : msg
      );
    }
    return messages;
  }

  // Scan ALL user messages (including first) in reverse to collect the LATEST
  // version of each block type. This handles both full and partial scatter.
  const found = new Map();

  for (let i = messages.length - 1; i >= firstUserIdx; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      const text = block.text || "";
      if (!isRelocatableBlock(text)) continue;

      // Determine block type for dedup
      let blockType;
      if (isSkillsBlock(text)) blockType = "skills";
      else if (isMcpBlock(text)) blockType = "mcp";
      else if (isDeferredToolsBlock(text)) blockType = "deferred";
      else if (isHooksBlock(text)) blockType = "hooks";
      else continue;

      // Keep only the LATEST (first found scanning backwards)
      if (!found.has(blockType)) {
        let fixedText = text;
        if (blockType === "hooks") fixedText = stripSessionKnowledge(text);
        if (blockType === "skills") fixedText = sortSkillsBlock(text);
        if (blockType === "deferred") fixedText = sortDeferredToolsBlock(text);

        // Pin content to prevent jitter from late MCP tool registration
        fixedText = pinBlockContent(blockType, fixedText);

        const { cache_control, ...rest } = block;
        found.set(blockType, { ...rest, text: fixedText });
      }
    }
  }

  if (found.size === 0) return messages;

  // Remove ALL relocatable blocks from ALL user messages (both first and later)
  const result = messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    const filtered = msg.content.filter((b) => !isRelocatableBlock(b.text || ""));
    if (filtered.length === msg.content.length) return msg;
    return { ...msg, content: filtered };
  });

  // FIX: Order must match fresh session layout: deferred → mcp → skills → hooks
  const ORDER = ["deferred", "mcp", "skills", "hooks"];
  const toRelocate = ORDER.filter((t) => found.has(t)).map((t) => found.get(t));

  result[firstUserIdx] = {
    ...result[firstUserIdx],
    content: [...toRelocate, ...result[firstUserIdx].content],
  };

  return result;
}

// --------------------------------------------------------------------------
// Image stripping from old tool results (cost optimization)
// --------------------------------------------------------------------------

// CACHE_FIX_IMAGE_KEEP_LAST=N  — keep images only in the last N user messages.
// Unset or 0 = disabled (all images preserved, backward compatible).
// Images in tool_result blocks older than N user messages from the end are
// replaced with a text placeholder. User-pasted images (direct image blocks
// in user messages, not inside tool_result) are left alone.
const IMAGE_KEEP_LAST = parseInt(process.env.CACHE_FIX_IMAGE_KEEP_LAST || "0", 10);

/**
 * Strip base64 image blocks from tool_result content in older messages.
 * Returns { messages, stats } where stats has stripping metrics.
 */
function stripOldToolResultImages(messages, keepLast) {
  if (!keepLast || keepLast <= 0 || !Array.isArray(messages)) {
    return { messages, stats: null };
  }

  // Find user message indices (turns) so we can count from the end
  const userMsgIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userMsgIndices.push(i);
  }

  if (userMsgIndices.length <= keepLast) {
    return { messages, stats: null }; // not enough turns to strip anything
  }

  // Messages at or after this index are "recent" — keep their images
  const cutoffIdx = userMsgIndices[userMsgIndices.length - keepLast];

  let strippedCount = 0;
  let strippedBytes = 0;

  const result = messages.map((msg, msgIdx) => {
    // Only process user messages before the cutoff (tool_result is in user msgs)
    if (msg.role !== "user" || msgIdx >= cutoffIdx || !Array.isArray(msg.content)) {
      return msg;
    }

    let msgModified = false;
    const newContent = msg.content.map((block) => {
      // Only strip images inside tool_result blocks, not user-pasted images
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        let toolModified = false;
        const newToolContent = block.content.map((item) => {
          if (item.type === "image") {
            strippedCount++;
            if (item.source?.data) {
              strippedBytes += item.source.data.length;
            }
            toolModified = true;
            return {
              type: "text",
              text: "[image stripped from history — file may still be on disk]",
            };
          }
          return item;
        });
        if (toolModified) {
          msgModified = true;
          return { ...block, content: newToolContent };
        }
      }
      return block;
    });

    if (msgModified) {
      return { ...msg, content: newContent };
    }
    return msg;
  });

  const stats = strippedCount > 0
    ? { strippedCount, strippedBytes, estimatedTokens: Math.ceil(strippedBytes * 0.125) }
    : null;

  return { messages: strippedCount > 0 ? result : messages, stats };
}

// --------------------------------------------------------------------------
// Tool schema stabilization (Bug 2 secondary cause)
// --------------------------------------------------------------------------

/**
 * Sort tool definitions by name for deterministic ordering. Tool schema bytes
 * changing mid-session was acknowledged as a bug in the v2.1.88 changelog.
 */
function stabilizeToolOrder(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  return [...tools].sort((a, b) => {
    const nameA = a.name || "";
    const nameB = b.name || "";
    return nameA.localeCompare(nameB);
  });
}

// --------------------------------------------------------------------------
// System prompt rewrite (optional)
// --------------------------------------------------------------------------

const OUTPUT_EFFICIENCY_SECTION_HEADER = "# Output efficiency";
const OUTPUT_EFFICIENCY_REPLACEMENT_RAW =
  process.env.CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT || "";
const OUTPUT_EFFICIENCY_SECTION_REPLACEMENT =
  normalizeOutputEfficiencyReplacement(OUTPUT_EFFICIENCY_REPLACEMENT_RAW);

function normalizeOutputEfficiencyReplacement(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return "";
  return trimmed.startsWith(OUTPUT_EFFICIENCY_SECTION_HEADER)
    ? trimmed
    : `${OUTPUT_EFFICIENCY_SECTION_HEADER}\n\n${trimmed}`;
}

/**
 * Replace Claude Code's entire output-efficiency section in-place while
 * preserving the existing system block structure and cache_control fields.
 */
function rewriteOutputEfficiencyInstruction(system) {
  if (!Array.isArray(system) || !OUTPUT_EFFICIENCY_SECTION_REPLACEMENT) {
    return null;
  }

  let changed = false;
  const rewritten = system.map((block) => {
    if (
      block?.type !== "text" ||
      typeof block.text !== "string" ||
      !block.text.includes(OUTPUT_EFFICIENCY_SECTION_HEADER)
    ) {
      return block;
    }

    const nextText = replaceOutputEfficiencySection(block.text);
    if (!nextText || nextText === block.text) {
      return block;
    }

    changed = true;
    return { ...block, text: nextText };
  });

  return changed ? rewritten : null;
}

function replaceOutputEfficiencySection(text) {
  const start = text.indexOf(OUTPUT_EFFICIENCY_SECTION_HEADER);
  if (start === -1) return null;

  const afterHeader = start + OUTPUT_EFFICIENCY_SECTION_HEADER.length;
  const remainder = text.slice(afterHeader);
  const nextHeadingMatch = remainder.match(/\n# [^\n]+/);

  if (!nextHeadingMatch || nextHeadingMatch.index == null) {
    return text.slice(0, start) + OUTPUT_EFFICIENCY_SECTION_REPLACEMENT;
  }

  const nextHeadingStart = afterHeader + nextHeadingMatch.index + 1;
  return (
    text.slice(0, start) +
    OUTPUT_EFFICIENCY_SECTION_REPLACEMENT +
    "\n\n" +
    text.slice(nextHeadingStart)
  );
}

// --------------------------------------------------------------------------
// Fetch interceptor
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Debug logging (writes to ~/.claude/cache-fix-debug.log)
// Set CACHE_FIX_DEBUG=1 to enable
// --------------------------------------------------------------------------

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEBUG = process.env.CACHE_FIX_DEBUG === "1";
const PREFIXDIFF = process.env.CACHE_FIX_PREFIXDIFF === "1";
const NORMALIZE_IDENTITY = process.env.CACHE_FIX_NORMALIZE_IDENTITY === "1";
const STRIP_GIT_STATUS = process.env.CACHE_FIX_STRIP_GIT_STATUS === "1";
const NORMALIZE_CWD = process.env.CACHE_FIX_NORMALIZE_CWD === "1";
const TTL_MAIN = (process.env.CACHE_FIX_TTL_MAIN || "1h").toLowerCase();
const TTL_SUBAGENT = (process.env.CACHE_FIX_TTL_SUBAGENT || "1h").toLowerCase();
const LOG_PATH = join(homedir(), ".claude", "cache-fix-debug.log");
const SNAPSHOT_DIR = join(homedir(), ".claude", "cache-fix-snapshots");
const USAGE_JSONL = process.env.CACHE_FIX_USAGE_LOG || join(homedir(), ".claude", "usage.jsonl");

function debugLog(...args) {
  if (!DEBUG) return;
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try { appendFileSync(LOG_PATH, line); } catch {}
}

// --------------------------------------------------------------------------
// Kill switches — disable fixes while keeping monitoring active
// --------------------------------------------------------------------------

const FIXES_DISABLED = process.env.CACHE_FIX_DISABLED === "1";

/**
 * Check if a specific fix should be applied.
 * Returns false if master kill switch is on OR individual fix is skipped.
 * Monitoring and optimizations (image strip, output efficiency) are NOT
 * affected by CACHE_FIX_DISABLED — only bug fixes are.
 */
function shouldApplyFix(fixName) {
  if (FIXES_DISABLED) return false;
  const skipKey = `CACHE_FIX_SKIP_${fixName.toUpperCase()}`;
  if (process.env[skipKey] === "1") return false;
  return true;
}

// --------------------------------------------------------------------------
// Persistent effectiveness stats
// --------------------------------------------------------------------------

const STATS_PATH = join(homedir(), ".claude", "cache-fix-stats.json");

const _STATS_SCHEMA = {
  relocate: { applied: 0, skipped: 0, bugPresent: 0, resumeScanned: 0, lastApplied: null, lastScanned: null },
  fingerprint: { applied: 0, skipped: 0, safetyBlocked: 0, lastApplied: null },
  tool_sort: { applied: 0, skipped: 0, lastApplied: null },
  ttl: { applied: 0, skipped: 0, lastApplied: null },
  identity: { applied: 0, skipped: 0, lastApplied: null },
  git_status: { applied: 0, skipped: 0, lastApplied: null },
  cwd_normalize: { applied: 0, skipped: 0, lastApplied: null },
  smoosh_normalize: { applied: 0, skipped: 0, lastApplied: null },
  smoosh_split: { applied: 0, skipped: 0, lastApplied: null },
  session_start_normalize: { applied: 0, skipped: 0, lastApplied: null },
  continue_trailer_strip: { applied: 0, skipped: 0, lastApplied: null },
  deferred_tools_restore: { applied: 0, skipped: 0, lastApplied: null },
  cache_control_sticky: { applied: 0, skipped: 0, lastApplied: null },
};

function _createEmptyStats() {
  return {
    version: 1,
    created: new Date().toISOString(),
    lastUpdated: null,
    fixes: JSON.parse(JSON.stringify(_STATS_SCHEMA)),
  };
}

/** Read stats from disk. Returns empty stats on any error. */
function readStats() {
  try {
    const data = JSON.parse(readFileSync(STATS_PATH, "utf8"));
    if (data.created) {
      const ageDays = (Date.now() - new Date(data.created).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > 30) return _createEmptyStats();
    }
    for (const [key, schema] of Object.entries(_STATS_SCHEMA)) {
      if (!data.fixes[key]) data.fixes[key] = { ...schema };
    }
    return data;
  } catch {
    return _createEmptyStats();
  }
}

/** Atomic write: temp file + rename to avoid corruption. */
function writeStats(stats) {
  try {
    stats.lastUpdated = new Date().toISOString();
    const tmp = STATS_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(stats, null, 2));
    renameSync(tmp, STATS_PATH);
  } catch (e) {
    debugLog("STATS WRITE ERROR:", e?.message);
  }
}

function recordFixResult(fixName, result) {
  const stats = readStats();
  if (!stats.fixes[fixName]) return;
  const now = new Date().toISOString();
  stats.lastUpdated = now;
  if (result === "applied") {
    stats.fixes[fixName].applied++;
    stats.fixes[fixName].lastApplied = now;
  } else if (result === "skipped") {
    stats.fixes[fixName].skipped++;
  } else if (result === "safety_blocked") {
    stats.fixes[fixName].safetyBlocked = (stats.fixes[fixName].safetyBlocked || 0) + 1;
  }
  writeStats(stats);
}

function recordRelocateScan(bugFound) {
  const stats = readStats();
  const now = new Date().toISOString();
  stats.lastUpdated = now;
  stats.fixes.relocate.resumeScanned++;
  stats.fixes.relocate.lastScanned = now;
  if (bugFound) stats.fixes.relocate.bugPresent++;
  writeStats(stats);
}

// --------------------------------------------------------------------------
// Prefix snapshot — captures message prefix for cross-process diff.
// Set CACHE_FIX_PREFIXDIFF=1 to enable.
//
// On each API call: saves JSON of first 5 messages + system + tools hash
// to ~/.claude/cache-fix-snapshots/<session-hash>-last.json
//
// On first call after startup: compares against saved snapshot and writes
// a diff report to ~/.claude/cache-fix-snapshots/<session-hash>-diff.json
// --------------------------------------------------------------------------

let _prefixDiffFirstCall = true;

// --------------------------------------------------------------------------
// GrowthBook flag dump (runs once on first API call)
// --------------------------------------------------------------------------

let _growthBookDumped = false;

function dumpGrowthBookFlags() {
  if (_growthBookDumped || !DEBUG) return;
  _growthBookDumped = true;
  try {
    const claudeJson = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    const features = claudeJson.cachedGrowthBookFeatures;
    if (!features) { debugLog("GROWTHBOOK: no cachedGrowthBookFeatures found"); return; }

    // Log the flags that matter for cost/cache/context behavior
    const interesting = {
      hawthorn_window: features.tengu_hawthorn_window,
      pewter_kestrel: features.tengu_pewter_kestrel,
      summarize_tool_results: features.tengu_summarize_tool_results,
      slate_heron: features.tengu_slate_heron,
      session_memory: features.tengu_session_memory,
      sm_compact: features.tengu_sm_compact,
      sm_compact_config: features.tengu_sm_compact_config,
      sm_config: features.tengu_sm_config,
      cache_plum_violet: features.tengu_cache_plum_violet,
      prompt_cache_1h_config: features.tengu_prompt_cache_1h_config,
      crystal_beam: features.tengu_crystal_beam,
      cold_compact: features.tengu_cold_compact,
      system_prompt_global_cache: features.tengu_system_prompt_global_cache,
      compact_cache_prefix: features.tengu_compact_cache_prefix,
      onyx_plover: features.tengu_onyx_plover,
    };
    debugLog("GROWTHBOOK FLAGS:", JSON.stringify(interesting, null, 2));
  } catch (e) {
    debugLog("GROWTHBOOK: failed to read ~/.claude.json:", e?.message);
  }
}

// --------------------------------------------------------------------------
// Startup health status line
// --------------------------------------------------------------------------

let _healthLinePrinted = false;

function _formatTimeSince(isoString) {
  if (!isoString) return "never";
  const ms = Date.now() - new Date(isoString).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(ms / (1000 * 60));
  return `${mins}m ago`;
}

function _formatFixStatus(fixName, fixStats, dormantThreshold = 5) {
  if (fixName === "relocate") {
    if (fixStats.resumeScanned >= dormantThreshold && fixStats.bugPresent === 0) {
      return `dormant(${fixStats.resumeScanned} clean sessions)`;
    }
  } else {
    if (fixStats.skipped >= dormantThreshold && fixStats.applied === 0) {
      return `dormant(${fixStats.skipped} skips)`;
    }
  }
  if (fixStats.safetyBlocked > 0) return `safety-blocked(${fixStats.safetyBlocked}x)`;
  if (fixStats.lastApplied) return `active(${_formatTimeSince(fixStats.lastApplied)})`;
  return "waiting";
}

function printHealthLine() {
  if (_healthLinePrinted) return;
  _healthLinePrinted = true;
  const stats = readStats();
  const parts = [];
  for (const [name, fixStats] of Object.entries(stats.fixes)) {
    const status = _formatFixStatus(name, fixStats);
    parts.push(`${name}=${status}`);
    if (status.startsWith("dormant")) {
      debugLog(`DORMANT: ${name} — CC may have fixed this. Consider CACHE_FIX_SKIP_${name.toUpperCase()}=1`);
    }
    if (status.startsWith("safety-blocked")) {
      debugLog(`SAFETY: ${name} — salt/indices may have changed. Fix is auto-disabled.`);
    }
  }
  debugLog(`HEALTH: ${parts.join(" ")}`);
  if (FIXES_DISABLED) {
    debugLog("HEALTH: all fixes disabled via CACHE_FIX_DISABLED=1 (monitoring active)");
  }
  debugLog("SECURITY: This interceptor has full read/write access to API requests. All telemetry is local only — no network calls. Source: github.com/cnighswonger/claude-code-cache-fix");
}

// --------------------------------------------------------------------------
// Microcompact / budget monitoring
// --------------------------------------------------------------------------

/**
 * Scan outgoing messages for signs of microcompact clearing and budget
 * enforcement. Counts tool results that have been gutted and reports stats.
 */
function monitorContextDegradation(messages) {
  if (!Array.isArray(messages)) return null;

  let clearedToolResults = 0;
  let totalToolResultChars = 0;
  let totalToolResults = 0;

  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        totalToolResults++;
        const content = block.content;
        if (typeof content === "string") {
          if (content === "[Old tool result content cleared]") {
            clearedToolResults++;
          } else {
            totalToolResultChars += content.length;
          }
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === "text") {
              if (item.text === "[Old tool result content cleared]") {
                clearedToolResults++;
              } else {
                totalToolResultChars += item.text.length;
              }
            }
          }
        }
      }
    }
  }

  if (totalToolResults === 0) return null;

  const stats = { totalToolResults, clearedToolResults, totalToolResultChars };

  if (clearedToolResults > 0) {
    debugLog(`MICROCOMPACT: ${clearedToolResults}/${totalToolResults} tool results cleared`);
  }

  // Warn when approaching the 200K budget threshold
  if (totalToolResultChars > 150000) {
    debugLog(`BUDGET WARNING: tool result chars at ${totalToolResultChars.toLocaleString()} / 200,000 threshold`);
  }

  return stats;
}

function snapshotPrefix(payload) {
  if (!PREFIXDIFF) return;
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });

    // Session key: use system prompt hash — stable across restarts for the same project.
    // Different projects get different snapshots, same project matches across resume.
    const sessionKey = payload.system
      ? createHash("sha256").update(JSON.stringify(payload.system).slice(0, 2000)).digest("hex").slice(0, 12)
      : "default";

    const snapshotFile = join(SNAPSHOT_DIR, `${sessionKey}-last.json`);
    const diffFile = join(SNAPSHOT_DIR, `${sessionKey}-diff.json`);

    // Build prefix snapshot: first 5 messages, stripped of cache_control
    const prefixMsgs = (payload.messages || []).slice(0, 5).map(msg => {
      const content = Array.isArray(msg.content)
        ? msg.content.map(b => {
            const { cache_control, ...rest } = b;
            // Truncate long text blocks for diffing
            if (rest.text && rest.text.length > 500) {
              rest.text = rest.text.slice(0, 500) + `...[${rest.text.length} chars]`;
            }
            return rest;
          })
        : msg.content;
      return { role: msg.role, content };
    });

    const toolsHash = payload.tools
      ? createHash("sha256").update(JSON.stringify(payload.tools.map(t => t.name))).digest("hex").slice(0, 16)
      : "none";

    const systemHash = payload.system
      ? createHash("sha256").update(JSON.stringify(payload.system)).digest("hex").slice(0, 16)
      : "none";

    const snapshot = {
      timestamp: new Date().toISOString(),
      messageCount: payload.messages?.length || 0,
      toolsHash,
      systemHash,
      prefixMessages: prefixMsgs,
    };

    // On first call: compare against saved
    if (_prefixDiffFirstCall) {
      _prefixDiffFirstCall = false;
      try {
        const prev = JSON.parse(readFileSync(snapshotFile, "utf8"));
        const diff = {
          timestamp: snapshot.timestamp,
          prevTimestamp: prev.timestamp,
          toolsMatch: prev.toolsHash === snapshot.toolsHash,
          systemMatch: prev.systemHash === snapshot.systemHash,
          messageCountPrev: prev.messageCount,
          messageCountNow: snapshot.messageCount,
          prefixDiffs: [],
        };

        const maxIdx = Math.max(prev.prefixMessages.length, snapshot.prefixMessages.length);
        for (let i = 0; i < maxIdx; i++) {
          const prevMsg = JSON.stringify(prev.prefixMessages[i] || null);
          const nowMsg = JSON.stringify(snapshot.prefixMessages[i] || null);
          if (prevMsg !== nowMsg) {
            diff.prefixDiffs.push({
              index: i,
              prev: prev.prefixMessages[i] || null,
              now: snapshot.prefixMessages[i] || null,
            });
          }
        }

        writeFileSync(diffFile, JSON.stringify(diff, null, 2));
        debugLog(`PREFIX DIFF: ${diff.prefixDiffs.length} differences in first 5 messages. tools=${diff.toolsMatch ? "match" : "DIFFER"} system=${diff.systemMatch ? "match" : "DIFFER"}`);
      } catch {
        // No previous snapshot — first run
      }
    }

    // Save current snapshot
    writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));
  } catch (e) {
    debugLog("PREFIX SNAPSHOT ERROR:", e?.message);
  }
}

// --------------------------------------------------------------------------
// Cache regression detector
// --------------------------------------------------------------------------

const _cacheHistory = []; // in-memory ring buffer of { ratio, turn }
const REGRESSION_MIN_CALLS = 5;
const REGRESSION_MIN_RATIO = 0.5;
let _apiCallCount = 0;

function _computeCacheRatio(usage) {
  if (!usage) return null;
  const read = usage.cache_read_input_tokens || 0;
  const creation = usage.cache_creation_input_tokens || 0;
  const input = usage.input_tokens || 0;
  const total = read + creation + input;
  if (total === 0) return null;
  return read / total;
}

function _checkCacheRegression() {
  if (_cacheHistory.length < REGRESSION_MIN_CALLS) return;
  const recent = _cacheHistory.slice(-REGRESSION_MIN_CALLS);
  const allLow = recent.every((h) => h.ratio < REGRESSION_MIN_RATIO);
  if (allLow) {
    const avgRatio = recent.reduce((sum, h) => sum + h.ratio, 0) / recent.length;
    debugLog(
      `REGRESSION WARNING: cache_read ratio averaged ${Math.round(avgRatio * 100)}%`,
      `across last ${REGRESSION_MIN_CALLS} calls (threshold: ${REGRESSION_MIN_RATIO * 100}%).`,
      FIXES_DISABLED
        ? "Fixes are disabled — consider re-enabling to recover cache performance."
        : "Fixes are active but cache is still degraded — CC may have introduced a new bug."
    );
  }
}

function _trackCacheRatio(usage) {
  if (_apiCallCount <= 1) return; // skip first call (cache creation, no reads)
  const ratio = _computeCacheRatio(usage);
  if (ratio === null) return;
  _cacheHistory.push({ ratio, turn: _apiCallCount });
  if (_cacheHistory.length > 20) _cacheHistory.shift(); // ring buffer
  _checkCacheRegression();
}

// --------------------------------------------------------------------------
// Fetch interceptor
// --------------------------------------------------------------------------

const _origFetch = globalThis.fetch;

globalThis.fetch = async function (url, options) {
  const urlStr = typeof url === "string" ? url : url?.url || String(url);

  const isMessagesEndpoint =
    urlStr.includes("/v1/messages") &&
    !urlStr.includes("batches") &&
    !urlStr.includes("count_tokens");

  if (isMessagesEndpoint && options?.body && typeof options.body === "string") {
    try {
      _apiCallCount++;
      const payload = JSON.parse(options.body);
      let modified = false;

      // One-time GrowthBook flag dump on first API call
      dumpGrowthBookFlags();
      printHealthLine();

      if (FIXES_DISABLED) {
        debugLog("CACHE_FIX_DISABLED=1 — all bug fixes bypassed, monitoring active");
      }

      debugLog("--- API call to", urlStr);
      debugLog("message count:", payload.messages?.length);

      // Detect synthetic model (false rate limiter, B3)
      if (payload.model === "<synthetic>") {
        debugLog("FALSE RATE LIMIT: synthetic model detected — client-side rate limit, no real API call");
      }

      // Bug 1: Relocate resume attachment blocks
      if (payload.messages && shouldApplyFix("relocate")) {
        // Log message structure for debugging
        if (DEBUG) {
          let firstUserIdx = -1, lastUserIdx = -1;
          for (let i = 0; i < payload.messages.length; i++) {
            if (payload.messages[i].role === "user") {
              if (firstUserIdx === -1) firstUserIdx = i;
              lastUserIdx = i;
            }
          }
          if (firstUserIdx !== -1) {
            const firstContent = payload.messages[firstUserIdx].content;
            const lastContent = payload.messages[lastUserIdx].content;
            debugLog("firstUserIdx:", firstUserIdx, "lastUserIdx:", lastUserIdx);
            debugLog("first user msg blocks:", Array.isArray(firstContent) ? firstContent.length : "string");
            if (Array.isArray(firstContent)) {
              for (const b of firstContent) {
                const t = (b.text || "").substring(0, 80);
                debugLog("  first[block]:", isRelocatableBlock(b.text) ? "RELOCATABLE" : "keep", JSON.stringify(t));
              }
            }
            if (firstUserIdx !== lastUserIdx) {
              debugLog("last user msg blocks:", Array.isArray(lastContent) ? lastContent.length : "string");
              if (Array.isArray(lastContent)) {
                for (const b of lastContent) {
                  const t = (b.text || "").substring(0, 80);
                  debugLog("  last[block]:", isRelocatableBlock(b.text) ? "RELOCATABLE" : "keep", JSON.stringify(t));
                }
              }
            } else {
              debugLog("single user message (fresh session)");
            }
          }
        }

        const normalized = normalizeResumeMessages(payload.messages);
        // Track bug presence for dormancy detection (resume = messages > 5)
        const isResume = payload.messages.length > 5;
        if (isResume) recordRelocateScan(normalized !== payload.messages);

        if (normalized !== payload.messages) {
          payload.messages = normalized;
          modified = true;
          debugLog("APPLIED: resume message relocation");
          recordFixResult("relocate", "applied");
        } else {
          debugLog("SKIPPED: resume relocation (not a resume or already correct)");
          recordFixResult("relocate", "skipped");
        }
      } else if (payload.messages && !shouldApplyFix("relocate")) {
        debugLog("SKIPPED: relocate fix disabled via env var");
      }

      // Image stripping: remove old tool_result images to reduce token waste
      if (payload.messages && IMAGE_KEEP_LAST > 0) {
        const { messages: imgStripped, stats: imgStats } = stripOldToolResultImages(
          payload.messages, IMAGE_KEEP_LAST
        );
        if (imgStats) {
          payload.messages = imgStripped;
          modified = true;
          debugLog(
            `APPLIED: stripped ${imgStats.strippedCount} images from old tool results`,
            `(~${imgStats.strippedBytes} base64 bytes, ~${imgStats.estimatedTokens} tokens saved)`
          );
        } else if (IMAGE_KEEP_LAST > 0) {
          debugLog("SKIPPED: image stripping (no old images found or not enough turns)");
        }
      }

      // Bug 2a: Stabilize tool ordering
      if (payload.tools && shouldApplyFix("tool_sort")) {
        const sorted = stabilizeToolOrder(payload.tools);
        const changed = sorted.some(
          (t, i) => t.name !== payload.tools[i]?.name
        );
        if (changed) {
          payload.tools = sorted;
          modified = true;
          debugLog("APPLIED: tool order stabilization");
          recordFixResult("tool_sort", "applied");
        } else {
          recordFixResult("tool_sort", "skipped");
        }
      } else if (payload.tools && !shouldApplyFix("tool_sort")) {
        debugLog("SKIPPED: tool sort fix disabled via env var");
      }

      // Bug 2b: Stabilize fingerprint in attribution header
      if (payload.system && payload.messages && shouldApplyFix("fingerprint")) {
        const fix = stabilizeFingerprint(payload.system, payload.messages);
        if (fix) {
          payload.system = [...payload.system];
          payload.system[fix.attrIdx] = {
            ...payload.system[fix.attrIdx],
            text: fix.newText,
          };
          modified = true;
          debugLog("APPLIED: fingerprint stabilized from", fix.oldFingerprint, "to", fix.stableFingerprint);
          recordFixResult("fingerprint", "applied");
        } else {
          recordFixResult("fingerprint", "skipped");
        }
      } else if (payload.system && payload.messages && !shouldApplyFix("fingerprint")) {
        debugLog("SKIPPED: fingerprint fix disabled via env var");
      }

      // Bug 6: Identity string normalization for Agent()/SendMessage() cache parity
      // The CC orchestrator emits a different identity string in system[1] depending
      // on whether the call originated from Agent() vs SendMessage() (subagent resume):
      //   Agent():       "You are Claude Code, Anthropic's official CLI for Claude."
      //   SendMessage(): "You are a Claude agent, built on Anthropic's Claude Agent SDK."
      // Both blocks carry cache_control: ephemeral. The ~50-char identity swap is enough
      // to invalidate the entire cache prefix, producing cache_read=0 on first SendMessage
      // turn even though system[2] (the actual instructions) is byte-identical.
      // Confirmed by @labzink via mitmproxy on #44724.
      // Opt-in because it's a model-perceivable behavior change (subagent thinks it's CC).
      if (NORMALIZE_IDENTITY && shouldApplyFix("identity") && payload.system && Array.isArray(payload.system)) {
        const CANONICAL = "You are Claude Code, Anthropic's official CLI for Claude.";
        const AGENT_SDK = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
        let normalized = 0;
        payload.system = payload.system.map((block) => {
          if (
            block?.type === "text" &&
            typeof block.text === "string" &&
            block.text.startsWith(AGENT_SDK)
          ) {
            normalized++;
            return { ...block, text: CANONICAL + block.text.slice(AGENT_SDK.length) };
          }
          return block;
        });
        if (normalized > 0) {
          modified = true;
          debugLog(`APPLIED: identity normalized on ${normalized} system block(s) (Agent SDK → Claude Code)`);
          recordFixResult("identity", "applied");
        } else {
          recordFixResult("identity", "skipped");
        }
      }

      // Optional: rewrite Claude Code's default output-efficiency section
      if (payload.system && OUTPUT_EFFICIENCY_SECTION_REPLACEMENT) {
        const rewritten = rewriteOutputEfficiencyInstruction(payload.system);
        if (rewritten) {
          payload.system = rewritten;
          modified = true;
          debugLog("APPLIED: output efficiency section rewritten");
        } else {
          debugLog("SKIPPED: output efficiency rewrite (section not found)");
        }
      }

      // Optimization: strip volatile git-status from system prompt
      // CC injects live git-status output (branch, changed files, recent commits)
      // into a system text block. This changes on every file edit, busting the
      // entire prefix cache. Opt-in via CACHE_FIX_STRIP_GIT_STATUS=1.
      // The model can still run `git status` via Bash tool when it needs context.
      if (STRIP_GIT_STATUS && shouldApplyFix("git_status") && payload.system && Array.isArray(payload.system)) {
        let stripped = 0;
        payload.system = payload.system.map((block) => {
          if (block?.type !== "text" || typeof block.text !== "string") return block;
          // Match the gitStatus section CC injects. Pattern:
          //   "gitStatus: This is the git status..."
          //   followed by branch, status, commits until the next section or end
          const gitStatusPattern = /gitStatus:.*?(?=\n# |\n## |\nWhen |\nAnswer |\n<[a-z]|$)/s;
          if (!gitStatusPattern.test(block.text)) return block;
          const newText = block.text.replace(gitStatusPattern, "gitStatus: [stripped by cache-fix for prefix stability]");
          if (newText !== block.text) {
            stripped++;
            return { ...block, text: newText };
          }
          return block;
        });
        if (stripped > 0) {
          modified = true;
          debugLog(`APPLIED: git-status stripped from ${stripped} system block(s)`);
          recordFixResult("git_status", "applied");
        } else {
          recordFixResult("git_status", "skipped");
        }
      }

      // Optimization: normalize CWD and path references in system prompt
      // CC injects the full working directory path, additional directories, and
      // path references into system text blocks. These change per project/worktree,
      // busting the prefix cache across different working directories.
      // Opt-in via CACHE_FIX_NORMALIZE_CWD=1.
      // The model can still discover paths via Bash (pwd, ls) when needed.
      if (NORMALIZE_CWD && shouldApplyFix("cwd_normalize") && payload.system && Array.isArray(payload.system)) {
        let normalized = 0;
        payload.system = payload.system.map((block) => {
          if (block?.type !== "text" || typeof block.text !== "string") return block;
          let newText = block.text;
          // Normalize "Primary working directory: /path/to/project"
          newText = newText.replace(
            /( - Primary working directory: ).+/g,
            "$1[normalized by cache-fix]"
          );
          // Normalize "Additional working directories:" section
          newText = newText.replace(
            /( - Additional working directories:\n)((?:  - .+\n)*)/g,
            "$1  - [normalized by cache-fix]\n"
          );
          // Normalize "Contents of /path/to/..." in claudeMd/memory references
          newText = newText.replace(
            /Contents of \/[^\s(]+/g,
            "Contents of [path normalized by cache-fix]"
          );
          if (newText !== block.text) {
            normalized++;
            return { ...block, text: newText };
          }
          return block;
        });
        if (normalized > 0) {
          modified = true;
          debugLog(`APPLIED: CWD/paths normalized in ${normalized} system block(s)`);
          recordFixResult("cwd_normalize", "applied");
        } else {
          recordFixResult("cwd_normalize", "skipped");
        }
      }

      // Extension: session_start_normalize — SessionStart:resume → :startup rewrite
      // and ephemeral session-id / Last-active strip. Runs BEFORE smoosh_normalize
      // so drift at msg[0] content[N] is stabilized before any subsequent pass
      // reads from the same text. Applies to both standalone text blocks and
      // tool_result.content strings (in case CC's smooshSystemReminderSiblings
      // folded the reminder before we see it).
      // Bug: anthropics/claude-code#43657
      // Opt-out via CACHE_FIX_SKIP_SESSION_START_NORMALIZE=1 (defaults ON).
      if (shouldApplyFix("session_start_normalize") && payload.messages) {
        let ssnApplied = 0;
        for (const msg of payload.messages) {
          if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;
          for (let i = 0; i < msg.content.length; i++) {
            const block = msg.content[i];
            if (block?.type === "text" && typeof block.text === "string") {
              const [t, n] = normalizeSessionStartText(block.text);
              if (n > 0) {
                msg.content[i] = { ...block, text: t };
                ssnApplied += n;
              }
            } else if (block?.type === "tool_result" && typeof block.content === "string") {
              const [c, n] = normalizeSessionStartText(block.content);
              if (n > 0) {
                msg.content[i] = { ...block, content: c };
                ssnApplied += n;
              }
            }
          }
        }
        if (ssnApplied > 0) {
          modified = true;
          debugLog(`APPLIED: session-start-normalize rewrote ${ssnApplied} marker(s)`);
          recordFixResult("session_start_normalize", "applied");
        } else {
          recordFixResult("session_start_normalize", "skipped");
        }
      }

      // Optimization: normalize smooshed dynamic system-reminders in tool_result content
      // CC's smooshSystemReminderSiblings (messages.ts:1835) folds <system-reminder> text
      // blocks into tool_result.content strings. Dynamic values (token_usage, budget_usd,
      // output_token_usage, todo_reminder) change every turn, causing mid-history cache
      // busts even without resume or attachment scatter.
      // Bug: anthropics/claude-code#49585 (deafsquad)
      // Opt-in via CACHE_FIX_NORMALIZE_SMOOSH=1.
      if (process.env.CACHE_FIX_NORMALIZE_SMOOSH === "1" && shouldApplyFix("smoosh_normalize") && payload.messages) {
        let smooshNormalized = 0;
        const smooshPatterns = [
          // Token usage: 12345/50000; 37655 remaining
          /(<system-reminder>\nToken usage: )\d+\/\d+; \d+ remaining/g,
          // USD budget: $1.23/$10.00; $8.77 remaining
          /(<system-reminder>\nUSD budget: )\$[\d.]+\/\$[\d.]+; \$[\d.]+ remaining/g,
          // Output tokens — turn: 1,234 / 5,000 · session: 12,345
          /(<system-reminder>\nOutput tokens \u2014 turn: )[\d,./\s]+ \u00b7 session: [\d,]+/g,
          // TodoWrite reminder with variable todo list content
          /(<system-reminder>\nThe TodoWrite tool hasn't been used recently\..*?)(\n\nHere are the existing contents of your todo list:\n\n\[[\s\S]*?\])?(\n<\/system-reminder>)/g,
        ];
        const smooshReplacements = [
          "$1[normalized]/[normalized]; [normalized] remaining",
          "$1$[normalized]/$[normalized]; $[normalized] remaining",
          "$1[normalized] \u00b7 session: [normalized]",
          "$1$3",  // strip the variable todo list, keep the static reminder text
        ];

        for (const msg of payload.messages) {
          if (msg.role !== "user") continue;
          // Handle both string content (smooshed tool_result) and array content
          if (Array.isArray(msg.content)) {
            for (let i = 0; i < msg.content.length; i++) {
              const block = msg.content[i];
              // Smooshed tool_result with string content
              if (block.type === "tool_result" && typeof block.content === "string" && block.content.includes("<system-reminder>")) {
                let newContent = block.content;
                for (let p = 0; p < smooshPatterns.length; p++) {
                  smooshPatterns[p].lastIndex = 0;
                  newContent = newContent.replace(smooshPatterns[p], smooshReplacements[p]);
                }
                if (newContent !== block.content) {
                  msg.content[i] = { ...block, content: newContent };
                  smooshNormalized++;
                }
              }
              // Unsmooshed standalone text blocks with dynamic system-reminder content
              if (block.type === "text" && typeof block.text === "string" && block.text.startsWith("<system-reminder>")) {
                let newText = block.text;
                for (let p = 0; p < smooshPatterns.length; p++) {
                  smooshPatterns[p].lastIndex = 0;
                  newText = newText.replace(smooshPatterns[p], smooshReplacements[p]);
                }
                if (newText !== block.text) {
                  msg.content[i] = { ...block, text: newText };
                  smooshNormalized++;
                }
              }
            }
          }
        }
        if (smooshNormalized > 0) {
          modified = true;
          debugLog(`APPLIED: smoosh-normalized ${smooshNormalized} tool_result block(s) with dynamic system-reminders`);
          recordFixResult("smoosh_normalize", "applied");
        } else {
          recordFixResult("smoosh_normalize", "skipped");
        }
      }

      // Extension: smoosh_split — universal un-smoosh, complements smoosh_normalize.
      // CC's smooshSystemReminderSiblings (messages.ts:1835) folds any
      // `<system-reminder>`-prefixed text block adjacent to a tool_result
      // into that tool_result's content string with a leading `\n\n`.
      // The existing smoosh_normalize above stabilizes bytes for 4 enumerated
      // patterns (Token usage, USD budget, Output tokens, TodoWrite), but
      // hook-injected reminders (thinking-enrichment, action-tracker, MCP
      // deltas, custom user hooks) don't match those patterns and still drift.
      // smoosh_split peels any trailing `\n\n<system-reminder>...\n</system-reminder>`
      // off tool_result.content strings and restores it as a standalone text
      // block — the pre-smoosh shape. Dynamic drift in the peeled reminder
      // lives in a small block instead of a multi-KB tool_result string.
      // Composed with smoosh_normalize: normalize stabilizes known patterns
      // in-place; split peels any remainder. Full universal coverage.
      // Bug: anthropics/claude-code#49585
      // Opt-out via CACHE_FIX_SKIP_SMOOSH_SPLIT=1 (defaults ON).
      if (shouldApplyFix("smoosh_split") && payload.messages) {
        const TRAILING_SMOOSH_TAIL = /\n\n(<system-reminder>\n(?:(?!<\/system-reminder>)[\s\S])*?\n<\/system-reminder>)\s*$/;
        let splitApplied = 0;
        for (const msg of payload.messages) {
          if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
          const out = [];
          let mutated = false;
          const peeledReminders = [];
          for (const block of msg.content) {
            if (block?.type === "tool_result" && typeof block.content === "string") {
              const reminders = [];
              let s = block.content;
              while (true) {
                const m = s.match(TRAILING_SMOOSH_TAIL);
                if (!m) break;
                reminders.unshift(m[1]);
                s = s.slice(0, m.index);
              }
              if (reminders.length > 0) {
                out.push({ ...block, content: s });
                for (const r of reminders) peeledReminders.push({ type: "text", text: r });
                splitApplied += reminders.length;
                mutated = true;
                continue;
              }
            }
            out.push(block);
          }
          // Peeled reminders go AFTER all other blocks so tool_results stay
          // consecutive (avoids API 400 "tool use concurrency" errors).
          if (mutated) msg.content = [...out, ...peeledReminders];
        }
        if (splitApplied > 0) {
          modified = true;
          debugLog(`APPLIED: smoosh-split peeled ${splitApplied} trailing system-reminder(s) from tool_result.content`);
          recordFixResult("smoosh_split", "applied");
        } else {
          recordFixResult("smoosh_split", "skipped");
        }
      }

      // Extension: continue_trailer_strip — remove the "Continue from where
      // you left off." text block CC appends to the last user message on
      // --continue. Pre-exit bodies didn't carry it, so its presence in the
      // resumed body creates tail-of-last-msg drift that breaks cache.
      // Exact-match string equality on `.text` — user sentences mentioning
      // the phrase inside longer content are not touched.
      // Bug: anthropics/claude-code#12 (resume UX), observed empirically.
      // Opt-out via CACHE_FIX_SKIP_CONTINUE_TRAILER_STRIP=1 (defaults ON).
      if (shouldApplyFix("continue_trailer_strip") && payload.messages) {
        let trailerStripped = 0;
        for (const msg of payload.messages) {
          if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;
          const kept = msg.content.filter((block) => {
            if (isContinueTrailerBlock(block)) {
              trailerStripped++;
              return false;
            }
            return true;
          });
          if (kept.length !== msg.content.length) msg.content = kept;
        }
        if (trailerStripped > 0) {
          modified = true;
          debugLog(`APPLIED: continue-trailer-strip removed ${trailerStripped} trailer block(s)`);
          recordFixResult("continue_trailer_strip", "applied");
        } else {
          recordFixResult("continue_trailer_strip", "skipped");
        }
      }

      // Extension: deferred_tools_restore — persist-and-restore the
      // deferred-tools attachment block across sessions so MCP reconnect
      // race at resume-time doesn't shrink msg[0] and bust the whole cache.
      // Snapshot key defaults to process.cwd() (one snapshot per project).
      // Opt-out via CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE=1 (defaults ON).
      if (shouldApplyFix("deferred_tools_restore") && payload.messages) {
        let dtrRestored = 0;
        const found = findDeferredToolsBlockInBody(payload);
        if (found) {
          const hasUnavail = found.text.includes(DEFERRED_TOOLS_UNAVAILABLE_MARKER);
          const snapshotPath = deferredToolsSnapshotPath(process.cwd());
          if (!hasUnavail) {
            // Clean baseline — persist it for future resumes. Silent on
            // any I/O error; snapshot is best-effort.
            try {
              mkdirSync(DEFERRED_TOOLS_SNAPSHOT_DIR, { recursive: true });
              writeFileSync(snapshotPath, found.text, "utf-8");
            } catch {}
          } else {
            // Shrunk block with explicit "no longer available" signal →
            // attempt restore. Only substitute if the persisted version is
            // strictly longer (never downgrade to a stale shorter snapshot).
            let snapshot = null;
            try { snapshot = readFileSync(snapshotPath, "utf-8"); } catch {}
            if (snapshot && snapshot.length > found.text.length) {
              const targetMsg = payload.messages[found.msgIdx];
              const newContent = targetMsg.content.slice();
              newContent[found.blockIdx] = { ...newContent[found.blockIdx], text: snapshot };
              payload.messages[found.msgIdx] = { ...targetMsg, content: newContent };
              dtrRestored = 1;
            }
          }
        }
        if (dtrRestored > 0) {
          modified = true;
          debugLog(`APPLIED: deferred-tools-restore substituted full block at msg[${found.msgIdx}].content[${found.blockIdx}]`);
          recordFixResult("deferred_tools_restore", "applied");
        } else {
          recordFixResult("deferred_tools_restore", "skipped");
        }
      }

      // Extension: cache_control_sticky — reinstate historical cache_control
      // markers on messages whose position CC has moved past. CC maintains
      // at most one user-side marker at a time; as it moves the marker to
      // the tail of each new user turn, the previous position loses the ~43
      // bytes of cache_control framing — a tail-of-message byte drift that
      // breaks every downstream cached block. This extension tracks marker
      // positions by stable message-hash across turns (up to 3) and re-adds
      // them on future bodies. Runs AFTER cache_control_normalize (when
      // present) so normalize pins the canonical tail-marker first and
      // sticky re-adds the historical ones. State file is per-project at
      // ~/.claude/cache-fix-state/cache-control-sticky-<sha1(cwd)>.json.
      // Opt-out via CACHE_FIX_SKIP_CACHE_CONTROL_STICKY=1 (defaults ON).
      if (shouldApplyFix("cache_control_sticky") && payload.messages) {
        try {
          const stickyApplied = applyCacheControlSticky(payload, process.cwd());
          if (stickyApplied > 0) {
            modified = true;
            debugLog(`APPLIED: cache_control_sticky reinstated ${stickyApplied} historical marker(s)`);
            recordFixResult("cache_control_sticky", "applied");
          } else {
            recordFixResult("cache_control_sticky", "skipped");
          }
        } catch (e) {
          debugLog(`cache_control_sticky: error (${e?.message}) — skipped`);
          recordFixResult("cache_control_sticky", "skipped");
        }
      }

      // Bug 5: TTL enforcement (configurable per request type)
      // The client gates 1h cache TTL behind a GrowthBook allowlist that checks
      // querySource against patterns like "repl_main_thread*", "sdk", "auto_mode".
      // Interactive CLI sessions may not match any pattern, causing the client to
      // send cache_control without ttl (defaulting to 5m server-side).
      // The server honors whatever TTL the client requests — so we inject it.
      // Discovered by @TigerKay1926 on #42052 using our GrowthBook flag dump.
      //
      // v1.9.0: configurable per request type via CACHE_FIX_TTL_MAIN and
      // CACHE_FIX_TTL_SUBAGENT. Values: "1h" (default), "5m", "none".
      // "none" = don't inject TTL, pass through caller's original cache_control.
      if (payload.system && shouldApplyFix("ttl")) {
        // Detect subagent: Agent SDK identity in system[1]
        const AGENT_SDK_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
        const isSubagent = Array.isArray(payload.system) &&
          payload.system.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.startsWith(AGENT_SDK_PREFIX));
        const ttlValue = isSubagent ? TTL_SUBAGENT : TTL_MAIN;
        const requestType = isSubagent ? "subagent" : "main";

        if (ttlValue === "none") {
          debugLog(`SKIPPED: TTL injection (${requestType} set to 'none' — pass-through)`);
          recordFixResult("ttl", "skipped");
        } else {
          const ttlParam = ttlValue === "5m" ? "5m" : "1h";
          let ttlInjected = 0;
          payload.system = payload.system.map((block) => {
            if (block.cache_control?.type === "ephemeral" && !block.cache_control.ttl) {
              ttlInjected++;
              return { ...block, cache_control: { ...block.cache_control, ttl: ttlParam } };
            }
            return block;
          });
          // Also check messages for cache_control blocks (conversation history breakpoints)
          if (payload.messages) {
            for (const msg of payload.messages) {
              if (!Array.isArray(msg.content)) continue;
              for (let i = 0; i < msg.content.length; i++) {
                const b = msg.content[i];
                if (b.cache_control?.type === "ephemeral" && !b.cache_control.ttl) {
                  msg.content[i] = { ...b, cache_control: { ...b.cache_control, ttl: ttlParam } };
                  ttlInjected++;
                }
              }
            }
          }
          if (ttlInjected > 0) {
            modified = true;
            debugLog(`APPLIED: ${ttlParam} TTL injected on ${ttlInjected} cache_control block(s) (${requestType})`);
            recordFixResult("ttl", "applied");
          } else {
            recordFixResult("ttl", "skipped");
          }
        }
      } else if (payload.system && !shouldApplyFix("ttl")) {
        debugLog("SKIPPED: TTL injection disabled via env var");
      }

      if (modified) {
        options = { ...options, body: JSON.stringify(payload) };
        debugLog("Request body rewritten");
      }

      // Monitor for microcompact / budget enforcement degradation
      if (payload.messages) {
        monitorContextDegradation(payload.messages);
      }

      // Diagnostic: dump cache breakpoint structure to a file when
      // CACHE_FIX_DUMP_BREAKPOINTS=<path> is set. Maps where cache_control markers
      // sit across system blocks and message content. Used to investigate #12
      // (missing breakpoint #3 for skills/CLAUDE.md).
      if (process.env.CACHE_FIX_DUMP_BREAKPOINTS && payload.system) {
        try {
          const dumpPath = process.env.CACHE_FIX_DUMP_BREAKPOINTS;
          const breakpoints = [];
          // System blocks
          if (Array.isArray(payload.system)) {
            payload.system.forEach((block, idx) => {
              if (block.cache_control) {
                breakpoints.push({
                  location: "system",
                  index: idx,
                  type: block.type,
                  cache_control: block.cache_control,
                  text_preview: (block.text || "").slice(0, 120),
                  text_chars: (block.text || "").length,
                });
              }
            });
          }
          // Message blocks
          if (payload.messages) {
            payload.messages.forEach((msg, msgIdx) => {
              if (!Array.isArray(msg.content)) return;
              msg.content.forEach((block, blockIdx) => {
                if (block.cache_control) {
                  breakpoints.push({
                    location: `messages[${msgIdx}].content`,
                    role: msg.role,
                    index: blockIdx,
                    type: block.type,
                    cache_control: block.cache_control,
                    text_preview: (block.text || "").slice(0, 120),
                    text_chars: (block.text || "").length,
                  });
                }
              });
            });
          }
          const dump = {
            timestamp: new Date().toISOString(),
            breakpoint_count: breakpoints.length,
            breakpoints,
            system_block_count: Array.isArray(payload.system) ? payload.system.length : 0,
            message_count: payload.messages ? payload.messages.length : 0,
          };
          writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
          debugLog(`DUMP: ${breakpoints.length} cache breakpoints written to ${dumpPath}`);
        } catch (e) { debugLog("BREAKPOINT DUMP ERROR:", e?.message); }
      }

      // Diagnostic: dump full tools array (names, descriptions, schemas, sizes) to a file
      // when CACHE_FIX_DUMP_TOOLS=<path> is set. Useful for per-version tool-schema drift
      // analysis and for understanding which tools contribute prefix bloat. First used
      // during the 2026-04-11 cross-version regression investigation.
      if (process.env.CACHE_FIX_DUMP_TOOLS && payload.tools) {
        try {
          const dumpPath = process.env.CACHE_FIX_DUMP_TOOLS;
          const dump = {
            timestamp: new Date().toISOString(),
            tool_count: payload.tools.length,
            tools: payload.tools.map(t => ({
              name: t.name,
              description: t.description || "",
              desc_chars: (t.description || "").length,
              schema_chars: JSON.stringify(t.input_schema || {}).length,
              total_chars: JSON.stringify(t).length,
            })),
            system_chars: JSON.stringify(payload.system || "").length,
            total_tools_chars: JSON.stringify(payload.tools).length,
          };
          writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
        } catch (e) { debugLog("DUMP ERROR:", e?.message); }
      }

      // Prompt size measurement — log system prompt, tools, and injected block sizes
      if (DEBUG && payload.system && payload.tools && payload.messages) {
        const sysChars = JSON.stringify(payload.system).length;
        const toolsChars = JSON.stringify(payload.tools).length;
        const firstUserIdx = payload.messages.findIndex(m => m.role === "user");
        if (firstUserIdx !== -1) {
          const msg0 = payload.messages[firstUserIdx];
          if (Array.isArray(msg0.content)) {
            let skillsChars = 0;
            let mcpChars = 0;
            let deferredChars = 0;
            let hooksChars = 0;
            for (const block of msg0.content) {
              const text = block.text || "";
              if (isSkillsBlock(text)) skillsChars += text.length;
              else if (isMcpBlock(text)) mcpChars += text.length;
              else if (isDeferredToolsBlock(text)) deferredChars += text.length;
              else if (isHooksBlock(text)) hooksChars += text.length;
            }
            const injectedTotal = skillsChars + mcpChars + deferredChars + hooksChars;
            if (injectedTotal > 0) {
              debugLog(
                `PROMPT SIZE: system=${sysChars} tools=${toolsChars}`,
                `injected=${injectedTotal} (skills=${skillsChars} mcp=${mcpChars}`,
                `deferred=${deferredChars} hooks=${hooksChars})`
              );
            }
          }
        }
      }

      // Capture prefix snapshot for cross-process diff analysis
      snapshotPrefix(payload);

    } catch (e) {
      debugLog("ERROR in interceptor:", e?.message);
      // Parse failure — pass through unmodified
    }
  }

  const response = await _origFetch.apply(this, [url, options]);

  // Extract quota utilization from response headers and save for hooks/MCP
  if (isMessagesEndpoint) {
    try {
      const h5 = response.headers.get("anthropic-ratelimit-unified-5h-utilization");
      const h7d = response.headers.get("anthropic-ratelimit-unified-7d-utilization");
      const reset5h = response.headers.get("anthropic-ratelimit-unified-5h-reset");
      const reset7d = response.headers.get("anthropic-ratelimit-unified-7d-reset");
      const status = response.headers.get("anthropic-ratelimit-unified-status");
      const overage = response.headers.get("anthropic-ratelimit-unified-overage-status");

      // Capture ALL anthropic-* and request-id/cf-ray response headers.
      // Pattern borrowed from @fgrosswig's claude-usage-dashboard proxy:
      //   https://github.com/fgrosswig/claude-usage-dashboard
      // Widening beyond the specific unified-ratelimit headers above future-proofs
      // us against Anthropic adding new headers (e.g. experimental rollout flags,
      // region hints, new quota dimensions) without needing code changes.
      const allAnthropicHeaders = {};
      for (const [name, value] of response.headers.entries()) {
        const lower = name.toLowerCase();
        if (
          lower.startsWith("anthropic-") ||
          lower === "request-id" ||
          lower === "x-request-id" ||
          lower === "cf-ray"
        ) {
          allAnthropicHeaders[lower] = value;
        }
      }

      if (h5 || h7d) {
        const quotaFile = join(homedir(), ".claude", "quota-status.json");
        let quota = {};
        try { quota = JSON.parse(readFileSync(quotaFile, "utf8")); } catch {}
        quota.timestamp = new Date().toISOString();
        quota.five_hour = h5 ? { utilization: parseFloat(h5), pct: Math.round(parseFloat(h5) * 100), resets_at: reset5h ? parseInt(reset5h) : null } : quota.five_hour;
        quota.seven_day = h7d ? { utilization: parseFloat(h7d), pct: Math.round(parseFloat(h7d) * 100), resets_at: reset7d ? parseInt(reset7d) : null } : quota.seven_day;
        quota.status = status || null;
        quota.overage_status = overage || null;
        quota.all_headers = allAnthropicHeaders;

        // Peak hour detection — Anthropic applies higher quota drain rate during
        // weekday peak hours: 13:00–19:00 UTC (Mon–Fri).
        // Source: Thariq (Anthropic) via X, 2026-03-26; confirmed by The Register,
        // PCWorld, Piunikaweb. No specific multiplier disclosed.
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcDay = now.getUTCDay(); // 0=Sun, 6=Sat
        const isPeak = utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour < 19;
        quota.peak_hour = isPeak;

        writeFileSync(quotaFile, JSON.stringify(quota, null, 2));

        if (DEBUG && isPeak) {
          debugLog("PEAK HOUR: weekday 13:00-19:00 UTC — quota drains at elevated rate");
        }
      }
    } catch {
      // Non-critical — don't break the response
    }

    // Clone response to extract TTL tier and usage telemetry from SSE stream.
    // Pass the model and quota headers so we can log a complete usage record.
    try {
      let reqModel = "unknown";
      try { reqModel = JSON.parse(options?.body)?.model || "unknown"; } catch {}
      const quotaHeaders = {
        q5h: parseFloat(response.headers.get("anthropic-ratelimit-unified-5h-utilization") || "0"),
        q7d: parseFloat(response.headers.get("anthropic-ratelimit-unified-7d-utilization") || "0"),
        status: response.headers.get("anthropic-ratelimit-unified-status") || null,
        overage: response.headers.get("anthropic-ratelimit-unified-overage-status") || null,
      };
      const clone = response.clone();
      drainTTLFromClone(clone, reqModel, quotaHeaders).catch(() => {});
    } catch {
      // clone() failure is non-fatal
    }
  }

  return response;
};

// --------------------------------------------------------------------------
// TTL tier extraction from SSE response stream
// --------------------------------------------------------------------------

/**
 * Drain a cloned SSE response to extract cache TTL tier from the usage object.
 * The message_start event contains usage.cache_creation with ephemeral_1h and
 * ephemeral_5m token counts, revealing which TTL tier the server applied.
 *
 * Writes TTL tier to ~/.claude/quota-status.json (merges with existing data)
 * and logs to debug log.
 */
async function drainTTLFromClone(clone, model, quotaHeaders) {
  if (!clone.body) return;

  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Accumulate usage across message_start (input/cache) and message_delta (output)
  let startUsage = null;
  let deltaUsage = null;
  let ttlTier = "unknown";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;

        try {
          const event = JSON.parse(line.slice(6));

          if (event.type === "message_start" && event.message?.usage) {
            const u = event.message.usage;
            startUsage = u;
            _trackCacheRatio(u);
            const cc = u.cache_creation || {};
            const e1h = cc.ephemeral_1h_input_tokens ?? 0;
            const e5m = cc.ephemeral_5m_input_tokens ?? 0;
            const cacheCreate = u.cache_creation_input_tokens ?? 0;
            const cacheRead = u.cache_read_input_tokens ?? 0;

            // Determine TTL tier from which ephemeral bucket got tokens
            if (e1h > 0 && e5m === 0) ttlTier = "1h";
            else if (e5m > 0 && e1h === 0) ttlTier = "5m";
            else if (e1h === 0 && e5m === 0 && cacheCreate === 0) {
              // Fully cached — no creation to determine tier. Preserve previous.
              try {
                const prev = JSON.parse(readFileSync(join(homedir(), ".claude", "quota-status.json"), "utf8"));
                ttlTier = prev.cache?.ttl_tier || "1h";
              } catch { ttlTier = "1h"; }
            }
            else if (e1h > 0 && e5m > 0) ttlTier = "mixed";

            const hitRate = (cacheRead + cacheCreate) > 0
              ? (cacheRead / (cacheRead + cacheCreate) * 100).toFixed(1)
              : "N/A";

            debugLog(
              `CACHE TTL: tier=${ttlTier}`,
              `create=${cacheCreate} read=${cacheRead} hit=${hitRate}%`,
              `(1h=${e1h} 5m=${e5m})`
            );

            // Merge TTL data into quota-status.json
            try {
              const quotaFile = join(homedir(), ".claude", "quota-status.json");
              let quota = {};
              try { quota = JSON.parse(readFileSync(quotaFile, "utf8")); } catch {}
              quota.cache = {
                ttl_tier: ttlTier,
                cache_creation: cacheCreate,
                cache_read: cacheRead,
                ephemeral_1h: e1h,
                ephemeral_5m: e5m,
                hit_rate: hitRate,
                timestamp: new Date().toISOString(),
              };
              writeFileSync(quotaFile, JSON.stringify(quota, null, 2));
            } catch {}
          }

          // Capture final usage from message_delta (has output_tokens)
          if (event.type === "message_delta" && event.usage) {
            deltaUsage = event.usage;
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  // Write usage record to JSONL after stream completes
  if (startUsage) {
    try {
      const cc = startUsage.cache_creation || {};
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcDay = now.getUTCDay();
      const record = {
        timestamp: now.toISOString(),
        model: model || "unknown",
        input_tokens: startUsage.input_tokens ?? 0,
        output_tokens: deltaUsage?.output_tokens ?? 0,
        cache_read_input_tokens: startUsage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: startUsage.cache_creation_input_tokens ?? 0,
        ephemeral_1h_input_tokens: cc.ephemeral_1h_input_tokens ?? 0,
        ephemeral_5m_input_tokens: cc.ephemeral_5m_input_tokens ?? 0,
        ttl_tier: ttlTier,
        q5h_pct: quotaHeaders ? Math.round(quotaHeaders.q5h * 100) : null,
        q7d_pct: quotaHeaders ? Math.round(quotaHeaders.q7d * 100) : null,
        peak_hour: utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour < 19,
      };
      appendFileSync(USAGE_JSONL, JSON.stringify(record) + "\n");
    } catch {
      // Non-critical — don't break anything
    }
  }
}

// --------------------------------------------------------------------------
// Test exports
// --------------------------------------------------------------------------
//
// These exports exist for unit testing the pure functions in this file. They
// have no effect on the interceptor's runtime behavior — production callers
// load this module via NODE_OPTIONS=--import and never use named imports.
// Tests import from this file directly: `import { sortSkillsBlock } from
// '../preload.mjs'`. The fetch patching above runs at import time but is
// harmless in a test process since tests do not make fetch calls.

export {
  sortSkillsBlock,
  sortDeferredToolsBlock,
  pinBlockContent,
  stripSessionKnowledge,
  stabilizeFingerprint,
  computeFingerprint,
  isSkillsBlock,
  isDeferredToolsBlock,
  isHooksBlock,
  isMcpBlock,
  isRelocatableBlock,
  isClearArtifact,
  rewriteOutputEfficiencyInstruction,
  normalizeOutputEfficiencyReplacement,
  normalizeSessionStartText,
  isContinueTrailerBlock,
  CONTINUE_TRAILER_TEXT,
  findDeferredToolsBlockInBody,
  deferredToolsSnapshotPath,
  DEFERRED_TOOLS_AVAILABLE_MARKER,
  DEFERRED_TOOLS_UNAVAILABLE_MARKER,
  computeStickyMessageHash,
  cacheControlStickyStatePath,
  updateCacheControlStickyState,
  applyCacheControlSticky,
  readCacheControlStickyState,
  writeCacheControlStickyState,
  CACHE_CONTROL_STICKY_MAX_POSITIONS,
  CACHE_CONTROL_STICKY_DEFAULT_MARKER,
  _pinnedBlocks,  // exported so tests can reset between runs
};
