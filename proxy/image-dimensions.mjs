// Pure-JS image header dimension parsing for PNG and JPEG.
//
// Used by the image-strip extension to detect images exceeding a configurable
// max dimension. Stays in a separate module so it can be unit-tested without
// the rest of the proxy machinery.
//
// No native deps. Decode-only — never modifies the image data.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG: after the 8-byte magic, the IHDR chunk begins. IHDR layout:
//   [4 bytes length][4 bytes "IHDR"][4 bytes width BE][4 bytes height BE]...
// Width starts at byte 16, height at byte 20, both 32-bit big-endian.
export function parsePngDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (buffer[i] !== PNG_MAGIC[i]) return null;
  }
  // Verify the IHDR chunk type (offset 12-15 should be ASCII "IHDR")
  if (
    buffer[12] !== 0x49 || buffer[13] !== 0x48 ||
    buffer[14] !== 0x44 || buffer[15] !== 0x52
  ) {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

// JPEG SOF (Start Of Frame) markers we care about. We don't differentiate
// between SOF0 (baseline), SOF1 (extended sequential), SOF2 (progressive),
// SOF3 (lossless) etc — all carry dimensions in the same layout.
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

// JPEG: starts with FF D8 (SOI). Each segment after is FF <marker> [length BE]
// [data...]. We scan for an SOF marker and read width/height from its segment.
// SOF segment layout after the marker: [length 2B][precision 1B][height 2B][width 2B]...
export function parseJpegDimensions(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let i = 2;
  const max = buffer.length;
  // Bound iterations to keep malformed inputs from looping. JPEG headers we
  // care about are well under 1KB; cap at the buffer size we got.
  let iterations = 0;
  while (i < max - 8 && iterations++ < 1000) {
    // Each marker segment starts with 0xFF followed by the marker byte.
    if (buffer[i] !== 0xff) {
      // Skip over fill bytes / pad bytes (not valid in standard JPEG but tolerated)
      i++;
      continue;
    }
    // Skip multiple 0xFF prefixes (pad fill — valid per spec)
    while (i < max - 1 && buffer[i] === 0xff) i++;
    const marker = buffer[i];
    i++;

    // Markers without a length-prefixed segment: SOI (D8), EOI (D9), RST0-7 (D0-D7).
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (i + 1 >= max) return null;
    const segLen = (buffer[i] << 8) | buffer[i + 1];
    if (segLen < 2 || i + segLen > max) return null;

    if (JPEG_SOF_MARKERS.has(marker)) {
      // Layout: [length 2B][precision 1B][height 2B][width 2B]
      // i currently points at the length field's first byte.
      if (i + 6 >= max) return null;
      const height = (buffer[i + 3] << 8) | buffer[i + 4];
      const width = (buffer[i + 5] << 8) | buffer[i + 6];
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }

    // Skip this segment to its end and continue scanning.
    i += segLen;
  }
  return null;
}

// Decode a small prefix of base64 data and dispatch to the right parser based
// on media_type. Returns { width, height } or null.
//
// We decode only the first ~512 bytes — enough for PNG IHDR (always near the
// start) and the typical JPEG SOF location (most image encoders place the SOF
// within the first few hundred bytes).
const HEADER_PROBE_BYTES = 1024;

export function parseImageDimensions(mediaType, base64Data) {
  if (!mediaType || !base64Data || typeof base64Data !== "string") return null;
  // Base64 expands by ~4/3, so to get HEADER_PROBE_BYTES decoded bytes we need
  // ~HEADER_PROBE_BYTES * 4 / 3 base64 chars. Round up generously.
  const probeChars = Math.min(base64Data.length, HEADER_PROBE_BYTES * 2);
  let buffer;
  try {
    buffer = Buffer.from(base64Data.slice(0, probeChars), "base64");
  } catch {
    return null;
  }
  if (!buffer || buffer.length === 0) return null;

  switch (mediaType.toLowerCase()) {
    case "image/png":
      return parsePngDimensions(buffer);
    case "image/jpeg":
    case "image/jpg":
      return parseJpegDimensions(buffer);
    default:
      // Unsupported format — fail-open. Caller treats null as "can't measure"
      // and keeps the image rather than stripping what it can't verify.
      return null;
  }
}
