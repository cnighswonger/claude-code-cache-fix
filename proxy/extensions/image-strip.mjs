// image-strip extension — back-compat for v3.2.1 KEEP_LAST/MAX_DIM behavior
// PLUS the v3.3.0 image-guard pipeline.
//
// Activation pattern: `enabled: true` in extensions.json (the extension is
// always loaded), runtime gates per-feature via env vars. Three independent
// trigger surfaces:
//
//   - CACHE_FIX_IMAGE_KEEP_LAST=N        → legacy Pass 0 (count cap on
//                                          tool_result images in user msgs)
//   - CACHE_FIX_IMAGE_MAX_DIM=N          → legacy Pass 1 strip-only (back-compat)
//   - CACHE_FIX_IMAGE_GUARD=1            → v3.3.0 pipeline (Pass 1 + 2 + count cap)
//   - CACHE_FIX_IMAGE_GUARD=1 +
//     CACHE_FIX_IMAGE_PRESERVE_DETAIL=1  → adds Pass 3 (Lanczos resize via sharp)
//
// Execution order: Pass 0 → Pass 3 → Pass 1 → Pass 2 → image-count cap.
//
// See `docs/directives/proxy-image-guard-pipeline.md` for full spec, including
// the precedence matrix and per-pass trigger/action contracts.

import { parseImageDimensions } from "../image-dimensions.mjs";
import { resizeImageToCap } from "../image-resize.mjs";

// --- Legacy v3.2.1 constants (back-compat) ---
const KEEP_LAST = parseInt(process.env.CACHE_FIX_IMAGE_KEEP_LAST || "0", 10);
const MAX_DIM = parseInt(process.env.CACHE_FIX_IMAGE_MAX_DIM || "0", 10);
const PLACEHOLDER = "[image stripped from history — file may still be on disk]";

function oversizedPlaceholder(maxDim, w, h) {
  return `[image stripped — exceeded ${maxDim}px max dimension (was ${w}x${h}px)]`;
}

// --- v3.3.0 pipeline env helpers (read at call time, not at module load,
// so per-test isolation works without re-importing the module) ---
function isImageGuardEnabled() {
  return process.env.CACHE_FIX_IMAGE_GUARD === "1";
}
function isPreserveDetailEnabled() {
  return process.env.CACHE_FIX_IMAGE_PRESERVE_DETAIL === "1";
}
function getMaxDim() {
  return parseInt(process.env.CACHE_FIX_IMAGE_MAX_DIM || "0", 10);
}
function getKeepLast() {
  return parseInt(process.env.CACHE_FIX_IMAGE_KEEP_LAST || "0", 10);
}
function getRequestSizeMax() {
  // Default 30 MB (31457280 bytes). 2 MB headroom from Anthropic's 32 MB body limit.
  const v = parseInt(process.env.CACHE_FIX_IMAGE_REQUEST_SIZE_MAX || "31457280", 10);
  return v > 0 ? v : 31457280;
}
function getImageCountMax() {
  // Default 100 — single cap covering the only model family in active CC use.
  // Users on legacy Claude 1/2.x/Instant who genuinely need 600 can override.
  const v = parseInt(process.env.CACHE_FIX_IMAGE_COUNT_MAX || "100", 10);
  return v > 0 ? v : 100;
}

// --- Legacy Pass 0: KEEP_LAST tool_result image strip ---
// (Unchanged from v3.2.1 — only formatting tightened.)
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

// --- Legacy Pass 1 (strip-only by max dim) ---
// (Unchanged from v3.2.1.) The new pipeline's Pass 1 is a separate function
// (`runPass1RejectionCapStrip`) that uses the conditional 2000/8000 logic.
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
    if (!dims) return item;
    if (dims.width <= maxDim && dims.height <= maxDim) return item;
    strippedCount++;
    strippedBytes += src.data.length;
    return { type: "text", text: oversizedPlaceholder(maxDim, dims.width, dims.height) };
  }

  const result = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    let mutated = false;
    const newContent = msg.content.map((block) => {
      if (block && block.type === "image") {
        const replaced = maybeStrip(block);
        if (replaced !== block) {
          mutated = true;
          return replaced;
        }
        return block;
      }
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

// =============================================================================
// v3.3.0 pipeline
// =============================================================================

// --- Pure helpers (exported for tests) ---

// Pass 1 cap selector. `maxDimOverride > 0` always wins over the conditional
// rejection cap. Otherwise: count > 20 → 2000 px, else 8000 px.
function pickPass1Cap(imageCount, maxDimOverride) {
  if (maxDimOverride && maxDimOverride > 0) return maxDimOverride;
  return imageCount > 20 ? 2000 : 8000;
}

// Pass 3 native-cap selector. Only Opus 4.7 has the higher cap.
function pickPass3NativeCap(modelString) {
  if (typeof modelString === "string" && modelString.startsWith("claude-opus-4-7")) {
    return 2576;
  }
  return 1568;
}

// Anthropic's documented per-image token formula: `width * height / 750`,
// capped at the model's native token cap. Diagnostic only (no enforcement).
function estimateImageTokens(width, height, modelTokenCap) {
  if (!width || !height) return 0;
  const raw = Math.ceil((width * height) / 750);
  if (modelTokenCap && raw > modelTokenCap) return modelTokenCap;
  return raw;
}

function nativeTokenCap(modelString) {
  if (typeof modelString === "string" && modelString.startsWith("claude-opus-4-7")) {
    return 4784;
  }
  return 1568;
}

// Walker: enumerate every image in `body.messages`, both user-msg direct content
// and tool_result.content. Returns a list of `{ msgIdx, blockIdx, itemIdx | null,
// item }` references. `itemIdx === null` means the image is a direct user-msg
// content block (not nested in tool_result).
function walkImages(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m];
    if (!Array.isArray(msg.content)) continue;
    for (let b = 0; b < msg.content.length; b++) {
      const block = msg.content[b];
      if (!block) continue;
      if (block.type === "image") {
        out.push({ msgIdx: m, blockIdx: b, itemIdx: null, item: block });
      } else if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (let i = 0; i < block.content.length; i++) {
          const item = block.content[i];
          if (item && item.type === "image") {
            out.push({ msgIdx: m, blockIdx: b, itemIdx: i, item });
          }
        }
      }
    }
  }
  return out;
}

// Mutate a single image at the given (msgIdx, blockIdx, itemIdx) reference,
// either replacing it with a placeholder text block (strip) or updating its
// source.data + dims (resize).
function replaceImageInPlace(messages, ref, replacement) {
  const msg = messages[ref.msgIdx];
  if (!msg || !Array.isArray(msg.content)) return;
  const block = msg.content[ref.blockIdx];
  if (!block) return;
  if (ref.itemIdx === null) {
    msg.content[ref.blockIdx] = replacement;
  } else {
    if (!Array.isArray(block.content)) return;
    block.content[ref.itemIdx] = replacement;
  }
}

// Pure walker for Pass 1: returns the list of image refs whose long edge
// exceeds `capPx`, alongside their measured dims. Unparseable images are not
// included (fail-open). Exposed for tests.
function walkImagesForPass1(messages, capPx) {
  const refs = walkImages(messages);
  const plan = [];
  for (const ref of refs) {
    const src = ref.item.source;
    if (!src || !src.data || !src.media_type) continue;
    const dims = parseImageDimensions(src.media_type, src.data);
    if (!dims) {
      plan.push({ ref, dims: null, action: "skip_unmeasurable" });
      continue;
    }
    const longEdge = Math.max(dims.width, dims.height);
    if (longEdge > capPx) {
      plan.push({ ref, dims, action: "strip" });
    }
  }
  return plan;
}

// Pure walker for Pass 3: returns refs whose long edge exceeds `nativeCapPx`,
// plus the dims/cap so the caller can do the actual resize.
function walkImagesForPass3(messages, nativeCapPx) {
  const refs = walkImages(messages);
  const plan = [];
  for (const ref of refs) {
    const src = ref.item.source;
    if (!src || !src.data || !src.media_type) continue;
    const dims = parseImageDimensions(src.media_type, src.data);
    if (!dims) {
      plan.push({ ref, dims: null, action: "skip_unmeasurable" });
      continue;
    }
    const longEdge = Math.max(dims.width, dims.height);
    if (longEdge > nativeCapPx) {
      plan.push({ ref, dims, action: "resize", capPx: nativeCapPx });
    }
  }
  return plan;
}

// Eviction order for Pass 2 / count cap: oldest first (low msgIdx wins),
// within a message tool_result images are preferred over direct images at the
// same age. Returns an ordered list of refs to drop.
function pickEvictionTargets(messages) {
  const refs = walkImages(messages);
  // Stable sort: by msgIdx ascending, then prefer tool_result (itemIdx !== null)
  // over direct (itemIdx === null) at the same msgIdx.
  refs.sort((a, b) => {
    if (a.msgIdx !== b.msgIdx) return a.msgIdx - b.msgIdx;
    const aTool = a.itemIdx !== null ? 0 : 1;
    const bTool = b.itemIdx !== null ? 0 : 1;
    if (aTool !== bTool) return aTool - bTool;
    if (a.blockIdx !== b.blockIdx) return a.blockIdx - b.blockIdx;
    return (a.itemIdx ?? 0) - (b.itemIdx ?? 0);
  });
  return refs;
}

// --- Stats initializer (matches the directive's telemetry surface verbatim) ---
function initStats() {
  return {
    total_images: 0,
    count_axis_path: "few",
    unsupported_format_count: 0,
    dimension_probe_fail_count: 0,
    resize_attempted: 0,
    resize_succeeded: 0,
    resize_failed: 0,
    library_missing: false,
    images_stripped_pass1: 0,
    images_dropped_for_size: 0,
    images_dropped_for_count_cap: 0,

    request_bytes_before: 0,
    request_bytes_after: 0,
    request_bytes_headroom: 0,
    image_bytes_total: 0,
    image_bytes_dropped: 0,

    estimated_image_tokens_total: 0,
  };
}

// --- Pass 3 runtime: native-cap resize via sharp ---
async function runPass3NativeCapResize(reqCtx, stats) {
  if (stats.library_missing) return;

  const messages = reqCtx.body.messages;
  const model = reqCtx.body.model;
  const nativeCap = pickPass3NativeCap(model);
  const tokenCap = nativeTokenCap(model);

  const plan = walkImagesForPass3(messages, nativeCap);
  for (const step of plan) {
    if (step.action === "skip_unmeasurable") {
      // Tracked separately via the unsupported/probe counters at the top-level
      // walker (we double-count if we touch them here too — leave it to the
      // central counter pass).
      continue;
    }
    if (step.action !== "resize") continue;

    const src = step.ref.item.source;
    stats.resize_attempted++;
    const result = await resizeImageToCap(src.data, src.media_type, step.capPx);
    if (result.ok) {
      stats.resize_succeeded++;
      // Mutate in place: keep the same content block shape, swap data + record dims.
      const newImage = {
        ...step.ref.item,
        source: { ...src, data: result.base64 },
      };
      replaceImageInPlace(messages, step.ref, newImage);
      const tokensBefore = estimateImageTokens(step.dims.width, step.dims.height, tokenCap);
      const tokensAfter = estimateImageTokens(result.dims.width, result.dims.height, tokenCap);
      stats.estimated_image_tokens_total += tokensAfter - tokensBefore;
    } else if (result.reason === "library_missing") {
      stats.library_missing = true;
      // Sticky: stop attempting Pass 3 for the remainder of this request.
      // (loadSharp() inside image-resize.mjs is also sticky for the process.)
      return;
    } else {
      stats.resize_failed++;
      // Leave image untouched; Pass 1 will evaluate it against its own cap.
    }
  }
}

// --- Pass 1 runtime: conditional rejection-cap strip ---
function runPass1RejectionCapStrip(reqCtx, stats, opts) {
  const { maxDimOverride } = opts || {};
  const messages = reqCtx.body.messages;

  const refs = walkImages(messages);
  const imageCount = refs.length;
  stats.total_images = Math.max(stats.total_images, imageCount);
  stats.count_axis_path = imageCount > 20 ? "many" : "few";
  const cap = pickPass1Cap(imageCount, maxDimOverride);

  for (const ref of refs) {
    const src = ref.item.source;
    if (!src || !src.data || !src.media_type) continue;
    const dims = parseImageDimensions(src.media_type, src.data);
    if (!dims) {
      // Distinguish unsupported format from probe failure on a known type.
      const mt = (src.media_type || "").toLowerCase();
      if (mt === "image/png" || mt === "image/jpeg" || mt === "image/jpg") {
        stats.dimension_probe_fail_count++;
      } else {
        stats.unsupported_format_count++;
      }
      continue;
    }
    const longEdge = Math.max(dims.width, dims.height);
    if (longEdge > cap) {
      replaceImageInPlace(messages, ref, {
        type: "text",
        text: oversizedPlaceholder(cap, dims.width, dims.height),
      });
      stats.images_stripped_pass1++;
    }
  }
}

// --- Pass 2 runtime: request-size guard ---
function runPass2RequestSizeGuard(reqCtx, stats) {
  const budget = getRequestSizeMax();
  const before = Buffer.byteLength(JSON.stringify(reqCtx.body));
  if (stats.request_bytes_before === 0) stats.request_bytes_before = before;

  if (before <= budget) {
    stats.request_bytes_after = before;
    stats.request_bytes_headroom = budget - before;
    return;
  }

  // Build eviction queue once; drop one at a time, re-measuring after each drop.
  const queue = pickEvictionTargets(reqCtx.body.messages);
  let bytes = before;
  for (const ref of queue) {
    if (bytes <= budget) break;
    const src = ref.item.source;
    const droppedBytes = src && src.data ? src.data.length : 0;
    replaceImageInPlace(reqCtx.body.messages, ref, {
      type: "text",
      text: "[image dropped to fit request-size budget]",
    });
    stats.images_dropped_for_size++;
    stats.image_bytes_dropped += droppedBytes;
    bytes = Buffer.byteLength(JSON.stringify(reqCtx.body));
  }
  stats.request_bytes_after = bytes;
  stats.request_bytes_headroom = budget - bytes;
  // If we exhausted the queue and bytes still exceed budget, the body is
  // over-budget for non-image reasons; the request will fail upstream and we
  // don't address that here. Telemetry already records the final bytes.
}

// --- Hard image-count cap ---
function runImageCountCap(reqCtx, stats) {
  const cap = getImageCountMax();
  const queue = pickEvictionTargets(reqCtx.body.messages);
  if (queue.length <= cap) return;
  const toDrop = queue.length - cap;
  for (let i = 0; i < toDrop; i++) {
    const ref = queue[i];
    const src = ref.item.source;
    const droppedBytes = src && src.data ? src.data.length : 0;
    replaceImageInPlace(reqCtx.body.messages, ref, {
      type: "text",
      text: "[image dropped — exceeded image-count cap]",
    });
    stats.images_dropped_for_count_cap++;
    stats.image_bytes_dropped += droppedBytes;
  }
  // Recompute request_bytes_after after count-cap evictions so the final
  // telemetry reflects the post-pipeline body. Without this, count-cap-only
  // requests would report unchanged byte totals (Codex review note).
  if (toDrop > 0) {
    const budget = getRequestSizeMax();
    const after = Buffer.byteLength(JSON.stringify(reqCtx.body));
    stats.request_bytes_after = after;
    stats.request_bytes_headroom = budget - after;
  }
}

// --- Telemetry: walk surviving images for byte/token totals ---
function finalizeTelemetry(reqCtx, stats) {
  const refs = walkImages(reqCtx.body.messages);
  let totalBytes = 0;
  let totalTokens = 0;
  const tokenCap = nativeTokenCap(reqCtx.body.model);
  for (const ref of refs) {
    const src = ref.item.source;
    if (!src || !src.data) continue;
    totalBytes += src.data.length;
    const dims = parseImageDimensions(src.media_type, src.data);
    if (dims) {
      totalTokens += estimateImageTokens(dims.width, dims.height, tokenCap);
    }
  }
  stats.image_bytes_total = totalBytes;
  // estimated_image_tokens_total was decremented by Pass 3 deltas; for the
  // baseline (Pass 3 disabled) recompute from surviving images.
  if (stats.resize_attempted === 0) {
    stats.estimated_image_tokens_total = totalTokens;
  } else {
    // Pass 3 mutated in place; re-measure surviving population to ground-truth.
    stats.estimated_image_tokens_total = totalTokens;
  }
}

// --- Top-level pipeline orchestrator ---
async function runImageGuard(reqCtx) {
  const stats = initStats();
  const messages = reqCtx.body.messages;
  if (!Array.isArray(messages)) return stats;

  // Capture initial population count for the summary line.
  stats.total_images = walkImages(messages).length;
  stats.count_axis_path = stats.total_images > 20 ? "many" : "few";

  const guardOn = isImageGuardEnabled();
  const preserveOn = isPreserveDetailEnabled();
  const maxDimOverride = getMaxDim();

  // Warn if PRESERVE_DETAIL is set without IMAGE_GUARD (one-time per process).
  if (!guardOn && preserveOn && !_preserveDetailWarned) {
    process.stderr.write(
      "[image-guard] CACHE_FIX_IMAGE_PRESERVE_DETAIL=1 has no effect without CACHE_FIX_IMAGE_GUARD=1\n"
    );
    _preserveDetailWarned = true;
  }

  // Pass 3: native-cap resize (only when both gates are on)
  if (guardOn && preserveOn) {
    await runPass3NativeCapResize(reqCtx, stats);
  }

  // Pass 1: rejection-cap strip — runs if IMAGE_GUARD=1 OR legacy MAX_DIM > 0
  if (guardOn || maxDimOverride > 0) {
    runPass1RejectionCapStrip(reqCtx, stats, { maxDimOverride });
  }

  // Pass 2: request-size guard — IMAGE_GUARD only
  if (guardOn) {
    runPass2RequestSizeGuard(reqCtx, stats);
  }

  // Hard image-count cap — IMAGE_GUARD only
  if (guardOn) {
    runImageCountCap(reqCtx, stats);
  }

  // Final telemetry sweep over surviving images
  finalizeTelemetry(reqCtx, stats);

  return stats;
}

// One-time warning state for PRESERVE_DETAIL-without-GUARD.
let _preserveDetailWarned = false;

// Test hook to reset warning flag.
function _resetWarningStateForTests() {
  _preserveDetailWarned = false;
}

export {
  // Legacy v3.2.1 exports (kept stable for back-compat tests)
  stripOldToolResultImages,
  stripOversizedImages,
  PLACEHOLDER,
  oversizedPlaceholder,
  // v3.3.0 pipeline pure functions (test seams)
  pickPass1Cap,
  pickPass3NativeCap,
  estimateImageTokens,
  walkImagesForPass1,
  walkImagesForPass3,
  pickEvictionTargets,
  // Orchestrator (used by the extension default export and direct test calls)
  runImageGuard,
  // Test utilities
  _resetWarningStateForTests,
};

export default {
  name: "image-strip",
  description:
    "v3.2.1 KEEP_LAST/MAX_DIM legacy paths PLUS v3.3.0 image-guard pipeline " +
    "(conditional rejection cap + request-size guard + optional Lanczos resize)",
  enabled: false,        // overridden by extensions.json
  order: 150,

  async onRequest(ctx) {
    const guardOn = isImageGuardEnabled();
    const preserveOn = isPreserveDetailEnabled();
    // ctx.meta overrides allow tests to drive the legacy paths without env vars.
    // Pipeline gates (IMAGE_GUARD, PRESERVE_DETAIL) remain env-only — tests that
    // need to flip them set process.env directly.
    const keepLast = parseInt(ctx.meta?.imageKeepLast ?? getKeepLast(), 10);
    const maxDim = parseInt(ctx.meta?.imageMaxDim ?? getMaxDim(), 10);

    // Short-circuit: nothing to do.
    if (!guardOn && keepLast <= 0 && maxDim <= 0) {
      // Surface the PRESERVE_DETAIL-without-GUARD warning even when the
      // pipeline doesn't run otherwise.
      if (preserveOn && !_preserveDetailWarned) {
        process.stderr.write(
          "[image-guard] CACHE_FIX_IMAGE_PRESERVE_DETAIL=1 has no effect without CACHE_FIX_IMAGE_GUARD=1\n"
        );
        _preserveDetailWarned = true;
      }
      return;
    }

    if (!ctx.body || !ctx.body.messages) return;

    // ========== Legacy path (v3.2.1 back-compat) ==========
    // When IMAGE_GUARD=1 is OFF but legacy env vars are set, run the v3.2.1
    // pipeline exactly as before — preserves bug-for-bug compatibility for
    // existing users.
    if (!guardOn) {
      let messages = ctx.body.messages;
      const logParts = [];

      if (keepLast > 0) {
        const r = stripOldToolResultImages(messages, keepLast);
        if (r.stats) {
          messages = r.messages;
          ctx.meta.imageStripStats = r.stats;
          logParts.push(
            `keep_last: ${r.stats.strippedCount} stripped (~${r.stats.estimatedTokens} tokens saved)`
          );
        }
      }

      if (maxDim > 0) {
        const r = stripOversizedImages(messages, maxDim);
        if (r.stats) {
          messages = r.messages;
          ctx.meta.imageStripOversizedStats = r.stats;
          logParts.push(
            `max_dim: ${r.stats.strippedCount} oversized stripped ` +
            `(~${r.stats.estimatedTokens} tokens saved)`
          );
        }
      }

      if (logParts.length > 0) {
        ctx.body.messages = messages;
        process.stderr.write(`[image-strip] ${logParts.join("; ")}\n`);
      }
      return;
    }

    // ========== v3.3.0 pipeline path ==========
    // KEEP_LAST runs first as Pass 0 (back-compat behavior preserved).
    if (keepLast > 0) {
      const r = stripOldToolResultImages(ctx.body.messages, keepLast);
      if (r.stats) {
        ctx.body.messages = r.messages;
        ctx.meta.imageStripStats = r.stats;
      }
    }

    const stats = await runImageGuard(ctx);
    ctx.meta.imageGuardStats = stats;

    // Emit summary only if the pipeline actually did anything observable.
    const didSomething =
      stats.images_stripped_pass1 > 0 ||
      stats.images_dropped_for_size > 0 ||
      stats.images_dropped_for_count_cap > 0 ||
      stats.resize_attempted > 0 ||
      stats.resize_succeeded > 0 ||
      stats.unsupported_format_count > 0 ||
      stats.dimension_probe_fail_count > 0;
    if (didSomething) {
      const parts = [];
      if (stats.resize_succeeded > 0) parts.push(`resized=${stats.resize_succeeded}`);
      if (stats.resize_failed > 0) parts.push(`resize_failed=${stats.resize_failed}`);
      if (stats.library_missing) parts.push("sharp=missing");
      if (stats.images_stripped_pass1 > 0) parts.push(`stripped=${stats.images_stripped_pass1}`);
      if (stats.images_dropped_for_size > 0) parts.push(`evicted=${stats.images_dropped_for_size}`);
      if (stats.images_dropped_for_count_cap > 0) {
        parts.push(`count_capped=${stats.images_dropped_for_count_cap}`);
      }
      if (stats.unsupported_format_count > 0) parts.push(`unsupported=${stats.unsupported_format_count}`);
      const summary = parts.join(" ") || "ran";
      const finalImages = stats.total_images
        - stats.images_stripped_pass1
        - stats.images_dropped_for_size
        - stats.images_dropped_for_count_cap;
      process.stderr.write(
        `[image-guard] ${summary} req_bytes=${stats.request_bytes_before}->${stats.request_bytes_after} ` +
        `(headroom=${stats.request_bytes_headroom}) images=${stats.total_images}->${finalImages}\n`
      );
    }
  },
};

