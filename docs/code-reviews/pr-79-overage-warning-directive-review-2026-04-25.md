# Review: overage cost warning directive

Date: 2026-04-25
Reviewed: PR #79 (`feature/overage-cost-warning`)
Label applied: changes-requested

## What Is Correct
- Splitting this into a new `overage-warning` extension is the right shape for the proxy. The directive keeps `cache-telemetry` focused on persisting the latest quota snapshot and isolates the rolling-window/dedup state machine in its own module, which fits the existing extension pipeline well.
- The overall product scope is appropriate for v3.2.0. Advisory-only output, no request mutation, no restart-persistent state, and no status-line integration keep the first cut bounded.
- The proposed seams align with current extension patterns. Exporting pure helpers alongside the default extension matches how diagnostic extensions such as `prefix-diff` are tested, and the JSONL output gives downstream tools a stable integration point.
- The dedup intent is directionally sound. Keying warnings by threshold plus reset window is a reasonable way to avoid spamming the same signal on every response while still allowing distinct threshold escalations to surface.
- The test plan covers the important functional cases: trigger gates, warm-up behavior, dedup across window changes, quiet mode, and append semantics.

## Blockers
- `docs/directives/proxy-overage-cost-warning.md:130-145` and `:174-175` define an activation model that does not work as written with the current pipeline. The directive says `CACHE_FIX_OVERAGE_WARNING=1` is the opt-in switch, but it also says the new `extensions.json` entry should default to `enabled: false`. In this repo, `enabled: false` means the module is not loaded at all ([proxy/pipeline.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/pipeline.mjs:10), [proxy/extensions.json](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions.json:1)), so a runtime env var inside the extension cannot activate it. Existing patterns choose one of two models: `enabled: true` plus an internal env gate (`prefix-diff`), or `enabled: false` with opt-in via `extensions.json` (`usage-log`). The directive needs to pick one model explicitly before implementation.
- `docs/directives/proxy-overage-cost-warning.md:22-28`, `:44`, and `:68-83` do not pin down when the warning is actually emitted relative to the stream lifecycle. The directive says detection happens on `onResponseStart`, but the projection inputs come from `ctx.meta.cacheStats` populated later from `message_start`/`message_delta` events ([proxy/stream.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/stream.mjs:15), [proxy/extensions/cache-telemetry.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/cache-telemetry.mjs:65)). As written, the extension cannot both fire on response start and include the projected minutes / cost data described in the output format. The spec needs to state the lifecycle precisely, for example: capture trigger eligibility on `onResponseStart`, collect/update samples during streaming, and emit once on the first eligible `message_delta` after enough data exists, otherwise emit a reduced warning at stream end. Without that, the implementation path is ambiguous and likely to diverge.

## What Needs Attention
- `docs/directives/proxy-overage-cost-warning.md:78-81` under-specifies the API-rate cost calculation. The text says to share input/cache/output rate constants, but the formula then falls back to `tokens_per_min * weighted_avg_rate` and explicitly hand-waves cache-read treatment. That is probably acceptable for a later iteration, but for v3.2.0 the directive should either define an exact per-token cost formula or explicitly label the number as a coarse estimate in both the directive and user-facing output.
- `docs/directives/proxy-overage-cost-warning.md:173` uses `tests/overage-warning.test.mjs`, but this repo’s test tree is `test/`, not `tests/`. That is a documentation inconsistency, not a design problem.
- `docs/directives/proxy-overage-cost-warning.md:164` says JSONL concurrency should be handled “similar to existing usage-log,” but `usage-log` currently just calls `appendFile()` and does not establish the stronger atomic-write pattern that `prefix-diff` documents. If concurrency safety matters for approval, the directive should cite the intended write contract directly instead of leaning on `usage-log` as precedent.

## Recommendations
- Resolve the activation story before implementation. Either:
  1. keep the extension always loaded with `enabled: true` and gate behavior on `CACHE_FIX_OVERAGE_WARNING=1`, matching `prefix-diff`; or
  2. keep `enabled: false` in `extensions.json` and document activation as a config change rather than an env var.
- Add a concrete hook-timing section that defines:
  - what state is captured on `onResponseStart`,
  - which stream event is responsible for appending a sample,
  - when the warning is emitted,
  - and how the extension avoids duplicate writes across multiple `message_delta` events in the same response.
- Tighten the projection text so the implementation does not invent pricing math ad hoc. Either specify the exact rate formula now or narrow v3.2.0 to utilization/time-to-100 plus a plainly labeled approximate burn indicator.
- Fix the small repo-alignment details in the directive (`test/` path, concurrency wording, activation examples) so the implementation PR does not have to reinterpret them.

## Bottom Line
Revise once more before adding `plan-approved`. The feature direction is good and the scope is right for v3.2.0, but the directive still has two implementation-shaping ambiguities: the feature cannot be both `extensions.json`-disabled and env-var-enabled at the same time, and the warning emission point is not defined tightly enough for the current stream lifecycle. Once those are clarified, this should be ready to implement.

Verdict: REQUEST CHANGES
