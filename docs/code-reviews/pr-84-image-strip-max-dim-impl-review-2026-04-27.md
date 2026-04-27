# Review: image-strip max-dim implementation

Date: 2026-04-27
Reviewed: PR #84 (`feat: image-strip — add CACHE_FIX_IMAGE_MAX_DIM oversized-image guard`)
Label applied: approved-by-codex-agent

## What Is Correct

- `proxy/image-dimensions.mjs` cleanly isolates pure helpers with no non-stdlib imports. `parsePngDimensions`, `parseJpegDimensions`, and `parseImageDimensions` all fail closed to `null` on malformed or unsupported inputs instead of throwing.
- PNG parsing is correct: signature bytes are verified, the `IHDR` chunk identifier is checked, and width/height are read from the correct big-endian offsets.
- JPEG parsing is implemented defensibly: SOF markers include the baseline/progressive variants plus the rarer SOF forms that share the same layout, non-SOF segments are skipped by their declared length, and the scan loop is bounded.
- `proxy/extensions/image-strip.mjs` preserves default behavior when `CACHE_FIX_IMAGE_MAX_DIM` is unset, keeps the legacy `ctx.meta.imageStripStats` shape intact for `KEEP_LAST`, and writes the new oversized-image stats to a separate `ctx.meta.imageStripOversizedStats` field.
- Oversized-image stripping covers both required locations: direct user-message image blocks and `tool_result.content` nested image blocks.
- Composition order is correct: `KEEP_LAST` runs first, then max-dimension stripping operates on the surviving images.
- Fail-open behavior is preserved: images with unknown or unparseable dimensions are retained rather than breaking or mutating the request.
- The placeholder text includes the original dimensions, which preserves useful forensic context for downstream debugging.
- Test coverage is good for the new surface area. Focused tests pass (`36/36`) and the full suite passes (`553/553`).

## Blockers

None.

## What Needs Attention

- The directive scoped README and `docs/extension-impact-guide.md` updates for the new `CACHE_FIX_IMAGE_MAX_DIM` env var, but this PR does not include those documentation changes. That is not a correctness issue in the runtime path, but it is a scope mismatch worth cleaning up before or immediately after merge.

## Recommendations

- Add the scoped documentation updates so operators can discover the new opt-in guard without reading the implementation or directive.
- Consider a future regression test with a JPEG header that contains a larger pre-SOF metadata segment, to pin the current bounded-probe assumption more explicitly.

## Bottom Line

Ship it. The implementation matches the directive’s reviewer checklist, preserves backward compatibility, composes correctly with the existing `KEEP_LAST` behavior, and passes both targeted and full test suites. The only gap I found is missing end-user documentation for the new env var, which should be cleaned up but does not justify blocking the implementation.
