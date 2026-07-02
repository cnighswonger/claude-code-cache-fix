// prefix-diff — diagnostic extension for hunting cache-bust sources.
//
// On every request, snapshots a small projection of the prefix (system
// prompt + tools + first 5 messages) and writes it to
// `~/.claude/cache-fix-snapshots/<key>-last.json`. If a prior snapshot
// exists and differs, also writes a `<key>-diff.json` and emits a
// one-line stderr summary.
//
// No request mutation. The diagnostic is fail-open: any I/O error is
// swallowed silently in production. Set CACHE_FIX_DEBUG=1 to also log
// swallowed errors so silent failures stay observable.
//
// Adaptation from preload's `snapshotPrefix(payload)` (preload.mjs ~1656):
// preload fired the diff once per process restart. The proxy is long-lived
// and supports hot-reload, so we drop the "first call" gate and run the
// diff per call. Trade-off: more disk writes, but each is tiny and the
// diagnostic value is higher (drift visible across every turn, not just
// at startup).

import {
  mkdir as _mkdir,
  readFile as _readFile,
  writeFile as _writeFile,
  rename as _rename,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { claudeHome } from "../claude-home.mjs";

const ENABLED = process.env.CACHE_FIX_PREFIXDIFF === "1";
const DEBUG = process.env.CACHE_FIX_DEBUG === "1";

const DEFAULT_FS = {
  mkdir: _mkdir,
  readFile: _readFile,
  writeFile: _writeFile,
  rename: _rename,
};

function getSnapshotDir() {
  return join(claudeHome(), "cache-fix-snapshots");
}

function debug(msg) {
  if (DEBUG) process.stderr.write(`[prefix-diff] ${msg}\n`);
}

function computeSessionKey(system) {
  return createHash("sha256")
    .update(JSON.stringify(system).slice(0, 2000))
    .digest("hex")
    .slice(0, 12);
}

function computeToolsHash(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "none";
  // Match preload behavior: hash unsorted tool names so order changes
  // surface as hash mismatches (a real cache-bust signal).
  return createHash("sha256")
    .update(JSON.stringify(tools.map((t) => t?.name ?? "")))
    .digest("hex")
    .slice(0, 16);
}

function computeSystemHash(system) {
  if (!system) return "none";
  return createHash("sha256")
    .update(JSON.stringify(system))
    .digest("hex")
    .slice(0, 16);
}

// Project the first 5 user/assistant messages: strip cache_control,
// truncate text >500 chars with `...[N chars]` marker. Pure: returns
// new objects, never mutates input.
function truncatePrefixMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(0, 5).map((msg) => {
    if (!msg || !Array.isArray(msg.content)) {
      return { role: msg?.role, content: msg?.content };
    }
    const cleanedContent = msg.content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const { cache_control, ...rest } = block;
      if (typeof rest.text === "string" && rest.text.length > 500) {
        return {
          ...rest,
          text: rest.text.slice(0, 500) + `...[${rest.text.length} chars]`,
        };
      }
      return rest;
    });
    return { role: msg.role, content: cleanedContent };
  });
}

function buildSnapshot(payload) {
  if (!payload || !payload.system) return null;
  return {
    timestamp: new Date().toISOString(),
    messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
    toolsHash: computeToolsHash(payload.tools),
    systemHash: computeSystemHash(payload.system),
    prefixMessages: truncatePrefixMessages(payload.messages),
  };
}

function computeDiff(prev, current) {
  const diff = {
    timestamp: current.timestamp,
    prevTimestamp: prev.timestamp,
    toolsMatch: prev.toolsHash === current.toolsHash,
    systemMatch: prev.systemHash === current.systemHash,
    messageCountPrev: prev.messageCount,
    messageCountNow: current.messageCount,
    prefixDiffs: [],
  };
  const prevMsgs = Array.isArray(prev.prefixMessages) ? prev.prefixMessages : [];
  const nowMsgs = Array.isArray(current.prefixMessages) ? current.prefixMessages : [];
  const maxIdx = Math.max(prevMsgs.length, nowMsgs.length);
  for (let i = 0; i < maxIdx; i++) {
    const prevSer = JSON.stringify(prevMsgs[i] ?? null);
    const nowSer = JSON.stringify(nowMsgs[i] ?? null);
    if (prevSer !== nowSer) {
      diff.prefixDiffs.push({
        index: i,
        prev: prevMsgs[i] ?? null,
        now: nowMsgs[i] ?? null,
      });
    }
  }
  return diff;
}

function diffHasChanges(diff) {
  return (
    diff.prefixDiffs.length > 0 ||
    !diff.toolsMatch ||
    !diff.systemMatch ||
    diff.messageCountPrev !== diff.messageCountNow
  );
}

// Atomic write: stage to a unique-per-invocation .tmp, then rename to
// final path. The unique suffix is essential under concurrency — two
// parallel callers writing to the same finalPath would otherwise share
// a single .tmp and corrupt each other's content.
//
// On rename failure the prior final-path file (if any) remains intact.
// The orphan .tmp persists on disk — because each invocation uses a
// unique temp name, later calls do NOT implicitly overwrite it. This is
// a small leak (accepted: failures are rare, files are tiny) rather than
// a correctness issue. A follow-up could add best-effort cleanup.
async function atomicWriteJson(finalPath, obj, fs) {
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(obj, null, 2));
  await fs.rename(tmpPath, finalPath);
}

/**
 * Snapshot the prefix of `payload` and diff against the prior snapshot.
 *
 * Pure-ish: never throws, never mutates `payload`. All I/O is gated by
 * try/catch; failures are debug-logged when CACHE_FIX_DEBUG=1.
 *
 * @param {object} payload  The request body (system, tools, messages).
 * @param {object} options
 * @param {string} [options.dir] Snapshot directory. Defaults to ~/.claude/cache-fix-snapshots.
 * @param {object} [options.fs]  fs/promises overrides for tests:
 *                               { mkdir, readFile, writeFile, rename }.
 *                               Any subset replaces the corresponding default.
 * @returns {Promise<{ key, wroteSnapshot, wroteDiff } | null>} Result for tests; null if no system.
 */
async function snapshotPrefix(payload, options = {}) {
  const current = buildSnapshot(payload);
  if (!current) return null;

  const dir = options.dir || getSnapshotDir();
  const fs = { ...DEFAULT_FS, ...(options.fs || {}) };

  const sessionKey = computeSessionKey(payload.system);
  const lastPath = join(dir, `${sessionKey}-last.json`);
  const diffPath = join(dir, `${sessionKey}-diff.json`);

  // Ensure directory exists. mkdir failure aborts — without dir, nothing
  // else can succeed.
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    debug(`mkdir failed for ${dir}: ${err?.message ?? err}`);
    return { key: sessionKey, wroteSnapshot: false, wroteDiff: false };
  }

  // Read prior snapshot if it exists. Missing file is normal; corrupt
  // file is treated as no prior (skip diff, proceed to overwrite).
  let prev = null;
  try {
    const txt = await fs.readFile(lastPath, "utf-8");
    prev = JSON.parse(txt);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      debug(`prior snapshot unreadable at ${lastPath}: ${err?.message ?? err}`);
    }
  }

  // Compute and write diff if anything changed.
  let wroteDiff = false;
  if (prev) {
    const diff = computeDiff(prev, current);
    if (diffHasChanges(diff)) {
      try {
        await atomicWriteJson(diffPath, diff, fs);
        wroteDiff = true;
        // Always log the summary line when a diff fires (not just under
        // CACHE_FIX_DEBUG) — this is the diagnostic's whole purpose.
        process.stderr.write(
          `[prefix-diff] ${sessionKey}: ${diff.prefixDiffs.length} differences, ` +
            `tools=${diff.toolsMatch ? "match" : "DIFFER"}, ` +
            `system=${diff.systemMatch ? "match" : "DIFFER"}, ` +
            `messages=${diff.messageCountPrev}→${diff.messageCountNow}\n`,
        );
      } catch (err) {
        debug(`diff write failed at ${diffPath}: ${err?.message ?? err}`);
      }
    }
  }

  // Always write the new snapshot atomically so the next call has a
  // fresh baseline. On failure, prior snapshot is intact.
  let wroteSnapshot = false;
  try {
    await atomicWriteJson(lastPath, current, fs);
    wroteSnapshot = true;
  } catch (err) {
    debug(`snapshot write failed at ${lastPath}: ${err?.message ?? err}`);
  }

  return { key: sessionKey, wroteSnapshot, wroteDiff };
}

// The named exports below are internal test seams, not part of the
// proxy extension contract. Pipeline loading consumes only `default`.
// They're exposed so tests can call the helpers directly with their own
// options (tmpdir, failing fs mocks) instead of mutating process env or
// monkey-patching node:fs/promises at module scope.
export {
  snapshotPrefix,
  buildSnapshot,
  computeDiff,
  computeSessionKey,
  truncatePrefixMessages,
  diffHasChanges,
};

export default {
  name: "prefix-diff",
  description:
    "Snapshot prefix (first 5 msgs + system + tools) and diff against previous run for cache-bust hunting",
  // Always loaded; gated at runtime by CACHE_FIX_PREFIXDIFF=1 inside onRequest.
  // This matches the acceptance criteria (env var alone activates) — the
  // extension is cheap to load (one no-op check per request when disabled).
  enabled: true,
  order: 680,

  async onRequest(ctx) {
    if (!ENABLED) return;
    if (!ctx || !ctx.body) return;
    // snapshotPrefix never throws; double-belt try/catch is defense in depth.
    try {
      await snapshotPrefix(ctx.body);
    } catch (err) {
      debug(`onRequest unexpected: ${err?.message ?? err}`);
    }
  },
};
