// upstream-change-detection — read-only structural fingerprinter that
// detects when Anthropic ships CC updates that change the structural shape
// of /v1/messages requests. Per-namespace baseline persists across proxy
// restarts to prevent false-positive floods.
//
// Output:
//   - stderr line prefixed [upstream-change] for proxy journals/logs
//   - ~/.claude/upstream-changes.jsonl (event log: baseline_established,
//     structural_change)
//   - ~/.claude/upstream-baseline.json (per-namespace baseline, atomic
//     full replace)
//
// Activation: `enabled: true` in extensions.json (always loaded), gated at
// runtime by `CACHE_FIX_UPSTREAM_DETECTION=1`. Prefix-diff pattern.
//
// Privacy: every persisted field is a count, position, boolean, bucket
// label, or hash of stable identifiers. NO prompt content, NO file paths,
// NO message text. Test #18 enforces this at unit level.
//
// See `docs/directives/proxy-upstream-change-detection.md` for full design.

import {
  mkdir as _mkdir,
  readFile as _readFile,
  writeFile as _writeFile,
  rename as _rename,
  unlink as _unlink,
  appendFile as _appendFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { claudeHome } from "../claude-home.mjs";

// --- Allowlists ---
//
// New entries are signal: when a request's text contains a marker / tag we
// haven't seen before, the boolean unknown-detector flips. Add entries here
// only when investigation has confirmed the new item is legitimate
// (genuine CC change, not an exploit attempt).

const KNOWN_SECTION_MARKERS = [
  "# Environment",
  "# System",
  "# Tools",
  "# Personality",
  "# Settings",
  "# Memory",
  "# Output efficiency",
  "# auto memory",
  "# Doing tasks",
  "# Tone and style",
  "# Using your tools",
  "# Text output",
  "# Session-specific guidance",
  "# Code references",
  "# Executing actions with care",
];

const KNOWN_REMINDER_PATTERNS = [
  "<system-reminder>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<git-status>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<command-stdout>",
  "<command-stderr>",
  "<file-attachment>",
];

const SECTION_MARKER_SHAPE = /^# [A-Z][a-zA-Z ]{1,30}$/m;
const REMINDER_TAG_SHAPE = /<[a-z][a-z-]{1,30}>/;

// --- Env gates (per-call to ease test isolation) ---

function isEnabled() {
  return process.env.CACHE_FIX_UPSTREAM_DETECTION === "1";
}
function isQuiet() {
  return process.env.CACHE_FIX_UPSTREAM_QUIET === "1";
}
function isDebug() {
  return process.env.CACHE_FIX_DEBUG === "1";
}

function debug(msg) {
  if (isDebug()) process.stderr.write(`[upstream-change] DEBUG: ${msg}\n`);
}

// --- Default fs (overridable for tests) ---

const DEFAULT_FS = {
  mkdir: _mkdir,
  readFile: _readFile,
  writeFile: _writeFile,
  rename: _rename,
  unlink: _unlink,
  appendFile: _appendFile,
};

// --- Module-scope state ---

let _namespaceMap = new Map();
let _baselineLoadedFrom = null;

export function _resetForTest() {
  _namespaceMap = new Map();
  _baselineLoadedFrom = null;
}

function getOutputDir() {
  return process.env.CACHE_FIX_UPSTREAM_DIR || claudeHome();
}

function getBaselinePath(dir) {
  return join(dir || getOutputDir(), "upstream-baseline.json");
}

function getJsonlPath(dir) {
  return join(dir || getOutputDir(), "upstream-changes.jsonl");
}

// --- Pure helpers ---

function sha16(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function bucketBlockSize(size) {
  if (size < 200) return "tiny";
  if (size < 2000) return "small";
  if (size < 20000) return "medium";
  return "large";
}

export function bucketMaxTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "unset";
  if (n < 1024) return "tiny";
  if (n < 8192) return "1k-8k";
  if (n < 32768) return "8k-32k";
  if (n < 100000) return "32k-100k";
  return "huge";
}

export function matchKnownSectionMarkers(text) {
  if (typeof text !== "string" || !text) return [];
  // Strict line-based match. The marker must be the ENTIRE line (after split),
  // otherwise "# Environment Details" would falsely match "# Environment" and
  // we would record an allowlist index for a marker that didn't actually
  // appear as a section header.
  const lineSet = new Set(text.split("\n"));
  const indices = [];
  for (let i = 0; i < KNOWN_SECTION_MARKERS.length; i++) {
    if (lineSet.has(KNOWN_SECTION_MARKERS[i])) indices.push(i);
  }
  return indices;
}

export function hasUnknownSectionMarker(text) {
  if (typeof text !== "string" || !text) return false;
  // Find candidate markers via the shape regex on each line.
  const lines = text.split("\n");
  for (const line of lines) {
    if (SECTION_MARKER_SHAPE.test(line) && !KNOWN_SECTION_MARKERS.includes(line)) {
      return true;
    }
  }
  return false;
}

export function matchKnownReminderPatterns(text) {
  if (typeof text !== "string" || !text) return [];
  const indices = [];
  for (let i = 0; i < KNOWN_REMINDER_PATTERNS.length; i++) {
    if (text.includes(KNOWN_REMINDER_PATTERNS[i])) indices.push(i);
  }
  return indices;
}

export function hasUnknownReminderPattern(text) {
  if (typeof text !== "string" || !text) return false;
  const matches = text.matchAll(/<[a-z][a-z-]{1,30}>/g);
  for (const m of matches) {
    if (!KNOWN_REMINDER_PATTERNS.includes(m[0])) return true;
  }
  return false;
}

export function namespaceKey(model, betaHeadersArr) {
  const sorted = Array.isArray(betaHeadersArr) ? [...betaHeadersArr].sort() : [];
  return sha16(`${model || ""}|${sorted.join(",")}`);
}

// Beta features arrive on the `anthropic-beta` REQUEST HEADER (Node http
// header keys are lowercased). The proxy surfaces request headers on
// `ctx.headers` to onRequest hooks. The function accepts the headers map
// (case-insensitive lookup) and falls back to body.anthropic_beta only as
// a defensive fallback for edge cases where a caller pre-merged it.
export function extractBetaHeaders(headers, body) {
  const fromHeader = headers && (headers["anthropic-beta"] || headers["Anthropic-Beta"] || headers["ANTHROPIC-BETA"]);
  let raw = fromHeader;
  if (!raw) raw = body?.anthropic_beta;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function blockTextLength(block) {
  if (!block || typeof block !== "object") return 0;
  if (typeof block.text === "string") return block.text.length;
  if (typeof block.content === "string") return block.content.length;
  return 0;
}

function blockText(block) {
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return "";
}

function countCacheControlInArray(arr) {
  if (!Array.isArray(arr)) return { count: 0, positions: [] };
  const positions = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (item && typeof item === "object" && item.cache_control) {
      positions.push(i);
    }
  }
  return { count: positions.length, positions };
}

function fingerprintSystem(system) {
  const blocks = Array.isArray(system) ? system : [];
  const types = blocks.map((b) => (b && typeof b === "object" && typeof b.type === "string" ? b.type : "unknown"));
  const sizes = blocks.map((b) => bucketBlockSize(blockTextLength(b)));
  const cc = countCacheControlInArray(blocks);

  const knownIndicesSet = new Set();
  let unknownPresent = false;
  for (const b of blocks) {
    const text = blockText(b);
    for (const idx of matchKnownSectionMarkers(text)) knownIndicesSet.add(idx);
    if (!unknownPresent && hasUnknownSectionMarker(text)) unknownPresent = true;
  }
  const knownIndicesSorted = [...knownIndicesSet].sort((a, b) => a - b);

  return {
    block_count: blocks.length,
    block_types_in_order: types,
    block_size_buckets: sizes,
    known_section_marker_set_hash: sha16(knownIndicesSorted.join(",")),
    known_section_marker_count: knownIndicesSorted.length,
    unknown_section_marker_present: unknownPresent,
    cache_control_count: cc.count,
    cache_control_positions: cc.positions,
  };
}

function fingerprintTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return {
      count: 0,
      names_sorted_hash: sha16(""),
      schema_shape_hash: sha16(""),
    };
  }
  const names = tools.map((t) => (t && typeof t.name === "string" ? t.name : "")).sort();
  // Build name → sorted-param-keys map deterministically.
  const shape = {};
  for (const t of tools) {
    if (!t || typeof t.name !== "string") continue;
    const props = t.input_schema?.properties;
    const keys = props && typeof props === "object" ? Object.keys(props).sort() : [];
    shape[t.name] = keys;
  }
  const shapeOrdered = {};
  for (const k of Object.keys(shape).sort()) shapeOrdered[k] = shape[k];

  return {
    count: tools.length,
    names_sorted_hash: sha16(JSON.stringify(names)),
    schema_shape_hash: sha16(JSON.stringify(shapeOrdered)),
  };
}

function fingerprintMessages(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  let cc = 0;
  const knownSet = new Set();
  let unknownPresent = false;

  for (const msg of arr) {
    if (!msg || typeof msg !== "object") continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === "object" && block.cache_control) cc++;
        const text = blockText(block);
        for (const idx of matchKnownReminderPatterns(text)) knownSet.add(idx);
        if (!unknownPresent && hasUnknownReminderPattern(text)) unknownPresent = true;
      }
    } else if (typeof msg.content === "string") {
      for (const idx of matchKnownReminderPatterns(msg.content)) knownSet.add(idx);
      if (!unknownPresent && hasUnknownReminderPattern(msg.content)) unknownPresent = true;
    }
  }

  const knownSorted = [...knownSet].sort((a, b) => a - b);
  return {
    count: arr.length,
    first_role: arr[0]?.role || null,
    cache_control_count_in_messages: cc,
    known_reminder_pattern_set_hash: sha16(knownSorted.join(",")),
    known_reminder_pattern_count: knownSorted.length,
    unknown_reminder_pattern_present: unknownPresent,
  };
}

function fingerprintRequestExtras(body) {
  return {
    has_thinking: !!body?.thinking,
    has_metadata: !!body?.metadata,
    stream: body?.stream === true,
    max_tokens_bucket: bucketMaxTokens(body?.max_tokens),
  };
}

// Compute a structural fingerprint. `headers` is the request headers map
// (case-insensitive lookup is internal); pass `{}` if not available.
export function computeFingerprint(body, headers = {}) {
  const safeBody = body && typeof body === "object" ? body : {};
  const beta = extractBetaHeaders(headers, safeBody);
  return {
    version: 1,
    namespace: {
      model: typeof safeBody.model === "string" ? safeBody.model : "",
      beta_headers_sorted_hash: sha16([...beta].sort().join(",")),
      beta_headers_count: beta.length,
    },
    system: fingerprintSystem(safeBody.system),
    tools: fingerprintTools(safeBody.tools),
    messages: fingerprintMessages(safeBody.messages),
    request_extras: fingerprintRequestExtras(safeBody),
  };
}

// Diff two fingerprints. Returns array of { path, from, to } entries. Equality
// is structural (deep). Arrays are compared by JSON stringification.
export function diffFingerprints(prev, current) {
  const diff = [];
  if (!prev || !current) return diff;
  walk("", prev, current, diff);
  return diff;
}

function walk(prefix, a, b, out) {
  if (a === b) return;
  if (typeof a !== typeof b) {
    out.push({ path: prefix, from: a, to: b });
    return;
  }
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || a === null || b === null) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ path: prefix, from: a, to: b });
    }
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const subPath = prefix ? `${prefix}.${k}` : k;
    walk(subPath, a[k], b[k], out);
  }
}

// --- Persistence ---

async function loadBaseline(fs = DEFAULT_FS, dir = getOutputDir()) {
  const path = getBaselinePath(dir);
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.namespaces && typeof parsed.namespaces === "object") {
      _namespaceMap = new Map(Object.entries(parsed.namespaces));
      _baselineLoadedFrom = path;
      return _namespaceMap;
    }
  } catch (err) {
    debug(`baseline load failed (${path}): ${err?.message ?? err}`);
  }
  _namespaceMap = new Map();
  return _namespaceMap;
}

async function persistBaseline(fs = DEFAULT_FS, dir = getOutputDir()) {
  const finalPath = getBaselinePath(dir);
  const tmpSuffix = `${process.pid}.${Date.now()}.${randomBytes(2).toString("hex")}`;
  const tmpPath = `${finalPath}.tmp.${tmpSuffix}`;
  const doc = {
    version: 1,
    namespaces: Object.fromEntries(_namespaceMap),
  };
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(doc));
    await fs.rename(tmpPath, finalPath);
  } finally {
    try { await fs.unlink(tmpPath); } catch {}
  }
}

async function appendEvent(record, fs = DEFAULT_FS, dir = getOutputDir()) {
  const path = getJsonlPath(dir);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path, JSON.stringify(record) + "\n");
}

// Test seam: bypass module-scope state and operate on a caller-supplied map.
export async function processRequestForTest(body, { dir, map = _namespaceMap, fs = DEFAULT_FS, headers = {} } = {}) {
  return _processRequest(body, headers, { dir, map, fs });
}

async function _processRequest(body, headers, { dir, map, fs }) {
  const fingerprint = computeFingerprint(body, headers);
  const nsKey = namespaceKey(fingerprint.namespace.model, extractBetaHeaders(headers, body));
  const ts = new Date().toISOString();

  const existing = map.get(nsKey);
  if (!existing) {
    const entry = {
      namespace: fingerprint.namespace,
      fingerprint,
      established_at: ts,
      last_updated_at: ts,
      update_count: 0,
    };
    map.set(nsKey, entry);
    await appendEvent(
      { ts, event: "baseline_established", namespace: fingerprint.namespace, fingerprint },
      fs,
      dir,
    );
    return { event: "baseline_established", nsKey };
  }

  if (JSON.stringify(existing.fingerprint) === JSON.stringify(fingerprint)) {
    return { event: "noop", nsKey };
  }

  const diff = diffFingerprints(existing.fingerprint, fingerprint);
  const previous = existing.fingerprint;
  const updated = {
    namespace: fingerprint.namespace,
    fingerprint,
    established_at: existing.established_at,
    last_updated_at: ts,
    update_count: (existing.update_count || 0) + 1,
  };
  map.set(nsKey, updated);

  await appendEvent(
    {
      ts,
      event: "structural_change",
      namespace: fingerprint.namespace,
      diff,
      previous,
      current: fingerprint,
    },
    fs,
    dir,
  );

  return { event: "structural_change", nsKey, diff };
}

function formatStderrLine({ ts, namespace, diff }) {
  const head = `[upstream-change] ${ts} model=${namespace.model || "?"} beta=${namespace.beta_headers_count}`;
  const summary = diff
    .slice(0, 6)
    .map((d) => `${d.path}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`)
    .join("; ");
  const more = diff.length > 6 ? ` (+${diff.length - 6} more)` : "";
  return `${head} :: ${summary}${more}`;
}

// --- Extension contract ---

export default {
  name: "upstream-change-detection",
  description:
    "Detect structural changes in CC-originated /v1/messages requests via per-namespace fingerprint",
  enabled: true,
  order: 50,

  async onRequest(ctx) {
    if (!isEnabled()) return;
    if (!ctx || !ctx.body) return;

    try {
      const dir = getOutputDir();
      const fs = DEFAULT_FS;
      // Lazy-load baseline on first call after module load.
      if (_baselineLoadedFrom === null) {
        await loadBaseline(fs, dir);
        _baselineLoadedFrom = getBaselinePath(dir);
      }
      const result = await _processRequest(ctx.body, ctx.headers || {}, { dir, map: _namespaceMap, fs });
      // Persist baseline whenever it changed.
      if (result.event === "baseline_established" || result.event === "structural_change") {
        await persistBaseline(fs, dir);
      }
      if (result.event === "structural_change" && !isQuiet()) {
        const ts = new Date().toISOString();
        const namespace = _namespaceMap.get(result.nsKey)?.namespace;
        process.stderr.write(formatStderrLine({ ts, namespace: namespace || {}, diff: result.diff }) + "\n");
      }
    } catch (err) {
      debug(`onRequest unexpected: ${err?.message ?? err}`);
    }
  },
};

// Expose internals for testing.
export {
  loadBaseline,
  persistBaseline,
  appendEvent,
  formatStderrLine,
  _namespaceMap as __testNamespaceMap,
};
