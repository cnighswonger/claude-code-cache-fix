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
// The `request_id` field (sourced from the upstream `request-id` response
// header) is emitted by default in v4.2.0. v4.1.0 shipped it default-off
// via CACHE_FIX_USAGE_LOG_REQID=on while claude-meter <v0.7.0 still
// rejected unknown keys; with meter v0.7.0/0.7.1/0.8.0 all published, the
// v4.2.0 flip is safe. The env-var is now a kill-switch:
// CACHE_FIX_USAGE_LOG_REQID=off omits the field for operators stuck on a
// pre-v0.7.0 meter install. The field is the post-hoc join key against
// CC's per-session JSONL transcripts (`~/.claude/projects/<project>/<session-uuid>.jsonl`
// carry `requestId` for every API call), which recovers per-CC-session
// attribution that `sid` alone cannot provide.
// See docs/directives/proxy-usage-log-request-id.md.
//
// See `docs/directives/proxy-claude-meter-compat.md` for full design.

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { claudeHome } from "../claude-home.mjs";

// Resolve live per call so CACHE_FIX_USAGE_LOG and CLAUDE_CONFIG_DIR (via
// claudeHome()) are honored at write time, not frozen at import. Matches the
// paths() / logPath() shape in the sibling log extensions.
function logPath() {
  return process.env.CACHE_FIX_USAGE_LOG || join(claudeHome(), "usage.jsonl");
}

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

export function assembleRecord({ start, delta, quota, requestedModel, sid, prevQ5h, prevQ7d, requestId, workflowAgent, ttlTier, durationMs, now = new Date() }) {
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

  // Emit request_id by default when the captured value is a non-empty
  // string within the schema's max(64) constraint. Belt-and-braces:
  // extractRequestId enforces these guards at capture time, and
  // assembleRecord re-enforces them here so a future refactor that bypasses
  // the extractor can't emit a row that would fail claude-meter's
  // strict-object validation.
  //
  // v4.2.0 flipped the default from off to on (the v4.1.0 default-off was
  // the precondition for shipping the field at all; meter v0.7.0+ now
  // accepts it, and v0.7.0 + v0.7.1 + v0.8.0 are all published). The
  // env-var becomes a kill-switch: CACHE_FIX_USAGE_LOG_REQID=off omits
  // the field, for operators stuck on a pre-v0.7.0 meter install (uncommon
  // — the v4.1.0 changelog already established meter v0.7.0+ as the
  // upgrade-coupling requirement). Env read happens per-call so operators
  // can flip it at runtime without proxy restart.
  if (
    process.env.CACHE_FIX_USAGE_LOG_REQID !== "off" &&
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

  // Optional: emit ttl_tier + duration_ms when CACHE_FIX_USAGE_LOG_EXTENDED=on.
  // Cross-repo contract: claude-code-meter must accept these fields on
  // MeterRowSchema before we emit them (meter #42 landed the schema change;
  // publishing that release is the operator-visible prerequisite for flipping
  // this gate). MeterRowSchema is a z.strictObject — an older meter install
  // rejects any row carrying an unknown key, and rejection is silent at both
  // chokepoints (writer.mjs:68-70 safeParse→null; jsonl-tailer.mjs:143-153
  // parse→skip). The env-var IS the operator's attestation of a compatible
  // meter — there is no runtime version probe.
  //
  // Same belt-and-braces pattern as agent_id: re-enforce the schema's
  // constraints here so a future refactor to ttl-tier-detect or the timing
  // hooks can't emit a row the meter's strict-object validation would reject.
  if (process.env.CACHE_FIX_USAGE_LOG_EXTENDED === "on") {
    if (ttlTier === "5m" || ttlTier === "1h") {
      record.ttl_tier = ttlTier;
    }
    if (typeof durationMs === "number" && Number.isInteger(durationMs) && durationMs >= 0) {
      record.duration_ms = durationMs;
    }
  }

  return record;
}

// --- I/O ---

async function appendJsonl(record, path = logPath()) {
  await mkdir(claudeHome(), { recursive: true });
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

export { logPath };

// --- Extension contract ---

export default {
  name: "usage-log",
  description: "Append per-call usage record to ~/.claude/usage.jsonl (MeterRowSchema v:1)",
  enabled: false,
  order: 650,

  // Timing capture for duration_ms (emitted when CACHE_FIX_USAGE_LOG_EXTENDED=on).
  // Kept self-contained rather than reading from request-log.mjs's stashes,
  // because request-log is enabled:false in extensions.json — an implementation
  // that depended on it would produce no duration on the default extension
  // graph. Definition: time-to-response-start, not to completion. That is the
  // value we can produce without buffering.
  async onRequest(ctx) {
    if (!ctx) return;
    ctx.meta = ctx.meta || {};
    ctx.meta._usageLogRequestStart = Date.now();
  },

  async onResponseStart(ctx) {
    if (!ctx || !ctx.meta) return;
    ctx.meta._usageLogResponseStart = Date.now();
  },

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
      // ttl_tier source: ttl-tier-detect.mjs (order 75) sets _ttlTier on every
      // request. It runs before usage-log (order 650), so the value is present
      // by the time we assemble. assembleRecord re-validates the shape.
      const ttlTier = ctx.meta?._ttlTier;
      // duration_ms source: our own onRequest+onResponseStart hooks above.
      // Falls back to undefined if either timing didn't fire (health-checks,
      // non-streaming request paths); assembleRecord omits the key rather than
      // emitting a null.
      const rs = ctx.meta?._usageLogRequestStart;
      const ss = ctx.meta?._usageLogResponseStart;
      const durationMs = typeof rs === "number" && typeof ss === "number" && ss >= rs ? ss - rs : undefined;

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
        ttlTier,
        durationMs,
        now: new Date(),
      });

      // Update delta tracking AFTER assembly so the first call's delta is 0
      // (per the directive contract: first call after restart → deltas zero).
      _lastQ5h = quota.q5h;
      _lastQ7d = quota.q7d;

      await appendJsonl(record, logPath());
    } catch {
      // Fail-open: never throw to the pipeline.
    }
  },
};
