// model-id-sanitize — detect (and optionally rewrite or block) malformed
// outbound `body.model` values caused by CC's `/model` picker bug
// (CC#68285, CC#68279). The picker writes ANSI SGR bold escape sequences
// into `~/.claude/settings.json`'s `model` field; Anthropic's API
// prefix-matches the substring and resolves to the current premium variant
// in that family. Deterministic ~$998 billing event on 2026-06-11.
//
// Directive: `docs/directives/proxy-model-id-sanitize.md`. Issue: #227.
//
// Modes (env: CACHE_FIX_MODEL_ID_SANITIZE):
//
//   off     v1 default. Extension early-returns; pipeline unchanged.
//   warn    Detect + log + stash; forward unchanged.
//   strip   Detect + recover. Strict precedence:
//             1. exact canonical full-ID inside the malformed value
//             2. family-root fallback (oldest-in-family wire ID)
//             3. no-confidence → block behavior for this request
//   block   Detect + reject with synthetic 400.
//
// The block-mode synthetic 400 reuses the existing `pre.handled`
// short-circuit shape from `image-retry-circuit-breaker.mjs:249-268` — the
// precedent synthesizes 200s, not 400s, so the 400 streaming path here is
// the first of its kind and the impl PR carries `needs-sim-validation`
// for both stream:true and stream:false.
//
// Failure isolation: detector runs inside the existing pipeline try/catch
// (pipeline.mjs:91-96). The extension's own try/catch wraps the regex
// match so a hostile body shape can't break the pipeline.

import { FAMILY_ROOT_FALLBACKS } from "../model-families.mjs";

// Canonical wire-format regex. `auto-1m-guard.mjs:11-12` documents CC
// strips `[(1|2)m]` from body.model before the wire, so a healthy outbound
// model id never carries the [1m] suffix. Shape: `claude-` prefix + lowercase
// alpha-num family + at least one hyphen-separated version segment.
const CANONICAL_MODEL_RE = /^claude-[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

// Same regex re-applied via .exec / .match against arbitrary substrings of
// a malformed value — used by exact-canonical recovery. We use a global +
// non-anchored variant for substring search.
const CANONICAL_SUBSTRING_RE = /claude-[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g;

// Hex-escape every byte of a value for safe logging + persistence. NEVER
// pass raw control sequences through stderr or JSON — they'll mess up
// operator terminals and downstream tooling. Matches the `\\x1b\\x5b\\x31\\x6d`
// shape per directive §5.
function hexEscape(value) {
  if (typeof value !== "string") return "";
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const cp = value.codePointAt(i);
    // \x{2-byte hex} for everything; uniform format is easier for triage
    // than mixing printable + escaped.
    out.push("\\x" + cp.toString(16).padStart(2, "0"));
    // Skip the trailing low surrogate of any astral cp.
    if (cp > 0xffff) i++;
  }
  return out.join("");
}

// Read the mode from env. Unknown values fall back to `off` with a
// one-time stderr warning so operators see the misconfiguration without
// a per-request spam.
let _unknownModeWarned = false;
function readMode() {
  const raw = process.env.CACHE_FIX_MODEL_ID_SANITIZE;
  if (raw === undefined || raw === "" || raw === "off") return "off";
  if (raw === "warn" || raw === "strip" || raw === "block") return raw;
  if (!_unknownModeWarned) {
    _unknownModeWarned = true;
    process.stderr.write(`[model-id-sanitize] unknown CACHE_FIX_MODEL_ID_SANITIZE=${hexEscape(String(raw))}; falling back to off.\n`);
  }
  return "off";
}

// First-seen tracker: when the extension fires for a session, we want to
// stamp the first-seen ISO timestamp on the per-session JSON spread. Map
// is keyed by sessionFilename and bounded by the same time-based stale-
// session sweep cache-telemetry runs (the entries naturally evict when
// the session goes inactive — module-scope map, fine because the proxy
// is one process per host).
const _firstSeenAt = new Map();

// Per-session corrections count for `strip` mode (the count of requests
// where the extension rewrote `body.model`).
const _correctionsCount = new Map();

// --- Recovery primitives ---

// Pure: search a malformed value for a canonical full-ID substring. If
// any match exists, return the longest match (the most-specific recovery).
// Returns null if none.
export function recoverExactCanonical(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  // Note: input is the original malformed value; substring match is
  // against the lower-cased form so an ANSI-escape-wrapped `Claude-Opus-4-7`
  // still recovers. But we return the lower-cased match (canonical wire is
  // lowercase).
  const lower = value.toLowerCase();
  const matches = lower.match(CANONICAL_SUBSTRING_RE);
  if (!matches || matches.length === 0) return null;
  // Longest match wins. `claude-opus-4-7` is preferred over `claude-opus-4`.
  return matches.reduce((longest, m) => (m.length > longest.length ? m : longest), "");
}

// Pure: scan a malformed value for family-root substrings. Returns the
// fallback target if exactly ONE root is found; null if zero or more than
// one (multi-root → no-confidence fallthrough).
export function recoverFamilyFallback(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const lower = value.toLowerCase();
  const matched = [];
  for (const entry of FAMILY_ROOT_FALLBACKS) {
    if (lower.includes(entry.root)) matched.push(entry);
  }
  if (matched.length !== 1) return null; // 0 or >1: no confidence
  return matched[0].fallbackTarget;
}

// --- Block-mode synthetic response ---

// Construct the synthetic 400 body. Returns the JSON-envelope shape used
// for stream:false requests; SSE handling is done in `buildBlockSkipResult`
// below.
function buildBlockBody(hexValue) {
  return {
    error: {
      type: "model_not_found",
      message: `[model-id-sanitize] malformed model_id rejected by cache-fix proxy: ${hexValue}. Inspect ~/.claude/settings.json and re-run /model to clean up; see anthropics/claude-code#68285 and #68279.`,
    },
  };
}

// Build the SSE-wrapped error for stream:true clients. Anthropic's
// streaming protocol delivers errors as an `event: error` frame followed
// by `data: <json>`; this matches what CC's parser expects.
function buildBlockSseString(hexValue) {
  const errEvent = {
    type: "error",
    error: {
      type: "model_not_found",
      message: `[model-id-sanitize] malformed model_id rejected by cache-fix proxy: ${hexValue}. Inspect ~/.claude/settings.json and re-run /model to clean up; see anthropics/claude-code#68285 and #68279.`,
    },
  };
  return `event: error\ndata: ${JSON.stringify(errEvent)}\n\n`;
}

function buildBlockSkipResult(hexValue, isStream) {
  if (isStream) {
    return {
      skip: true,
      status: 400,
      headers: { "content-type": "text/event-stream" },
      body: buildBlockSseString(hexValue),
    };
  }
  return {
    skip: true,
    status: 400,
    headers: { "content-type": "application/json" },
    body: buildBlockBody(hexValue),
  };
}

// --- Telemetry stash ---

// Build the normalized `_modelIdSanitize` stash + the per-session JSON
// spread fragment. The spread is what `cache-telemetry.mjs` will spread
// into the per-session JSON build site.
function buildStashAndSpread({ sessionKey, malformed, mode, recovery, original, rewritten }) {
  const stash = { malformed, mode };
  if (recovery) stash.recovery = recovery;
  if (original !== undefined) stash.original = original;
  if (rewritten !== undefined) stash.rewritten = rewritten;

  if (!malformed) {
    stash.spread = undefined;
    return stash;
  }

  const nowIso = new Date().toISOString();
  if (!_firstSeenAt.has(sessionKey)) _firstSeenAt.set(sessionKey, nowIso);
  const firstSeen = _firstSeenAt.get(sessionKey);

  const correctionsBefore = _correctionsCount.get(sessionKey) || 0;
  const corrections = recovery === "exact-canonical" || recovery === "family-fallback"
    ? correctionsBefore + 1
    : correctionsBefore;
  if (corrections !== correctionsBefore) _correctionsCount.set(sessionKey, corrections);

  stash.spread = {
    model_id_malformed: true,
    model_id_malformed_first_seen: firstSeen,
    model_id_corrections_count: corrections,
    model_id_malformed_last_value_hex: hexEscape(original ?? ""),
  };
  return stash;
}

// --- Detection + dispatch ---

// Pure: classify the current request. Returns one of:
//   { decision: "pass" }
//   { decision: "warn", original }
//   { decision: "strip", original, rewritten, recovery }
//   { decision: "block", original, hexValue, isStream }
//
// Pulled out for unit-testability — the extension's onRequest is the
// integration layer that mutates ctx + side-effects.
export function classify({ rawModel, mode, isStream }) {
  if (mode === "off") return { decision: "pass" };
  if (typeof rawModel !== "string" || rawModel.length === 0) return { decision: "pass" };
  if (CANONICAL_MODEL_RE.test(rawModel)) return { decision: "pass" };

  const hexValue = hexEscape(rawModel);

  if (mode === "warn") {
    return { decision: "warn", original: rawModel, hexValue };
  }

  if (mode === "block") {
    return { decision: "block", original: rawModel, hexValue, isStream };
  }

  // strip: try recovery
  const exact = recoverExactCanonical(rawModel);
  if (exact) {
    return { decision: "strip", original: rawModel, rewritten: exact, recovery: "exact-canonical", hexValue };
  }
  const family = recoverFamilyFallback(rawModel);
  if (family) {
    return { decision: "strip", original: rawModel, rewritten: family, recovery: "family-fallback", hexValue };
  }
  // No-confidence → fall through to block behavior
  return { decision: "block", original: rawModel, hexValue, isStream, recovery: "no-confidence-blocked" };
}

// Stable per-session key. Mirrors cache-telemetry.resolveSessionId's
// pattern — pulls from request headers. Returns null when sessionless
// (the first-seen tracker just gets a generic "unknown" bucket).
function sessionKeyFromHeaders(headers) {
  if (!headers) return "unknown";
  const sid =
    headers["x-claude-code-session-id"] ||
    headers["x-session-id"] ||
    headers["x-anthropic-session-id"] ||
    null;
  return sid || "unknown";
}

// --- Extension contract ---

export default {
  name: "model-id-sanitize",
  description: "Detect (and optionally strip or block) malformed body.model values caused by CC's /model picker bug (#68285, #68279).",
  order: 50,

  async onRequest(ctx) {
    try {
      const mode = readMode();
      if (mode === "off") return undefined;

      const rawModel = ctx?.body?.model;
      const isStream = ctx?.body?.stream === true;
      const sessionKey = sessionKeyFromHeaders(ctx?.headers);

      const result = classify({ rawModel, mode, isStream });

      if (result.decision === "pass") return undefined;

      if (result.decision === "warn") {
        process.stderr.write(`[model-id-sanitize] malformed model_id detected: ${result.hexValue} (mode=warn)\n`);
        const stash = buildStashAndSpread({
          sessionKey,
          malformed: true,
          mode,
          original: result.original,
        });
        ctx.meta = ctx.meta || {};
        ctx.meta._modelIdSanitize = stash;
        return undefined;
      }

      if (result.decision === "strip") {
        process.stderr.write(`[model-id-sanitize] malformed model_id detected: ${result.hexValue} (mode=strip; recovery=${result.recovery}; rewritten=${result.rewritten})\n`);
        ctx.body.model = result.rewritten;
        const stash = buildStashAndSpread({
          sessionKey,
          malformed: true,
          mode,
          recovery: result.recovery,
          original: result.original,
          rewritten: result.rewritten,
        });
        ctx.meta = ctx.meta || {};
        ctx.meta._modelIdSanitize = stash;
        return undefined;
      }

      // decision === "block" — either explicit block mode or strip-mode
      // no-confidence fallthrough.
      const recoveryReason = result.recovery || "no-confidence-blocked";
      process.stderr.write(`[model-id-sanitize] malformed model_id rejected: ${result.hexValue} (mode=${mode}; ${recoveryReason})\n`);
      const stash = buildStashAndSpread({
        sessionKey,
        malformed: true,
        mode,
        recovery: recoveryReason,
        original: result.original,
      });
      ctx.meta = ctx.meta || {};
      ctx.meta._modelIdSanitize = stash;
      return buildBlockSkipResult(result.hexValue, isStream);
    } catch (err) {
      // Failure isolation: any unexpected exception in the detector
      // drops the request to the pipeline unchanged. Per directive NFR §,
      // the regex shouldn't throw, but the catch is mandatory.
      process.stderr.write(`[model-id-sanitize] detector error: ${err?.message || err}\n`);
      return undefined;
    }
  },

  // Test-only: reset module state between tests.
  __resetForTests() {
    _firstSeenAt.clear();
    _correctionsCount.clear();
    _unknownModeWarned = false;
  },
};

// Test-only exports for unit-testability.
export const __testOnly = {
  CANONICAL_MODEL_RE,
  hexEscape,
  buildBlockBody,
  buildBlockSseString,
};
