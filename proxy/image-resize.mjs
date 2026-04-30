// Lazy `sharp` wrapper for the image-guard pipeline's Pass 3 (native-cap resize).
//
// `sharp` is declared as an OPTIONAL peer dependency in package.json. The proxy
// must run without it. This module:
//
//   1. Lazy-imports `sharp` only when first needed (no module-load cost when
//      Pass 3 is disabled or sharp is absent).
//   2. Caches the import result (success or library-missing failure) so we
//      don't pay the import cost or re-throw repeatedly.
//   3. Returns a stable `{ ok, reason }` shape the caller can branch on
//      without try/catch around every call.
//
// The actual resize uses Lanczos resampling (sharp's default kernel for
// downscales), preserves aspect ratio, and re-encodes using the SAME media
// type as the input. No transcoding in v1 — JPEG stays JPEG, PNG stays PNG.

let _sharpModule = null;          // resolved sharp module (or null if missing)
let _sharpResolved = false;       // have we attempted the import?
let _sharpMissing = false;        // sticky flag — if first import fails, never retry

// Reset hook for tests. Not exported in the default surface; tests import by name.
export function _resetSharpCacheForTests() {
  _sharpModule = null;
  _sharpResolved = false;
  _sharpMissing = false;
}

// Override hook for tests: inject a fake sharp without going through real import.
// The fake should be callable as `fake(buffer)` returning an object with
// `.resize()` and `.toBuffer()`/`.toFormat()` methods like real sharp.
export function _setSharpForTests(fakeSharp) {
  _sharpModule = fakeSharp;
  _sharpResolved = true;
  _sharpMissing = !fakeSharp;
}

async function loadSharp() {
  if (_sharpResolved) {
    return { ok: !_sharpMissing, sharp: _sharpModule };
  }
  try {
    const mod = await import("sharp");
    _sharpModule = mod.default || mod;
    _sharpResolved = true;
    _sharpMissing = false;
    return { ok: true, sharp: _sharpModule };
  } catch (err) {
    _sharpResolved = true;
    _sharpMissing = true;
    _sharpModule = null;
    return { ok: false, sharp: null, err };
  }
}

// Re-encode media type → sharp output format name. Keep symmetric with the
// dimension probe (PNG + JPEG only in v1).
function mediaTypeToSharpFormat(mediaType) {
  switch ((mediaType || "").toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpeg";
    default:
      return null;
  }
}

// Resize a base64-encoded image to `capPx` on the long edge using Lanczos.
// Returns:
//   { ok: true, base64, dims: { width, height }, bytes }     on success
//   { ok: false, reason: "library_missing" | "unsupported_media_type" | "decode_failed" | "resize_failed" }
//
// Caller is expected to:
//   - skip Pass 3 entirely on `library_missing` (sticky for the process)
//   - increment per-image telemetry counters on the other failure modes and
//     leave the original image untouched for Pass 1 to evaluate.
export async function resizeImageToCap(base64Data, mediaType, capPx) {
  if (!base64Data || typeof base64Data !== "string") {
    return { ok: false, reason: "decode_failed" };
  }
  const format = mediaTypeToSharpFormat(mediaType);
  if (!format) {
    return { ok: false, reason: "unsupported_media_type" };
  }

  const loaded = await loadSharp();
  if (!loaded.ok) {
    return { ok: false, reason: "library_missing" };
  }
  const sharp = loaded.sharp;

  let inputBuffer;
  try {
    inputBuffer = Buffer.from(base64Data, "base64");
  } catch {
    return { ok: false, reason: "decode_failed" };
  }
  if (!inputBuffer || inputBuffer.length === 0) {
    return { ok: false, reason: "decode_failed" };
  }

  try {
    const pipeline = sharp(inputBuffer).resize({
      width: capPx,
      height: capPx,
      fit: "inside",          // preserve aspect ratio, neither edge exceeds capPx
      withoutEnlargement: true, // never upscale
      kernel: "lanczos3",
    });

    // Re-encode using the SAME format as the input. No transcoding in v1.
    const encoded = format === "png"
      ? await pipeline.png().toBuffer({ resolveWithObject: true })
      : await pipeline.jpeg().toBuffer({ resolveWithObject: true });

    const newBase64 = encoded.data.toString("base64");
    return {
      ok: true,
      base64: newBase64,
      dims: { width: encoded.info.width, height: encoded.info.height },
      bytes: encoded.data.length,
    };
  } catch {
    return { ok: false, reason: "resize_failed" };
  }
}

// Tiny helper for tests: returns whether sharp was successfully imported once.
// Doesn't trigger an import — caller must have invoked resizeImageToCap first.
export function _sharpStatusForTests() {
  return { resolved: _sharpResolved, missing: _sharpMissing };
}
