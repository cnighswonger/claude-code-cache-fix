import { appendFileSync, statSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const SCHEMA_VERSION = 1;
const EXTENSION_VERSION = "v3.6.3";

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
  if (raw === "audit" || raw === "block") return raw;
  return fallback;
}

// PII discipline: the audit log MUST NOT include client headers (Authorization,
// x-api-key, cookies, etc.) or request/response bodies. Callers pass only the
// extracted scalar fields below — the full headers object is never threaded
// through this function, so a future maintainer can't accidentally widen the
// log surface by spreading the parameter object.
//
// v3.7.0 extension fields are emitted as null/defaulted so log readers don't
// break when v3.7.0 starts populating baseline_hash, anomaly_status, etc.
function recordShape({ phase, mode, status, body_bytes, upstream_host, request_id, error }) {
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

export default {
  name: "bootstrap-defense",
  description:
    "Audit (default) or block /api/claude_cli/bootstrap traffic. Audit mode proxies the response through to CC and logs metadata to ~/.claude/cache-fix-bootstrap-log.jsonl. Block mode returns empty 200, preserving v3.6.2's de-facto behavior in explicit form.",
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
    if (mode !== "audit") return;

    // Prefer raw on-wire byte count from server.mjs (accurate even for
    // non-JSON / unparseable upstream responses). The fallback stringify path
    // exists only for direct unit-test invocation of onResponse without going
    // through handleBootstrap — production traffic always sets the meta field.
    let bodyBytes = ctx.meta?._bootstrapBodyBytes ?? null;
    if (bodyBytes === null) {
      try { bodyBytes = Buffer.byteLength(JSON.stringify(ctx.body ?? {})); } catch {}
    }

    const upstreamError = ctx.meta?._bootstrapUpstreamError ?? null;
    // Request-side context (request_id, upstream_host) is captured at
    // forward time and stashed on ctx.meta — we read from meta here rather
    // than ctx.headers (which on onResponse contains the upstream RESPONSE
    // headers, not the client request).
    appendRecord(
      recordShape({
        phase: upstreamError ? "upstream_error_audited" : "response_audited",
        mode,
        status: ctx.status,
        body_bytes: bodyBytes,
        upstream_host: ctx.meta?._bootstrapUpstreamHost ?? null,
        request_id: ctx.meta?._bootstrapRequestId ?? null,
        error: upstreamError,
      }),
    );
  },
};
