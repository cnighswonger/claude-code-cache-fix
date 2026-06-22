// cc-version-normalize — rewrite the `cc_version` value inside the
// `x-anthropic-billing-header` block of the system prompt to prevent
// per-build cache invalidation. Addresses #238.
//
// The problem (recap): Some Claude Code distribution channels (notably the
// VS Code extension under auto-update) emit a `cc_version` value with a
// trailing per-build hash segment on top of MAJOR.MINOR.PATCH, e.g.
// `2.1.185.<buildhash>`. That value is inside the cacheable prefix, so
// when the build-hash mutates mid-session (binary auto-updates between
// turns), every subsequent turn pays full cache_creation cost until the
// suffix stabilizes again.
//
// Existing fingerprint-strip (order 100) does NOT cover this: it only
// rewrites suffixes whose value matches a CC-generated fingerprint of the
// user message text. A binary build-hash doesn't match, so fingerprint-
// strip's verification fails and it returns null without rewriting.
//
// This extension runs at order 90 (before fingerprint-strip) and:
//   - strip mode: collapses `cc_version=X.Y.Z(.suffix)+` to `cc_version=X.Y.Z`
//   - pin:<value> mode: replaces `cc_version=<anything>` with the operator
//     literal `cc_version=<value>`. Used for fleets that want one stable
//     identifier across all clients.
//
// After this runs, the cc_version is 3 segments, so fingerprint-strip's
// `dotParts.length < 4 → return null` guard makes it a no-op. The two
// extensions cooperate cleanly without ordering hazards beyond "this one
// first".
//
// Default OFF (env gate `CACHE_FIX_NORMALIZE_CC_VERSION`). Fail-open:
// any rewrite error leaves the body intact and logs a stderr warning.

const ENV_VAR = "CACHE_FIX_NORMALIZE_CC_VERSION";

let _firstFireLogged = false;

// Validates a pin value before we accept it. Reject empty, reject anything
// that would introduce a `;` or `=` (would break the surrounding header
// text grammar), reject whitespace. Keep the allowed alphabet tight —
// MAJOR.MINOR.PATCH plus a dotted suffix is what realistic operator pins
// look like; anything beyond ASCII alnum + `.` + `-` is suspect.
function isValidPinValue(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) return false;
  return /^[A-Za-z0-9.\-]+$/.test(v);
}

// Parse the env var into one of: { mode: "off" } | { mode: "strip" } |
// { mode: "pin", value: <string> } | { mode: "off", reason: <string> }
// (the last form is used when the env var is set but malformed).
export function parseMode(raw) {
  if (raw === undefined || raw === "" || raw === "off") return { mode: "off" };
  if (raw === "strip") return { mode: "strip" };
  if (typeof raw === "string" && raw.startsWith("pin:")) {
    const v = raw.slice(4);
    if (!isValidPinValue(v)) {
      return { mode: "off", reason: `invalid_pin_value: ${JSON.stringify(v).slice(0, 32)}` };
    }
    return { mode: "pin", value: v };
  }
  return { mode: "off", reason: `unrecognized_mode: ${JSON.stringify(raw).slice(0, 32)}` };
}

// Rewrite a single cc_version assignment inside an arbitrary header-text
// snippet. Returns { changed, text }. The match is anchored on
// `cc_version=` so it cannot fire on adjacent fields that happen to contain
// the substring.
export function rewriteCcVersion(text, parsedMode) {
  if (typeof text !== "string" || !text.includes("cc_version=")) {
    return { changed: false, text };
  }
  if (parsedMode.mode === "off") return { changed: false, text };

  // The cc_version assignment runs until the first `;` or end-of-line/string.
  // (The billing-header text grammar uses `;` as the separator between
  // assignments — same as `x-anthropic-billing-header:` and how
  // fingerprint-strip parses it.)
  const re = /cc_version=([^;\s]+)/g;
  let changed = false;
  const out = text.replace(re, (match, value) => {
    let newValue;
    if (parsedMode.mode === "strip") {
      const parts = value.split(".");
      if (parts.length <= 3) return match; // already 3 or fewer segments
      newValue = parts.slice(0, 3).join(".");
    } else if (parsedMode.mode === "pin") {
      newValue = parsedMode.value;
    } else {
      return match;
    }
    if (newValue === value) return match;
    changed = true;
    return `cc_version=${newValue}`;
  });
  return { changed, text: out };
}

export default {
  name: "cc-version-normalize",
  description:
    "Normalize cc_version inside the x-anthropic-billing-header to prevent per-build cache invalidation. " +
    "Modes via CACHE_FIX_NORMALIZE_CC_VERSION: off (default) | strip | pin:<value>. Addresses #238.",
  // Run BEFORE fingerprint-strip (order 100). After normalization the
  // version is 3 segments, so fingerprint-strip's "dotParts.length < 4"
  // guard makes it a no-op — the two cooperate cleanly.
  order: 90,

  async onRequest(ctx) {
    let parsed;
    try {
      parsed = parseMode(process.env[ENV_VAR]);
    } catch {
      return; // fail-open
    }
    if (parsed.mode === "off") {
      if (parsed.reason && !_firstFireLogged) {
        _firstFireLogged = true;
        try {
          process.stderr.write(
            `[cc-version-normalize] ${ENV_VAR} set to malformed value (${parsed.reason}); treating as off.\n`,
          );
        } catch {}
      }
      return;
    }

    const body = ctx && ctx.body;
    if (!body || !Array.isArray(body.system)) return;

    let mutatedAny = false;
    try {
      for (let i = 0; i < body.system.length; i += 1) {
        const block = body.system[i];
        if (!block || typeof block.text !== "string") continue;
        if (!block.text.includes("x-anthropic-billing-header:")) continue;
        const { changed, text } = rewriteCcVersion(block.text, parsed);
        if (changed) {
          body.system[i] = { ...block, text };
          mutatedAny = true;
        }
      }
    } catch (err) {
      // Fail-open: leave body intact, log once per process.
      if (!_firstFireLogged) {
        _firstFireLogged = true;
        try {
          process.stderr.write(
            `[cc-version-normalize] rewrite error (${err && err.message}); leaving body intact.\n`,
          );
        } catch {}
      }
      return;
    }

    if (mutatedAny && !_firstFireLogged) {
      _firstFireLogged = true;
      try {
        const modeDesc = parsed.mode === "strip" ? "strip" : `pin:${parsed.value}`;
        process.stderr.write(
          `[cc-version-normalize] active (${modeDesc}); first cc_version rewrite observed.\n`,
        );
      } catch {}
    }
  },
};

// Test seam — for unit tests that want to clear the once-per-process latch.
export function __resetFirstFireForTests() { _firstFireLogged = false; }
