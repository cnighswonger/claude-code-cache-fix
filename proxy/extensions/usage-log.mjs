// usage-log — append per-call usage record to ~/.claude/usage.jsonl.
//
// The emitted record matches `MeterRowSchema` v:1 from
// `claude-code-meter/src/log/schema.mjs` exactly. claude-meter validates each
// row through that schema; the wire format is the cross-repo contract.
//
// Schema (every row):
//   v: 1
//   ts: ISO datetime
//   sid: 8-char lowercase hex (proxy session, sticky for proxy lifetime)
//   model: string ≤64, /^[a-z0-9._-]+$/
//   requested_model?: string ≤64, /^[a-z0-9._-]*$/  (optional)
//   model_mismatch?: bool                            (optional)
//   speed: "standard" | "fast" | ""
//   service_tier: string ≤32, /^[a-z0-9_-]*$/
//   input_tokens, output_tokens, cache_creation_input_tokens,
//   cache_read_input_tokens, ephemeral_1h_input_tokens,
//   ephemeral_5m_input_tokens, web_search_requests: int ≥ 0
//   q5h, q7d: float 0–2
//   q5h_reset, q7d_reset: int (unix sec)
//   qstatus, qoverage, qclaim: string lowercase enums
//   qfallback_pct: float 0–1
//   qoverage_util?: float ≥ 0                        (optional)
//   qrepresentative_claim?: string ≤16               (optional)
//   org_id?: 16-char hex (sha256(raw header).digest("hex").slice(0,16))
//   overage_disabled_reason?: string ≤64             (optional)
//   cache_hit_rate: float 0–1
//   q5h_delta, q7d_delta: float (0 on first call after restart)
//   request_id?: string ≤64                          (optional, gated)
//
// `peak_hour` is NOT in the wire format. It can be derived from `ts` if any
// consumer needs it.
//
// Activation: enabled:false in the export default (existing usage-log
// pattern). Users opt in by adding an entry to proxy/extensions.json:
//   "usage-log": { "enabled": true, "order": 650 }
// CACHE_FIX_USAGE_LOG=<path> overrides the destination path only — it is NOT
// an enable flag and never has been.
//
// CACHE_FIX_USAGE_LOG_REQID=on emits the optional `request_id` field
// (sourced from the upstream `request-id` response header). Default-off in
// v4.1.0 to avoid breaking unpatched claude-meter installs whose strict-
// object schema rejects unknown keys. claude-meter v0.7.0+ accepts the
// optional field; the v4.2.0 flip to default-on assumes that floor.
// The field is the post-hoc join key against CC's per-session JSONL
// transcripts
// (`~/.claude/projects/<project>/<session-uuid>.jsonl` carry `requestId`
// for every API call), which recovers per-CC-session attribution that
// `sid` alone cannot provide. See docs/directives/proxy-usage-log-request-id.md.
//
// See `docs/directives/proxy-claude-meter-compat.md` for full design.

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const LOG_PATH = process.env.CACHE_FIX_USAGE_LOG || join(homedir(), ".claude", "usage.jsonl");

// --- Module-scope state ---

const _sid = generateSid();
let _lastQ5h = null;
let _lastQ7d = null;

// --- Pure helpers (test seam) ---

export function generateSid() {
  return createHash("sha256")
    .update(`${process.pid}-${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 8);
}

export function hashOrgId(rawOrgId) {
  if (!rawOrgId || typeof rawOrgId !== "string") return undefined;
  return createHash("sha256").update(rawOrgId).digest("hex").slice(0, 16);
}

export function extractMessageStartFields(event) {
  if (!event || event.type !== "message_start") return null;
  const msg = event.message;
  if (!msg || !msg.usage) return null;
  const usage = msg.usage;
  const cc = usage.cache_creation || {};
  const sti = usage.server_tool_use || {};
  return {
    model: typeof msg.model === "string" ? msg.model : "",
    speed: usage.speed || "",
    service_tier: usage.service_tier || "",
    input_tokens: usage.input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    ephemeral_1h_input_tokens: cc.ephemeral_1h_input_tokens || 0,
    ephemeral_5m_input_tokens: cc.ephemeral_5m_input_tokens || 0,
    web_search_requests: sti.web_search_requests || 0,
  };
}

export function extractMessageDeltaFields(event) {
  if (!event || event.type !== "message_delta") return null;
  if (!event.usage) return null;
  return { output_tokens: event.usage.output_tokens || 0 };
}

// Extract upstream request-id from response headers, guarded against the
// max(64) MeterRowSchema constraint. Returns the string when valid, or
// `undefined` so the optional schema field is omitted on bad input rather
// than emitting a row that would fail meter-side validation.
export function extractRequestId(headers) {
  const raw = headers?.["request-id"];
  if (typeof raw !== "string") return undefined;
  if (raw.length === 0 || raw.length > 64) return undefined;
  return raw;
}

function num(headers, key) {
  const v = headers?.[key];
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function intOf(headers, key) {
  const v = headers?.[key];
  if (v === undefined || v === null || v === "") return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function strOf(headers, key) {
  const v = headers?.[key];
  return typeof v === "string" ? v : "";
}

export function parseQuotaHeaders(headers) {
  const h = headers || {};
  return {
    q5h: num(h, "anthropic-ratelimit-unified-5h-utilization") ?? 0,
    q7d: num(h, "anthropic-ratelimit-unified-7d-utilization") ?? 0,
    q5h_reset: intOf(h, "anthropic-ratelimit-unified-5h-reset"),
    q7d_reset: intOf(h, "anthropic-ratelimit-unified-7d-reset"),
    qstatus: strOf(h, "anthropic-ratelimit-unified-status"),
    qoverage: strOf(h, "anthropic-ratelimit-unified-overage-status"),
    qclaim: strOf(h, "anthropic-ratelimit-unified-claim"),
    qfallback_pct: num(h, "anthropic-ratelimit-unified-fallback-percentage") ?? 0,
    qoverage_util: num(h, "anthropic-ratelimit-unified-overage-utilization"),
    qrepresentative_claim: strOf(h, "anthropic-ratelimit-unified-representative-claim") || undefined,
    org_id_raw: strOf(h, "anthropic-organization-id") || undefined,
    overage_disabled_reason: strOf(h, "anthropic-ratelimit-unified-overage-disabled-reason") || undefined,
  };
}

export function computeDelta(current, previous) {
  if (previous === null || previous === undefined) return 0;
  if (typeof current !== "number" || typeof previous !== "number") return 0;
  return current - previous;
}

export function assembleRecord({ start, delta, quota, requestedModel, sid, prevQ5h, prevQ7d, requestId, workflowAgent, now = new Date() }) {
  const s = start || {};
  const d = delta || {};
  const q = quota || {};

  const inputTokens = s.input_tokens || 0;
  const outputTokens = d.output_tokens || 0;
  const cacheRead = s.cache_read_input_tokens || 0;
  const cacheCreation = s.cache_creation_input_tokens || 0;
  const totalIn = inputTokens + cacheCreation + cacheRead;
  const cacheHitRate = totalIn > 0 ? cacheRead / totalIn : 0;

  const record = {
    v: 1,
    ts: now.toISOString(),
    sid,
    model: s.model || "",
    speed: s.speed || "",
    service_tier: s.service_tier || "",
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    ephemeral_1h_input_tokens: s.ephemeral_1h_input_tokens || 0,
    ephemeral_5m_input_tokens: s.ephemeral_5m_input_tokens || 0,
    web_search_requests: s.web_search_requests || 0,
    q5h: q.q5h ?? 0,
    q7d: q.q7d ?? 0,
    q5h_reset: q.q5h_reset || 0,
    q7d_reset: q.q7d_reset || 0,
    qstatus: q.qstatus || "",
    qoverage: q.qoverage || "",
    qclaim: q.qclaim || "",
    qfallback_pct: q.qfallback_pct ?? 0,
    cache_hit_rate: cacheHitRate,
    q5h_delta: computeDelta(q.q5h, prevQ5h),
    q7d_delta: computeDelta(q.q7d, prevQ7d),
  };

  // Optional fields are OMITTED (not present as undefined) when source absent.
  if (requestedModel) {
    record.requested_model = requestedModel;
    if (record.model && requestedModel !== record.model) {
      record.model_mismatch = true;
    }
  }
  if (q.qoverage_util !== null && q.qoverage_util !== undefined) {
    record.qoverage_util = q.qoverage_util;
  }
  if (q.qrepresentative_claim) {
    record.qrepresentative_claim = q.qrepresentative_claim;
  }
  const orgIdHashed = hashOrgId(q.org_id_raw);
  if (orgIdHashed) {
    record.org_id = orgIdHashed;
  }
  if (q.overage_disabled_reason) {
    record.overage_disabled_reason = q.overage_disabled_reason;
  }

  // Optional: emit request_id when CACHE_FIX_USAGE_LOG_REQID=on AND the
  // captured value is a non-empty string within the schema's max(64)
  // constraint. Belt-and-braces: extractRequestId enforces these guards at
  // capture time, and assembleRecord re-enforces them here so a future
  // refactor that bypasses the extractor can't emit a row that would fail
  // claude-meter's strict-object validation.
  // Env read happens per-call so operators can flip it at runtime without
  // proxy restart, matching the image-strip debug-gate pattern.
  // Cross-repo contract: claude-code-meter v0.7.0+ accepts this optional
  // field; older meter installs reject rows that carry it, so the gate
  // stays default-off in v4.1.0. Default flips on in cache-fix v4.2.0.
  if (
    process.env.CACHE_FIX_USAGE_LOG_REQID === "on" &&
    typeof requestId === "string" &&
    requestId.length > 0 &&
    requestId.length <= 64
  ) {
    record.request_id = requestId;
  }

  // Optional: emit agent_id + agent_id_source when CACHE_FIX_USAGE_LOG_AGENT_ID=on
  // AND the synthesis extension stashed a `_workflowAgentId` on ctx.meta.
  // Cross-repo contract: claude-code-meter v0.8.0+ accepts these fields;
  // older meter installs reject rows that carry them, so the gate stays
  // default-off in v4.2.0. The env-var IS the operator's attestation of
  // meter v0.8.0+ — there is no runtime version probe (see directive
  // `proxy-workflow-agent-id-synthesis.md` § "Meter compatibility").
  //
  // Belt-and-braces: re-enforce the schema's constraints here so a future
  // refactor to the synthesis extension can't emit a row the meter's
  // strict-object validation would reject.
  if (
    process.env.CACHE_FIX_USAGE_LOG_AGENT_ID === "on" &&
    workflowAgent &&
    typeof workflowAgent.id === "string" &&
    workflowAgent.id.length > 0 &&
    workflowAgent.id.length <= 64 &&
    (workflowAgent.source === "cc_header" || workflowAgent.source === "cache_fix_derived")
  ) {
    record.agent_id = workflowAgent.id;
    record.agent_id_source = workflowAgent.source;
  }

  return record;
}

// --- I/O ---

async function appendJsonl(record, path = LOG_PATH) {
  await mkdir(join(homedir(), ".claude"), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
}

// Test helper: write a record to a caller-supplied path. Bypasses env-var
// lookup so tests don't race on a shared env.
export async function writeRecord(record, path) {
  await mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
}

// Test helper: reset module-scope delta state.
export function _resetDeltaStateForTest() {
  _lastQ5h = null;
  _lastQ7d = null;
}

export { LOG_PATH };

// --- Extension contract ---

export default {
  name: "usage-log",
  description: "Append per-call usage record to ~/.claude/usage.jsonl (MeterRowSchema v:1)",
  enabled: false,
  order: 650,

  async onStreamEvent(ctx) {
    if (!ctx || !ctx.event) return;

    try {
      // message_start: capture per-response state into ctx.meta._usageLog.
      if (ctx.event.type === "message_start") {
        const start = extractMessageStartFields(ctx.event);
        if (start) {
          ctx.meta = ctx.meta || {};
          ctx.meta._usageLog = { start };
        }
        return;
      }

      // message_delta: assemble and emit the final record.
      if (ctx.event.type !== "message_delta" || !ctx.event.usage) return;

      const start = ctx.meta?._usageLog?.start;
      if (!start) return; // no message_start was observed for this response

      const delta = extractMessageDeltaFields(ctx.event);
      const quota = parseQuotaHeaders(ctx.responseHeaders || {});
      const requestedModel = ctx.telemetry?.requestedModel || undefined;
      const requestId = extractRequestId(ctx.responseHeaders || {});
      const workflowAgent = ctx.meta?._workflowAgentId || undefined;

      const record = assembleRecord({
        start,
        delta,
        quota,
        requestedModel,
        sid: _sid,
        prevQ5h: _lastQ5h,
        prevQ7d: _lastQ7d,
        requestId,
        workflowAgent,
        now: new Date(),
      });

      // Update delta tracking AFTER assembly so the first call's delta is 0
      // (per the directive contract: first call after restart → deltas zero).
      _lastQ5h = quota.q5h;
      _lastQ7d = quota.q7d;

      await appendJsonl(record, process.env.CACHE_FIX_USAGE_LOG || LOG_PATH);
    } catch {
      // Fail-open: never throw to the pipeline.
    }
  },
};
