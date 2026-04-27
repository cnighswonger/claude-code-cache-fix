# Directive: Image guard pipeline (conditional dim cap + request-size guard + optional client-side resize)

**Issue:** #87
**Branch:** `feature/image-guard-pipeline`
**Stage:** directive + implementation (single PR)
**Milestone:** v3.3.0

## Goal

Replace the static `CACHE_FIX_IMAGE_MAX_DIM` model shipped in v3.2.1 with a conditional pipeline that mirrors Anthropic's actual rules. The proxy already sees every base64-encoded image on the way out; it can enforce the rejection thresholds (4xx and 413) client-side and, when the user opts in, do a deliberate client-side Lanczos resize instead of relying on the server's default downscale path.

Three passes, gated by a single opt-in env var. **The passes are independent**: each has its own trigger condition and its own action, and they run in a fixed order. There is no fall-through between passes — if Pass 3 successfully resizes an image, Pass 1 may find nothing to do; if Pass 3 is disabled or fails for an image, Pass 1 evaluates that image against its own (different) threshold.

Pass order:

1. **Pass 3 (when enabled) — opt-in native-cap resize.** Triggered by `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1`. Acts on any image whose long edge exceeds the model's native cap (2576 px for Opus 4.7, 1568 px for all other current models). Action: Lanczos resize to the native cap via `sharp`, preserve aspect ratio, preserve original media type. Runs first because successful resizes shrink images below Pass 1's higher rejection cap and remove work for Pass 1.
2. **Pass 1 — conditional rejection-threshold cap.** Always runs when the pipeline is active. Acts on any image whose long edge exceeds the active rejection cap: 2000 px when total image count > 20, 8000 px otherwise. `CACHE_FIX_IMAGE_MAX_DIM` overrides both as a tighter ceiling. Action: strip the image and replace with the existing forensic placeholder. (Pass 1 never resizes — resizing is Pass 3's job.)
3. **Pass 2 — request-size guard.** Always runs when the pipeline is active. Measures `Buffer.byteLength(JSON.stringify(reqCtx.body))` after Passes 3 + 1 have mutated the body. If the result exceeds the configured budget (default 30 MB, 2 MB headroom from Anthropic's 32 MB ceiling), drop oldest images until under budget.

Plus a **hard image-count cap** (default 100, configurable via `CACHE_FIX_IMAGE_COUNT_MAX`) — defensive, never breaks a request that would have succeeded.

## Why

PR #84 (v3.2.1) shipped `CACHE_FIX_IMAGE_MAX_DIM` as a single static threshold. It works, but it's the wrong shape:

- The 2000 px cap only applies when image count > 20. Setting `MAX_DIM=2000` is an overcorrection for ≤20-image requests, where the real ceiling is 8000 px.
- It doesn't address 413 errors — a request with 19 images each ~2 MB sails past the dimension check and trips the 32 MB body limit.
- It doesn't help users who care about resize quality: the server downsizes blindly (algorithm not documented, and not under client control), which is qualitatively different from a deliberate Lanczos resize for OCR/extraction/document workflows.

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
   - `CACHE_FIX_IMAGE_COUNT_MAX` (default 100 — single cap covering the only model family in active CC use)
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

The pipeline runs in a fixed order. Every pass has its own trigger condition and its own action; passes do not fall through into each other.

| Order | Pass | Trigger condition | Action when triggered | Depends on `sharp`? |
|---|---|---|---|---|
| 0 | KEEP_LAST | `CACHE_FIX_IMAGE_KEEP_LAST=N` set | Strip tool_result images from user messages older than the N most recent | No |
| 3 | Native-cap resize | `IMAGE_GUARD=1` AND `PRESERVE_DETAIL=1` AND image long edge > native cap | Lanczos resize to native cap, preserve media type | Yes (lazy import; falls through on failure) |
| 1 | Rejection-cap strip | `IMAGE_GUARD=1` (or legacy `MAX_DIM=N`) AND image long edge > active rejection cap | Strip and replace with forensic placeholder | No |
| 2 | Request-size guard | `IMAGE_GUARD=1` AND `Buffer.byteLength(JSON.stringify(body)) > budget` | Drop oldest images, re-measure, repeat until under budget | No |
| — | Hard image-count cap | `IMAGE_GUARD=1` AND surviving image count > `CACHE_FIX_IMAGE_COUNT_MAX` | Strip oldest images down to the cap | No |

Passes are numbered by AI Team Lead's design discussion, not execution order. Execution order is **0 → 3 → 1 → 2 → count cap**.

### Pass 0 — legacy KEEP_LAST (back-compat, runs first)

Unchanged from v3.2.1. When `CACHE_FIX_IMAGE_KEEP_LAST=N` is set, strip images from tool_results in user messages older than the N most recent user messages. The remaining passes run on the survivors.

### Pass 3 — native-cap resize (runs second when enabled)

Runs only when both `CACHE_FIX_IMAGE_GUARD=1` and `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1` are set. For each image whose long edge exceeds the model's native cap:

| Model classifier | Native cap (long edge) | Native token cap |
|---|---|---|
| `body.model` starts with `claude-opus-4-7` | 2576 px | 4784 |
| All other models (including unknown / missing `body.model`) | 1568 px | 1568 |

The native-cap classifier is intentionally narrow — only Opus 4.7 has the higher cap. There is no need for the broader 200K-window prefix list here; any non-4.7 model gets the conservative 1568 px target.

Resize behavior:

1. Lazy `await import("sharp")` on the first image that needs resizing in this process. Cache the module reference for subsequent calls.
2. Decode the base64 payload via `sharp`.
3. Resize to the native cap on the long edge using Lanczos resampling, preserve aspect ratio.
4. Re-encode using the **same** media type as the input (JPEG stays JPEG, PNG stays PNG). No transcoding in v1.
5. Replace the original base64 payload with the new bytes.
6. Emit telemetry: increment `resize_attempted` and `resize_succeeded`; record original/resized dims and bytes on a per-image basis if needed for debugging.

If `sharp` is unavailable at first attempt, set `library_missing: true` on telemetry and skip Pass 3 entirely for this request and all subsequent requests until process restart. Pass 1 still runs on the un-resized images and may strip them.

If `sharp` is available but a specific resize call throws (corrupt image, format edge case), increment `resize_failed`, leave the image untouched, and let Pass 1 evaluate it on its own terms.

**Why Pass 3 runs before Pass 1.** A successful resize from 5000×5000 → 2576×2576 leaves an image that is below Pass 1's rejection cap (2000 or 8000) on the count axis it would have otherwise occupied. Running Pass 3 first means Pass 1 has nothing to do for those images. Running them in the other order would mean Pass 1 strips an image that Pass 3 would have rescued.

### Pass 1 — conditional rejection-threshold cap

Runs whenever the pipeline is active (`CACHE_FIX_IMAGE_GUARD=1`) or whenever the legacy `CACHE_FIX_IMAGE_MAX_DIM` env var is set. For each image surviving Pass 3 in `body.messages` (both user-message direct content and `tool_result.content`):

- Probe dimensions via `parseImageDimensions(media_type, base64Data)`. Unparseable dimensions → leave the image alone (fail-open, current behavior).
- Determine the active rejection cap:
  - If `CACHE_FIX_IMAGE_MAX_DIM=N` is set, the active cap is `N` (overrides the conditional logic).
  - Otherwise: count > 20 → cap at 2000 px; count ≤ 20 → cap at 8000 px.
- For each image whose long edge exceeds the active cap: strip, replace with the existing forensic placeholder `[image stripped — exceeded {cap}px max dimension (was {W}x{H}px)]`.

Pass 1 never resizes. Resizing is exclusively Pass 3's concern. This keeps the strip-only path free of any `sharp` dependency.

### Pass 2 — request-size guard

Runs whenever the pipeline is active. After Pass 3 + Pass 1 have mutated `reqCtx.body`:

```js
const serialized = JSON.stringify(reqCtx.body);
let bytes = Buffer.byteLength(serialized);
while (bytes > CACHE_FIX_IMAGE_REQUEST_SIZE_MAX) {
  // Drop the oldest remaining image, then re-serialize and re-measure.
  // Stop when no more images are present (then the body is over budget for
  // non-image reasons, which we do not address here — emit a telemetry
  // counter and let the request fail upstream).
}
```

Eviction order: oldest first, walking `body.messages` from index 0. Within a message, prefer `tool_result.content` images over user-message direct images (tool results are the more common bulk-image carrier). Stop as soon as a re-serialization brings bytes below the budget.

Image-byte totals (`image_bytes_total`, `image_bytes_dropped`) are **telemetry only** — they do not drive enforcement. Enforcement is driven by `Buffer.byteLength(JSON.stringify(reqCtx.body))` exclusively.

### Hard image-count cap

After Passes 0 → 3 → 1 → 2, if the surviving image count exceeds `CACHE_FIX_IMAGE_COUNT_MAX` (default 100), strip oldest images down to the cap. Defensive — most workflows won't hit it — but cheap.

Single cap, no per-model branching. Anthropic's docs distinguish 100 (200K-window models) from 600 (older / smaller-context models), but the latter set is comprised of Claude 1, Claude 2.x, and Claude Instant — none of which are in active use through Claude Code. Users who genuinely need the higher cap can set `CACHE_FIX_IMAGE_COUNT_MAX=600` explicitly. Keeping the default at 100 is safe across every model in current CC use.

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
| `package.json` | ADD — declare `sharp` only under `peerDependenciesMeta` with `optional: true`. Intent: signal the optional integration without imposing a hard install requirement. The proxy never imports `sharp` at module load; the runtime `await import("sharp")` in Pass 3 is what actually exercises it, and that path handles `MODULE_NOT_FOUND` cleanly. |
| `test/proxy-image-guard.test.mjs` | NEW — every precedence row + blocker corrections + sharp-unavailable fallback. |
| `test/proxy-image-strip.test.mjs` | EXTEND — confirm legacy paths unchanged (regression coverage). |
| `README.md` | EXTEND — env-var table additions, precedence matrix verbatim, sharp peer-dep note. |
| `docs/extension-impact-guide.md` | EXTEND — image-strip section: pipeline overview, Pass 3 trade-offs, telemetry. |

### Pipeline shape (sketch)

```js
async function runImageGuard(reqCtx) {
  const stats = initStats();

  // Pass 0: legacy KEEP_LAST (back-compat, runs first regardless of IMAGE_GUARD)
  if (KEEP_LAST > 0) { /* stripOldToolResultImages, mutate reqCtx.body.messages */ }

  // Early exit if neither the new pipeline nor the legacy MAX_DIM is in play
  if (!isImageGuardEnabled() && MAX_DIM <= 0) return stats;

  // Pass 3: native-cap resize (only if IMAGE_GUARD=1 AND PRESERVE_DETAIL=1)
  if (isImageGuardEnabled() && isPreserveDetailEnabled()) {
    await runPass3NativeCapResize(reqCtx, stats);
  }

  // Pass 1: rejection-cap strip — runs if IMAGE_GUARD=1 OR legacy MAX_DIM>0
  runPass1RejectionCapStrip(reqCtx, stats);

  // Pass 2: request-size guard — IMAGE_GUARD only
  if (isImageGuardEnabled()) runPass2RequestSizeGuard(reqCtx, stats);

  // Hard image-count cap — IMAGE_GUARD only
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
  pickPass1Cap,                     // NEW: (imageCount, maxDimOverride) -> capPx
  pickPass3NativeCap,               // NEW: (modelString) -> 2576 | 1568
  walkImagesForPass1,               // NEW: pure walker, returns mutation plan
  walkImagesForPass3,               // NEW: pure walker, returns resize plan (no sharp call here)
  pickEvictionTargets,              // NEW: pure (messages, bytesOver) -> indices to drop
  estimateImageTokens,              // NEW: (width, height, modelCap) -> tokens
};
```

`pickPass3NativeCap` returns 2576 if `body.model` starts with `claude-opus-4-7`, otherwise 1568. No model-classifier complexity beyond that one prefix check.

Tests call these with synthetic message arrays. No env-var-only test seams.

## Test plan

### Activation tests
1. `IMAGE_GUARD` unset, no legacy env vars → extension is loaded but short-circuits; no mutation, no `imageGuardStats`.
2. `IMAGE_GUARD=1` → pipeline runs even with no images in request (stats present, all zeros).
3. `PRESERVE_DETAIL=1` without `IMAGE_GUARD=1` → stderr warning emitted once, no mutation.

### Pass 1 — rejection-cap strip
4. 21 images, all 3000×3000 PNG, `IMAGE_GUARD=1` (no PRESERVE_DETAIL) → all stripped (count > 20 axis, cap 2000 px).
5. 5 images, all 5000×5000 PNG, `IMAGE_GUARD=1` → all kept (count ≤ 20, under 8000 px cap).
6. 5 images, one 9000×9000 PNG, `IMAGE_GUARD=1` → only the 9000×9000 stripped (over 8000 px cap).
7. `IMAGE_GUARD=1` + `MAX_DIM=1500` → 1500 px overrides the conditional cap regardless of count axis.
8. Image with unparseable dimensions (WebP), `IMAGE_GUARD=1` → kept, `unsupported_format_count` incremented.
9. Pass 1 NEVER resizes — confirm stripped image's content block is the forensic-placeholder text, not a smaller base64 payload.

### Pass 2 — request-size guard
10. Request body 35 MB, `IMAGE_GUARD=1` → 30 MB budget triggers eviction; oldest images dropped until under budget; `request_bytes_after <= CACHE_FIX_IMAGE_REQUEST_SIZE_MAX`.
11. Request body 25 MB, `IMAGE_GUARD=1` → no eviction, `images_dropped_for_size === 0`.
12. Custom budget `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX=10485760` (10 MB) → eviction at the lower threshold.
13. Eviction prefers `tool_result.content` images over user-message direct images at same age.

### Pass 3 — native-cap resize (sharp-required tests are conditional on `sharp` being importable in the CI env)
14. `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1`, sharp available, image 3000×3000 PNG, model `claude-opus-4-7-20260101` → resized to 2576 px long edge via Lanczos, media_type stays `image/png`, aspect ratio preserved (e.g., square stays square).
15. `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1`, sharp available, image 3000×3000 JPEG, model `claude-3-5-sonnet-20241022` → resized to 1568 px long edge, media_type stays `image/jpeg`.
16. `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1`, sharp available, **5 images of 5000×5000 PNG, model `claude-3-5-sonnet-...`** → all resized to 1568 px native cap (Pass 3 fires) even though Pass 1's 8000 px cap would have left them untouched. Confirms Pass 3 runs independently for any image above native cap, not only for Pass 1 violations. **This is the test case Codex specifically called out as missing.**
17. `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1`, image 1200×1200 PNG, model `claude-3-5-sonnet-...` (1568 cap) → image kept untouched (under native cap, no resize attempted, no Pass 1 strip).
18. `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1`, sharp unavailable (mocked import failure on first call) → `library_missing: true`, Pass 3 skipped, Pass 1 runs and strips images that exceed its (different, higher) cap. Confirm an image at 5000×5000 with 5 images survives because Pass 1's cap is 8000, and Pass 3 was the one that would have resized it.
19. `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1`, sharp available but resize call throws on a single image (mocked) → `resize_failed` increments by 1, image left untouched, Pass 1 evaluates it on its own terms (5000×5000 with 5 images stays).

### Hard image-count cap
20. Model `claude-opus-4-7-20260101`, 105 images, `IMAGE_GUARD=1` → trimmed to 100; `images_dropped_for_count_cap === 5`.
21. `CACHE_FIX_IMAGE_COUNT_MAX=600` set, model `claude-opus-4-7-20260101`, 605 images → trimmed to 600. Confirms the env var override works.
22. Default `CACHE_FIX_IMAGE_COUNT_MAX` (100), 99 images → no trim, `images_dropped_for_count_cap === 0`.

### Precedence matrix coverage (one test per row in the README matrix)
23. Nothing set → no mutation.
24. `KEEP_LAST=2` only → legacy v3.2.1 behavior (unchanged).
25. `MAX_DIM=2000` only → legacy v3.2.1 behavior.
26. `KEEP_LAST=2` + `MAX_DIM=2000` → legacy two-step.
27. `IMAGE_GUARD=1` → pipeline (Pass 0 no-op + Pass 1 strip + Pass 2 + count cap; no Pass 3).
28. `IMAGE_GUARD=1` + `MAX_DIM=1500` → Pass 1 cap = 1500; Pass 2 still runs.
29. `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1` → adds Pass 3 (skip if no sharp).
30. `IMAGE_GUARD=1` + `KEEP_LAST=2` → KEEP_LAST first (Pass 0), then pipeline on survivors.
31. `IMAGE_GUARD=1` + `KEEP_LAST=2` + `MAX_DIM=1500` → three-way: Pass 0 then pipeline with Pass 1 cap = 1500.
32. `PRESERVE_DETAIL=1` only → no-op + warning.

### Telemetry shape
33. `ctx.meta.imageGuardStats` has every documented field after a pipeline-active request.
34. Stderr line includes the relevant components conditionally (e.g., `resized=N` only appears when Pass 3 actually resized something).

### Regression coverage
35. All v3.2.1 `proxy-image-strip.test.mjs` tests still pass unchanged.
36. All v3.2.1 `proxy-image-dimensions.test.mjs` tests still pass unchanged.

## Reviewer checklist

- [ ] Activation uses `enabled: true` + runtime env-gate (prefix-diff pattern). `extensions.json` updated.
- [ ] Execution order is exactly **Pass 0 → Pass 3 → Pass 1 → Pass 2 → count cap**, with each pass triggered only by its own gate and acting only on its own action (Pass 1 never resizes; Pass 3 never strips).
- [ ] Pass 3 trigger is "`IMAGE_GUARD=1` AND `PRESERVE_DETAIL=1` AND image long edge > native cap"; native cap is 2576 px iff `body.model` starts with `claude-opus-4-7`, otherwise 1568 px.
- [ ] Pass 1 trigger is "image long edge > active rejection cap" with cap = `MAX_DIM` if set, else 2000 (count > 20) or 8000 (count ≤ 20).
- [ ] Pass 2 measures `Buffer.byteLength(JSON.stringify(reqCtx.body))` after Pass 3/1 mutations and trims until under budget.
- [ ] Pass 3 preserves original media type — no transcoding in v1.
- [ ] `sharp` declared in `peerDependenciesMeta` only (not `peerDependencies`); lazy-imported; never required for Pass 0, Pass 1, or Pass 2.
- [ ] Single hard image-count cap default 100, override via `CACHE_FIX_IMAGE_COUNT_MAX`. No 200K-vs-other classifier; the v1 600-cap path was removed because no current CC-pipeline model takes it.
- [ ] Format support: PNG/JPEG only via dimension probe; WebP/GIF/AVIF/BMP fail open with telemetry.
- [ ] All v3.2.1 legacy paths unchanged (`KEEP_LAST` only, `MAX_DIM` only, both together).
- [ ] Precedence matrix in README matches the matrix in this directive verbatim.
- [ ] Telemetry includes the full counter set (counts + bytes + estimated tokens).
- [ ] Tests cover every precedence row, every blocker correction, the above-native-below-rejection gap (test 16), sharp-unavailable fallback, sharp-throws fallback.
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
