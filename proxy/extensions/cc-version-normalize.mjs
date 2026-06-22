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

// Rewrite the cc_version assignment(s) inside an arbitrary header-text
// snippet. Returns { changed, text }.
//
// CRITICAL — Codex r1 blocker 1: the rewrite MUST anchor on a field
// boundary, not just the substring `cc_version=`. The billing-header text
// is a `;`-separated assignment list, optionally preceded by the
// `x-anthropic-billing-header:` leader, e.g.:
//
//   x-anthropic-billing-header: cc_version=2.1.185.hash; other=stuff
//
// A naive regex `/cc_version=([^;]+)/` matches the cc_version EMBEDDED
// inside another field's value, e.g. `other=prefix_cc_version=2.1.185.hash`
// would rewrite the inner occurrence and corrupt `other`.
//
// Fix: anchor on a field-boundary character — start-of-string, semicolon,
// colon, or whitespace. The regex captures that boundary in group 1 so
// the replacement preserves it verbatim. Whitespace divergence note: we
// terminate the value at the first `;` OR whitespace, matching the
// original implementation. Realistic cc_version values are alnum+dot and
// never contain whitespace, so a malformed value with embedded whitespace
// is treated as ending at the whitespace (defensive — fingerprint-strip
// uses `[^;]+` which would swallow whitespace, but stopping early is the
// safer choice for a field that should never contain a space).
const CC_VERSION_REGEX = /(^|[;\s:])cc_version=([^;\s]+)/g;

export function rewriteCcVersion(text, parsedMode) {
  if (typeof text !== "string" || !text.includes("cc_version=")) {
    return { changed: false, text };
  }
  if (parsedMode.mode === "off") return { changed: false, text };

  let changed = false;
  const out = text.replace(CC_VERSION_REGEX, (match, boundary, value) => {
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
    return `${boundary}cc_version=${newValue}`;
  });
  if (!changed) return { changed: false, text };
  return { changed: true, text: out };
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

    // Codex r1 blocker 2: the fail-open guarantee requires the body to be
    // BYTE-INTACT if any iteration throws. The previous in-loop mutation
    // could leave earlier blocks rewritten when a later block's access
    // threw. Stage all replacements first, then apply only after the scan
    // completes — atomic in the sense that either every planned rewrite
    // lands or none of them do.
    let mutatedAny = false;
    try {
      const replacements = []; // [{ index, newBlock }]
      for (let i = 0; i < body.system.length; i += 1) {
        const block = body.system[i];
        if (!block || typeof block.text !== "string") continue;
        if (!block.text.includes("x-anthropic-billing-header:")) continue;
        const { changed, text } = rewriteCcVersion(block.text, parsed);
        if (changed) {
          replacements.push({ index: i, newBlock: { ...block, text } });
        }
      }
      // Scan succeeded — apply atomically.
      for (const r of replacements) {
        body.system[r.index] = r.newBlock;
      }
      mutatedAny = replacements.length > 0;
    } catch (err) {
      // Fail-open: any error during the scan leaves body byte-intact
      // (no replacements applied because we hadn't reached the apply phase).
      // Log once per process.
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
