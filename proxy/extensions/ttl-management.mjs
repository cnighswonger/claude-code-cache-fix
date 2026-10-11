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

// A subagent's continue request drops the SDK prefix from its system but keeps the agent-id header, so the
// id seen with the prefix classifies it. shortcut: capped at 1000 ids in insertion order; an evicted id's continue reads "main".
const SUBAGENT_IDS = new Set();
const MAX_SUBAGENT_IDS = 1000;

export { detectRequestType, injectTtl };

export default {
  name: "ttl-management",
  description: "Inject correct TTL on cache_control markers based on detected tier",
  order: 500,

  async onRequest(ctx) {
    const { body } = ctx;
    if (!body.system) return;

    let requestType = detectRequestType(body.system);
    const agentId = ctx.headers?.["x-claude-code-agent-id"];
    if (agentId && requestType === "subagent") {
      SUBAGENT_IDS.add(agentId);
      if (SUBAGENT_IDS.size > MAX_SUBAGENT_IDS) SUBAGENT_IDS.delete(SUBAGENT_IDS.values().next().value);
    } else if (agentId && SUBAGENT_IDS.has(agentId)) requestType = "subagent";
    const ttlValue = requestType === "subagent" ? TTL_SUBAGENT : TTL_MAIN;

    if (ttlValue === "none") return;

    const detectedTier = ctx.meta?._ttlTier || "1h";
    const ttlParam = ttlValue === "5m" || detectedTier === "5m" ? "5m" : "1h";

    // The API 400s on a 1h block after a 5m one (system, messages): a bare marker takes 1h when a 1h block follows it.
    let seen1h = false;
    const fill = (blocks) => {
      for (let i = blocks.length - 1; i >= 0; i--) {
        blocks[i] = injectTtl(blocks[i], seen1h ? "1h" : ttlParam);
        seen1h ||= blocks[i].cache_control?.ttl === "1h";
      }
    };

    if (Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        if (Array.isArray(body.messages[i].content)) fill(body.messages[i].content);
      }
    }
    if (Array.isArray(body.system)) fill(body.system);
  },
};
