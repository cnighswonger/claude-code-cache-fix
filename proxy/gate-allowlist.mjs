// Which CACHE_FIX_* values may be published, and the rule for everything else.
//
// TWO CONSUMERS, one definition: `/health`'s `gates` object and the capture
// corpus's boot record. Both existed to answer one question — "which gates was
// this proxy actually running with" — and both answered it by dumping every
// CACHE_FIX_* variable with its VALUE. That is more than the question needs and
// more than is safe to publish: `/health` is served to anything that can reach
// the port, and a capture file is the artifact most likely to be attached to a
// bug report or replayed on another machine.
//
// The environment is not a uniform population. Of the ~117 CACHE_FIX_* names
// this codebase reads, the switches are inert to publish ("1", "on", a byte
// budget) while others carry an OAuth client id, a token endpoint, a
// credentials path, the upstream URL, a command line, and a dozen filesystem
// paths that describe the operator's machine. A dump cannot tell them apart.
//
// SO THE DEFAULT IS NAME-ONLY, and that is the load-bearing decision here.
// An allowlisted key is published as `KEY: value`. Everything else is
// published as its NAME with a `<redacted>` marker — the reader still learns
// that the variable is set, which is what provenance needs, and learns nothing
// about what it is set to. A new CACHE_FIX_* variable added tomorrow is
// therefore safe on the day it is added, without anyone remembering this file
// exists. Redaction lists fail the other way round: they cover the hazards
// someone enumerated and ship the unanticipated one by default.
//
// The allowlist below is the set whose VALUE answers the gates question — the
// pipeline switches and the numeric budgets that change behaviour. It contains
// no path, no URL, no command, no credential, and no free-form pattern, and a
// key of any of those kinds must not be added to it.

export const PUBLISHABLE_GATES = new Set([
  // Pipeline switches (the production set in cache-fix-proxy.service).
  "CACHE_FIX_FORWARD_PROXY",
  "CACHE_FIX_INSERTION_NORMALIZE",
  "CACHE_FIX_OUTPUT_GUARD",
  "CACHE_FIX_PREFIXDIFF",
  "CACHE_FIX_REQUEST_CAPTURE",
  "CACHE_FIX_SESSION_MIRROR",
  "CACHE_FIX_TOOL_REWRITE",
  "CACHE_FIX_UPSTREAM_DETECTION",
  "CACHE_FIX_UPSTREAM_ERROR_LOG",
  "CACHE_FIX_VOLATILE_PIN",
  // Further behaviour switches, same character.
  "CACHE_FIX_AUTO_1M_GUARD",
  "CACHE_FIX_BOOTSTRAP_MODE",
  "CACHE_FIX_DEBUG",
  "CACHE_FIX_DISABLED",
  "CACHE_FIX_GATEWAY_ERROR_LOG",
  "CACHE_FIX_HOT_RELOAD",
  "CACHE_FIX_IMAGE_GUARD",
  "CACHE_FIX_IMAGE_RETRY_BREAKER",
  "CACHE_FIX_NORMALIZE_CC_VERSION",
  "CACHE_FIX_NORMALIZE_MICROCOMPACT",
  "CACHE_FIX_OAUTH_REFRESH",
  "CACHE_FIX_OVERAGE_WARNING",
  "CACHE_FIX_READ_DEDUPE",
  "CACHE_FIX_REQUEST_LOG",
  "CACHE_FIX_SESSION_BUDGET",
  "CACHE_FIX_THINKING_DISPLAY",
  "CACHE_FIX_THINKING_RISK",
  "CACHE_FIX_THINKING_SANITIZE",
  "CACHE_FIX_USAGE_LOG",
  "CACHE_FIX_WIRED_BY_LAUNCHER",
  "CACHE_FIX_WORKFLOW_AGENT_DERIVATION",
  // Numeric budgets and limits — a size, never an identifier.
  "CACHE_FIX_CAPTURE_MAX_MB",
  "CACHE_FIX_IMAGE_COUNT_MAX",
  "CACHE_FIX_IMAGE_KEEP_LAST",
  "CACHE_FIX_IMAGE_MAX_DIM",
  "CACHE_FIX_IMAGE_REQUEST_SIZE_MAX",
  "CACHE_FIX_PROXY_PORT",
  "CACHE_FIX_PROXY_TIMEOUT",
  "CACHE_FIX_SESSION_BUDGET_TOKENS",
  "CACHE_FIX_TTL_MAIN",
  "CACHE_FIX_TTL_SUBAGENT",
]);

export const REDACTED = "<redacted>";

/**
 * The publishable view of the CACHE_FIX_* environment: allowlisted keys with
 * their values, every other CACHE_FIX_* key present by NAME with its value
 * replaced by `REDACTED`. Sorted, so two boot records or two /health reads are
 * comparable byte-for-byte.
 *
 * `skip` drops keys entirely — used for CACHE_FIX_PROXY_TREE, which the boot
 * record already carries as its own field.
 */
export function publishableGates(env = process.env, { skip = [] } = {}) {
  const skipSet = new Set(skip);
  const out = {};
  for (const key of Object.keys(env).sort((a, b) => a.localeCompare(b))) {
    if (!key.startsWith("CACHE_FIX_") || skipSet.has(key)) continue;
    out[key] = PUBLISHABLE_GATES.has(key) ? env[key] : REDACTED;
  }
  return out;
}
