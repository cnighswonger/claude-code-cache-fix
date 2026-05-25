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

function extractAuditFields(headers) {
  if (!headers) return { upstream_host: null, request_id: null };
  return {
    upstream_host: headers.host ?? null,
    request_id: headers["request-id"] ?? headers["x-request-id"] ?? null,
  };
}

export default {
  name: "bootstrap-defense",
  description:
    "Audit (default) or block /api/claude_cli/bootstrap traffic. Audit mode proxies the response through to CC and logs metadata to ~/.claude/cache-fix-bootstrap-log.jsonl. Block mode returns empty 200, preserving v3.6.2's de-facto behavior in explicit form.",
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
          ...extractAuditFields(ctx.headers),
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
    appendRecord(
      recordShape({
        phase: upstreamError ? "upstream_error_audited" : "response_audited",
        mode,
        status: ctx.status,
        body_bytes: bodyBytes,
        ...extractAuditFields(ctx.headers),
        error: upstreamError,
      }),
    );
  },
};
