import { appendFileSync, statSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const SCHEMA_VERSION = 2;
const EXTENSION_VERSION = "v3.7.1";

const LEGACY_PROMPT_KEY = "tengu_heron_brook";

function logPath() {
  return process.env.CACHE_FIX_BOOTSTRAP_LOG_PATH || join(homedir(), ".claude", "cache-fix-bootstrap-log.jsonl");
}

// Single-tier rotation by design: any previous .1 gets overwritten. The audit
// log is a forward-looking signal feed, not an archival record — if v3.7.0
// anomaly detection wants long-term retention it can subscribe to the stream
// directly. Keeping rotation to one tier bounds disk usage at 2×5MB = 10MB.
function rotateIfNeeded(path) {
  let size = 0;
  try { size = statSync(path).size; } catch { return; }
  if (size < LOG_ROTATE_BYTES) return;
  try { renameSync(path, `${path}.1`); } catch {}
}

// Single-writer invariant: cache-fix-proxy is one Node process per host, and
// every bootstrap response that needs logging flows through this extension.
// All writes are appendFileSync from a single event loop, so no inter-process
// or inter-extension locking is required. If that invariant ever changes
// (e.g. multi-process proxy, sibling extension writing to the same file),
// this writer needs to gain a lock.
function appendRecord(record) {
  const path = logPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, JSON.stringify(record) + "\n");
  } catch (err) {
    process.stderr.write(`[bootstrap-defense] log write failed: ${err.message}\n`);
  }
}

function modeFromEnv(fallback) {
  const raw = process.env.CACHE_FIX_BOOTSTRAP_MODE;
  if (raw === "audit" || raw === "block" || raw === "allowlist") return raw;
  return fallback;
}

// Parse the allowlist env var. Distinguishes three states:
//   - var unset            → default allowlist [LEGACY_PROMPT_KEY]
//   - var = "" (explicit)  → empty allowlist (deny-all)
//   - var = "a,b,c"        → [a, b, c] (trimmed, empty entries dropped)
function allowedKeysFromEnv() {
  const raw = process.env.CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS;
  if (raw === undefined) return new Set([LEGACY_PROMPT_KEY]);
  if (raw === "") return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
}

// Hash derivation contract (directive § Hash derivation): first 16 chars of
// the lowercase hex SHA-256 digest over the UTF-8-encoded flag value. Pinned
// here so a future refactor cannot silently change historical-record identity.
function hashFlagValue(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

// PII discipline: the audit log MUST NOT include client headers (Authorization,
// x-api-key, cookies, etc.) or request/response bodies. Callers pass only the
// extracted scalar fields below — the full headers object is never threaded
// through this function, so a future maintainer can't accidentally widen the
// log surface by spreading the parameter object.
//
// v3.7.0 extension fields (baseline_hash, anomaly_status) are emitted as null
// so log readers from that schema don't break. v3.7.1 adds the prompt-source
// surface fields (surface, prompt_key, prompt_value_hash, remote_mode,
// stripped_keys) — consumers reading v1 records should treat these as
// null/empty array.
function recordShape({
  phase, mode, status, body_bytes, upstream_host, request_id, error,
  surface, prompt_key, prompt_value_hash, remote_mode, stripped_keys,
}) {
  return {
    schema_version: SCHEMA_VERSION,
    extension_version: EXTENSION_VERSION,
    timestamp: new Date().toISOString(),
    phase,
    mode,
    status: status ?? null,
    body_bytes: body_bytes ?? null,
    upstream_host: upstream_host ?? null,
    request_id: request_id ?? null,
    baseline_hash: null,
    anomaly_status: null,
    error: error ?? null,
    surface: surface ?? "bootstrap",
    prompt_key: prompt_key ?? null,
    prompt_value_hash: prompt_value_hash ?? null,
    remote_mode: remote_mode ?? false,
    stripped_keys: stripped_keys ?? [],
  };
}

// Extract audit-record scalars from the request context. Meta wins over
// headers so that the canonical request-side fields stashed by the server
// (handleBootstrap stashes `_bootstrapUpstreamHost` and `_bootstrapRequestId`
// before the upstream call) are authoritative on the onResponse path, where
// ctx.headers carries the upstream RESPONSE headers (no Host, no request-id).
// On the onRequest block path, meta hasn't been populated yet — the helper
// falls back to ctx.headers (the client request headers) so request_id is
// still captured. Upstream_host falls back to null on the request path
// because the resolved upstream isn't known until handleBootstrap runs.
//
// Signature is scalar-only by design: callers MUST NOT spread a headers
// object into recordShape, so a future maintainer can't accidentally widen
// the log surface to carry Authorization / x-api-key / cookies.
function extractAuditFields(meta, headers) {
  const requestId =
    meta?._bootstrapRequestId ??
    headers?.["request-id"] ??
    headers?.["x-request-id"] ??
    null;
  return {
    upstream_host: meta?._bootstrapUpstreamHost ?? null,
    request_id: requestId,
  };
}

// Surface-activation logic (directive § Multi-surface records):
//   - "bootstrap" surface fires when the legacy hardcoded key is in the body.
//   - "prompt_injection_gb" surface fires when CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE
//     is set, independent of whether that named key is in the body — this gives
//     the audit log operator-visibility into env-configured intent even when
//     the upstream did not deliver the value.
function detectSurfaces(body) {
  const surfaces = [];
  const bodyIsObject = body !== null && typeof body === "object" && !Array.isArray(body);
  if (bodyIsObject && Object.prototype.hasOwnProperty.call(body, LEGACY_PROMPT_KEY)) {
    surfaces.push({ surface: "bootstrap", prompt_key: LEGACY_PROMPT_KEY });
  }
  const envKey = process.env.CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE;
  if (envKey) {
    surfaces.push({ surface: "prompt_injection_gb", prompt_key: envKey });
  }
  return surfaces;
}

export default {
  name: "bootstrap-defense",
  description:
    "Audit (default), block, or allowlist server-controlled system-prompt injection through /api/claude_cli/bootstrap. " +
    "Covers both the legacy tengu_heron_brook reader and the env-var-selected (CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE) reader. " +
    "Audit mode logs surface metadata to ~/.claude/cache-fix-bootstrap-log.jsonl. Block mode returns empty 200 from onRequest. " +
    "Allowlist mode strips non-allowlisted prompt-source-eligible keys from the response body before returning it to CC.",
  // Pipeline route scoping (pipeline.mjs:appliesToRoute) gates this extension
  // to the bootstrap path. The internal route guard below is belt-and-suspenders
  // in case a caller invokes the hook directly.
  routes: ["bootstrap"],
  order: 45,

  async onRequest(ctx) {
    if (ctx.meta?.route !== "bootstrap") return;

    const mode = modeFromEnv("audit");
    ctx.meta._bootstrapDefenseMode = mode;

    if (mode === "block") {
      appendRecord(
        recordShape({
          phase: "request_blocked",
          mode,
          ...extractAuditFields(ctx.meta, ctx.headers),
          remote_mode: Boolean(process.env.CLAUDE_CODE_REMOTE),
        }),
      );
      return {
        skip: true,
        status: 200,
        headers: { "content-type": "application/json" },
        body: {},
      };
    }
  },

  async onResponse(ctx) {
    if (ctx.meta?.route !== "bootstrap") return;
    const mode = ctx.meta._bootstrapDefenseMode || "audit";
    if (mode !== "audit" && mode !== "allowlist") return;

    // Prefer raw on-wire byte count from server.mjs (accurate even for
    // non-JSON / unparseable upstream responses). The fallback stringify path
    // exists only for direct unit-test invocation of onResponse without going
    // through handleBootstrap — production traffic always sets the meta field.
    let bodyBytes = ctx.meta?._bootstrapBodyBytes ?? null;
    if (bodyBytes === null) {
      try { bodyBytes = Buffer.byteLength(JSON.stringify(ctx.body ?? {})); } catch {}
    }

    const upstreamError = ctx.meta?._bootstrapUpstreamError ?? null;
    const auditFields = extractAuditFields(ctx.meta, ctx.headers);
    const remoteMode = Boolean(process.env.CLAUDE_CODE_REMOTE);
    const baseRecord = {
      mode,
      status: ctx.status,
      body_bytes: bodyBytes,
      ...auditFields,
      remote_mode: remoteMode,
    };

    // Anomaly path: upstream error or unparseable body. Single record with
    // new fields defaulted; no multi-surface emission (directive § Multi-surface
    // records, last paragraph).
    if (upstreamError) {
      appendRecord(recordShape({
        ...baseRecord,
        phase: "upstream_error_audited",
        error: upstreamError,
      }));
      return;
    }
    if (ctx.body === null || ctx.body === undefined) {
      appendRecord(recordShape({
        ...baseRecord,
        phase: "response_audited",
      }));
      return;
    }

    // Detect which prompt-source surfaces apply to this response.
    const surfaces = detectSurfaces(ctx.body);

    // No injection-detected baseline: single record preserving v3.7.0's
    // record shape (surface defaults to "bootstrap", prompt_key null).
    if (surfaces.length === 0) {
      appendRecord(recordShape({
        ...baseRecord,
        phase: "response_audited",
      }));
      return;
    }

    // Compute per-surface fields. Read from the original (unmutated) body
    // for every surface BEFORE applying any allowlist strips, so multiple
    // surfaces referencing the same key (env-var-aliases-legacy-key) both
    // see the same value and emit identical prompt_value_hash.
    const allowed = mode === "allowlist" ? allowedKeysFromEnv() : null;
    const perSurface = surfaces.map((s) => {
      const value = ctx.body[s.prompt_key];
      const hash = typeof value === "string" ? hashFlagValue(value) : null;
      const stripThis =
        mode === "allowlist" &&
        !allowed.has(s.prompt_key) &&
        Object.prototype.hasOwnProperty.call(ctx.body, s.prompt_key);
      return {
        ...s,
        prompt_value_hash: hash,
        stripped_keys: stripThis ? [s.prompt_key] : [],
      };
    });

    // Apply strips to ctx.body. Deletion is idempotent across multiple
    // surfaces that target the same key (alias case).
    if (mode === "allowlist") {
      for (const r of perSurface) {
        for (const k of r.stripped_keys) {
          delete ctx.body[k];
        }
      }
    }

    // Emit one audit record per detected surface. Shared scalars
    // (request_id, timestamp window, body_bytes, etc.) are duplicated across
    // records emitted from a single response; consumers correlate by
    // request_id + timestamp window.
    for (const r of perSurface) {
      appendRecord(recordShape({
        ...baseRecord,
        phase: "response_audited",
        surface: r.surface,
        prompt_key: r.prompt_key,
        prompt_value_hash: r.prompt_value_hash,
        stripped_keys: r.stripped_keys,
      }));
    }
  },
};
