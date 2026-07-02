// deferred-tools-restore — preserve cache prefix across MCP reconnect race.
//
// PROBLEM (mirrored from preload.mjs ~429-518):
// On `claude --continue`, if MCP servers haven't finished reconnecting before
// CC fires the first post-resume request, the
//   <system-reminder>The following deferred tools are now available via ToolSearch…</system-reminder>
// block at msg[0] (or wherever the attachment lands post-compaction) shrinks
// dramatically. ~40 tools collapse to a handful of CC built-ins, and CC
// injects a trailing
//   "The following deferred tools are no longer available (their MCP server
//    disconnected). Do not search for them — ToolSearch will return no match:"
// notice. That block change at the root of the message array busts the cache
// at the very top — the entire ~940K prompt re-caches.
//
// FIX: Persist the clean (no-UNAVAILABLE-marker) form of the block. On a
// subsequent request where the block has shrunk and contains the UNAVAILABLE
// marker, substitute the persisted full bytes. Restore only if the snapshot
// is STRICTLY LONGER than the current block — never downgrade to a stale
// shorter snapshot.
//
// SNAPSHOT KEY (proxy-specific adaptation):
// Preload uses process.cwd() because each preload runs in the CC process,
// where cwd identifies the project. The proxy is a long-lived daemon; its
// cwd is shared across all CC sessions on the host. To key per-project, the
// proxy parses the cwd OUT of the system prompt content (CC injects
// " - Primary working directory: <path>" in the # Environment section) and
// keys on sha1("cwd:" + that path). Verified empirically against CC v2.1.117.
//
// FAIL-OPEN: If the cwd marker is absent (CC format drift, missing system
// prompt), the extension no-ops the request entirely. Result: status quo
// cache-bust, never silently restores the wrong block.

import {
  mkdir as _mkdir,
  readFile as _readFile,
  writeFile as _writeFile,
  rename as _rename,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { claudeHome } from "../claude-home.mjs";

const SKIP = process.env.CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE === "1";
const DEBUG = process.env.CACHE_FIX_DEBUG === "1";

const AVAILABLE_MARKER =
  "The following deferred tools are now available via ToolSearch";
const UNAVAILABLE_MARKER =
  "The following deferred tools are no longer available";

const DEFAULT_FS = {
  mkdir: _mkdir,
  readFile: _readFile,
  writeFile: _writeFile,
  rename: _rename,
};

function getSnapshotDir() {
  return join(claudeHome(), "cache-fix-state");
}

function debug(msg) {
  if (DEBUG) process.stderr.write(`[deferred-tools-restore] ${msg}\n`);
}

/**
 * Extract the working-directory path from CC's system prompt.
 * Returns the parsed path string, or null if the marker is not found OR
 * the prompt structure is ambiguous (multiple valid env sections).
 *
 * STRICT STRUCTURAL PARSER (line-based, not regex-window):
 *
 * Recognizes a valid # Environment section ONLY when ALL of these hold:
 *   1. A line that is exactly `# Environment` (whitespace-trimmed)
 *   2. The next non-blank line is exactly the CC intro line:
 *      `You have been invoked in the following environment:`
 *   3. The marker appears in a bullet line (`- Primary working directory: ...`)
 *      within the bullet list immediately following the intro line — bounded
 *      by the first blank line or first non-bullet line.
 *
 * Only the conjunction of all three rejects the false positives Codex flagged:
 *   - bare `# Environment` mention in narrative/code (fails rule 2)
 *   - code-fenced `Primary working directory:` example without the env header
 *     (fails rule 1)
 *   - a fake marker line elsewhere in the same block but not in a bullet
 *     list immediately following the intro (fails rule 3)
 *
 * AMBIGUITY GUARD: if MULTIPLE distinct valid env sections produce different
 * cwd values (across blocks or within one block), refuse to pick — return
 * null. The fail-open path (extension no-ops the request) is strictly safer
 * than restoring with the wrong snapshot key.
 *
 * Accepts:
 *   - array of content blocks (CC's normal shape): walks .text fields in order
 *   - a single string (rare; older clients): scans directly
 *   - anything else: returns null
 */
const ENV_HEADER_LINE = "# Environment";
const ENV_INTRO_LINE = "You have been invoked in the following environment:";
const CWD_BULLET_RE = /^-\s+Primary working directory:\s*(.+?)\s*$/;

function parseAllCwdsFromBlock(text) {
  const found = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== ENV_HEADER_LINE) continue;
    // Skip blank lines after the header (CC emits exactly one intro line
    // immediately following, but be tolerant of whitespace).
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length) continue;
    if (lines[j].trim() !== ENV_INTRO_LINE) continue;
    // Walk the bullet list following the intro line; first cwd bullet wins
    // for this section. A blank line or non-bullet line ends the section.
    for (let k = j + 1; k < lines.length; k++) {
      const trimmed = lines[k].trimStart();
      if (lines[k].trim() === "") break;
      if (!trimmed.startsWith("-")) break;
      const m = trimmed.match(CWD_BULLET_RE);
      if (m && m[1]) {
        found.push(m[1]);
        break;
      }
    }
  }
  return found;
}

function extractCwdFromSystem(system) {
  if (!system) return null;
  const texts = [];
  if (typeof system === "string") {
    texts.push(system);
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (block && typeof block === "object" && typeof block.text === "string") {
        texts.push(block.text);
      }
    }
  } else {
    return null;
  }
  const seen = new Set();
  for (const t of texts) {
    const matches = parseAllCwdsFromBlock(t);
    for (const m of matches) {
      seen.add(m);
      if (seen.size > 1) return null; // ambiguous → no-op
    }
  }
  if (seen.size === 1) return [...seen][0];
  return null;
}

function deriveSnapshotKey(cwd) {
  return createHash("sha1").update(`cwd:${cwd}`).digest("hex").slice(0, 16);
}

/**
 * Locate the deferred-tools attachment block in body.messages.
 * Only inspects user messages (skips assistant so the agent quoting the
 * AVAILABLE marker verbatim doesn't trigger a false match).
 * Returns { msgIdx, blockIdx, text } or null.
 */
function findDeferredToolsBlockInBody(body) {
  if (!body || !Array.isArray(body.messages)) return null;
  for (let m = 0; m < body.messages.length; m++) {
    const msg = body.messages[m];
    if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let i = 0; i < msg.content.length; i++) {
      const b = msg.content[i];
      if (
        b &&
        b.type === "text" &&
        typeof b.text === "string" &&
        b.text.includes(AVAILABLE_MARKER)
      ) {
        return { msgIdx: m, blockIdx: i, text: b.text };
      }
    }
  }
  return null;
}

// Atomic write (same lesson as prefix-diff): unique tmp per invocation so
// concurrent calls don't collide on a shared .tmp path.
async function atomicWriteText(finalPath, data, fs) {
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`;
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, finalPath);
}

/**
 * Persist a snapshot of the clean deferred-tools block.
 *
 * @param {string} text  The full block text to persist.
 * @param {object} options
 * @param {string} options.dir  Snapshot directory.
 * @param {string} options.key  Snapshot key (from deriveSnapshotKey).
 * @param {object} [options.fs] fs/promises overrides for tests.
 * @returns {Promise<{persisted: boolean, bytes: number, path: string}>}
 */
async function persistDeferredTools(text, options) {
  const dir = options.dir;
  const key = options.key;
  const fs = { ...DEFAULT_FS, ...(options.fs || {}) };
  const path = join(dir, `deferred-tools-${key}.txt`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteText(path, text, fs);
    return { persisted: true, bytes: Buffer.byteLength(text, "utf-8"), path };
  } catch (err) {
    debug(`persist failed at ${path}: ${err?.message ?? err}`);
    return { persisted: false, bytes: 0, path };
  }
}

/**
 * Read and validate a snapshot. Returns the snapshot text on success, null
 * otherwise. Validation:
 *  - file exists and is readable
 *  - byte length >= AVAILABLE_MARKER length (sanity floor)
 *  - content contains the AVAILABLE marker (defense in depth against a
 *    truncated-but-readable file passing only the length check)
 */
async function restoreDeferredTools(options) {
  const dir = options.dir;
  const key = options.key;
  const fs = { ...DEFAULT_FS, ...(options.fs || {}) };
  const path = join(dir, `deferred-tools-${key}.txt`);
  let snapshot;
  try {
    snapshot = await fs.readFile(path, "utf-8");
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      debug(`snapshot read failed at ${path}: ${err?.message ?? err}`);
    }
    return null;
  }
  if (typeof snapshot !== "string") return null;
  if (snapshot.length < AVAILABLE_MARKER.length) {
    debug(`snapshot rejected (too short: ${snapshot.length} bytes) at ${path}`);
    return null;
  }
  if (!snapshot.includes(AVAILABLE_MARKER)) {
    debug(`snapshot rejected (missing AVAILABLE marker) at ${path}`);
    return null;
  }
  // Defense in depth: persisted snapshots should be clean by construction
  // (we only persist when !hasUnavail), but if a snapshot ever contains the
  // UNAVAILABLE marker we refuse to restore it — restoring a "no longer
  // available" block would be worse than no restore.
  if (snapshot.includes(UNAVAILABLE_MARKER)) {
    debug(`snapshot rejected (contains UNAVAILABLE marker, not a clean baseline) at ${path}`);
    return null;
  }
  return snapshot;
}

export {
  extractCwdFromSystem,
  deriveSnapshotKey,
  findDeferredToolsBlockInBody,
  persistDeferredTools,
  restoreDeferredTools,
  AVAILABLE_MARKER,
  UNAVAILABLE_MARKER,
};

export default {
  name: "deferred-tools-restore",
  description:
    "Persist and restore the deferred-tools attachment block across sessions to prevent MCP-reconnect-race cache busts at resume time",
  enabled: true,
  order: 350,

  async onRequest(ctx) {
    if (SKIP) return;
    if (!ctx || !ctx.body) return;
    const body = ctx.body;

    // 1. Parse cwd from system. No marker → no-op (honest degradation).
    const cwd = extractCwdFromSystem(body.system);
    if (!cwd) {
      ctx.meta = ctx.meta || {};
      ctx.meta.deferredToolsRestoreStats = { action: "skipped", reason: "no-cwd" };
      return;
    }
    const key = deriveSnapshotKey(cwd);

    // 2-4. Locate the deferred-tools block.
    const found = findDeferredToolsBlockInBody(body);
    if (!found) {
      ctx.meta = ctx.meta || {};
      ctx.meta.deferredToolsRestoreStats = { action: "skipped", reason: "no-block", key };
      return;
    }

    const dir = getSnapshotDir();
    const hasUnavail = found.text.includes(UNAVAILABLE_MARKER);

    if (!hasUnavail) {
      // 5. Clean baseline → persist.
      const result = await persistDeferredTools(found.text, { dir, key });
      ctx.meta = ctx.meta || {};
      ctx.meta.deferredToolsRestoreStats = {
        action: result.persisted ? "persisted" : "skipped",
        bytes: result.bytes,
        key,
      };
      if (result.persisted) {
        process.stderr.write(
          `[deferred-tools-restore] persisted ${result.bytes} bytes (key=${key})\n`,
        );
      }
      return;
    }

    // 6. Block has UNAVAILABLE marker → attempt restore.
    const snapshot = await restoreDeferredTools({ dir, key });
    if (!snapshot) {
      ctx.meta = ctx.meta || {};
      ctx.meta.deferredToolsRestoreStats = { action: "skipped", reason: "no-snapshot", key };
      return;
    }

    // Strictly-longer guard. Equal-length snapshots are not restored.
    if (snapshot.length <= found.text.length) {
      ctx.meta = ctx.meta || {};
      ctx.meta.deferredToolsRestoreStats = {
        action: "skipped",
        reason: "snapshot-not-longer",
        key,
        snapshotBytes: snapshot.length,
        currentBytes: found.text.length,
      };
      return;
    }

    // Substitute. Build new content array and new message; do not mutate
    // the original arrays / objects.
    const targetMsg = body.messages[found.msgIdx];
    const newContent = targetMsg.content.slice();
    newContent[found.blockIdx] = { ...newContent[found.blockIdx], text: snapshot };
    body.messages[found.msgIdx] = { ...targetMsg, content: newContent };

    ctx.meta = ctx.meta || {};
    ctx.meta.deferredToolsRestoreStats = {
      action: "restored",
      bytes: snapshot.length,
      previousBytes: found.text.length,
      key,
    };
    process.stderr.write(
      `[deferred-tools-restore] restored ${found.text.length}→${snapshot.length} bytes ` +
        `at msg[${found.msgIdx}].content[${found.blockIdx}] (key=${key})\n`,
    );
  },
};
