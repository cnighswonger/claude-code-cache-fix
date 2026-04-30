// messages-cache-breakpoint — inject the missing breakpoint #3 cache_control
// at the boundary between Claude Code's auto-injected blocks (hooks, skills,
// project CLAUDE.md, deferred-tools, MCP server descriptions) and the first
// real user content inside `messages[0]`.
//
// Activation: `enabled: true` in extensions.json (always loaded), runtime
// gates per env var:
//
//   - CACHE_FIX_INJECT_MESSAGES_BREAKPOINT=1 → opt-in injection
//   - CACHE_FIX_DUMP_MESSAGES_HEAD=<path>    → diagnostic-only JSONL dump
//                                              of messages[0].content shape
//
// Order 410 — runs immediately after `cache-control-normalize` (400), so we
// count markers and place breakpoint #3 against a normalized baseline.
//
// See `docs/directives/proxy-messages-cache-breakpoint.md` for the full
// design (boundary detection algorithm, marker-count guard, telemetry surface).

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// --- Env gates (read per-call so tests can flip without re-importing) ---

function isInjectEnabled() {
  return process.env.CACHE_FIX_INJECT_MESSAGES_BREAKPOINT === "1";
}
function getDumpPath() {
  const v = process.env.CACHE_FIX_DUMP_MESSAGES_HEAD;
  return v && v.length > 0 ? v : null;
}
function isDebug() {
  return process.env.CACHE_FIX_DEBUG === "1";
}

function debug(msg) {
  if (isDebug()) process.stderr.write(`[messages-breakpoint] DEBUG: ${msg}\n`);
}

// --- Block classification ---
//
// Auto-injected block kinds that CC writes into `messages[0].content` ahead of
// the real user content. Order matters: each block runs through these checks
// in declaration order and the first match wins. Tightening notes:
//
//   - Hooks: requires both `<system-reminder>` opening AND `hook success`
//     substring — narrow enough that user prose discussing hook semantics
//     won't false-positive.
//   - Skills: anchored on `<system-reminder>` opening tag; won't match user
//     messages that quote `<available-skills>` from documentation.
//   - CLAUDE.md: regex anchored on absolute-path prefix (`/`); won't match
//     "see CLAUDE.md in the docs".
//   - Deferred-tools: exact `<deferred-tools>` tag substring; won't match
//     user prose about "deferred tools".
//   - MCP: two specific sentinels (`<mcp-resources>` tag OR
//     `Available MCP servers:` literal); won't match generic MCP prose.

const CLAUDE_MD_RE = /Contents of \/[^\n]*?CLAUDE\.md/;

function getBlockText(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type !== "text") return null;
  if (typeof block.text !== "string") return null;
  return block.text;
}

export function classifyBlock(block) {
  const text = getBlockText(block);
  if (text === null) return "user";

  // Hooks: <system-reminder> + "hook success"
  if (text.startsWith("<system-reminder>") && text.includes("hook success")) {
    return "hooks";
  }
  // Skills: <system-reminder> + (<available-skills> OR <plugin-skills>)
  if (
    text.startsWith("<system-reminder>") &&
    (text.includes("<available-skills>") || text.includes("<plugin-skills>"))
  ) {
    return "skills";
  }
  // Project CLAUDE.md: <system-reminder> wrapper + absolute-path Contents-of
  // marker. The system-reminder wrapper is required to keep user prose that
  // happens to mention "Contents of /path/to/CLAUDE.md" from matching.
  if (text.includes("<system-reminder>") && CLAUDE_MD_RE.test(text)) {
    return "claude_md";
  }
  // Deferred tools: exact <deferred-tools> tag
  if (text.includes("<deferred-tools>")) {
    return "deferred_tools";
  }
  // MCP: either sentinel
  if (text.includes("<mcp-resources>") || text.includes("Available MCP servers:")) {
    return "mcp_resources";
  }
  return "user";
}

const AUTO_INJECTED_KINDS = new Set([
  "hooks",
  "skills",
  "claude_md",
  "deferred_tools",
  "mcp_resources",
]);

// Return the LAST index in `content` whose block classifies as auto-injected,
// or -1 if no auto-injected block is found. Walking the full array (rather
// than stopping at the first user block) keeps us correct in the defensive
// case where auto-injected and user blocks are interleaved.
export function detectAutoInjectedBoundary(content) {
  if (!Array.isArray(content)) return -1;
  let lastIdx = -1;
  for (let i = 0; i < content.length; i++) {
    const kind = classifyBlock(content[i]);
    if (AUTO_INJECTED_KINDS.has(kind)) lastIdx = i;
  }
  return lastIdx;
}

// --- Marker counting ---

export function countAllCacheControlMarkers(body) {
  if (!body || typeof body !== "object") return 0;
  let n = 0;
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block && typeof block === "object" && block.cache_control) n++;
    }
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block && typeof block === "object" && block.cache_control) n++;
      }
    }
  }
  return n;
}

// --- Stats shape (also used as telemetry on ctx.meta) ---

function initStats() {
  return {
    enabled: true,
    injected: false,
    boundary_idx: -1,
    boundary_block_kind: null,
    blocks_examined: 0,
    existing_marker_count: 0,
    skip_reason: null,
  };
}

// --- Orchestrator (pure on body — no I/O) ---

export function injectMessagesBreakpoint(reqCtx) {
  const stats = initStats();
  if (!reqCtx || !reqCtx.body) {
    stats.skip_reason = "unexpected_role_or_shape";
    return stats;
  }
  const body = reqCtx.body;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    stats.skip_reason = "unexpected_role_or_shape";
    return stats;
  }
  const first = messages[0];
  if (!first || first.role !== "user" || !Array.isArray(first.content)) {
    stats.skip_reason = "unexpected_role_or_shape";
    return stats;
  }

  const existingMarkers = countAllCacheControlMarkers(body);
  stats.existing_marker_count = existingMarkers;

  if (existingMarkers === 0) {
    stats.skip_reason = "no_existing_markers";
    return stats;
  }
  if (existingMarkers >= 4) {
    stats.skip_reason = "at_marker_limit";
    if (existingMarkers > 4) {
      process.stderr.write(
        `[messages-breakpoint] warn: existing_markers=${existingMarkers} exceeds Anthropic's documented max of 4\n`,
      );
    }
    return stats;
  }

  stats.blocks_examined = first.content.length;
  const boundaryIdx = detectAutoInjectedBoundary(first.content);
  stats.boundary_idx = boundaryIdx;
  if (boundaryIdx === -1) {
    stats.skip_reason = "boundary_not_found";
    return stats;
  }

  const target = first.content[boundaryIdx];
  stats.boundary_block_kind = classifyBlock(target);

  if (target && target.cache_control) {
    stats.skip_reason = "boundary_already_marked";
    return stats;
  }

  first.content[boundaryIdx] = {
    ...target,
    cache_control: { type: "ephemeral", ttl: "1h" },
  };
  stats.injected = true;
  return stats;
}

// --- Diagnostic dump ---
//
// Dumps the structural shape of messages[0].content (per-block kind, first
// 200 chars of text, cache_control presence flag) to a JSONL file. Read-only
// — no body mutation. Independent of injection: a user can enable the dump
// without enabling injection to gather fixture data first.

const DUMP_TEXT_PREFIX_CHARS = 200;

export function buildDumpRecord(body, ts = new Date().toISOString()) {
  const messages = body?.messages;
  const first = Array.isArray(messages) ? messages[0] : null;
  const content = first && Array.isArray(first.content) ? first.content : null;
  const blocks = content
    ? content.map((block, idx) => {
        const kind = classifyBlock(block);
        const text = getBlockText(block);
        return {
          idx,
          type: block?.type ?? null,
          kind,
          text_prefix: text === null ? null : text.slice(0, DUMP_TEXT_PREFIX_CHARS),
          has_cache_control: !!(block && block.cache_control),
        };
      })
    : [];
  return {
    ts,
    role: first?.role ?? null,
    block_count: blocks.length,
    existing_marker_count: countAllCacheControlMarkers(body),
    blocks,
  };
}

async function writeDump(path, record) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
}

// --- Stderr summary ---

function emitStderrSummary(stats) {
  if (stats.injected) {
    process.stderr.write(
      `[messages-breakpoint] injected boundary_idx=${stats.boundary_idx} kind=${stats.boundary_block_kind} existing_markers=${stats.existing_marker_count}\n`,
    );
  } else {
    process.stderr.write(
      `[messages-breakpoint] skipped reason=${stats.skip_reason} existing_markers=${stats.existing_marker_count}\n`,
    );
  }
}

// --- Extension contract ---

export default {
  name: "messages-cache-breakpoint",
  description:
    "Inject the missing breakpoint #3 cache_control marker at the boundary " +
    "between Claude Code's auto-injected messages[0] blocks (hooks, skills, " +
    "CLAUDE.md, deferred-tools, MCP) and the first real user content",
  enabled: false, // overridden by extensions.json
  order: 410,

  async onRequest(ctx) {
    const dumpPath = getDumpPath();
    const inject = isInjectEnabled();

    // Both gates off → no-op. Avoid even building stats so the disabled path
    // is essentially free.
    if (!dumpPath && !inject) return;

    if (!ctx || !ctx.body) return;

    // Diagnostic dump runs first and is independent of injection. We dump
    // BEFORE injection so the recorded shape is the request as CC sent it,
    // not as we mutated it.
    if (dumpPath) {
      try {
        const record = buildDumpRecord(ctx.body);
        await writeDump(dumpPath, record);
      } catch (err) {
        debug(`dump write failed: ${err?.message ?? err}`);
      }
    }

    if (!inject) return;

    try {
      const stats = injectMessagesBreakpoint(ctx);
      ctx.meta = ctx.meta || {};
      ctx.meta.messagesBreakpointStats = stats;
      emitStderrSummary(stats);
    } catch (err) {
      debug(`onRequest unexpected: ${err?.message ?? err}`);
    }
  },
};
