// Shared rate constants for cost projections.
//
// This is a deliberate over-simplification for v3.2.0. Anthropic's
// per-token rates vary by model, by cache tier (input vs cache_read vs
// cache_creation_5m vs cache_creation_1h), and by overage classification.
// Encoding all of that correctly is its own subproject — see the v3.3.0
// follow-up for a precise per-tier engine.
//
// For v3.2.0 we ship a single weighted blend constant suitable for
// a coarse "burn rate at API rates" indicator. Consumers MUST label the
// resulting number as `coarse` so users do not mistake it for a precise
// quote.

// Heuristic blend covering input + cache_read + cache_creation + output
// at a typical Opus 4.7 mix. Order of magnitude is right; precise it is not.
export const WEIGHTED_TOKEN_COST_USD_COARSE = 0.000005;
