# Directive: Strip oversized images in image-strip extension

**Issue:** filed by Alexander (X-15) via Chris on 2026-04-26
**Branch:** `feature/image-strip-max-dim`
**Stage:** directive + implementation (single PR)
**Milestone:** v3.3.0 (or v3.2.1 if treated as enhancement-of-existing-feature)

## Goal

Extend the existing `image-strip` extension to detect images whose largest dimension exceeds a configurable threshold (default off; opt-in via `CACHE_FIX_IMAGE_MAX_DIM=<pixels>`) and strip them before they reach the API. Prevents the Anthropic API error:

> "An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images."

## Why

Two practitioners independently hit this limit:

1. **Alexander** asked for it after running into the error during normal CC use.
2. **Chris** hits it routinely on the Chronology research project — manuscript scans are commonly 5000-10000px on a side. A single hi-res scan plus a few other images in the conversation triggers the error mid-task.

Without intervention, the request fails entirely. Users have no choice but to start a fresh session, losing context. The current `image-strip` extension's `CACHE_FIX_IMAGE_KEEP_LAST=N` behavior only addresses the OLD-images problem; it doesn't help when the user actively wants to attach a hi-res image to the current turn.

## Scope (single PR)

In scope:

1. **New env var: `CACHE_FIX_IMAGE_MAX_DIM=<pixels>`**. Numeric. Default unset = no enforcement (current behavior unchanged). Set to e.g. `2000` to enable.
2. **Image dimension detection** for PNG and JPEG via pure-JS header parsing (no native deps).
3. **Strip oversized images** in BOTH code paths where images can appear:
   - `tool_result.content` items with `type: "image"` (existing image-strip code path)
   - User message `content` blocks with `type: "image"` (new — current image-strip doesn't scan these)
4. **Forensic placeholder** preserves the original dimensions for the model: `[image stripped — exceeded {limit}px max dimension (was {W}x{H}px)]`.
5. **Composes with `CACHE_FIX_IMAGE_KEEP_LAST`**: both can be on simultaneously. KEEP_LAST applies first (strips OLD images entirely), MAX_DIM then applies to whatever images remain (strips OVERSIZED among the kept).
6. New test file `test/proxy-image-dimensions.test.mjs` covering the parsing functions in isolation.
7. Extend `test/proxy-image-strip.test.mjs` (or co-located) with end-to-end tests of the new behavior.

Out of scope:

- **Resizing/downsampling.** Would require a native image-manipulation dep (sharp or similar), which we've intentionally avoided. Strip-only solves the immediate "request fails" problem; resize is a Phase 2 if multiple users ask.
- **GIF, WebP, AVIF, BMP support.** Not in CC's typical image-source pipeline. Add support reactively if practitioners report it.
- **Detecting "many-image" threshold.** Anthropic's exact threshold for when the 2000px limit kicks in isn't documented. Safe approach: enforce the ceiling whenever MAX_DIM is set, regardless of how many images are in the request. Never creates a NEW error, only prevents one.

## Implementation

### `proxy/image-dimensions.mjs` (new module)

Pure functions, easy to unit-test:

```js
// Returns { width, height } or null if undetectable.
export function parsePngDimensions(buffer)   // buffer: Buffer or Uint8Array
export function parseJpegDimensions(buffer)
export function parseImageDimensions(mediaType, base64Data)  // dispatches based on media_type
```

PNG: magic check (`89 50 4E 47 0D 0A 1A 0A`), then width/height as 32-bit big-endian at offsets 16 and 20 in the IHDR chunk.

JPEG: magic check (`FF D8 FF`), then scan for SOF markers (`FF C0`, `FF C1`, `FF C2`). Height/width are 16-bit big-endian at marker+5 and marker+7 in the SOF segment. Skip non-SOF segments using their length field.

For both: decode only the first ~200 bytes from the base64 (enough for headers; PNG's IHDR is always early, JPEG's SOF usually within the first KB but we should bound the scan).

### `proxy/extensions/image-strip.mjs` (extend)

Add a second pass after the existing KEEP_LAST stripping:

```js
const MAX_DIM = parseInt(process.env.CACHE_FIX_IMAGE_MAX_DIM || "0", 10);

function stripOversizedImages(messages, maxDim) {
  if (!maxDim || maxDim <= 0 || !Array.isArray(messages)) {
    return { messages, stats: null };
  }
  // Walk every user-message content block AND every tool_result.content item;
  // for each `type: "image"`, parse dimensions and replace if over the limit.
}
```

Order in `onRequest`:
1. Run KEEP_LAST stripping (existing behavior on tool_result images in old messages).
2. Run MAX_DIM stripping on what remains (both user-message images and tool_result images).

Stats merged into the existing log line: `image-strip: {keepLast stats} {maxDim stats}`.

### Activation

Already-loaded extension (existing `enabled: true` in `extensions.json` if user opted in to image-strip; otherwise their existing config is unchanged). Both env vars are gates — if MAX_DIM is unset, only the existing KEEP_LAST behavior runs.

## Test plan

`test/proxy-image-dimensions.test.mjs` (new):

1. **PNG: valid header, 100x100** → returns `{width: 100, height: 100}`
2. **PNG: valid header, 3000x2000** → returns `{width: 3000, height: 2000}`
3. **PNG: truncated header** → returns `null`
4. **PNG: wrong magic** → returns `null`
5. **JPEG: SOF0 at standard offset, 1920x1080** → returns `{width: 1920, height: 1080}`
6. **JPEG: SOF2 (progressive) at non-zero offset** → returns correct dimensions
7. **JPEG: malformed length field** → returns `null` (doesn't crash)
8. **`parseImageDimensions("image/png", b64)`** → dispatches correctly
9. **`parseImageDimensions("image/jpeg", b64)`** → dispatches correctly
10. **`parseImageDimensions("image/gif", b64)`** → returns `null` (unsupported, fail-open)
11. **`parseImageDimensions("image/png", "")`** → returns `null`

`test/proxy-image-strip.test.mjs` (extend):

12. **MAX_DIM unset → oversized images NOT stripped** (current behavior preserved)
13. **MAX_DIM=2000, image 1000x1000 → kept**
14. **MAX_DIM=2000, image 3000x1500 → stripped, placeholder includes "was 3000x1500px"**
15. **MAX_DIM=2000, image 1500x3000 → stripped (height exceeds)**
16. **MAX_DIM=2000, image 2000x2000 → kept (boundary, dimension equals limit)**
17. **User-message direct image (not in tool_result) gets MAX_DIM treatment too**
18. **MAX_DIM + KEEP_LAST=2 compose**: 5 user messages each with 1 image, last 3 oversized → KEEP_LAST strips first 3, MAX_DIM strips the remaining 3 oversized (placeholder), only the small image survives; both stats logged
19. **Image with unparseable dimensions** → kept (fail-open: don't strip what we can't measure)
20. **Stats correctly track oversized count + bytes**

## Files modified / created

| File | Change |
|---|---|
| `proxy/image-dimensions.mjs` | NEW |
| `proxy/extensions/image-strip.mjs` | EXTEND — add MAX_DIM behavior |
| `test/proxy-image-dimensions.test.mjs` | NEW (~11 tests) |
| `test/proxy-image-strip.test.mjs` | EXTEND (~9 new tests) |
| `README.md` | Document new env var in image-strip section |
| `docs/extension-impact-guide.md` | Update image-strip section |

## Reviewer checklist

- [ ] Pure dimension-parsing functions exported from `proxy/image-dimensions.mjs` with no native deps.
- [ ] PNG magic and dimensions verified at correct offsets.
- [ ] JPEG SOF marker scan handles all three SOF variants (FFC0, FFC1, FFC2) and skips other segments correctly using their length field.
- [ ] Truncated/malformed/unsupported inputs return `null` rather than throwing.
- [ ] MAX_DIM behavior is opt-in via env var; default behavior unchanged when unset.
- [ ] Both image locations covered: user-message direct + tool_result-nested.
- [ ] Strip placeholder includes original dimensions for forensic value.
- [ ] Composes correctly with KEEP_LAST when both env vars are set.
- [ ] Fail-open: images whose dimensions can't be parsed are kept (never break a request because we couldn't measure).
- [ ] Tests pass on Node 18, 20, 22 (CI matrix).
- [ ] No new top-level dependencies.

## Out of scope (explicit)

- Image resizing (Phase 2 if requested; needs sharp or similar)
- GIF/WebP/AVIF/BMP detection
- Detecting Anthropic's exact "many-image" threshold

— AI Team Lead
