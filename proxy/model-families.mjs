// Shared family-roots table for the model-id family domain. Single source
// of truth consumed by both:
//
//   1. `cache-telemetry.mjs` served-model divergence detector (issue #223,
//      PR #225) — uses substring matching of `canonical model ID → family
//      root` to classify cross-family vs same-family swaps in the sticky
//      heuristic.
//
//   2. `model-id-sanitize.mjs` (issue #227, this directive) — uses the
//      reverse `family root → fallback target` direction to choose a safe
//      rewrite when the operator's `body.model` is malformed and no exact
//      canonical ID is recoverable from inside the malformed value.
//
// Selection rationale for the fallback target is **oldest in-family wire
// ID**, NOT cheapest. Anthropic's pricing currently puts Opus 4.6/4.7/4.8
// at the same `$5/$25 MTok` point, so picking 4.6 is a capability
// downgrade at the same price. "Oldest in-family" minimizes accidental
// upgrade from the operator's intent — if the operator's settings.json
// got corrupted, they almost certainly intended what they had been using,
// which was the variant available before the most recent in-family
// release. Fable / Mythos targets are an availability fallback (both
// currently suspended per Anthropic's 2026-06-12 notice), not cost.
//
// Substring-match semantics: the `root` field is the substring matched
// against the lower-cased model ID. This intentionally catches dated
// point-release IDs like `claude-haiku-4-5-20251001` via the shorter
// `haiku` family token. Order matters when two substrings could both
// match the same id; current entries don't collide but reviewers adding
// new families should verify.

export const MODEL_FAMILIES = [
  // Family roots used by BOTH consumers. `root` is the substring matched
  // against lowercased model id (sub-string `includes`) for family
  // classification. `fallbackTarget` is the canonical wire ID used when
  // the model-id-sanitize extension's family-fallback path fires.
  //
  // Fable and Mythos are currently suspended (Anthropic 2026-06-12); the
  // fallback target is cross-family (Sonnet) as the availability path.
  // When Anthropic re-enables either family, update the fallbackTarget to
  // the appropriate oldest-in-family wire ID at re-enable time.
  { root: "fable",            family: "fable",  fallbackTarget: "claude-sonnet-4-6" },
  { root: "mythos",           family: "mythos", fallbackTarget: "claude-sonnet-4-6" },
  { root: "claude-opus-4-7",  family: "opus",   fallbackTarget: "claude-opus-4-6" },
  { root: "claude-opus-4-8",  family: "opus",   fallbackTarget: "claude-opus-4-6" },
  { root: "claude-sonnet-4-6", family: "sonnet", fallbackTarget: "claude-sonnet-4-6" },
  { root: "claude-sonnet-4-7", family: "sonnet", fallbackTarget: "claude-sonnet-4-6" },
  { root: "claude-haiku-4-5", family: "haiku",  fallbackTarget: "claude-haiku-4-5-20251001" },
];

// Family-root substrings (lowercase) used by the model-id-sanitize
// extension's family-fallback recovery path when exact canonical full-ID
// recovery fails. Distinct from MODEL_FAMILIES.root because a single
// family root (e.g. "opus") is what the sanitize extension looks for
// inside a malformed value — multiple MODEL_FAMILIES entries (4-7, 4-8)
// share the same family-root substring.
export const FAMILY_ROOT_FALLBACKS = [
  { root: "opus",   fallbackTarget: "claude-opus-4-6" },
  { root: "sonnet", fallbackTarget: "claude-sonnet-4-6" },
  { root: "haiku",  fallbackTarget: "claude-haiku-4-5-20251001" },
  { root: "fable",  fallbackTarget: "claude-sonnet-4-6" },
  { root: "mythos", fallbackTarget: "claude-sonnet-4-6" },
];

// Family classification — substring-matched against the lowercased model
// id. Returns the family name (`"opus"` / `"sonnet"` / `"haiku"` /
// `"fable"` / `"mythos"`) or `"unknown"` if no entry matches.
export function modelFamily(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) return "unknown";
  const lower = modelId.toLowerCase();
  for (const entry of MODEL_FAMILIES) {
    if (lower.includes(entry.root)) return entry.family;
  }
  return "unknown";
}
