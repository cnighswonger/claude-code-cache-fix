# Review: issue #87 image-guard design re-review

Date: 2026-04-27
Reviewed: Issue #87 (`proxy: image-strip — full conditional pipeline matching Anthropic's actual image constraints`)
Label applied: approved-by-codex-agent

## What Is Correct
- The activation fix is now explicit enough to implement correctly. The resolution names the required loader shape directly: `image-strip` switched to `enabled: true`, then runtime-gated with `if (!process.env.CACHE_FIX_IMAGE_GUARD) return ctx;`. That matches the repo's established prefix-diff pattern used by `overage-warning` and `upstream-change-detection`, and it also adds a directive-level reminder so the mistake is less likely to recur.
- The request-size guard now budgets the right unit. Measuring `Buffer.byteLength(JSON.stringify(reqCtx.body))` after Pass 1 / Pass 3 mutations and then dropping oldest images until the serialized body is back under the configured ceiling is sufficient to prevent the real `413` failure mode. The important property is the final pre-send measurement of the fully mutated body; image-only byte totals are correctly demoted to telemetry.
- Pass 3's v1 re-encode policy is now safe and deterministic: resize only, preserve original media type, no automatic transcoding, `sharp` lazy-loaded as an optional peer dependency. That removes both the JPEG-to-PNG size explosion risk and the need for proxy-side content classification heuristics.
- The unsupported-format policy is now explicit rather than accidental: PNG/JPEG are enforced in v1, unsupported formats fail open, and telemetry records the gap. That is an acceptable scope boundary for a first implementation.
- Pass 1's sharp-unavailable behavior is clear and workable. The rejection-avoidance core does not acquire a hard native dependency; it falls back to the existing strip path, while Pass 3 logs and skips when the library is unavailable.
- The telemetry schema is materially improved. It now exposes the counters needed to understand both success paths and blind spots, and it keeps `estimated_image_tokens_total` informational rather than turning it back into an enforcement signal.

## Blockers
None.

## What Needs Attention
- The hardcoded 100-cap model-prefix list is safe because unknown models fall back to `100`, but it is probably still worth adding `claude-3-7-sonnet-` explicitly if that family remains in circulation in any deployments. Omitting it does not create an under-enforcement risk; it only increases "unknown classification" telemetry and could cause avoidable over-trimming.
- The precedence table is directionally correct but not fully exhaustive. The README should spell out the existing `KEEP_LAST=N` + `MAX_DIM=N` combination explicitly, and ideally the three-way `KEEP_LAST + IMAGE_GUARD + MAX_DIM` ordering too, instead of leaving those to inference.

## Recommendations
- Approve the design and move to implementation with the resolved blocker text carried over verbatim into the implementation directive, especially the activation line and the exact serialized-body measurement rule.
- Add `claude-3-7-sonnet-` to the 100-cap prefix list if the team still expects legacy Claude 3.7 traffic in the field.
- Expand the precedence section in the README/tests so every supported env-var combination used today is described in one place.

## Bottom Line
Approve with notes. The three blockers from the first review are resolved cleanly: activation now matches the loader's real behavior, Pass 2 budgets the actual serialized request bytes, and Pass 3 has a deterministic no-transcoding policy. The remaining nits are documentation-level refinements around model-prefix completeness and precedence-table exhaustiveness, not design blockers.
