// Shared family-roots table. Single source of truth for the family-name
// concept used by served-model divergence detection (PR #225, currently
// `proxy/extensions/cache-telemetry.mjs`'s sticky heuristic).
//
// Extracted from `cache-telemetry.mjs`'s inline `MODEL_FAMILY_MAP` as a
// preparatory refactor — when Anthropic ships a new model the maintenance
// edit lives here, not inside an extension file. Future extensions that
// need family classification can import `modelFamily` directly without
// pulling in the entire cache-telemetry module.
//
// Substring-match semantics: `root` is the substring matched against
// the lower-cased model id via `includes`. Order matters when two
// substrings could both match the same id; current entries don't
// collide but reviewers adding new families should verify.

export const MODEL_FAMILIES = [
  { root: "fable",             family: "fable"  },
  { root: "mythos",            family: "mythos" },
  { root: "claude-opus-4-7",   family: "opus"   },
  { root: "claude-opus-4-8",   family: "opus"   },
  { root: "claude-sonnet-4-6", family: "sonnet" },
  { root: "claude-sonnet-4-7", family: "sonnet" },
  { root: "claude-haiku-4-5",  family: "haiku"  },
];

// Family classification — substring-matched against the lowercased model
// id. Returns the family name (`"opus"` / `"sonnet"` / `"haiku"` /
// `"fable"` / `"mythos"`) or `"unknown"` if no entry matches.
//
// The substring shape intentionally catches dated point-release IDs like
// `claude-haiku-4-5-20251001` via the shorter `claude-haiku-4-5` token.
export function modelFamily(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) return "unknown";
  const lower = modelId.toLowerCase();
  for (const entry of MODEL_FAMILIES) {
    if (lower.includes(entry.root)) return entry.family;
  }
  return "unknown";
}
