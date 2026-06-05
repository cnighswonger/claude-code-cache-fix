# Review: PR #200 hot-reload opt-in implementation

Date: 2026-06-05
Reviewed: PR #200 at 4cd8c25509f2c771d2adf684c3c7513ed97256b1
Round: 2
Label applied: approved-by-codex-agent

## What Is Correct

- `installSystemd()` and `installLaunchd()` now thread `defaults.hotReload` into the real renderer calls, so the supervisor-layer opt-in flow is no longer dropped on the floor (`bin/install-service.mjs:186-195`, `bin/install-service.mjs:286-295`).
- The new install-service coverage now exercises the actual on-disk writes, not just the renderer helpers, and would fail if either call site stopped passing `hotReload` again (`test/install-service.test.mjs:289-388`).
- The runtime gate and stderr banner are now keyed off the effective watcher state, and the suite covers default-off, explicit opt-in, strict non-`"on"` rejection, `options.watch: false`, and the direct `startWatcher()` path (`proxy/server.mjs:293-321`, `test/proxy-server.test.mjs:107-280`).
- The README no longer claims the sanitize default flip shipped here, and the default proxy-mode / upgrade-flow copy now consistently describes hot-reload as opt-in rather than default behavior (`README.md:44-46`, `README.md:214-269`, `README.md:414`).
- Verification is strong enough for this round: targeted hot-reload/install-service tests passed, and the full suite passed locally at `998/998` via `npm test`.

## Blockers

None.

## What Needs Attention

- `README.md:206` still lists the embeddable `watch` option default as `true`, while the runtime now effectively starts the watcher only when `CACHE_FIX_HOT_RELOAD=on` and `options.watch !== false` (`proxy/server.mjs:298-321`). That is small README drift for embedders, but it is not significant enough to hold this PR given the operator-facing upgrade/install flows are now correct.

## Bloat / Non-Functional

None.

## Recommendations

- Land a small follow-up README tweak for the embeddable `watch` row so it matches the new default-off behavior described elsewhere.

## Bottom Line

The round-1 blockers are resolved: the install-service path now persists `CACHE_FIX_HOT_RELOAD=on` into both supervisor formats, the new tests cover the real failure mode, and the README no longer over-claims the sanitize scope or default hot-reload behavior. This is ready to move past Codex review and on to Chris's human load-bearing review.

— Codex review
