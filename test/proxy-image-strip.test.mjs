import { test } from "node:test";
import assert from "node:assert/strict";
import ext, {
  stripOldToolResultImages,
  stripOversizedImages,
  PLACEHOLDER,
  oversizedPlaceholder,
} from "../proxy/extensions/image-strip.mjs";

// --- Helpers for synthesizing PNG headers with known dimensions ---
function buildPngHeader(width, height) {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.set([0x49, 0x48, 0x44, 0x52], 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}
function pngB64(width, height) {
  return buildPngHeader(width, height).toString("base64");
}
function userMsgWithDirectImage(b64) {
  return { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }] };
}
function userMsgWithToolResultImage(toolUseId, b64) {
  return {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: toolUseId,
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
        { type: "text", text: "Read OK" },
      ],
    }],
  };
}

function userMsg(content) {
  return { role: "user", content };
}

function assistantMsg(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResultWithImage(toolUseId, base64Data) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: base64Data } },
      { type: "text", text: "File read successfully" },
    ],
  };
}

function toolResultTextOnly(toolUseId, text) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [{ type: "text", text }],
  };
}

// --- Unit tests: stripOldToolResultImages ---

test("stripOldToolResultImages: strips images from old user messages", () => {
  const fakeBase64 = "A".repeat(1000);
  const messages = [
    userMsg([toolResultWithImage("t1", fakeBase64), { type: "text", text: "prompt 1" }]),
    assistantMsg("reply 1"),
    userMsg([toolResultWithImage("t2", fakeBase64), { type: "text", text: "prompt 2" }]),
    assistantMsg("reply 2"),
    userMsg([toolResultWithImage("t3", fakeBase64), { type: "text", text: "prompt 3" }]),
  ];

  const { messages: result, stats } = stripOldToolResultImages(messages, 1);

  assert.ok(stats, "should have stripping stats");
  assert.equal(stats.strippedCount, 2, "should strip 2 images from old messages");
  assert.equal(stats.strippedBytes, 2000);

  // First two user messages should have images stripped
  assert.equal(result[0].content[0].content[0].type, "text");
  assert.equal(result[0].content[0].content[0].text, PLACEHOLDER);
  assert.equal(result[2].content[0].content[0].type, "text");
  assert.equal(result[2].content[0].content[0].text, PLACEHOLDER);

  // Last user message should keep its image
  assert.equal(result[4].content[0].content[0].type, "image");
});

test("stripOldToolResultImages: keeps images in recent N messages", () => {
  const fakeBase64 = "B".repeat(500);
  const messages = [
    userMsg([toolResultWithImage("t1", fakeBase64)]),
    assistantMsg("r1"),
    userMsg([toolResultWithImage("t2", fakeBase64)]),
    assistantMsg("r2"),
    userMsg([toolResultWithImage("t3", fakeBase64)]),
    assistantMsg("r3"),
    userMsg([toolResultWithImage("t4", fakeBase64)]),
  ];

  const { messages: result, stats } = stripOldToolResultImages(messages, 3);

  assert.ok(stats);
  assert.equal(stats.strippedCount, 1, "should only strip the oldest");
  assert.equal(result[0].content[0].content[0].text, PLACEHOLDER);
  // Messages 2, 4, 6 (last 3 user messages) should keep images
  assert.equal(result[2].content[0].content[0].type, "image");
  assert.equal(result[4].content[0].content[0].type, "image");
  assert.equal(result[6].content[0].content[0].type, "image");
});

test("stripOldToolResultImages: no-op when keepLast is 0", () => {
  const messages = [userMsg([toolResultWithImage("t1", "data")])];
  const { stats } = stripOldToolResultImages(messages, 0);
  assert.equal(stats, null);
});

test("stripOldToolResultImages: no-op when not enough messages", () => {
  const messages = [
    userMsg([toolResultWithImage("t1", "data")]),
    assistantMsg("reply"),
    userMsg([{ type: "text", text: "hi" }]),
  ];
  const { stats } = stripOldToolResultImages(messages, 3);
  assert.equal(stats, null);
});

test("stripOldToolResultImages: does not strip user-pasted images", () => {
  const messages = [
    userMsg([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "userPasted" } },
      { type: "text", text: "what is this image?" },
    ]),
    assistantMsg("reply"),
    userMsg([{ type: "text", text: "follow up" }]),
    assistantMsg("reply2"),
    userMsg([{ type: "text", text: "another" }]),
  ];

  const { messages: result, stats } = stripOldToolResultImages(messages, 1);
  assert.equal(stats, null, "user-pasted images should not be stripped");
  assert.equal(result[0].content[0].type, "image");
});

test("stripOldToolResultImages: preserves non-image tool_result content", () => {
  const messages = [
    userMsg([
      toolResultWithImage("t1", "imgdata"),
      toolResultTextOnly("t2", "text result"),
    ]),
    assistantMsg("reply"),
    userMsg([{ type: "text", text: "recent" }]),
    assistantMsg("reply2"),
    userMsg([{ type: "text", text: "current" }]),
  ];

  const { messages: result, stats } = stripOldToolResultImages(messages, 1);
  assert.equal(stats.strippedCount, 1);
  // Text-only tool result should be untouched
  assert.equal(result[0].content[1].content[0].text, "text result");
});

test("stripOldToolResultImages: handles null/undefined input", () => {
  assert.deepEqual(stripOldToolResultImages(null, 3), { messages: null, stats: null });
  assert.deepEqual(stripOldToolResultImages(undefined, 3), { messages: undefined, stats: null });
});

// --- Integration tests: onRequest ---

test("onRequest: strips images when CACHE_FIX_IMAGE_KEEP_LAST is set via meta", async () => {
  const fakeBase64 = "C".repeat(800);
  const ctx = {
    body: {
      messages: [
        userMsg([toolResultWithImage("t1", fakeBase64)]),
        assistantMsg("r1"),
        userMsg([toolResultWithImage("t2", fakeBase64)]),
        assistantMsg("r2"),
        userMsg([{ type: "text", text: "current prompt" }]),
      ],
    },
    headers: {},
    meta: { imageKeepLast: 1 },
  };

  await ext.onRequest(ctx);

  assert.ok(ctx.meta.imageStripStats, "should have stats");
  assert.equal(ctx.meta.imageStripStats.strippedCount, 2);
  assert.equal(ctx.body.messages[0].content[0].content[0].text, PLACEHOLDER);
});

test("onRequest: no-op when keepLast is 0 or unset", async () => {
  const ctx = {
    body: {
      messages: [
        userMsg([toolResultWithImage("t1", "data")]),
        assistantMsg("r1"),
        userMsg([{ type: "text", text: "prompt" }]),
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.equal(ctx.meta.imageStripStats, undefined);
});

// ── MAX_DIM behavior tests ─────────────────────────────────────────────
// stripOversizedImages: pure function tests

test("MAX_DIM: 1000x1000 image is kept (under limit)", () => {
  const msgs = [userMsgWithToolResultImage("t1", pngB64(1000, 1000))];
  const r = stripOversizedImages(msgs, 2000);
  assert.equal(r.stats, null, "no stats when nothing stripped");
  assert.equal(r.messages, msgs, "input returned unchanged when nothing stripped");
});

test("MAX_DIM: 3000x1500 image is stripped (width over)", () => {
  const msgs = [userMsgWithToolResultImage("t1", pngB64(3000, 1500))];
  const r = stripOversizedImages(msgs, 2000);
  assert.equal(r.stats.strippedCount, 1);
  const replaced = r.messages[0].content[0].content[0];
  assert.equal(replaced.type, "text");
  assert.match(replaced.text, /3000x1500px/);
  assert.match(replaced.text, /2000px max/);
});

test("MAX_DIM: 1500x3000 image is stripped (height over)", () => {
  const msgs = [userMsgWithToolResultImage("t1", pngB64(1500, 3000))];
  const r = stripOversizedImages(msgs, 2000);
  assert.equal(r.stats.strippedCount, 1);
  assert.match(r.messages[0].content[0].content[0].text, /1500x3000px/);
});

test("MAX_DIM: 2000x2000 boundary is kept (dimension equals limit)", () => {
  const msgs = [userMsgWithToolResultImage("t1", pngB64(2000, 2000))];
  const r = stripOversizedImages(msgs, 2000);
  assert.equal(r.stats, null);
});

test("MAX_DIM: user-message direct image (not in tool_result) gets stripped", () => {
  const msgs = [userMsgWithDirectImage(pngB64(3000, 3000))];
  const r = stripOversizedImages(msgs, 2000);
  assert.equal(r.stats.strippedCount, 1);
  assert.equal(r.messages[0].content[0].type, "text");
  assert.match(r.messages[0].content[0].text, /3000x3000px/);
});

test("MAX_DIM: image with unparseable dimensions is kept (fail-open)", () => {
  // Garbage base64 that doesn't decode to a valid PNG/JPEG header
  const msgs = [userMsgWithToolResultImage("t1", "Z2FyYmFnZQ==" /* "garbage" */)];
  const r = stripOversizedImages(msgs, 2000);
  assert.equal(r.stats, null);
  // Image block preserved unchanged
  assert.equal(r.messages[0].content[0].content[0].type, "image");
});

test("MAX_DIM: stats track count and bytes correctly", () => {
  const big1 = pngB64(3000, 1500);
  const big2 = pngB64(4000, 2500);
  const msgs = [
    userMsgWithToolResultImage("t1", big1),
    userMsgWithToolResultImage("t2", big2),
  ];
  const r = stripOversizedImages(msgs, 2000);
  assert.equal(r.stats.strippedCount, 2);
  assert.equal(r.stats.strippedBytes, big1.length + big2.length);
  assert.ok(r.stats.estimatedTokens > 0);
});

test("MAX_DIM unset: no oversized stripping (current behavior preserved)", () => {
  const msgs = [userMsgWithToolResultImage("t1", pngB64(5000, 5000))];
  const r = stripOversizedImages(msgs, 0);
  assert.equal(r.stats, null);
  assert.equal(r.messages, msgs);
});

// ── Compose KEEP_LAST + MAX_DIM via the extension hook ───────────────
test("KEEP_LAST + MAX_DIM compose: keep_last drops oldest, max_dim then strips remaining oversized", async () => {
  // Build 5 user messages. The first 3 should be dropped by KEEP_LAST=2,
  // then MAX_DIM=2000 should strip oversized from the remaining 2.
  // But: KEEP_LAST only operates on tool_result-nested images. To make the
  // composition test crisp, all 5 messages have tool_result images.
  // Last 2 (indices 3 and 4) survive KEEP_LAST.
  // index 3: 1000x1000 (under) — survives both passes
  // index 4: 3000x3000 (over)  — survives KEEP_LAST, stripped by MAX_DIM
  const ctx = {
    body: {
      messages: [
        userMsgWithToolResultImage("t1", pngB64(500, 500)),    // dropped by keep_last
        userMsgWithToolResultImage("t2", pngB64(500, 500)),    // dropped by keep_last
        userMsgWithToolResultImage("t3", pngB64(500, 500)),    // dropped by keep_last
        userMsgWithToolResultImage("t4", pngB64(1000, 1000)),  // kept by both
        userMsgWithToolResultImage("t5", pngB64(3000, 3000)),  // kept by keep_last, stripped by max_dim
      ],
    },
    headers: {},
    meta: { imageKeepLast: 2, imageMaxDim: 2000 },
  };
  await ext.onRequest(ctx);
  // Both stat objects should be present (separate fields, back-compat preserved)
  assert.ok(ctx.meta.imageStripStats, "keep_last stats must land on imageStripStats");
  assert.equal(ctx.meta.imageStripStats.strippedCount, 3, "3 oldest images dropped by keep_last");
  assert.ok(ctx.meta.imageStripOversizedStats, "max_dim stats must land on imageStripOversizedStats");
  assert.equal(ctx.meta.imageStripOversizedStats.strippedCount, 1, "1 oversized image stripped by max_dim");
  // Verify the surviving image (t4, index 3) is intact
  const t4Result = ctx.body.messages[3].content[0];
  assert.equal(t4Result.content[0].type, "image", "small recent image should survive both passes");
  // Verify the t5 image was replaced with oversized placeholder
  const t5Result = ctx.body.messages[4].content[0];
  assert.equal(t5Result.content[0].type, "text");
  assert.match(t5Result.content[0].text, /3000x3000px/);
});

test("MAX_DIM only via env-equivalent meta: hook fires and emits stats", async () => {
  const ctx = {
    body: {
      messages: [
        userMsgWithToolResultImage("t1", pngB64(5000, 5000)),
        userMsgWithToolResultImage("t2", pngB64(800, 800)),
      ],
    },
    headers: {},
    meta: { imageMaxDim: 2000 },
  };
  await ext.onRequest(ctx);
  assert.ok(ctx.meta.imageStripOversizedStats);
  assert.equal(ctx.meta.imageStripOversizedStats.strippedCount, 1);
  assert.equal(ctx.meta.imageStripStats, undefined, "keep_last stats must be absent when keep_last is unset");
  // First image stripped, second kept
  assert.equal(ctx.body.messages[0].content[0].content[0].type, "text");
  assert.equal(ctx.body.messages[1].content[0].content[0].type, "image");
});

test("oversizedPlaceholder formats as documented", () => {
  assert.equal(
    oversizedPlaceholder(2000, 3000, 1500),
    "[image stripped — exceeded 2000px max dimension (was 3000x1500px)]",
  );
});

// --- Legacy [image-strip] stderr gating (#98) ---

async function withLegacyStderrCapture(envOverrides, fn) {
  const origDebug = process.env.CACHE_FIX_DEBUG;
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => { captured += chunk.toString(); return true; };
  try {
    if (envOverrides.CACHE_FIX_DEBUG === undefined) delete process.env.CACHE_FIX_DEBUG;
    else process.env.CACHE_FIX_DEBUG = envOverrides.CACHE_FIX_DEBUG;
    await fn(() => captured);
  } finally {
    process.stderr.write = origWrite;
    if (origDebug === undefined) delete process.env.CACHE_FIX_DEBUG;
    else process.env.CACHE_FIX_DEBUG = origDebug;
  }
}

function legacyKeepLastCtx() {
  return {
    body: {
      messages: [
        userMsg([toolResultWithImage("t1", "X".repeat(800))]),
        assistantMsg("r1"),
        userMsg([toolResultWithImage("t2", "Y".repeat(800))]),
        assistantMsg("r2"),
        userMsg([{ type: "text", text: "current prompt" }]),
      ],
    },
    headers: {},
    meta: { imageKeepLast: 1 },
  };
}

test("legacy path: [image-strip] summary emitted with CACHE_FIX_DEBUG=1", async () => {
  await withLegacyStderrCapture({ CACHE_FIX_DEBUG: "1" }, async (getCaptured) => {
    const ctx = legacyKeepLastCtx();
    await ext.onRequest(ctx);
    // Sanity: legacy path actually ran and stripped images.
    assert.equal(ctx.meta.imageStripStats.strippedCount, 2);
    assert.match(getCaptured(), /\[image-strip\] keep_last:/);
  });
});

test("legacy path: [image-strip] summary suppressed without CACHE_FIX_DEBUG (#98)", async () => {
  await withLegacyStderrCapture({ CACHE_FIX_DEBUG: undefined }, async (getCaptured) => {
    const ctx = legacyKeepLastCtx();
    await ext.onRequest(ctx);
    // Work still happens — only the stderr line is gated.
    assert.equal(ctx.meta.imageStripStats.strippedCount, 2, "legacy path still mutates messages");
    assert.ok(!getCaptured().includes("[image-strip]"), "summary must be silent without CACHE_FIX_DEBUG");
  });
});
