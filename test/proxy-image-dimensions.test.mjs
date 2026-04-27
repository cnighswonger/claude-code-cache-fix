import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parsePngDimensions,
  parseJpegDimensions,
  parseImageDimensions,
} from "../proxy/image-dimensions.mjs";

// --- PNG synthesis ---
//
// Build a valid-enough PNG header (just IHDR; we don't render or display).
// Layout: 8-byte magic + IHDR chunk (4B length + 4B "IHDR" + 4B width + 4B
// height + 5B remaining IHDR data + 4B CRC).
function buildPngHeader(width, height) {
  const buf = Buffer.alloc(33);
  // PNG magic
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR chunk length (always 13)
  buf.writeUInt32BE(13, 8);
  // "IHDR"
  buf.set([0x49, 0x48, 0x44, 0x52], 12);
  // width
  buf.writeUInt32BE(width, 16);
  // height
  buf.writeUInt32BE(height, 20);
  // bit depth, color type, compression, filter, interlace (5 bytes, all 0 for our purposes)
  // CRC (4 bytes, junk for our purposes)
  return buf;
}

// --- JPEG synthesis ---
//
// Build SOI (FF D8) + a JFIF APP0 segment + a SOF0 segment with the dimensions
// we want. The parser needs to walk past APP0 to find SOF0 — exercises segment
// skipping logic.
function buildJpegHeader(width, height, sofMarker = 0xc0) {
  // SOI
  const soi = Buffer.from([0xff, 0xd8]);
  // APP0 (JFIF) — 16-byte data: length(2) + "JFIF\0"(5) + version(2) + units(1) + xden(2) + yden(2) + xthumb(1) + ythumb(1)
  const app0 = Buffer.from([
    0xff, 0xe0,           // marker
    0x00, 0x10,           // length (16, includes itself)
    0x4a, 0x46, 0x49, 0x46, 0x00,  // "JFIF\0"
    0x01, 0x01,           // version 1.1
    0x00,                 // units: aspect ratio
    0x00, 0x01,           // xdensity 1
    0x00, 0x01,           // ydensity 1
    0x00, 0x00,           // thumbnail w=0 h=0
  ]);
  // SOF — marker(2) + length(2) + precision(1) + height(2) + width(2) + components(1)
  // We only need the parser to find marker + read height/width.
  const sof = Buffer.alloc(11);
  sof[0] = 0xff;
  sof[1] = sofMarker;
  // length (from after marker through end): 2 + 1 + 2 + 2 + 1 = 8
  sof.writeUInt16BE(8, 2);
  sof[4] = 8; // precision (8-bit)
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1; // num components (just for valid-shape)
  // (then component data byte at sof[10] = 0)
  return Buffer.concat([soi, app0, sof]);
}

// --- 1. PNG basic ---

test("1. PNG header → 100x100", () => {
  const buf = buildPngHeader(100, 100);
  assert.deepEqual(parsePngDimensions(buf), { width: 100, height: 100 });
});

test("2. PNG header → 3000x2000 (oversized)", () => {
  const buf = buildPngHeader(3000, 2000);
  assert.deepEqual(parsePngDimensions(buf), { width: 3000, height: 2000 });
});

test("3. PNG: truncated buffer → null", () => {
  const buf = buildPngHeader(100, 100).subarray(0, 18); // cut off mid-width
  assert.equal(parsePngDimensions(buf), null);
});

test("4. PNG: wrong magic → null", () => {
  const buf = buildPngHeader(100, 100);
  buf[0] = 0x00; // corrupt magic
  assert.equal(parsePngDimensions(buf), null);
});

test("4b. PNG: wrong IHDR identifier → null", () => {
  const buf = buildPngHeader(100, 100);
  buf[12] = 0x00; // corrupt "IHDR"
  assert.equal(parsePngDimensions(buf), null);
});

// --- 5-7. JPEG ---

test("5. JPEG SOF0 1920x1080", () => {
  const buf = buildJpegHeader(1920, 1080, 0xc0);
  assert.deepEqual(parseJpegDimensions(buf), { width: 1920, height: 1080 });
});

test("6. JPEG SOF2 (progressive) 4096x3072", () => {
  const buf = buildJpegHeader(4096, 3072, 0xc2);
  assert.deepEqual(parseJpegDimensions(buf), { width: 4096, height: 3072 });
});

test("7. JPEG malformed length → null (no crash)", () => {
  const buf = buildJpegHeader(100, 100);
  // Corrupt the APP0 segment length so the scanner walks off the end
  buf[3] = 0xff; // length now huge
  buf[2] = 0xff;
  assert.equal(parseJpegDimensions(buf), null);
});

test("7b. JPEG wrong magic → null", () => {
  const buf = buildJpegHeader(100, 100);
  buf[0] = 0x00;
  assert.equal(parseJpegDimensions(buf), null);
});

// --- 8-11. dispatch via parseImageDimensions ---

test("8. parseImageDimensions(image/png) dispatches", () => {
  const b64 = buildPngHeader(640, 480).toString("base64");
  assert.deepEqual(parseImageDimensions("image/png", b64), { width: 640, height: 480 });
});

test("9. parseImageDimensions(image/jpeg) dispatches", () => {
  const b64 = buildJpegHeader(640, 480).toString("base64");
  assert.deepEqual(parseImageDimensions("image/jpeg", b64), { width: 640, height: 480 });
});

test("9b. parseImageDimensions(image/jpg) also dispatches to JPEG", () => {
  const b64 = buildJpegHeader(640, 480).toString("base64");
  assert.deepEqual(parseImageDimensions("image/jpg", b64), { width: 640, height: 480 });
});

test("10. parseImageDimensions(image/gif) → null (unsupported, fail-open)", () => {
  // Even with valid PNG-shaped data, gif media_type → null
  const b64 = buildPngHeader(100, 100).toString("base64");
  assert.equal(parseImageDimensions("image/gif", b64), null);
});

test("11. parseImageDimensions: empty/missing inputs → null", () => {
  assert.equal(parseImageDimensions("image/png", ""), null);
  assert.equal(parseImageDimensions("", "abc"), null);
  assert.equal(parseImageDimensions(null, "abc"), null);
  assert.equal(parseImageDimensions("image/png", null), null);
});

test("11b. parseImageDimensions: media_type case-insensitive", () => {
  const b64 = buildPngHeader(640, 480).toString("base64");
  assert.deepEqual(parseImageDimensions("IMAGE/PNG", b64), { width: 640, height: 480 });
  assert.deepEqual(parseImageDimensions("Image/Jpeg", buildJpegHeader(800, 600).toString("base64")), { width: 800, height: 600 });
});

test("11c. parseImageDimensions: malformed base64 → null (no throw)", () => {
  // Buffer.from("not-valid-b64", "base64") doesn't throw — produces empty/garbage.
  // The downstream parser should reject.
  assert.equal(parseImageDimensions("image/png", "!!!"), null);
});
