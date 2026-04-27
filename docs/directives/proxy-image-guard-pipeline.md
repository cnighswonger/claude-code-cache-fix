# Directive: Image guard pipeline (conditional dim cap + request-size guard + optional client-side resize)

**Issue:** #87
**Branch:** `feature/image-guard-pipeline`
**Stage:** directive + implementation (single PR)
**Milestone:** v3.3.0

## Goal

Replace the static `CACHE_FIX_IMAGE_MAX_DIM` model shipped in v3.2.1 with a conditional pipeline that mirrors Anthropic's actual rules. The proxy already sees every base64-encoded image on the way out; it can enforce the rejection thresholds (4xx and 413) client-side and, when the user opts in, do a higher-quality resize than the server's default Lanczos.

Three passes, gated by a single opt-in env var:

1. **Pass 1 — conditional dimension cap.** Anthropic rejects requests when image count > 20 and any image's long edge > 2000 px (4xx), or when image long edge > 8000 px regardless of count. This pass enforces both thresholds client-side.
2. **Pass 2 — request-size guard.** Anthropic returns 413 `request_too_large` when the serialized request body exceeds 32 MB. This pass measures the post-mutation serialized body and trims oldest images until under a configurable budget (default 30 MB, 2 MB headroom).
3. **Pass 3 — optional Lanczos resize.** When the user opts in via `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1`, images whose long edge exceeds the model's native cap are resized client-side via `sharp` before sending, replacing the server's blind default downscale. Original media type preserved (no transcoding).

Plus a **hard image-count cap** (100 for 200K-window models, 600 for others) — defensive, never breaks a request that would have succeeded.

## Why

PR #84 (v3.2.1) shipped `CACHE_FIX_IMAGE_MAX_DIM` as a single static threshold. It works, but it's the wrong shape:

- The 2000 px cap only applies when image count > 20. Setting `MAX_DIM=2000` is an overcorrection for ≤20-image requests, where the real ceiling is 8000 px.
- It doesn't address 413 errors — a request with 19 images each ~2 MB sails past the dimension check and trips the 32 MB body limit.
- It doesn't help users who care about resize quality: the server downsizes blindly, which is qualitatively different from a deliberate Lanczos resize for OCR/extraction/document workflows.

The pipeline is the right shape. v3.2.1's `CACHE_FIX_IMAGE_MAX_DIM` env var continues to work as a hard size override (for users who already use it); the new pipeline is opt-in via a separate env var.

## Source of truth

This directive is the implementation form of the design discussion on issue #87, which closed with Codex's APPROVED-with-notes re-review on 2026-04-27. The two non-blocking notes (model-prefix list, precedence-matrix legacy combinations) are folded in below.

Key references in the issue thread:
- Anthropic doc research comment — token formula, server-side resize behavior, conditional dim cap, 32 MB body limit, image count caps, third-party platform caps.
- Quality-preservation addendum — why client-side Lanczos is not equivalent to server-side blind downscale.
- Codex review #1 (REQUEST CHANGES) — three blockers: activation pattern, byte-unit error, transcoding ambiguity.
- Resolutions comment — verbatim resolutions, full telemetry counter set, model-prefix list, precedence matrix.
- Codex re-review (APPROVED with notes) — the two doc refinements.
- Notes-fix comment — expanded precedence matrix.

## Scope (v3.3.0)

In scope:

1. New env var `CACHE_FIX_IMAGE_GUARD=1` — top-level pipeline gate.
2. New env var `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1` — opt-in for Pass 3 (Lanczos resize via `sharp`).
3. New env vars for tunable defaults:
   - `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX` (default 31457280 — 30 MB; 2 MB headroom from Anthropic's 32 MB ceiling)
   - `CACHE_FIX_IMAGE_COUNT_MAX_200K` (default 100)
   - `CACHE_FIX_IMAGE_COUNT_MAX_OTHER` (default 600)
4. Pipeline implementation in `proxy/extensions/image-strip.mjs` (extend, don't rewrite — keep `stripOldToolResultImages` and `stripOversizedImages` intact for the legacy-only paths).
5. Optional `sharp` peer-dep declared via `peerDependenciesMeta` (`optional: true`). Lazy-loaded only when Pass 3 is enabled.
6. New `proxy/image-resize.mjs` module — Lanczos resize wrapper that lazy-imports `sharp` and reports `library_missing` cleanly.
7. Telemetry surface on `ctx.meta.imageGuardStats` — the full counter set from the resolutions comment.
8. README precedence-matrix section + env-var table updates.
9. Test coverage for every precedence row, every blocker correction, and the sharp-unavailable fallback path.

Out of scope (deferred):

- Format conversion (e.g., JPEG → PNG). v1 preserves the original media type to avoid the JPEG-byte-explosion failure mode Codex flagged.
- WebP/GIF/AVIF/BMP dimension probing. Pass 1 currently fails open for these (per `image-dimensions.mjs:109`); v1 keeps that behavior. Telemetry records `unsupported_format_count` so we can see whether expanding support is worth the parser work.
- Pure-JS Lanczos fallback. v1 requires `sharp`; without it, Pass 3 logs `library_missing` and skips. Pass 1 + Pass 2 still run.
- Custom resampling algorithms (bicubic, nearest-neighbor). Lanczos only.

## Activation

**Prefix-diff pattern** (the `overage-warning` / `upstream-change-detection` shape). The corrected activation:

- `image-strip` extension flips to `enabled: true` and is registered in `proxy/extensions.json` (currently absent — falls through to the per-extension default of `enabled: false`).
- Runtime gate inside the extension body: `if (!isImageGuardEnabled() && !isLegacyKeepLastSet() && !isLegacyMaxDimSet()) return;`. The legacy gates remain functional for back-compat — users on v3.2.1 who set `CACHE_FIX_IMAGE_KEEP_LAST` or `CACHE_FIX_IMAGE_MAX_DIM` keep getting their existing behavior with no edit to `extensions.json` required.
- Existing behavior preserved: `CACHE_FIX_IMAGE_KEEP_LAST` and `CACHE_FIX_IMAGE_MAX_DIM` continue to drive the legacy `stripOldToolResultImages` / `stripOversizedImages` paths exactly as in v3.2.1.

The repeat error from PR #79 round-1 (`enabled: false` + env-var gate cannot work because the loader skips disabled extensions) is avoided by construction here.

## Pipeline

### Pass 0 — legacy KEEP_LAST (back-compat, runs first)

Unchanged from v3.2.1. When `CACHE_FIX_IMAGE_KEEP_LAST=N` is set, strip images from tool_results in user messages older than the N most recent user messages. The pipeline (Passes 1–3) runs on the survivors.

### Pass 1 — conditional dimension cap

For each image in `body.messages` (both user-message direct content and `tool_result.content`):

- Probe dimensions via `parseImageDimensions(media_type, base64Data)`.
- Determine the per-image dimension cap based on aggregate image count in the request:
  - count > 20 → cap at 2000 px on the long edge
  - count ≤ 20 → cap at 8000 px on the long edge
- If `CACHE_FIX_IMAGE_MAX_DIM` is also set, it overrides the conditional cap (legacy users who explicitly set a tighter ceiling keep that ceiling).
- For each image whose long edge exceeds the active cap:
  - **Pass 3 enabled and `sharp` loadable** → resize to the cap on long edge via Lanczos, preserve aspect ratio, preserve original media type. Replace the base64 payload.
  - **Pass 3 disabled or `sharp` unavailable** → strip the image, replace with the existing forensic placeholder `[image stripped — exceeded {cap}px max dimension (was {W}x{H}px)]`.

Pass 1 has zero hard dependency on `sharp`. The strip-fallback is the existing `stripOversizedImages` behavior; Pass 3 just upgrades the action when the dependency is present.

### Pass 2 — request-size guard

After Pass 1 (and Pass 3 if enabled) have run:

```js
const serialized = JSON.stringify(reqCtx.body);
let bytes = Buffer.byteLength(serialized);
if (bytes > CACHE_FIX_IMAGE_REQUEST_SIZE_MAX) {
  // Drop oldest images until under budget.
  // Re-serialize to re-measure after each drop.
}
```

Eviction order: oldest first, walking `body.messages` from index 0. Within a message, prefer `tool_result.content` images over user-message direct images (tool results are the more common bulk-image carrier). Stop as soon as a re-serialization brings bytes below the budget.

Image-byte totals (`image_bytes_total`, `image_bytes_dropped`) become **telemetry only** — they do not drive enforcement. Enforcement is driven by `Buffer.byteLength(JSON.stringify(reqCtx.body))` exclusively, after mutations.

### Pass 3 — Lanczos resize (opt-in, lazy `sharp`)

Triggered inside Pass 1 when `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1` is set. For images that exceed the model's native cap:

| Model family prefix | Native cap (long edge) | Native token cap |
|---|---|---|
| `claude-opus-4-7` and later 4.7 variants | 2576 px | 4784 |
| All other current models | 1568 px | 1568 |

Resize behavior:

1. Decode the base64 payload via `sharp` (lazy `await import("sharp")` on first call; cached for subsequent calls).
2. Resize to the cap on the long edge using Lanczos resampling, preserve aspect ratio.
3. Re-encode using the **same** media type as the input (JPEG stays JPEG, PNG stays PNG). No transcoding in v1.
4. Replace the original base64 payload with the new bytes.
5. Emit telemetry: `{path, original_dims, resized_dims, original_bytes, resized_bytes, algorithm: "lanczos"}`.

If `sharp` is unavailable at first attempt, set `library_missing: true` on telemetry, fall back to Pass 1's strip behavior for the rest of the request, and never re-attempt the import in this process. Subsequent requests skip Pass 3 entirely until restart.

### Hard image-count cap

After Passes 0–3, if the surviving image count exceeds the model's hard cap, strip oldest images down to the cap. This is mostly defensive — most workflows won't hit it — but cheap to add.

Model classification for the cap (200K-context-window prefix list):

```
claude-opus-4-
claude-sonnet-4-
claude-haiku-4-
claude-3-7-sonnet-
claude-3-5-sonnet-
claude-3-5-haiku-
claude-3-opus-
```

Match the request's `body.model` against the list:
- Match → cap at `CACHE_FIX_IMAGE_COUNT_MAX_200K` (default 100)
- No match (unknown alias, beta model, missing model field) → fall back to the safer **100**, increment `model_classification_unknown_count` in telemetry. Better to over-trim and surface the classification gap than to under-trim and 4xx.

## Precedence matrix

This matrix goes into the README directly when shipped. Every documented combination has a defined behavior in one place.

| Env var combination | Behavior |
|---|---|
| Nothing set | No image processing (back-compat default; the extension short-circuits). |
| `KEEP_LAST=N` only | Existing v3.2.1: count cap on tool_result images in user messages, runs first. No pipeline. |
| `MAX_DIM=N` only | Existing v3.2.1: hard size cap, strip-only. No pipeline. |
| `KEEP_LAST=N` + `MAX_DIM=N` | Existing v3.2.1 composition: `KEEP_LAST` runs first (drops count), then `MAX_DIM` runs on survivors (caps size). No pipeline, no Pass 2, no Pass 3. |
| `IMAGE_GUARD=1` | New pipeline: Pass 1 (conditional cap) + Pass 2 (request-size guard) + image-count cap. |
| `IMAGE_GUARD=1` + `MAX_DIM=N` | `MAX_DIM` overrides Pass 1's conditional cap (acts as the cap value); Pass 2 still runs. |
| `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1` | Adds Pass 3 (Lanczos resize via `sharp`). When `sharp` unavailable, falls back to strip behavior. |
| `IMAGE_GUARD=1` + `KEEP_LAST=N` | `KEEP_LAST` runs first as count cap (Pass 0); pipeline runs on remainder. |
| `IMAGE_GUARD=1` + `KEEP_LAST=N` + `MAX_DIM=N` | Three-way: `KEEP_LAST` runs first; pipeline runs on remainder, but `MAX_DIM` overrides Pass 1's conditional cap; Pass 2 still runs. |
| `PRESERVE_DETAIL=1` without `IMAGE_GUARD=1` | Logs warning, treats as no-op. `PRESERVE_DETAIL` is meaningless without the pipeline running. |

## Telemetry

Full counter set on `ctx.meta.imageGuardStats`:

```js
ctx.meta.imageGuardStats = {
  // counts
  total_images: number,
  count_axis_path: "few" | "many",     // <=20 vs >20
  unsupported_format_count: number,
  dimension_probe_fail_count: number,
  resize_attempted: number,
  resize_succeeded: number,
  resize_failed: number,
  library_missing: boolean,
  images_dropped_for_size: number,
  images_dropped_for_count_cap: number,
  model_classification_unknown_count: number,

  // bytes
  request_bytes_before: number,
  request_bytes_after: number,
  request_bytes_headroom: number,      // budget - bytes_after
  image_bytes_total: number,           // telemetry only, NOT enforcement
  image_bytes_dropped: number,

  // estimated tokens (informational, NOT enforcement)
  estimated_image_tokens_total: number,
};
```

`estimated_image_tokens_total` uses Anthropic's documented `width * height / 750` formula, capped at the model's native token cap. It's purely diagnostic — the proxy never trims on token budget because the server already enforces a per-image cap.

A single stderr line is emitted per processed request when the pipeline did anything:

```
[image-guard] {summary} req_bytes=N->M (headroom=K) images=A->B
```

Components are conditional on what actually happened (e.g., `resized=3` only appears if Pass 3 resized something).

## Implementation

### File map

| File | Change |
|---|---|
| `proxy/extensions/image-strip.mjs` | EXTEND — add `runImageGuard(reqCtx)` pipeline; keep legacy `stripOldToolResultImages`, `stripOversizedImages` intact. |
| `proxy/image-resize.mjs` | NEW — lazy `sharp` wrapper; exports `resizeImageToCap(buffer, mediaType, capPx)` returning `{buffer, dims}` or null. |
| `proxy/extensions.json` | EXTEND — add `"image-strip": { "enabled": true, "order": 150 }`. |
| `package.json` | ADD — `peerDependenciesMeta: { sharp: { optional: true } }`. No `peerDependencies` entry (avoid hard install gate); the `optional: true` marker prevents npm warnings for users who don't install it. |
| `test/proxy-image-guard.test.mjs` | NEW — every precedence row + blocker corrections + sharp-unavailable fallback. |
| `test/proxy-image-strip.test.mjs` | EXTEND — confirm legacy paths unchanged (regression coverage). |
| `README.md` | EXTEND — env-var table additions, precedence matrix verbatim, sharp peer-dep note. |
| `docs/extension-impact-guide.md` | EXTEND — image-strip section: pipeline overview, Pass 3 trade-offs, telemetry. |

### Pipeline shape (sketch)

```js
async function runImageGuard(reqCtx) {
  const stats = initStats();
  const messages = reqCtx.body.messages;

  // Pass 0: legacy KEEP_LAST (existing helper, unchanged)
  if (KEEP_LAST > 0) { /* stripOldToolResultImages, mutate reqCtx.body.messages */ }

  // Early exit if neither IMAGE_GUARD nor MAX_DIM is in play
  if (!isImageGuardEnabled() && MAX_DIM <= 0) return stats;

  // Pass 1 (with optional Pass 3 inline)
  await runPass1(reqCtx, stats);

  // Pass 2: serialized-body-size guard
  if (isImageGuardEnabled()) runPass2(reqCtx, stats);

  // Hard image-count cap
  if (isImageGuardEnabled()) runImageCountCap(reqCtx, stats);

  return stats;
}
```

### Pure functions exposed for tests

The existing test seam pattern (pure functions exported alongside the default extension) extends naturally:

```js
export {
  stripOldToolResultImages,         // unchanged from v3.2.1
  stripOversizedImages,             // unchanged from v3.2.1
  classifyModelImageCountCap,       // NEW: (modelString) -> {cap: 100|600, unknown: bool}
  pickPass1Cap,                     // NEW: (imageCount, maxDimOverride) -> capPx
  walkImagesForPass1,               // NEW: pure walker, returns mutation plan
  pickEvictionTargets,              // NEW: pure (messages, bytesOver) -> indices to drop
  estimateImageTokens,              // NEW: (width, height, modelCap) -> tokens
};
```

Tests call these with synthetic message arrays. No env-var-only test seams.

## Test plan

### Activation tests
1. `IMAGE_GUARD` unset, no legacy env vars → extension is loaded but short-circuits; no mutation, no `imageGuardStats`.
2. `IMAGE_GUARD=1` → pipeline runs even with no images in request (stats present, all zeros).
3. `PRESERVE_DETAIL=1` without `IMAGE_GUARD=1` → stderr warning emitted once, no mutation.

### Pass 1 — conditional dim cap
4. 21 images, all 3000×3000 PNG → all resized/stripped to 2000 px cap (count > 20 axis).
5. 5 images, all 5000×5000 PNG → all kept (count ≤ 20, under 8000 px cap).
6. 5 images, one 9000×9000 PNG → that one resized/stripped to 8000 px cap.
7. `MAX_DIM=1500` set → 1500 px overrides the conditional cap regardless of count axis.
8. Image with unparseable dimensions (WebP) → kept, `unsupported_format_count` incremented.

### Pass 2 — request-size guard
9. Request body 35 MB, no other config → 30 MB budget triggers eviction; oldest images dropped until under budget; `request_bytes_after < CACHE_FIX_IMAGE_REQUEST_SIZE_MAX`.
10. Request body 25 MB → no eviction, `images_dropped_for_size === 0`.
11. Custom budget `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX=10485760` (10 MB) → eviction at the lower threshold.
12. Eviction prefers `tool_result.content` images over user-message direct images at same age.

### Pass 3 — Lanczos resize (only runs in CI environments with sharp installed; skip otherwise)
13. `PRESERVE_DETAIL=1`, sharp available, image 3000×3000 PNG, model `claude-opus-4-7` → resized to 2576 px long edge, media_type stays `image/png`, dims preserved aspect ratio.
14. `PRESERVE_DETAIL=1`, sharp available, image 3000×3000 JPEG, model `claude-3-5-sonnet-...` → resized to 1568 px long edge, media_type stays `image/jpeg`.
15. `PRESERVE_DETAIL=1`, sharp unavailable (mocked) → `library_missing: true`, falls back to strip behavior.

### Hard image-count cap
16. Model `claude-opus-4-7-20260101`, 105 images → trimmed to 100; `images_dropped_for_count_cap === 5`.
17. Model `claude-3-haiku-20240307` (legacy non-200K, prefix-list-miss) → unknown classification, falls back to 100, `model_classification_unknown_count > 0`.
18. Model `claude-3-7-sonnet-20250219` (200K-window) → cap at 100, no unknown bump.

### Precedence matrix coverage (one test per row in the README matrix)
19. Nothing set → no mutation.
20. `KEEP_LAST=2` only → legacy v3.2.1 behavior (unchanged).
21. `MAX_DIM=2000` only → legacy v3.2.1 behavior.
22. `KEEP_LAST=2` + `MAX_DIM=2000` → legacy two-step.
23. `IMAGE_GUARD=1` → pipeline.
24. `IMAGE_GUARD=1` + `MAX_DIM=1500` → pipeline with MAX_DIM overriding conditional cap.
25. `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1` → adds Pass 3 (skip if no sharp).
26. `IMAGE_GUARD=1` + `KEEP_LAST=2` → KEEP_LAST first, then pipeline.
27. `IMAGE_GUARD=1` + `KEEP_LAST=2` + `MAX_DIM=1500` → three-way.
28. `PRESERVE_DETAIL=1` only → no-op + warning.

### Telemetry shape
29. `ctx.meta.imageGuardStats` has every documented field after a pipeline-active request.
30. Stderr line includes the relevant components conditionally.

### Regression coverage
31. All v3.2.1 `proxy-image-strip.test.mjs` tests still pass unchanged.
32. All v3.2.1 `proxy-image-dimensions.test.mjs` tests still pass unchanged.

## Reviewer checklist

- [ ] Activation uses `enabled: true` + runtime env-gate (prefix-diff pattern). `extensions.json` updated.
- [ ] Pass 2 measures `Buffer.byteLength(JSON.stringify(reqCtx.body))` after Pass 1/3 mutations and trims until under budget.
- [ ] Pass 3 preserves original media type — no transcoding in v1.
- [ ] `sharp` declared in `peerDependenciesMeta` only (not `peerDependencies`); lazy-imported; never required for Pass 1 or Pass 2.
- [ ] Model classification: prefix list includes `claude-3-7-sonnet-`; unknown → fallback to 100 with telemetry bump.
- [ ] Format support: PNG/JPEG only via dimension probe; WebP/GIF/AVIF/BMP fail open with telemetry.
- [ ] All v3.2.1 legacy paths unchanged (`KEEP_LAST` only, `MAX_DIM` only, both together).
- [ ] Precedence matrix in README matches the matrix in this directive verbatim.
- [ ] Telemetry includes the full counter set (counts + bytes + estimated tokens).
- [ ] Tests cover every precedence row, every blocker correction, sharp-unavailable fallback, model-classification fallback.
- [ ] CI green on Node 18 / 20 / 22 (CI matrix). `sharp` not required for CI — Pass 3 tests are conditional.
- [ ] No new top-level dependencies.

## Out of scope (explicit, deferred)

- Format conversion (transcoding).
- WebP / GIF / AVIF / BMP dimension probing.
- Pure-JS Lanczos fallback (`pica` or hand-rolled).
- Custom resampling algorithms.
- Request-size measurements in token space (server-side per-image cap makes proxy-side aggregate-token trimming non-load-bearing).
- Bedrock / Vertex AI variant size limits (this proxy targets the direct Anthropic API).

— Proxy Builder
