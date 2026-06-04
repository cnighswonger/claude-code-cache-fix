# Review: Image guard directive

Date: 2026-04-27
Reviewed: `docs/directives/proxy-image-guard-pipeline.md`
Label applied: `changes-requested`

## What Is Correct

- Activation is specified with the correct prefix-diff pattern: `image-strip` moves to `enabled: true` in `proxy/extensions.json`, and runtime gating stays inside the extension body. This avoids the rejected `enabled: false` loader-shape from the earlier review.
- Pass 2 is pinned to the right enforcement unit: `Buffer.byteLength(JSON.stringify(reqCtx.body))` after Pass 1 / Pass 3 mutations, with image-byte totals telemetry-only.
- Pass 3 explicitly preserves the original media type. The directive does not regress to the rejected JPEG→PNG transcode shape.
- The 200K-context-window prefix list includes `claude-3-7-sonnet-`.
- The precedence matrix now includes the legacy `KEEP_LAST + MAX_DIM` row and the three-way `IMAGE_GUARD + KEEP_LAST + MAX_DIM` row that were missing in the re-review note.
- The test plan covers the requested buckets at a high level: precedence rows, blocker corrections, sharp-unavailable fallback, and model-classification fallback.
- The file map and reviewer checklist are generally aligned with the directive body and the current repo layout.

## Blockers

1. Pass 3 is not pinned to one trigger condition or one target cap.

The directive describes two incompatible implementations:
- In the goal and Pass 3 sections, Pass 3 is an optional quality pass for images above the model's native cap (`1568` / `2576`) even when the request is otherwise valid under the Pass 1 rejection thresholds ([docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L16), [docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L116)).
- In Pass 1, the only images eligible for the Pass 3 branch are images whose long edge exceeds the active Pass 1 cap (`2000`, `8000`, or `MAX_DIM`), and the resize target is that active cap, not the native cap ([docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L91)).

Those are materially different behaviors. For example, with `IMAGE_GUARD=1` and `PRESERVE_DETAIL=1`, a `5000x5000` image in a 5-image request is:
- resized to native cap under the Pass 3 description, but
- left untouched under the Pass 1 description because it is below the `8000px` rejection cap.

The test plan reinforces the ambiguity: test 5 says `5000x5000` images are kept, while tests 13-14 define Pass 3 as a native-cap resize path ([docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L279), [docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L291)).

This needs one explicit rule set:
- whether Pass 3 runs independently for any image above native cap, or only as the action taken for Pass 1 violations, and
- whether its target dimension is the native cap or the active Pass 1 cap when both apply.

2. The hard image-count-cap spec advertises a 600-image "other models" path, but the directive never defines a model class that actually receives it.

The directive says the hard cap is "100 for 200K-window models, 600 for others" and introduces `CACHE_FIX_IMAGE_COUNT_MAX_OTHER` ([docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L18), [docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L51)).

But the only classification rule that is actually specified is:
- known 200K prefix match -> `100`
- no match / unknown / missing model -> fallback `100`

See the hard-cap section and test plan ([docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L149), [docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L297)).

As written, there is no defined path to `600`, which means:
- `CACHE_FIX_IMAGE_COUNT_MAX_OTHER` is dead spec surface, and
- an implementer could either never use `600` or invent a second classifier for "other models", and both readings can claim support from different parts of the directive.

The directive needs to choose one of these clearly:
- v1 intentionally collapses all unknown/non-listed models to the safer `100`, in which case the "600 for others" language and `CACHE_FIX_IMAGE_COUNT_MAX_OTHER` should be removed from scope, or
- v1 supports a real `600` branch, in which case the directive must define exactly which models take that branch and add tests for it.

## What Needs Attention

- The line saying Pass 3 provides "a higher-quality resize than the server's default Lanczos" is not grounded by the rest of the directive. The spec elsewhere only establishes that the server downsizes blindly; it does not establish the server's algorithm. This is wording drift, not a blocker, but it should be tightened to avoid overclaiming ([docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L10)).
- The `package.json` note claims that `peerDependenciesMeta` without a `peerDependencies` entry "prevents npm warnings". The directive may still want that shape, but the rationale should be stated more carefully so implementation review is judging the intended install contract rather than a package-manager side effect claim ([docs/directives/proxy-image-guard-pipeline.md](docs/directives/proxy-image-guard-pipeline.md#L220)).

## Recommendations

- Rewrite the Pass 1 / Pass 3 interaction as ordered decision logic instead of prose fragments. One acceptable shape would be:
  - Pass 1 enforces the rejection-threshold cap (`2000` / `8000` / `MAX_DIM`) and decides whether an image must be modified to avoid a request failure.
  - Pass 3, when enabled, separately applies a native-cap quality resize to any image above native cap, even if Pass 1 would otherwise allow it.
  - If an image violates both, specify the exact target dimension and precedence in one sentence.
- Either remove the unused "other models = 600" path from v1, or define it concretely with a stable classifier and at least one explicit test row that proves the `600` branch is reachable.
- Add one test case that demonstrates the intended behavior for `IMAGE_GUARD=1 + PRESERVE_DETAIL=1` on an image that is above native cap but below the Pass 1 rejection cap. That is the scenario currently left open by the directive.

## Bottom Line

Revise before implementation. The directive fixes the previously blocked activation, byte-accounting, media-type, prefix-list, and precedence-matrix issues, but it still leaves two implementation-shaping choices unresolved: when Pass 3 runs and what dimension target it uses, and whether the advertised 600-image "other models" cap actually exists in v1. Those need to be pinned before downstream implementation review can fairly hold the code to a single behavior.
