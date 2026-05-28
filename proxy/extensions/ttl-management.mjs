const TTL_MAIN = (process.env.CACHE_FIX_TTL_MAIN || "1h").toLowerCase();
const TTL_SUBAGENT = (process.env.CACHE_FIX_TTL_SUBAGENT || "1h").toLowerCase();
const AGENT_SDK_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

function detectRequestType(system) {
  if (!Array.isArray(system)) return "main";
  const isSubagent = system.some(
    (b) => b?.type === "text" && typeof b.text === "string" && b.text.startsWith(AGENT_SDK_PREFIX)
  );
  return isSubagent ? "subagent" : "main";
}

// Thinking and redacted_thinking blocks must be returned to the API byte-identical
// to the original model response — the API validates them and rejects any
// modification with "thinking blocks ... cannot be modified" (a 400 on the whole
// request). On Opus 4.7 interleaved thinking, CC can place a cache_control
// breakpoint on a thinking block; injecting a ttl there would mutate the block
// and break the request. Skip them — the marginal TTL benefit on one breakpoint
// is never worth corrupting a thinking turn.
const PROTECTED_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

function injectTtl(block, ttlParam) {
  if (block && PROTECTED_BLOCK_TYPES.has(block.type)) return block;
  if (block.cache_control?.type === "ephemeral" && !block.cache_control.ttl) {
    return { ...block, cache_control: { ...block.cache_control, ttl: ttlParam } };
  }
  return block;
}

export { detectRequestType, injectTtl };

export default {
  name: "ttl-management",
  description: "Inject correct TTL on cache_control markers based on detected tier",
  order: 500,

  async onRequest(ctx) {
    const { body } = ctx;
    if (!body.system) return;

    const requestType = detectRequestType(body.system);
    const ttlValue = requestType === "subagent" ? TTL_SUBAGENT : TTL_MAIN;

    if (ttlValue === "none") return;

    const detectedTier = ctx.meta?._ttlTier || "1h";
    const ttlParam = ttlValue === "5m" || detectedTier === "5m" ? "5m" : "1h";

    if (Array.isArray(body.system)) {
      body.system = body.system.map((block) => injectTtl(block, ttlParam));
    }

    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (let i = 0; i < msg.content.length; i++) {
          msg.content[i] = injectTtl(msg.content[i], ttlParam);
        }
      }
    }
  },
};
