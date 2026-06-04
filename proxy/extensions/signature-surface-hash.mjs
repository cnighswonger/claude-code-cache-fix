// signature-surface-hash — hash helper for thinking-block-sanitize v2.
//
// Computes a deterministic 16-hex-char fingerprint of the inputs that
// participate in the API's thinking-block signature: the tools surface,
// and (forward-compat) optionally the system block or anthropic-beta
// header value.
//
// v2 only passes `{ tools }`. The signature is left forward-compatible so
// a future v3 directive can extend coverage without renaming this helper.
//
// Canonicalization rules (per directive proxy-thinking-block-sanitize-v2.md):
//   - Each tool object: recursive stable JSON stringify with recursive key
//     sorting at every nesting level. Nested JSON-schema objects (in
//     input_schema, parameters, etc.) have their own keys, which also
//     sort stably.
//   - Preserve tools[] array order. Reordering tools changes which slot
//     which tool occupies in the API's view; the hash MUST reflect that.
//     (Note: sort-stabilization at order 200 currently locks the array
//     order before v2 fires, so this rule is forward-compatibility against
//     any future change in upstream ordering.)
//   - Sentinel for empty/absent: if tools is undefined, null, or [], the
//     hash input is the literal string "none". Rules out collision with
//     other empty-shaped inputs in a future extension.
//
// Output: sha256(canonical_input).slice(0, 16) — 16 hex chars matches the
// existing _sessionHealth / _thinkingSanitize precedent for in-JSON identifiers.

import { createHash } from "node:crypto";

// Recursive stable stringify: object keys sort, arrays preserve order,
// primitives go through JSON.stringify as-is. Handles nested objects and
// arrays to arbitrary depth.
export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(value[k]));
  return "{" + parts.join(",") + "}";
}

// Compute the signature-surface hash. v2 passes only { tools }; system and
// anthropic_beta are reserved for future versions.
export function computeSignatureSurfaceHash({ tools, system, anthropic_beta } = {}) {
  // Empty/absent tools → "none" sentinel (not the canonical-stringify of [],
  // which would be "[]" and could collide with other empty-shaped inputs).
  const toolsPart =
    tools == null || (Array.isArray(tools) && tools.length === 0)
      ? "none"
      : canonicalStringify(tools);
  // Reserved inputs — passed by future versions; v2 always omits them, so
  // they contribute nothing to the hash today. Kept in the signature so
  // existing call sites don't need to change when v3 adds them.
  void system;
  void anthropic_beta;
  return createHash("sha256").update(toolsPart).digest("hex").slice(0, 16);
}
