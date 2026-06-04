# Review: TTL tier detection implementation

Date: 2026-05-03
Reviewed: PR #100 implementation (`18e854a`, `1b5fe60`)
Label applied: changes-requested

## Verdict

changes-requested

## What Is Correct

- `detectExistingTier(body)` in [proxy/extensions/ttl-tier-detect.mjs](proxy/extensions/ttl-tier-detect.mjs#L10) is a faithful port of `preload.mjs` tier detection. It scans `body.system` plus flattened `body.messages[*].content[*]`, returns `"5m"` on the first matching `cache_control.ttl === "5m"`, and otherwise returns `"1h"`.
- The detector is pure with respect to `ctx.body`. [proxy/extensions/ttl-tier-detect.mjs](proxy/extensions/ttl-tier-detect.mjs#L30) only writes `ctx.meta._ttlTier`; I did not find any `ctx.body.*` writes in that module.
- The `ttl-management` change in [proxy/extensions/ttl-management.mjs](proxy/extensions/ttl-management.mjs#L36) is behaviorally equivalent to `preload.mjs:2457`: explicit env `5m` wins, detected `5m` upgrades effective `1h` to `5m`, and explicit env `none` still suppresses injection.
- `extensions.json` registers `"ttl-tier-detect": { "enabled": true, "order": 75 }`, which places it before the first cache-control mutators (`fresh-session-sort` at 250, `cache-control-normalize` at 400) and after the read-only observability hook.
- Full suite result is green on the PR branch: `698/698` passing.

## Blockers

- Test #18 does not exercise the regression path it claims to cover. In [test/proxy-ttl-tier-pipeline.test.mjs](test/proxy-ttl-tier-pipeline.test.mjs#L46), the only `ttl: "5m"` marker is already on the last block of the last user message (`content[1]`). `cache-control-normalize` strips that marker and re-applies the canonical marker to the same block, so the test never proves the important case approved in the directive: detection before strip when the original `5m` marker lives on a non-last user block and canonical placement moves elsewhere. As written, this test would still pass even if the specific non-last-block regression remained broken.

## What Needs Attention

- Test #19 does build the relocatable `<skills>` geometry and does verify relocation observably happened, but it stops short of asserting the relocated block itself has no `cache_control` field after the pipeline. The directive approved that end-state check specifically for the fresh-session-sort strip path.
- The `withEnv` helper in [test/proxy-ttl-management.test.mjs](test/proxy-ttl-management.test.mjs#L77) restores env vars in `finally`, but only after the cache-busting import succeeds. If that import ever throws, the overridden env can leak into later tests and make failures noisier to diagnose.
- The new detector handles non-array `m.content` safely via `Array.isArray(m?.content)`, but there is still no unit test locking that edge case explicitly.

## Recommendations

- Rewrite pipeline test #18 so the only incoming `ttl: "5m"` marker sits on a user block that is not the canonical target after normalize. Then assert both that `_ttlTier === "5m"` and that the original block no longer carries `cache_control` while the canonical last block now carries `ttl: "5m"`.
- Strengthen test #19 with an explicit assertion that the relocated `<skills>` block has no `cache_control` field after the pipeline.
- Move the cache-busting import inside the `try` block in `withEnv`, or otherwise guarantee env restoration even if module import fails.

## Bottom Line

The implementation code is aligned with the approved directive and the preload port itself looks correct. I am not approving yet because the most important pipeline regression test (#18) is misconstructed and does not actually prove the non-last-block strip/reapply path that motivated the design change.
