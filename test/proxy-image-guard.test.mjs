// Tests for the v3.3.0 image-guard pipeline.
//
// Coverage map (test plan from docs/directives/proxy-image-guard-pipeline.md):
//   Activation     1-3
//   Pass 1         4-9
//   Pass 2         10-13
//   Pass 3         14-19
//   Count cap      20-22
//   Precedence     23-32
//   Telemetry      33-34
//   Regression     35-36 (covered by existing proxy-image-strip / -dimensions tests)
//
// Pass 3 (sharp) tests use a fake sharp injected via the test seam in
// proxy/image-resize.mjs. No real `sharp` install required to run these tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import ext, {
  pickPass1Cap,
  pickPass3NativeCap,
  estimateImageTokens,
  walkImagesForPass1,
  walkImagesForPass3,
  pickEvictionTargets,
  runImageGuard,
  _resetWarningStateForTests,
} from "../proxy/extensions/image-strip.mjs";
import { _resetSharpCacheForTests, _setSharpForTests } from "../proxy/image-resize.mjs";

// ============================================================================
// Helpers
// ============================================================================

function buildPngHeader(width, height, payloadSize = 0) {
  // Real PNG header (8 magic + 25 IHDR) + optional padding bytes so the encoded
  // size differs across images. Keeps base64 length test-realistic without
  // forcing actual chunk validation.
  const totalSize = 33 + payloadSize;
  const buf = Buffer.alloc(totalSize);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.set([0x49, 0x48, 0x44, 0x52], 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}
function pngB64(width, height, payloadSize = 0) {
  return buildPngHeader(width, height, payloadSize).toString("base64");
}

function buildJpegHeader(width, height) {
  // Minimal JPEG: SOI + SOF0 segment with given dimensions. The SOF0 segment
  // length field claims 17 bytes (precision + h + w + components + per-component
  // descriptors), so the buffer must be at least 4 (SOI+marker prefix) + 17 = 21
  // bytes for the parser's segment-bounds check to pass. Allocate 32 for headroom.
  const buf = Buffer.alloc(32);
  buf[0] = 0xff; buf[1] = 0xd8;       // SOI
  buf[2] = 0xff; buf[3] = 0xc0;       // SOF0 marker
  buf[4] = 0x00; buf[5] = 0x11;       // segment length 17
  buf[6] = 0x08;                      // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  buf[11] = 0x03;                     // 3 components
  return buf;
}
function jpegB64(width, height) {
  return buildJpegHeader(width, height).toString("base64");
}

function imageBlock(b64, mediaType = "image/png") {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } };
}

function userMsgWithDirectImages(...blocks) {
  return { role: "user", content: blocks };
}
function userMsgWithToolResultImages(toolUseId, ...blocks) {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content: blocks }],
  };
}

function makeBody(messages, model = "claude-3-5-sonnet-20241022") {
  return { model, messages };
}

function makeCtx(body) {
  return { body, meta: {} };
}

// Save/restore env vars per test so tests don't bleed.
function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const original = {};
  for (const k of keys) {
    original[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = String(overrides[k]);
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  }
}
async function withEnvAsync(overrides, fn) {
  const keys = Object.keys(overrides);
  const original = {};
  for (const k of keys) {
    original[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = String(overrides[k]);
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  }
}

// Fake sharp factory: returns a callable mimicking sharp's chained API.
// The fake never decodes the input — it just returns canned output bytes
// reflecting the requested resize cap.
function makeFakeSharp({ throwOn = null } = {}) {
  return function fakeSharp(_buffer) {
    let resizeOpts = null;
    return {
      resize(opts) {
        resizeOpts = opts;
        if (throwOn === "resize") throw new Error("forced resize failure");
        return this;
      },
      png() {
        return {
          toBuffer: async ({ resolveWithObject } = {}) => {
            if (throwOn === "encode") throw new Error("forced encode failure");
            const cap = resizeOpts?.width || 1568;
            const data = Buffer.from(`PNG_RESIZED_${cap}_PAYLOAD`, "utf8");
            const info = { width: cap, height: cap, format: "png" };
            return resolveWithObject ? { data, info } : data;
          },
        };
      },
      jpeg() {
        return {
          toBuffer: async ({ resolveWithObject } = {}) => {
            if (throwOn === "encode") throw new Error("forced encode failure");
            const cap = resizeOpts?.width || 1568;
            const data = Buffer.from(`JPEG_RESIZED_${cap}_PAYLOAD`, "utf8");
            const info = { width: cap, height: cap, format: "jpeg" };
            return resolveWithObject ? { data, info } : data;
          },
        };
      },
    };
  };
}

// Reset state hooks before each test (env, warning flag, sharp cache).
function resetState() {
  _resetWarningStateForTests();
  _resetSharpCacheForTests();
}

// ============================================================================
// Pure helpers
// ============================================================================

test("pickPass1Cap: count > 20 → 2000 px", () => {
  assert.equal(pickPass1Cap(21, 0), 2000);
  assert.equal(pickPass1Cap(100, 0), 2000);
});

test("pickPass1Cap: count <= 20 → 8000 px", () => {
  assert.equal(pickPass1Cap(0, 0), 8000);
  assert.equal(pickPass1Cap(20, 0), 8000);
});

test("pickPass1Cap: maxDim override always wins", () => {
  assert.equal(pickPass1Cap(0, 1500), 1500);
  assert.equal(pickPass1Cap(100, 1500), 1500);
});

test("pickPass3NativeCap: opus-4-7 prefix → 2576 px", () => {
  assert.equal(pickPass3NativeCap("claude-opus-4-7-20260101"), 2576);
  assert.equal(pickPass3NativeCap("claude-opus-4-7"), 2576);
});

test("pickPass3NativeCap: anything else → 1568 px", () => {
  assert.equal(pickPass3NativeCap("claude-3-5-sonnet-20241022"), 1568);
  assert.equal(pickPass3NativeCap("claude-opus-4-6"), 1568);
  assert.equal(pickPass3NativeCap(""), 1568);
  assert.equal(pickPass3NativeCap(undefined), 1568);
});

test("estimateImageTokens: applies width*height/750 formula and caps", () => {
  // 1500x1500 = 2.25M / 750 = 3000, capped at 1568 native
  assert.equal(estimateImageTokens(1500, 1500, 1568), 1568);
  // 100x100 = 10000/750 ~ 14, well under any cap
  assert.equal(estimateImageTokens(100, 100, 1568), 14);
});

// ============================================================================
// Activation tests (1-3)
// ============================================================================

test("[T1] IMAGE_GUARD unset, no legacy env vars → no mutation, no stats", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined },
    async () => {
      const body = makeBody([userMsgWithDirectImages(imageBlock(pngB64(3000, 3000)))]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.equal(ctx.meta.imageGuardStats, undefined);
      // Image untouched
      assert.equal(body.messages[0].content[0].type, "image");
    }
  );
});

test("[T2] IMAGE_GUARD=1, no images → pipeline runs, stats present and zeroed", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_KEEP_LAST: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined },
    async () => {
      const body = makeBody([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.ok(ctx.meta.imageGuardStats, "stats should be present");
      assert.equal(ctx.meta.imageGuardStats.total_images, 0);
      assert.equal(ctx.meta.imageGuardStats.images_dropped_for_size, 0);
      assert.equal(ctx.meta.imageGuardStats.images_dropped_for_count_cap, 0);
    }
  );
});

test("[T3] PRESERVE_DETAIL=1 without IMAGE_GUARD=1 → warning, no mutation", async () => {
  resetState();
  // Capture stderr to verify warning emission.
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => { captured += chunk.toString(); return true; };
  try {
    await withEnvAsync(
      { CACHE_FIX_IMAGE_GUARD: undefined, CACHE_FIX_IMAGE_PRESERVE_DETAIL: "1", CACHE_FIX_IMAGE_KEEP_LAST: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined },
      async () => {
        const body = makeBody([userMsgWithDirectImages(imageBlock(pngB64(3000, 3000)))]);
        const ctx = makeCtx(body);
        await ext.onRequest(ctx);
        assert.match(captured, /no effect without CACHE_FIX_IMAGE_GUARD=1/);
        assert.equal(body.messages[0].content[0].type, "image"); // untouched
      }
    );
  } finally {
    process.stderr.write = origWrite;
  }
});

// ============================================================================
// Pass 1 — rejection-cap strip (4-9)
// ============================================================================

test("[T4] 21 images at 3000px, IMAGE_GUARD=1 → all stripped (count>20, cap=2000)", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const blocks = [];
      for (let i = 0; i < 21; i++) blocks.push(imageBlock(pngB64(3000, 3000)));
      const body = makeBody([userMsgWithDirectImages(...blocks)]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const stripped = body.messages[0].content.filter((b) => b.type === "text").length;
      assert.equal(stripped, 21);
      assert.equal(ctx.meta.imageGuardStats.count_axis_path, "many");
    }
  );
});

test("[T5] 5 images at 5000px, IMAGE_GUARD=1 → all kept (count<=20, cap=8000)", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const blocks = [];
      for (let i = 0; i < 5; i++) blocks.push(imageBlock(pngB64(5000, 5000)));
      const body = makeBody([userMsgWithDirectImages(...blocks)]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const survivors = body.messages[0].content.filter((b) => b.type === "image").length;
      assert.equal(survivors, 5);
      assert.equal(ctx.meta.imageGuardStats.count_axis_path, "few");
    }
  );
});

test("[T6] 5 images, one 9000px PNG, IMAGE_GUARD=1 → only the 9000px stripped", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const blocks = [
        imageBlock(pngB64(1000, 1000)),
        imageBlock(pngB64(2000, 2000)),
        imageBlock(pngB64(9000, 9000)),
        imageBlock(pngB64(1500, 1500)),
        imageBlock(pngB64(800, 800)),
      ];
      const body = makeBody([userMsgWithDirectImages(...blocks)]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const survivors = body.messages[0].content.filter((b) => b.type === "image");
      const stripped = body.messages[0].content.filter((b) => b.type === "text");
      assert.equal(survivors.length, 4);
      assert.equal(stripped.length, 1);
      assert.match(stripped[0].text, /9000x9000/);
    }
  );
});

test("[T7] IMAGE_GUARD=1 + MAX_DIM=1500 → 1500 overrides conditional cap regardless of count", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_MAX_DIM: "1500", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      // 5 images, all 2000x2000 — 8000 cap would keep them; MAX_DIM=1500 strips them.
      const blocks = [];
      for (let i = 0; i < 5; i++) blocks.push(imageBlock(pngB64(2000, 2000)));
      const body = makeBody([userMsgWithDirectImages(...blocks)]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const stripped = body.messages[0].content.filter((b) => b.type === "text").length;
      assert.equal(stripped, 5);
    }
  );
});

test("[T8] image with unparseable dimensions (WebP), IMAGE_GUARD=1 → kept, unsupported counter increments", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const body = makeBody([
        userMsgWithDirectImages(
          imageBlock(Buffer.from("RIFF????WEBP").toString("base64"), "image/webp")
        ),
      ]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.equal(body.messages[0].content[0].type, "image");
      assert.equal(ctx.meta.imageGuardStats.unsupported_format_count, 1);
    }
  );
});

test("[T9] Pass 1 NEVER resizes — stripped block is forensic placeholder text", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const blocks = [];
      for (let i = 0; i < 25; i++) blocks.push(imageBlock(pngB64(3000, 3000)));
      const body = makeBody([userMsgWithDirectImages(...blocks)]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const replaced = body.messages[0].content.filter((b) => b.type === "text");
      assert.equal(replaced.length, 25);
      // Verify forensic placeholder format
      assert.match(replaced[0].text, /image stripped — exceeded \d+px max dimension \(was \d+x\d+px\)/);
    }
  );
});

// ============================================================================
// Pass 2 — request-size guard (10-13)
// ============================================================================

test("[T10] body 35MB → 30MB budget triggers eviction; oldest dropped first", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_REQUEST_SIZE_MAX: undefined, CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      // 8 images of ~5MB each = ~40MB body. Must evict ≥2 to get under 30MB budget.
      // Use 1000x1000 PNG so Pass 1 keeps them (well under 8000 cap).
      const bigPayload = 5 * 1024 * 1024;
      const messages = [];
      for (let i = 0; i < 8; i++) {
        messages.push(userMsgWithDirectImages(imageBlock(pngB64(1000, 1000, bigPayload))));
      }
      const body = makeBody(messages);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const stats = ctx.meta.imageGuardStats;
      assert.ok(stats.images_dropped_for_size > 0, "should have evicted at least one image");
      assert.ok(stats.request_bytes_after <= 31457280, "final body should be at or under budget");
      // Oldest first: msg index 0 should have been replaced before later ones
      const firstMsgFirstBlock = body.messages[0].content[0];
      assert.equal(firstMsgFirstBlock.type, "text", "msg[0] should have been evicted first");
    }
  );
});

test("[T11] body 25MB → no eviction", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_REQUEST_SIZE_MAX: undefined, CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const bigPayload = 5 * 1024 * 1024;
      const messages = [];
      for (let i = 0; i < 4; i++) {
        messages.push(userMsgWithDirectImages(imageBlock(pngB64(1000, 1000, bigPayload))));
      }
      const body = makeBody(messages);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.equal(ctx.meta.imageGuardStats.images_dropped_for_size, 0);
    }
  );
});

test("[T12] custom REQUEST_SIZE_MAX=10MB → eviction at lower threshold", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_REQUEST_SIZE_MAX: "10485760", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const bigPayload = 5 * 1024 * 1024;
      const messages = [];
      for (let i = 0; i < 4; i++) {
        messages.push(userMsgWithDirectImages(imageBlock(pngB64(1000, 1000, bigPayload))));
      }
      const body = makeBody(messages);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.ok(ctx.meta.imageGuardStats.images_dropped_for_size > 0);
      assert.ok(ctx.meta.imageGuardStats.request_bytes_after <= 10485760);
    }
  );
});

test("[T13] eviction prefers tool_result images over direct images at same age", () => {
  resetState();
  // Same msgIdx, both image types — tool_result should sort first (preferred eviction).
  const messages = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: pngB64(100, 100) } }, // direct
        { type: "tool_result", tool_use_id: "tu1", content: [imageBlock(pngB64(100, 100))] },           // tool_result
      ],
    },
  ];
  const targets = pickEvictionTargets(messages);
  // First target should be the tool_result (itemIdx !== null), not the direct.
  assert.equal(targets[0].itemIdx !== null, true, "tool_result image should be preferred");
});

// ============================================================================
// Pass 3 — native-cap resize (14-19, sharp via fake)
// ============================================================================

test("[T14] PRESERVE_DETAIL=1, opus-4-7 model, 3000px PNG → resized to 2576px, media_type stays PNG", async () => {
  resetState();
  _setSharpForTests(makeFakeSharp());
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: "1", CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const body = makeBody(
        [userMsgWithDirectImages(imageBlock(pngB64(3000, 3000)))],
        "claude-opus-4-7-20260101"
      );
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const stats = ctx.meta.imageGuardStats;
      assert.equal(stats.resize_attempted, 1);
      assert.equal(stats.resize_succeeded, 1);
      const img = body.messages[0].content[0];
      assert.equal(img.type, "image");
      assert.equal(img.source.media_type, "image/png");
      // Fake sharp encodes "PNG_RESIZED_2576_PAYLOAD"
      assert.match(Buffer.from(img.source.data, "base64").toString(), /PNG_RESIZED_2576/);
    }
  );
});

test("[T15] PRESERVE_DETAIL=1, sonnet model, 3000px JPEG → resized to 1568px, JPEG", async () => {
  resetState();
  _setSharpForTests(makeFakeSharp());
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: "1", CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const body = makeBody(
        [userMsgWithDirectImages(imageBlock(jpegB64(3000, 3000), "image/jpeg"))],
        "claude-3-5-sonnet-20241022"
      );
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const img = body.messages[0].content[0];
      assert.equal(img.source.media_type, "image/jpeg");
      assert.match(Buffer.from(img.source.data, "base64").toString(), /JPEG_RESIZED_1568/);
    }
  );
});

test("[T16] 5 images at 5000x5000 PNG, sonnet model → all resized via Pass 3 (Pass 1 cap 8000 would have left them)", async () => {
  resetState();
  _setSharpForTests(makeFakeSharp());
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: "1", CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const blocks = [];
      for (let i = 0; i < 5; i++) blocks.push(imageBlock(pngB64(5000, 5000)));
      const body = makeBody([userMsgWithDirectImages(...blocks)], "claude-3-5-sonnet-20241022");
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const stats = ctx.meta.imageGuardStats;
      assert.equal(stats.resize_attempted, 5);
      assert.equal(stats.resize_succeeded, 5);
      // Pass 1's 8000 cap would have left them; confirm no Pass 1 strip happened.
      const survivors = body.messages[0].content.filter((b) => b.type === "image");
      assert.equal(survivors.length, 5);
    }
  );
});

test("[T17] 1200px PNG, sonnet model → kept untouched (under native 1568 cap)", async () => {
  resetState();
  _setSharpForTests(makeFakeSharp());
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: "1", CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const body = makeBody(
        [userMsgWithDirectImages(imageBlock(pngB64(1200, 1200)))],
        "claude-3-5-sonnet-20241022"
      );
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const stats = ctx.meta.imageGuardStats;
      assert.equal(stats.resize_attempted, 0);
      // Original image unchanged
      assert.equal(body.messages[0].content[0].source.data, pngB64(1200, 1200));
    }
  );
});

test("[T18] sharp unavailable → library_missing, Pass 3 skipped, Pass 1 still evaluates", async () => {
  resetState();
  _setSharpForTests(null); // simulate import failure
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: "1", CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      // 5 images at 5000x5000 — Pass 3 would resize, Pass 1's 8000 cap keeps them.
      const blocks = [];
      for (let i = 0; i < 5; i++) blocks.push(imageBlock(pngB64(5000, 5000)));
      const body = makeBody([userMsgWithDirectImages(...blocks)], "claude-3-5-sonnet-20241022");
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const stats = ctx.meta.imageGuardStats;
      assert.equal(stats.library_missing, true);
      assert.equal(stats.resize_succeeded, 0);
      // Pass 1 would have left them (5 images, 8000 cap > 5000).
      const survivors = body.messages[0].content.filter((b) => b.type === "image");
      assert.equal(survivors.length, 5);
    }
  );
});

test("[T19] sharp throws on resize → resize_failed++, image untouched, Pass 1 evaluates", async () => {
  resetState();
  _setSharpForTests(makeFakeSharp({ throwOn: "resize" }));
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: "1", CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const blocks = [];
      for (let i = 0; i < 5; i++) blocks.push(imageBlock(pngB64(5000, 5000)));
      const body = makeBody([userMsgWithDirectImages(...blocks)], "claude-3-5-sonnet-20241022");
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const stats = ctx.meta.imageGuardStats;
      assert.equal(stats.resize_attempted, 5);
      assert.equal(stats.resize_succeeded, 0);
      assert.equal(stats.resize_failed, 5);
      const survivors = body.messages[0].content.filter((b) => b.type === "image");
      assert.equal(survivors.length, 5);
    }
  );
});

// ============================================================================
// Hard image-count cap (20-22)
// ============================================================================

test("[T20] 105 images, default cap → trimmed to 100, dropped=5", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_COUNT_MAX: undefined, CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const blocks = [];
      for (let i = 0; i < 105; i++) blocks.push(imageBlock(pngB64(500, 500)));
      const body = makeBody([userMsgWithDirectImages(...blocks)], "claude-opus-4-7-20260101");
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const stats = ctx.meta.imageGuardStats;
      assert.equal(stats.images_dropped_for_count_cap, 5);
      const survivors = body.messages[0].content.filter((b) => b.type === "image");
      assert.equal(survivors.length, 100);
    }
  );
});

test("[T21] CACHE_FIX_IMAGE_COUNT_MAX=600 override, 605 images → trimmed to 600", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_COUNT_MAX: "600", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const blocks = [];
      for (let i = 0; i < 605; i++) blocks.push(imageBlock(pngB64(500, 500)));
      const body = makeBody([userMsgWithDirectImages(...blocks)], "claude-opus-4-7-20260101");
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const stats = ctx.meta.imageGuardStats;
      assert.equal(stats.images_dropped_for_count_cap, 5);
      const survivors = body.messages[0].content.filter((b) => b.type === "image");
      assert.equal(survivors.length, 600);
    }
  );
});

test("[T22] 99 images at default cap → no trim", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_COUNT_MAX: undefined, CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const blocks = [];
      for (let i = 0; i < 99; i++) blocks.push(imageBlock(pngB64(500, 500)));
      const body = makeBody([userMsgWithDirectImages(...blocks)], "claude-opus-4-7-20260101");
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const stats = ctx.meta.imageGuardStats;
      assert.equal(stats.images_dropped_for_count_cap, 0);
    }
  );
});

// ============================================================================
// Precedence matrix coverage (23-32)
// ============================================================================

test("[T23] Nothing set → no mutation, no stats", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined },
    async () => {
      const body = makeBody([userMsgWithDirectImages(imageBlock(pngB64(9000, 9000)))]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.equal(ctx.meta.imageGuardStats, undefined);
      assert.equal(body.messages[0].content[0].type, "image");
    }
  );
});

test("[T24] KEEP_LAST=2 only → legacy behavior, no pipeline", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: undefined, CACHE_FIX_IMAGE_KEEP_LAST: "2", CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined },
    async () => {
      const body = makeBody([
        userMsgWithToolResultImages("t1", imageBlock(pngB64(100, 100))),
        userMsgWithToolResultImages("t2", imageBlock(pngB64(100, 100))),
        userMsgWithToolResultImages("t3", imageBlock(pngB64(100, 100))),
      ]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.ok(ctx.meta.imageStripStats, "legacy stats present");
      assert.equal(ctx.meta.imageGuardStats, undefined, "pipeline did not run");
    }
  );
});

test("[T25] MAX_DIM=2000 only → legacy strip behavior", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined, CACHE_FIX_IMAGE_MAX_DIM: "2000", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined },
    async () => {
      const body = makeBody([userMsgWithDirectImages(imageBlock(pngB64(3000, 3000)))]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.ok(ctx.meta.imageStripOversizedStats);
      assert.equal(ctx.meta.imageGuardStats, undefined, "pipeline did not run in legacy mode");
      assert.equal(body.messages[0].content[0].type, "text");
    }
  );
});

test("[T26] KEEP_LAST + MAX_DIM (legacy two-step)", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: undefined, CACHE_FIX_IMAGE_KEEP_LAST: "1", CACHE_FIX_IMAGE_MAX_DIM: "2000", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined },
    async () => {
      const body = makeBody([
        userMsgWithToolResultImages("t1", imageBlock(pngB64(3000, 3000))),
        userMsgWithToolResultImages("t2", imageBlock(pngB64(3000, 3000))),
        userMsgWithDirectImages(imageBlock(pngB64(3000, 3000))),
      ]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.ok(ctx.meta.imageStripStats, "keep_last fired");
      assert.ok(ctx.meta.imageStripOversizedStats, "max_dim fired");
      assert.equal(ctx.meta.imageGuardStats, undefined, "no pipeline");
    }
  );
});

test("[T27] IMAGE_GUARD=1 → pipeline runs, no Pass 3", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const body = makeBody([userMsgWithDirectImages(imageBlock(pngB64(9000, 9000)))]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.ok(ctx.meta.imageGuardStats);
      assert.equal(ctx.meta.imageGuardStats.resize_attempted, 0);
      assert.equal(body.messages[0].content[0].type, "text"); // 9000 > 8000 cap
    }
  );
});

test("[T28] IMAGE_GUARD=1 + MAX_DIM=1500 → Pass 1 cap=1500", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_MAX_DIM: "1500", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const body = makeBody([userMsgWithDirectImages(imageBlock(pngB64(2000, 2000)))]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.equal(body.messages[0].content[0].type, "text"); // 2000 > 1500
    }
  );
});

test("[T29] IMAGE_GUARD=1 + PRESERVE_DETAIL=1 → adds Pass 3", async () => {
  resetState();
  _setSharpForTests(makeFakeSharp());
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: "1", CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const body = makeBody([userMsgWithDirectImages(imageBlock(pngB64(3000, 3000)))]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.equal(ctx.meta.imageGuardStats.resize_attempted, 1);
      assert.equal(ctx.meta.imageGuardStats.resize_succeeded, 1);
    }
  );
});

test("[T30] IMAGE_GUARD=1 + KEEP_LAST=2 → KEEP_LAST first, then pipeline on survivors", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_KEEP_LAST: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined },
    async () => {
      const body = makeBody([
        userMsgWithToolResultImages("t1", imageBlock(pngB64(9000, 9000))),
        userMsgWithToolResultImages("t2", imageBlock(pngB64(9000, 9000))),
      ]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.ok(ctx.meta.imageStripStats, "Pass 0 fired");
      assert.ok(ctx.meta.imageGuardStats, "pipeline fired");
      // The "kept last" image (msg index 1) is now 9000x9000 → Pass 1 strips it.
      assert.equal(body.messages[1].content[0].content[0].type, "text");
    }
  );
});

test("[T31] IMAGE_GUARD=1 + KEEP_LAST=1 + MAX_DIM=1500 → three-way", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_KEEP_LAST: "1", CACHE_FIX_IMAGE_MAX_DIM: "1500", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined },
    async () => {
      const body = makeBody([
        userMsgWithToolResultImages("t1", imageBlock(pngB64(2000, 2000))),
        userMsgWithToolResultImages("t2", imageBlock(pngB64(2000, 2000))),
      ]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      assert.ok(ctx.meta.imageStripStats, "Pass 0 fired (KEEP_LAST=1 dropped older)");
      assert.ok(ctx.meta.imageGuardStats, "pipeline fired");
      // Most recent message (idx=1) had 2000x2000; MAX_DIM=1500 strips it.
      assert.equal(body.messages[1].content[0].content[0].type, "text");
    }
  );
});

test("[T32] PRESERVE_DETAIL=1 only → no-op + warning (covered by T3)", () => {
  // Already verified in T3.
  assert.ok(true);
});

// ============================================================================
// Telemetry shape (33-34)
// ============================================================================

test("[T33] imageGuardStats has every documented field after a pipeline-active request", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      const body = makeBody([userMsgWithDirectImages(imageBlock(pngB64(1000, 1000)))]);
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const s = ctx.meta.imageGuardStats;
      const expected = [
        "total_images", "count_axis_path", "unsupported_format_count", "dimension_probe_fail_count",
        "resize_attempted", "resize_succeeded", "resize_failed", "library_missing",
        "images_dropped_for_size", "images_dropped_for_count_cap",
        "request_bytes_before", "request_bytes_after", "request_bytes_headroom",
        "image_bytes_total", "image_bytes_dropped",
        "estimated_image_tokens_total",
      ];
      for (const f of expected) {
        assert.ok(f in s, `missing field: ${f}`);
      }
    }
  );
});

test("[T34a] Pass 1-only stripping emits stderr summary (Codex review fix)", async () => {
  resetState();
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => { captured += chunk.toString(); return true; };
  try {
    await withEnvAsync(
      { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
      async () => {
        const body = makeBody(
          [userMsgWithDirectImages(imageBlock(pngB64(9000, 9000)))],
          "claude-3-5-sonnet-20241022"
        );
        const ctx = makeCtx(body);
        await ext.onRequest(ctx);
        // Pass 1 stripped one image — stderr summary should be emitted.
        assert.match(captured, /\[image-guard\]/);
        assert.match(captured, /stripped=1/, "Pass 1 strips should appear in summary");
      }
    );
  } finally {
    process.stderr.write = origWrite;
  }
});

test("[T34b] count-cap-only request reports updated request_bytes_after (Codex review fix)", async () => {
  resetState();
  await withEnvAsync(
    { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_COUNT_MAX: undefined, CACHE_FIX_IMAGE_PRESERVE_DETAIL: undefined, CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
    async () => {
      // 105 small images → trimmed to 100 by count cap. Pass 2 won't fire (well under 30 MB).
      const blocks = [];
      for (let i = 0; i < 105; i++) blocks.push(imageBlock(pngB64(500, 500, 1000)));
      const body = makeBody([userMsgWithDirectImages(...blocks)], "claude-opus-4-7-20260101");
      const ctx = makeCtx(body);
      await ext.onRequest(ctx);
      const stats = ctx.meta.imageGuardStats;
      assert.equal(stats.images_dropped_for_count_cap, 5);
      // request_bytes_after must reflect the post-count-cap body, not the pre-trim size.
      const actualBytes = Buffer.byteLength(JSON.stringify(body));
      assert.equal(stats.request_bytes_after, actualBytes,
        "request_bytes_after should equal the post-pipeline body size");
      assert.ok(stats.request_bytes_after < stats.request_bytes_before,
        "post-trim bytes should be less than pre-trim");
    }
  );
});

test("[T34] stderr summary line conditional on actual work", async () => {
  resetState();
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => { captured += chunk.toString(); return true; };
  try {
    _setSharpForTests(makeFakeSharp());
    await withEnvAsync(
      { CACHE_FIX_IMAGE_GUARD: "1", CACHE_FIX_IMAGE_PRESERVE_DETAIL: "1", CACHE_FIX_IMAGE_MAX_DIM: undefined, CACHE_FIX_IMAGE_KEEP_LAST: undefined },
      async () => {
        const body = makeBody(
          [userMsgWithDirectImages(imageBlock(pngB64(3000, 3000)))],
          "claude-3-5-sonnet-20241022"
        );
        const ctx = makeCtx(body);
        await ext.onRequest(ctx);
        assert.match(captured, /\[image-guard\]/);
        assert.match(captured, /resized=1/, "should report resized count");
      }
    );
  } finally {
    process.stderr.write = origWrite;
  }
});

// ============================================================================
// Pure-function walker tests
// ============================================================================

test("walkImagesForPass1: reports plan for each oversized image", () => {
  const messages = [
    userMsgWithDirectImages(imageBlock(pngB64(9000, 9000))),
    userMsgWithDirectImages(imageBlock(pngB64(1000, 1000))),
    userMsgWithToolResultImages("t1", imageBlock(pngB64(5000, 5000))),
  ];
  const plan = walkImagesForPass1(messages, 8000);
  // Only the 9000x9000 exceeds 8000.
  const stripPlans = plan.filter((p) => p.action === "strip");
  assert.equal(stripPlans.length, 1);
  assert.equal(stripPlans[0].dims.width, 9000);
});

test("walkImagesForPass3: reports plan for each above-native-cap image", () => {
  const messages = [
    userMsgWithDirectImages(imageBlock(pngB64(2000, 2000))),
    userMsgWithDirectImages(imageBlock(pngB64(1200, 1200))),
  ];
  const plan = walkImagesForPass3(messages, 1568);
  const resizePlans = plan.filter((p) => p.action === "resize");
  assert.equal(resizePlans.length, 1);
  assert.equal(resizePlans[0].dims.width, 2000);
});
