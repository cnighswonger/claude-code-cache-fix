# Review: TTL tier detection directive

Date: 2026-05-03
Reviewed: docs/directives/proxy-ttl-tier-detection.md
Label applied: changes-requested

Verdict: changes-requested

Findings:

- Blocking: the revised split fixes the original `cache-control-normalize` ordering bug for ordinary user-message markers, but it still does not match preload's scan of the incoming payload. `fresh-session-sort` runs earlier at order 250 and strips `cache_control` from relocated user blocks (`proxy/extensions/fresh-session-sort.mjs:137-141`, `163-165`), with explicit test coverage (`test/proxy-fresh-session-sort.test.mjs:205-227`). The directive's claim that no upstream extension has touched `cache_control` by order 350 is false (`docs/directives/proxy-ttl-tier-detection.md:38`). A `ttl: "5m"` marker on a relocatable block would still be visible to preload (`preload.mjs:1815-1828`) but invisible to `ttl-tier-detect` at order 350, so parity remains incomplete.
- Non-blocking: the dedicated `ttl-tier-detect` extension is the right separation of concerns once the remaining upstream blind spot is addressed. Using `ctx.meta._ttlTier` is consistent with existing internal-handoff keys such as `ctx.meta._quotaData`, and the `"1h"` negative-case assertion makes the contract explicit.
- Non-blocking: defaulting `ttl-management` to `"1h"` when `ttl-tier-detect` is disabled is defensible. Disabling the detector should degrade to today's behavior rather than reintroduce a partial late body-scan inside `ttl-management`.
- Non-blocking: pipeline test #18 materially improves coverage because it would fail if detection happened only after `cache-control-normalize` or if `ttl-management` injected `"1h"` on the canonicalized marker. It does not literally prove "`ttl-tier-detect` ran first" unless the test also asserts registry order or instruments hook execution, so that wording should be tightened.
- Non-blocking: test scope is close to right-sized, but one additional pipeline case is needed if preload parity is the acceptance bar: a `ttl: "5m"` marker on a relocatable user block that `fresh-session-sort` currently rewrites. Without that, the remaining blind spot stays untested.
- Non-blocking: the v1 decision to defer quota-header subscription is still defensible. The remaining issue is not scope creep; it is one more in-payload pre-normalization path that still gets erased upstream.

## What Is Correct

- Moving detection out of `ttl-management` and ahead of `cache-control-normalize` directly addresses the blocker from the previous review for the ordinary user-message path.
- Keeping detection pure and request-scoped via `ctx.meta` is the right contract.
- Preserving `"none"` as a hard opt-out and making auto-detection upgrade-only remains correct.

## Blockers

- The directive still overstates preload equivalence. `fresh-session-sort` removes `cache_control` from relocatable user blocks before order 350, so `ttl-tier-detect` cannot yet observe every `ttl: "5m"` marker that preload would observe.

## What Needs Attention

- Clarify the ordering claim around order 350. The current pipeline already has multiple `350` extensions, and `loadExtensions()` sorts only by numeric `order` with stable preservation of filename order (`proxy/pipeline.mjs:13-36`), so "between 300 and 400" does not uniquely describe execution placement.
- Tighten test #18's assertion language to observable facts: registry order and end-to-end output, not an inferred "ran first" claim.

## Recommendations

- Revise the design so detection happens before any extension that can strip `cache_control` from user blocks, or explicitly preserve the detected TTL across `fresh-session-sort` as well as `cache-control-normalize`.
- Add a pipeline-level test covering a relocatable user block carrying `ttl: "5m"` to prove real preload parity.
- If the design intentionally accepts this narrower parity target, state that limitation explicitly instead of claiming equivalence to `preload.mjs`.

## Bottom Line

The revised directive is materially better and fixes the specific `cache-control-normalize` timing gap from the first round. It is not yet ready to approve because one earlier extension still strips a class of user-message `cache_control` markers before the new detector runs, so the directive still falls short of the stated preload-equivalence contract.
