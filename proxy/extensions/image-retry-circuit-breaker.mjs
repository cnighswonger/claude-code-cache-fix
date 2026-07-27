import { appendFileSync, statSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { imageHashesFromBody } from "../image-hash.mjs";
import { resolveSessionId } from "./cache-telemetry.mjs";
import { claudeHome } from "../claude-home.mjs";

// Directive: docs/directives/proxy-image-retry-circuit-breaker.md (merged at d12cc05)
// Upstream: anthropics/claude-code#66815

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const DEFAULT_COOLOFF_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 4096;
const SWEEP_THROTTLE_MS = 60_000;
const UNKNOWN_SESSION = "unknown";
const SHORT_CIRCUIT_TAG = "[cache-fix-proxy]";

// Modes:
//   "on"      — default-off in v4.2.0 first ship (per directive § Activation).
//               When set, the breaker fires short-circuits.
//   "off"     — record nothing, fire nothing. Same as the extension disabled.
//   "dry-run" — record JSONL events on detection but DO NOT short-circuit.
//               Useful for production debugging without changing behavior.
function modeFromEnv() {
  const raw = process.env.CACHE_FIX_IMAGE_RETRY_BREAKER;
  if (raw === "on" || raw === "dry-run") return raw;
  return "off";
}

function cooloffMs() {
  const raw = parseInt(process.env.CACHE_FIX_IMAGE_RETRY_COOLOFF_MS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COOLOFF_MS;
}

function maxEntries() {
  const raw = parseInt(process.env.CACHE_FIX_IMAGE_RETRY_MAX_ENTRIES, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_ENTRIES;
}

function logPath() {
  return process.env.CACHE_FIX_IMAGE_RETRY_LOG_PATH ||
    join(claudeHome(), "image-retry-events.jsonl");
}

// Single-tier rotation matching bootstrap-defense's rotateIfNeeded — any
// previous .1 is overwritten. The log is a forward-looking signal for
// operators diagnosing misfires; long-term retention is out of scope.
function rotateIfNeeded(path) {
  let size = 0;
  try { size = statSync(path).size; } catch { return; }
  if (size < LOG_ROTATE_BYTES) return;
  try { renameSync(path, `${path}.1`); } catch {}
}

function appendEvent(record) {
  const path = logPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, JSON.stringify(record) + "\n");
  } catch (err) {
    process.stderr.write(`[image-retry-circuit-breaker] log write failed: ${err.message}\n`);
  }
}

// State map: per-session, per-failed-request entries. Insertion-order Map
// gives us O(1) LRU via Map iteration order — re-insert on access to bump.
const state = {
  failures: new Map(), // key: `${sessionId}:${requestSignature}` → entry
  lastSweepMs: 0,
};

// Test seam — production state lives at module scope; tests can reset between
// cases without re-importing the module.
export function _resetState() {
  state.failures.clear();
  state.lastSweepMs = 0;
}

// Sessionless requests bucket to the "unknown" key WITHOUT requestSignature
// scoping per directive § Detection logic point 4 — sessionless requests are
// explicitly NOT isolated from each other by requestSignature; cross-
// contamination within the cool-off window is the acknowledged trade-off.
// All "unknown"-bucket entries collapse onto a single key so any sessionless
// request whose image hashes overlap a recorded "unknown" failure fires the
// breaker. For real sessions, the per-attempt-per-session granularity is
// preserved by keying on `${sessionId}:${requestSignature}`.
function makeKey(sessionId, requestSignature) {
  if (sessionId === UNKNOWN_SESSION) return `${UNKNOWN_SESSION}:_`;
  return `${sessionId}:${requestSignature}`;
}

// Stable hash of the failing request. Distinguishes per-attempt failures
// within a session (the same session may fail on multiple different image
// payloads independently). The signature is derived from the wire form
// (already image-stripped if image-strip ran first), so a retry of the same
// body produces the same signature.
function requestSignatureOf(body) {
  if (!body || typeof body !== "object") return "empty";
  const h = createHash("sha256");
  const model = typeof body.model === "string" ? body.model : "";
  h.update(model);
  h.update("\0");
  if (Array.isArray(body.messages)) {
    h.update(String(body.messages.length));
    h.update("\0");
    for (const msg of body.messages) {
      const role = typeof msg?.role === "string" ? msg.role : "";
      h.update(role);
      h.update("\0");
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object") {
            h.update(typeof block.type === "string" ? block.type : "");
            h.update("\0");
          }
        }
      } else if (typeof msg?.content === "string") {
        h.update("text");
        h.update("\0");
      }
    }
  }
  return h.digest("hex").slice(0, 16);
}

// LRU eviction: oldest insertion-order entry is dropped when over cap. The
// Map preserves insertion order; on access we re-insert to bump.
function bumpLru(key, entry) {
  state.failures.delete(key);
  state.failures.set(key, entry);
}

function evictIfOverCap() {
  const cap = maxEntries();
  while (state.failures.size > cap) {
    const oldest = state.failures.keys().next().value;
    if (oldest === undefined) break;
    state.failures.delete(oldest);
  }
}

// Throttled sweep precedent: cache-telemetry.mjs:132-156 (sweepStaleSessions).
// Runs every 60s at most, removing entries past 2× the cool-off window —
// generous so a sweep racing a near-boundary entry doesn't drop something
// still in its cool-off.
function sweepStale() {
  const now = Date.now();
  if (now - state.lastSweepMs < SWEEP_THROTTLE_MS) return;
  state.lastSweepMs = now;
  const ttl = cooloffMs() * 2;
  for (const [key, entry] of state.failures) {
    if (now - entry.lastFailureAt > ttl) state.failures.delete(key);
  }
}

// Lazy expiry on lookup — drop the entry if it's past the cool-off window
// at the moment of access. Cheaper than the throttled sweep and handles
// the common case (next retry arrives just past TTL).
function readActiveEntry(sessionId, requestSignature) {
  const key = makeKey(sessionId, requestSignature);
  const entry = state.failures.get(key);
  if (!entry) return null;
  if (Date.now() - entry.lastFailureAt > cooloffMs()) {
    state.failures.delete(key);
    return null;
  }
  return entry;
}

// Detection condition: any-hash overlap between the recorded failure's
// image-hash set and the current request's image-hash set. Per directive
// § Multi-image matching rule, this is the deliberate trade-off — short TTL
// mitigates the replaced-bad-image+shared-good-image false-positive case.
function hashesIntersect(setA, setB) {
  if (!setA || !setB) return false;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const h of small) {
    if (large.has(h)) return true;
  }
  return false;
}

// Inlined Anthropic image-processing-error predicate (directive § Error-class
// predicate). Following rate-limit-log.mjs:68-74's isRateLimitResponse pattern
// — no new shared module introduced. Pattern set covers the documented
// "image could not be processed" family; sim validation widens the regex if
// production traffic surfaces additional message variants.
function isImageProcessingError(ctx) {
  if (!ctx || typeof ctx.status !== "number") return false;
  if (ctx.status !== 400) return false;
  const body = ctx.body;
  if (!body || typeof body !== "object") return false;
  if (body.type !== "error" || body.error?.type !== "invalid_request_error") return false;
  const msg = body.error?.message || "";
  return /image (could not be processed|format|content)/i.test(msg);
}

// --- Synthesized response (directive § Synthesized response — wire format) ---

function shortCircuitText(firstHash, remainingMs) {
  return `${SHORT_CIRCUIT_TAG} Image with content hash ${firstHash.slice(0, 8)} ` +
    `failed processing on the previous attempt. To avoid burning cache_creation ` +
    `tokens on the same failure, this attempt was short-circuited locally. ` +
    `Please drop or replace the image. (See CC#66815. Cooldown: ${remainingMs}ms.)`;
}

// SSE/JSON synthesis moved to the shared proxy/synth-response.mjs so the
// session-budget-breaker (and future local short-circuits) reuse one wire
// format.
import { buildSseString, buildJsonBody } from "../synth-response.mjs";

function buildSkipResult(mode, request, entry) {
  const remainingMs = Math.max(0, cooloffMs() - (Date.now() - entry.lastFailureAt));
  const firstHash = entry.imageHashes.values().next().value || "";
  const text = shortCircuitText(firstHash, remainingMs);
  const model = typeof request?.model === "string" ? request.model : "claude-unknown";
  const isStream = request?.stream === true;
  if (isStream) {
    return {
      skip: true,
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: buildSseString(model, text),
    };
  }
  return {
    skip: true,
    status: 200,
    headers: { "content-type": "application/json" },
    body: buildJsonBody(model, text),
  };
}

function recordFireEvent({ sessionId, requestSignature, entry, mode, requestId }) {
  appendEvent({
    timestamp: new Date().toISOString(),
    event: "breaker_fire",
    mode,
    session_id: sessionId,
    request_signature: requestSignature,
    image_hashes: [...entry.imageHashes],
    retry_count: entry.retryCount,
    last_failure_at: entry.lastFailureAt,
    remaining_ms: Math.max(0, cooloffMs() - (Date.now() - entry.lastFailureAt)),
    request_id: requestId || null,
  });
}

function recordFailureEvent({ sessionId, requestSignature, entry, requestId }) {
  appendEvent({
    timestamp: new Date().toISOString(),
    event: "failure_recorded",
    session_id: sessionId,
    request_signature: requestSignature,
    image_hashes: [...entry.imageHashes],
    last_failure_at: entry.lastFailureAt,
    request_id: requestId || null,
  });
}

export default {
  name: "image-retry-circuit-breaker",
  description:
    "Short-circuits CC harness retries of image-bearing requests that previously failed with a permanent " +
    "'image could not be processed' error. Detection: same session + image-hash overlap + within cool-off window. " +
    "Synthesized response uses the upstream wire format (SSE for stream:true, JSON otherwise) so the harness " +
    "consumes it as a normal completed turn. Bounded by CC#66815's retry-storm cost model.",
  order: 370,
  routes: ["messages"],

  async onRequest(ctx) {
    const mode = modeFromEnv();
    if (mode === "off") return;
    if (!ctx || !ctx.body) return;

    const sessionId = resolveSessionId(ctx.headers) || UNKNOWN_SESSION;
    const requestSignature = requestSignatureOf(ctx.body);
    const currentHashes = imageHashesFromBody(ctx.body);

    // Stash for the onResponse failure-recorder. We stash even when no images
    // are present so the failure path can disambiguate "no images in this
    // request" from "we forgot to stash."
    ctx.meta._imageRetryHashes = currentHashes;
    ctx.meta._imageRetrySession = sessionId;
    ctx.meta._imageRetrySignature = requestSignature;

    if (currentHashes.size === 0) return;

    sweepStale();
    const entry = readActiveEntry(sessionId, requestSignature);
    if (!entry) return;
    if (!hashesIntersect(currentHashes, entry.imageHashes)) return;

    const requestId =
      ctx.headers?.["request-id"] || ctx.headers?.["x-request-id"] || null;

    // Sliding cool-off window per directive § State management N3 — refresh
    // lastFailureAt on every fire so the cool-off extends from the most recent
    // suppressed attempt rather than from the original upstream failure.
    entry.lastFailureAt = Date.now();
    entry.retryCount += 1;
    bumpLru(makeKey(sessionId, requestSignature), entry);

    recordFireEvent({ sessionId, requestSignature, entry, mode, requestId });

    if (mode === "dry-run") return;
    return buildSkipResult(mode, ctx.body, entry);
  },

  async onResponse(ctx) {
    const mode = modeFromEnv();
    if (mode === "off") return;
    if (!isImageProcessingError(ctx)) return;

    const sessionId = ctx.meta?._imageRetrySession || resolveSessionId(ctx.headers) || UNKNOWN_SESSION;
    const requestSignature = ctx.meta?._imageRetrySignature || "unknown";
    const stashedHashes = ctx.meta?._imageRetryHashes;
    if (!stashedHashes || stashedHashes.size === 0) return;

    const requestId =
      ctx.headers?.["request-id"] || ctx.headers?.["x-request-id"] || null;
    const key = makeKey(sessionId, requestSignature);
    const existing = state.failures.get(key);
    const entry = existing
      ? {
          ...existing,
          imageHashes: new Set([...existing.imageHashes, ...stashedHashes]),
          lastFailureAt: Date.now(),
        }
      : {
          sessionId,
          imageHashes: new Set(stashedHashes),
          lastFailureAt: Date.now(),
          requestId,
          retryCount: 0,
        };

    bumpLru(key, entry);
    evictIfOverCap();
    recordFailureEvent({ sessionId, requestSignature, entry, requestId });
  },
};
