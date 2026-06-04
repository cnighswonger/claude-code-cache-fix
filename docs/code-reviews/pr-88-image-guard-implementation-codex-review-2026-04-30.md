# Review: PR 88 image-guard implementation

Date: 2026-04-30
Reviewed: commit `f64d35f` against `docs/directives/proxy-image-guard-pipeline.md`
Label applied: changes-requested

## What Is Correct

- The implementation matches the required execution order in code: Pass 0 in `onRequest()`, then Pass 3, Pass 1, Pass 2, then count cap in `runImageGuard()` ([proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L647), [proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L523), [proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L528), [proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L533), [proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L538)).
- Pass isolation is implemented correctly. Pass 3 only resizes and never strips; Pass 1 only strips and never resizes ([proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L341), [proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L381)).
- Pass 3’s trigger and model cap logic match the directive: `CACHE_FIX_IMAGE_GUARD=1` plus `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1`, with 2576 px only for `claude-opus-4-7*` and 1568 px otherwise ([proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L181), [proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L523)).
- Pass 2 uses `Buffer.byteLength(JSON.stringify(reqCtx.body))` after prior mutations, and eviction order prefers older images first with `tool_result` images ahead of direct images at the same age ([proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L282), [proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L421)).
- The `sharp` integration is lazy and isolated in `proxy/image-resize.mjs`; Passes 0/1/2 do not import it. Media type is preserved on successful resize, and the library-missing path is sticky as specified ([proxy/image-resize.mjs](proxy/image-resize.mjs#L37), [proxy/image-resize.mjs](proxy/image-resize.mjs#L57), [proxy/image-resize.mjs](proxy/image-resize.mjs#L112)).
- `image-strip` is registered at order 150, `sharp` is declared only under `peerDependenciesMeta`, and the new test file covers the key directive cases including T16, T18, and T19 ([proxy/extensions.json](proxy/extensions.json#L3), [package.json](package.json#L24), [test/proxy-image-guard.test.mjs](test/proxy-image-guard.test.mjs#L512), [test/proxy-image-guard.test.mjs](test/proxy-image-guard.test.mjs#L553), [test/proxy-image-guard.test.mjs](test/proxy-image-guard.test.mjs#L575)).

## Blockers

- README precedence matrix is not the directive text verbatim. The directive says the matrix goes into the README directly and defines exact row wording ([docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L160)), but the shipped README shortens and paraphrases multiple rows instead of copying them verbatim ([README.md](README.md#L390)). This fails the explicit implementation requirement the PR was asked to satisfy.
- Pass 1-only mutations do not emit the required `[image-guard]` stderr summary. The directive requires a single stderr line whenever “the pipeline did anything” ([docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L207)), but `didSomething` only checks resize/eviction/probe-failure counters and has no condition for Pass 1 stripping ([proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L659)). Reproduced locally with `CACHE_FIX_IMAGE_GUARD=1` and one `9000x9000` PNG on Sonnet: the image is stripped, `ctx.meta.imageGuardStats` is populated, and captured stderr is empty.

## What Needs Attention

- `request_bytes_after` and the summary line are finalized in Pass 2 and not recomputed after the later count-cap pass, so count-cap-only requests report unchanged byte totals even after images are dropped ([proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L421), [proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L456), [proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L682)). That is telemetry drift rather than enforcement drift, but it makes the emitted summary misleading on T20/T21-style requests.

## Recommendations

- Replace the README precedence matrix rows with the exact directive text, row for row, rather than a shortened restatement.
- Track Pass 1 strip count explicitly in `imageGuardStats` or otherwise derive a `didSomething` condition that includes Pass 1 replacements, then emit the summary line for those requests.
- Recompute `request_bytes_after` and `request_bytes_headroom` after the count-cap pass so the final telemetry reflects the actual post-pipeline body.

## Bottom Line

The core pipeline logic is in good shape: ordering, gating, sharp fallback behavior, legacy-path preservation, and the key T16/T18/T19 implementation cases all check out. I do not approve this implementation yet because it still misses two directive-level deliverables: the README precedence matrix is not shipped verbatim, and the required stderr summary is absent for Pass 1-only work.
