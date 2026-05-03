// ttl-tier-detect — port of preload.mjs:1815-1828 in-payload tier detection.
//
// Runs at order 75 (between read-only upstream-change-detection at 50 and
// every cache_control mutator) so that downstream strips by fresh-session-sort
// (250) and cache-control-normalize (400) cannot hide a ttl="5m" signal from
// ttl-management at order 500.
//
// Pure detection. Sets ctx.meta._ttlTier. Does not mutate ctx.body.

function detectExistingTier(body) {
  const blocks = [
    ...(Array.isArray(body?.system) ? body.system : []),
    ...(Array.isArray(body?.messages)
      ? body.messages.flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
      : []),
  ];
  for (const block of blocks) {
    if (block?.cache_control?.ttl === "5m") return "5m";
  }
  return "1h";
}

export { detectExistingTier };

export default {
  name: "ttl-tier-detect",
  description: "Detect existing TTL tier from incoming payload before cache_control normalization",
  order: 75,

  async onRequest(ctx) {
    ctx.meta._ttlTier = detectExistingTier(ctx.body);
  },
};
