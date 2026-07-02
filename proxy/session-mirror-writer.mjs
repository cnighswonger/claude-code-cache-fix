import { appendFileSync, statSync, mkdirSync, readdirSync, unlinkSync, rmdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { sessionFilename } from "./extensions/cache-telemetry.mjs";
import { claudeHome } from "./claude-home.mjs";

// Directive: docs/directives/proxy-jsonl-session-mirror.md
// Storage root: ~/.claude/session-mirrors/<sessionFilename(sessionId)>/<timestamp>.jsonl
// (NOT ~/.cache-fix-proxy/ — established convention is all proxy artifacts
// live under ~/.claude/ per Fable round 1 B5 finding.)

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
const EVENT_LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const SWEEP_THROTTLE_MS = 60_000;

function mirrorRoot() {
  return process.env.CACHE_FIX_SESSION_MIRROR_DIR ||
    join(claudeHome(), "session-mirrors");
}

function eventLogPath() {
  return process.env.CACHE_FIX_SESSION_MIRROR_EVENT_LOG ||
    join(mirrorRoot(), "session-mirror-events.jsonl");
}

function maxBytes() {
  const raw = parseInt(process.env.CACHE_FIX_SESSION_MIRROR_MAX_BYTES, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

function retentionMs() {
  const raw = parseInt(process.env.CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS, 10);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
  return days * 86_400_000;
}

// Per-session active-file state: { activeFile, sweepLastMs }. Module-scope so
// multiple writes against the same session reuse the file path without restating.
const sessionState = new Map();

function sessionDir(sessionId) {
  return join(mirrorRoot(), sessionFilename(sessionId));
}

let filenameCounter = 0;
function newActiveFile(sessionId) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  // Counter guards against rapid-succession opens (rotation tests, real
  // bursts) producing identical millisecond-resolution timestamps that would
  // collide and silently overwrite the older file.
  const seq = (filenameCounter++).toString(36);
  return join(sessionDir(sessionId), `${ts}-${seq}.jsonl`);
}

function getActiveFile(sessionId) {
  let state = sessionState.get(sessionId);
  if (!state) {
    state = { activeFile: newActiveFile(sessionId), sweepLastMs: 0, rotationCount: 0 };
    sessionState.set(sessionId, state);
    // Per directive § PII discipline: emit an "open" event when first opening
    // the file for a session. Scalar surface — session id + event only.
    logEvent({ event: "open", session_id: sessionId });
  }
  return state.activeFile;
}

function rotateIfFull(sessionId) {
  const state = sessionState.get(sessionId);
  if (!state) return;
  let size = 0;
  try { size = statSync(state.activeFile).size; } catch { return; }
  if (size < maxBytes()) return;
  state.activeFile = newActiveFile(sessionId);
  // Scalar-surface contract: log session id + rotation count + bytes only.
  // No file paths (operator can infer; carrying them risks leakage to log
  // consumers and bloats the line). Codex round-1 attention #2 follow-through.
  state.rotationCount = (state.rotationCount || 0) + 1;
  logEvent({ event: "rotate", session_id: sessionId, rotation: state.rotationCount, bytes: size });
}

// Single-tier rotation matching bootstrap-defense.rotateIfNeeded. Any
// previous .1 is overwritten — the event log is a forward-looking signal
// feed, not an archival record.
function rotateEventLogIfNeeded(path) {
  let size = 0;
  try { size = statSync(path).size; } catch { return; }
  if (size < EVENT_LOG_ROTATE_BYTES) return;
  try { renameSync(path, `${path}.1`); } catch {}
}

// Allowed scalar fields per the directive's PII discipline: timestamp + event
// + session_id + rotation + bytes + unlinked + error_class. NEVER paths,
// raw error messages, image bytes, prompt content, or auth headers. Callers
// must pass scalar values only; anything outside this allow-list is dropped.
const EVENT_LOG_ALLOWED_FIELDS = new Set([
  "timestamp", "event", "session_id", "rotation", "bytes", "unlinked", "error_class",
]);

function sanitizeEventRecord(record) {
  const out = { timestamp: new Date().toISOString() };
  for (const [k, v] of Object.entries(record || {})) {
    if (!EVENT_LOG_ALLOWED_FIELDS.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue; // scalars only
    if (typeof v === "string" && v.length > 64) continue; // tight bound; session ids fit
    out[k] = v;
  }
  return out;
}

// PII-safe event-log writer for session-mirror operational events (open /
// rotate / sweep / error). Carries session id, timestamps, action, byte
// counts — never image bytes, never prompt content, never auth headers,
// never file paths, never raw error messages.
function logEvent(record) {
  const path = eventLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateEventLogIfNeeded(path);
    appendFileSync(path, JSON.stringify(sanitizeEventRecord(record)) + "\n");
  } catch (err) {
    process.stderr.write(`[session-mirror-writer] event-log write failed: ${err.message}\n`);
  }
}

// Write a batch of records to the session's active file. Records are
// pre-shaped (envelope already built); writer concatenates them as a single
// appendFileSync call so a crash mid-write either persists all or none.
// Returns the number of bytes written; throws on filesystem error so the
// caller (the extension) can handle / log it.
export function writeRecordsSync(sessionId, records) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  rotateIfFull(sessionId);
  const path = getActiveFile(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const payload = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(path, payload);
  return Buffer.byteLength(payload);
}

// Throttled retention sweep. Walks every session directory under the root,
// unlinks any mirror file whose mtime is older than RETENTION_DAYS, then
// removes empty directories. Caller invokes this lazily from the extension
// hooks (not a separate timer), matching cache-telemetry.sweepStaleSessions
// precedent (132-156).
let lastGlobalSweepMs = 0;
export function sweepRetentionThrottled() {
  const now = Date.now();
  if (now - lastGlobalSweepMs < SWEEP_THROTTLE_MS) return;
  lastGlobalSweepMs = now;
  const root = mirrorRoot();
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = now - retentionMs();
  let unlinked = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = join(root, ent.name);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    let remaining = 0;
    for (const f of files) {
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs < cutoff) {
          unlinkSync(p);
          unlinked += 1;
          // If this was the active file for an in-memory state, clear it so
          // the next write opens a new file.
          for (const [sid, s] of sessionState) {
            if (s.activeFile === p) {
              sessionState.delete(sid);
              break;
            }
          }
        } else {
          remaining += 1;
        }
      } catch {}
    }
    if (remaining === 0) {
      try { rmdirSync(dir); } catch {}
    }
  }
  if (unlinked > 0) {
    logEvent({ event: "sweep", unlinked });
  }
}

// Test seam — production state is module-scope; tests reset between cases.
export function _resetWriterState() {
  sessionState.clear();
  lastGlobalSweepMs = 0;
}

// Test seam — operational event-log direct access.
export function _appendEvent(record) {
  logEvent(record);
}
