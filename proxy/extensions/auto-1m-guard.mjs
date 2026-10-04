// auto-1m-guard — detect/warn/strip the 1M-context beta token on outbound
// requests. Addresses anthropics/claude-code#64919 (VS Code Extension forcing
// 1M context on Pro Plan).
//
// Binary-walk (CC v2.1.148 / v2.1.161 — same code body, names churned):
//   sL→kJ:  function strips /\[(1|2)m\]/gi from the model string
//   W2→bZ:  gates 1M-beta inclusion on /\[1m\]/i.test(model)
//   xKH→E9H: kill switch keys off CLAUDE_CODE_DISABLE_1M_CONTEXT
// CC always applies the sanitizer at messages.create call sites:
//   messages.create({...J, model: kJ(J.model)})
// So req.body.model NEVER carries [1m] on the wire — the proxy-visible
// signal is the anthropic-beta REQUEST HEADER carrying context-1m-2025-08-07.
//
// Three modes (env: CACHE_FIX_AUTO_1M_GUARD):
//   off    no-op
//   warn   (default) stash _auto1mGuard annotation + latched stderr line; no mutation
//   strip  also remove context-1m-2025-08-07 from the anthropic-beta header
//
// Order 520: after ttl-management (500) and before thinking-block-sanitize
// (550) / session-health (590) / cache-telemetry (600). The stashed flat
// object at ctx.meta._auto1mGuard is spread top-level into the per-session
// JSON by cache-telemetry, matching the _sessionHealth / _thinkingSanitize
// pattern.
//
// See docs/directives/proxy-auto-1m-guard.md.

const BETA_TOKEN_1M = "context-1m-2025-08-07";
const HEADER_NAME = "anthropic-beta";
const ADVICE =
  "Outbound request carries the context-1m-2025-08-07 beta header, which enables 1M context. " +
  "On Pro plans this consumes overage credits immediately. To prevent CC from auto-selecting 1M: " +
  "set CLAUDE_CODE_DISABLE_1M_CONTEXT=1 in your env, or use /model with a non-[1m] model variant " +
  "in-session. Strip mode (CACHE_FIX_AUTO_1M_GUARD=strip) intercepts the header at the proxy.";

function modeFromEnv() {
  const v = process.env.CACHE_FIX_AUTO_1M_GUARD;
  if (v === "off" || v === "strip") return v;
  return "warn";
}

// Case-insensitive read of the anthropic-beta header. Mirrors
// upstream-change-detection.mjs:200-207. Returns { key, raw } where key is
// the actual property name found (so the rewrite can replace in-place),
// or null if absent.
export function findBetaHeader(headers) {
  if (!headers) return null;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === HEADER_NAME) {
      return { key: k, raw: headers[k] };
    }
  }
  return null;
}

// Parse the comma-separated header value into a trimmed token array.
// Tolerates string or array input.
export function parseBetaTokens(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

// Pure planner: returns { detected, stripped, tokensAfter } given the
// parsed token array. Strip removes ALL occurrences (defensive against
// duplicates introduced by intermediaries).
export function planSanitizeBetaHeader(tokens, mode) {
  const detected = tokens.includes(BETA_TOKEN_1M);
  if (!detected || mode !== "strip") {
    return { detected, stripped: false, tokensAfter: tokens };
  }
  const tokensAfter = tokens.filter((t) => t !== BETA_TOKEN_1M);
  return { detected, stripped: true, tokensAfter };
}

// Rejoin tokens with the CC-canonical ", " separator. Empty array → "".
export function joinBetaTokens(tokens) {
  return tokens.join(", ");
}

// PROCESS-DURABLE: `loadExtensions` cache-busts every import, so a module-scoped
// `let` is re-armed on every extension reload and the advisory returns once per
// reload. `Symbol.for`, not `Symbol()` -- the registry is what makes every
// re-evaluated copy reach the same object. `process.env` is the other way this
// repo keeps reload-durable state (server.mjs, request-capture.mjs); a boolean
// does not need the string coercion or the leak into spawned children.
const _latch = (globalThis[Symbol.for("cache-fix.auto-1m-guard")] ??= { advised: false });

export default {
  name: "auto-1m-guard",
  description:
    "Detect (warn) or remove (strip) the context-1m-2025-08-07 token from the outbound anthropic-beta header. " +
    "Addresses CC#64919 (VS Code Extension forcing 1M context on Pro Plan). " +
    "Modes via CACHE_FIX_AUTO_1M_GUARD: off | warn (default) | strip.",
  order: 520,

  async onRequest(ctx) {
    const mode = modeFromEnv();
    if (mode === "off") return;

    const found = findBetaHeader(ctx.headers);
    if (!found) return;

    const tokens = parseBetaTokens(found.raw);
    const plan = planSanitizeBetaHeader(tokens, mode);
    if (!plan.detected) return;

    if (plan.stripped) {
      ctx.headers[found.key] = joinBetaTokens(plan.tokensAfter);
    }

    ctx.meta._auto1mGuard = {
      auto_1m_detected: true,
      auto_1m_action: plan.stripped ? "stripped" : "warn",
      auto_1m_advice: ADVICE,
    };

    // A repeat carries nothing the first line did not, and at request rate buries the log.
    if (_latch.advised) return;
    _latch.advised = true;
    process.stderr.write(
      `[auto-1m-guard] ${BETA_TOKEN_1M} detected in outbound betas` +
        (plan.stripped ? " — stripped" : "") +
        ` — see CACHE_FIX_AUTO_1M_GUARD=strip to intercept. ` +
        `Set CLAUDE_CODE_DISABLE_1M_CONTEXT=1 to prevent CC from sending it.\n`,
    );
  },
};

// Test seam — clears the process-wide latch. Any module instance clears it for
// all of them, which is the property the latch exists to have.
export function __resetAdvisedForTests() { _latch.advised = false; }
