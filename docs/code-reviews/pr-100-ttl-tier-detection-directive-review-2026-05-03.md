# Review: TTL tier detection directive

Date: 2026-05-03
Reviewed: docs/directives/proxy-ttl-tier-detection.md
Label applied: changes-requested

Verdict: changes-requested

## What Is Correct

- The proposed `ttlParam = ttlValue === "5m" || detectedTier === "5m" ? "5m" : "1h"` rule is faithful to the preload injection rule in `preload.mjs:2456-2457`.
- The directive is also correct to keep `"none"` as a hard opt-out and to make auto-detection upgrade-only. That preserves the current env-var contract in `proxy/extensions/ttl-management.mjs:31-36`.
- Applying the same detection rule to main and subagent requests is defensible. The detected tier is a per-request payload fact, not a request-class policy knob.
- Deferring quota-header subscription is a reasonable v1 scope call if the proxy still observes the same in-payload markers that preload observes.

## Blockers

- `docs/directives/proxy-ttl-tier-detection.md:34-59` assumes `ttl-management` can detect `ttl: "5m"` by scanning `body.messages[*].content[*]` at `order: 500`, but `cache-control-normalize` already strips all user-message `cache_control` markers at `order: 400` and re-applies only a bare `{ type: "ephemeral" }` marker afterward (`proxy/extensions/cache-control-normalize.mjs:34-59`). Existing tests confirm that a user-message `ttl: "5m"` marker is removed during normalization (`test/cacheControlNormalize.test.mjs:30-43`). As written, the directive is not faithful to preload's timing (`preload.mjs:1815-1828`) and can silently miss the exact signal it intends to port. The directive needs to account for pipeline order: either detect/persist the tier before normalization, preserve TTL through normalization, or move the detection responsibility to an earlier stage.

## What Needs Attention

- The proposed tests in `docs/directives/proxy-ttl-tier-detection.md:76-84` exercise `ttl-management` in isolation, but they do not cover the extension interaction that currently destroys message-level TTL evidence before `ttl-management` runs. Add at least one pipeline-level test proving a user-message `ttl: "5m"` marker survives the extension sequence in whatever design is chosen.
- The scope rationale in `docs/directives/proxy-ttl-tier-detection.md:17-28` is acceptable for v1, but only after the in-payload path is made equivalent to preload in the proxy pipeline. Without that, the review is not between "simple in-payload v1" and "broader quota-signal v2"; it is between "working signal path" and "signal path already erased upstream."

## Recommendations

- Revise the directive so the 5m detection happens before `cache-control-normalize` removes user-message markers, or explicitly preserve the observed TTL tier across normalization via request-local state.
- Expand acceptance criteria and tests to cover the real extension order from `proxy/extensions.json`, not just `ttl-management` as a standalone unit.
- Keep quota-header subscription out of v1 unless telemetry later shows a first-downgrade gap after the pipeline-order issue is fixed.

## Bottom Line

The core rule being ported from preload is correct, and the narrower v1 scope is defensible. The directive still has a blocking architectural gap: it places detection in an extension that runs after another extension has already stripped the primary message-level evidence. Revise the directive to preserve or observe the signal before normalization, then this is ready to approve.
