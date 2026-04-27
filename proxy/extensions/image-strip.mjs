import { parseImageDimensions } from "../image-dimensions.mjs";

const KEEP_LAST = parseInt(process.env.CACHE_FIX_IMAGE_KEEP_LAST || "0", 10);
const MAX_DIM = parseInt(process.env.CACHE_FIX_IMAGE_MAX_DIM || "0", 10);
const PLACEHOLDER = "[image stripped from history — file may still be on disk]";

function oversizedPlaceholder(maxDim, w, h) {
  return `[image stripped — exceeded ${maxDim}px max dimension (was ${w}x${h}px)]`;
}

function stripOldToolResultImages(messages, keepLast) {
  if (!keepLast || keepLast <= 0 || !Array.isArray(messages)) {
    return { messages, stats: null };
  }

  const userMsgIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userMsgIndices.push(i);
  }

  if (userMsgIndices.length <= keepLast) {
    return { messages, stats: null };
  }

  const cutoffIdx = userMsgIndices[userMsgIndices.length - keepLast];

  let strippedCount = 0;
  let strippedBytes = 0;

  const result = messages.map((msg, msgIdx) => {
    if (msg.role !== "user" || msgIdx >= cutoffIdx || !Array.isArray(msg.content)) {
      return msg;
    }

    let msgModified = false;
    const newContent = msg.content.map((block) => {
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        let toolModified = false;
        const newToolContent = block.content.map((item) => {
          if (item.type === "image") {
            strippedCount++;
            if (item.source?.data) {
              strippedBytes += item.source.data.length;
            }
            toolModified = true;
            return { type: "text", text: PLACEHOLDER };
          }
          return item;
        });
        if (toolModified) {
          msgModified = true;
          return { ...block, content: newToolContent };
        }
      }
      return block;
    });

    return msgModified ? { ...msg, content: newContent } : msg;
  });

  const stats = strippedCount > 0
    ? { strippedCount, strippedBytes, estimatedTokens: Math.ceil(strippedBytes * 0.125) }
    : null;

  return { messages: strippedCount > 0 ? result : messages, stats };
}

// Strip oversized images from BOTH user-message direct content and
// tool_result-nested content. Orthogonal to KEEP_LAST: scans every image
// remaining in the message list and replaces any whose width or height
// exceeds maxDim. Fail-open: images we can't measure (unsupported format,
// truncated header) are kept rather than stripped.
//
// Stripping by oversize prevents the Anthropic API error:
//   "An image in the conversation exceeds the dimension limit for many-image
//    requests (2000px). Start a new session with fewer images."
function stripOversizedImages(messages, maxDim) {
  if (!maxDim || maxDim <= 0 || !Array.isArray(messages)) {
    return { messages, stats: null };
  }

  let strippedCount = 0;
  let strippedBytes = 0;

  function maybeStrip(item) {
    if (!item || item.type !== "image") return item;
    const src = item.source;
    if (!src || !src.data || !src.media_type) return item;
    const dims = parseImageDimensions(src.media_type, src.data);
    if (!dims) return item; // can't measure → keep
    if (dims.width <= maxDim && dims.height <= maxDim) return item;
    strippedCount++;
    strippedBytes += src.data.length;
    return { type: "text", text: oversizedPlaceholder(maxDim, dims.width, dims.height) };
  }

  const result = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    let mutated = false;
    const newContent = msg.content.map((block) => {
      // Direct image block on a user message
      if (block && block.type === "image") {
        const replaced = maybeStrip(block);
        if (replaced !== block) {
          mutated = true;
          return replaced;
        }
        return block;
      }
      // Image nested inside a tool_result.content array
      if (block && block.type === "tool_result" && Array.isArray(block.content)) {
        let toolMutated = false;
        const newToolContent = block.content.map((item) => {
          const replaced = maybeStrip(item);
          if (replaced !== item) toolMutated = true;
          return replaced;
        });
        if (toolMutated) {
          mutated = true;
          return { ...block, content: newToolContent };
        }
      }
      return block;
    });
    return mutated ? { ...msg, content: newContent } : msg;
  });

  const stats = strippedCount > 0
    ? { strippedCount, strippedBytes, estimatedTokens: Math.ceil(strippedBytes * 0.125) }
    : null;

  return { messages: strippedCount > 0 ? result : messages, stats };
}

export { stripOldToolResultImages, stripOversizedImages, PLACEHOLDER, oversizedPlaceholder };

export default {
  name: "image-strip",
  description:
    "Strip base64 images from old tool results AND optionally strip oversized images that would trigger Anthropic's many-image dimension limit",
  enabled: false,
  order: 150,

  async onRequest(ctx) {
    const keepLast = parseInt(ctx.meta.imageKeepLast ?? KEEP_LAST, 10);
    const maxDim = parseInt(ctx.meta.imageMaxDim ?? MAX_DIM, 10);
    if ((!keepLast || keepLast <= 0) && (!maxDim || maxDim <= 0)) return;
    if (!ctx.body.messages) return;

    let messages = ctx.body.messages;
    const logParts = [];

    // Pass 1: existing keep_last behavior. Sets ctx.meta.imageStripStats with
    // the same shape as before this PR — back-compat preserved.
    if (keepLast > 0) {
      const r = stripOldToolResultImages(messages, keepLast);
      if (r.stats) {
        messages = r.messages;
        ctx.meta.imageStripStats = r.stats;
        logParts.push(`keep_last: ${r.stats.strippedCount} stripped (~${r.stats.estimatedTokens} tokens saved)`);
      }
    }

    // Pass 2: new max_dim behavior. Stats land on a new field so consumers
    // already reading imageStripStats don't see a shape change.
    if (maxDim > 0) {
      const r = stripOversizedImages(messages, maxDim);
      if (r.stats) {
        messages = r.messages;
        ctx.meta.imageStripOversizedStats = r.stats;
        logParts.push(`max_dim: ${r.stats.strippedCount} oversized stripped (~${r.stats.estimatedTokens} tokens saved)`);
      }
    }

    if (logParts.length > 0) {
      ctx.body.messages = messages;
      process.stderr.write(`[image-strip] ${logParts.join("; ")}\n`);
    }
  },
};
