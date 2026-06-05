# Review: PR #200 hot-reload opt-in implementation

Date: 2026-06-05
Reviewed: PR #200 at 9866667d4febd80a523f64b2dbf12a3811b25248
Round: 1
Label applied: changes-requested

## What Is Correct

- The watcher gate is added at the intended seam in `proxy/server.mjs:288-319`; `proxy/watcher.mjs` stays unchanged and `startWatcher()` has no other production entry point.
- The runtime gate is strict `process.env.CACHE_FIX_HOT_RELOAD === "on"`, and `options.watch === false` still suppresses the watcher in the actual `startProxy()` path.
- The direct `startWatcher()` smoke test requested during directive review is present and meaningful in `test/proxy-server.test.mjs:224-242`.
- The stderr banner did not break the existing suite: `npm test` passed 993/993 locally, including other tests that capture `process.stderr.write`.
- `CHANGELOG.md` stays scoped to the hot-reload default flip instead of also claiming the sanitize default flip shipped here.

## Blockers

1. **`install-service` never threads `hotReload` into the actual unit/plist writes, so the opt-in flow in the README does not work.**

   `getDefaults()` now captures `hotReload`, and both renderer helpers know how to emit it (`bin/install-service.mjs:20-30`, `bin/install-service.mjs:90-138`). But the real installers omit that field when they call the renderers: `installSystemd()` passes `port/upstream/debug/workingDir/requires` only (`bin/install-service.mjs:186-193`), and `installLaunchd()` does the same (`bin/install-service.mjs:285-293`). The result is that `CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service` still writes service files with no `CACHE_FIX_HOT_RELOAD=on` entry, so README Flow 2 is broken and operators silently remain on default-off after restart.

   The new tests missed exactly this failure mode because they only exercise `renderSystemdTemplate()` / `renderLaunchdTemplate()` directly (`test/install-service.test.mjs:120-154`); they never assert what `installSystemd()` / `installLaunchd()` actually write.

2. **The README publishes the sanitize default flip even though this PR and the current tree still keep sanitize opt-in.**

   The new `Upgrading from v3.x` section says `thinking-block-sanitize` is "now on by default" (`README.md:220`), but the same README still documents the extension as opt-in (`README.md:44`, `README.md:835`, `README.md:839`), and this PR does not change the runtime behavior. The PR body explicitly marked the sanitize default-on work as out of scope. Merging this README as-is would ship upgrade guidance for behavior the tree does not implement yet.

   Relatedly, the top-level proxy description still says extensions are hot-reloadable and that edits apply to the next request without restart (`README.md:15`, `README.md:46`), which is no longer true for the default install after this PR.

## What Needs Attention

- The strict non-`"on"` cases in `test/proxy-server.test.mjs:199-218` only assert the off-banner, not that reload behavior also stays off. That is secondary to blocker 1, but it leaves a gap around "banner says off, watcher is actually off."
- The boot banner is keyed off `hotReloadOptIn`, not the effective `watch` value (`proxy/server.mjs:298-311`). An embedder calling `startProxy({ watch: false })` with `CACHE_FIX_HOT_RELOAD=on` will see an "on" banner even though the watcher is suppressed.

## Bloat / Non-Functional

- The directive budget was `<=160` touched LOC / `<=8` files. This landed at `+324/-1` across 9 files. Most of the overage is README/test prose rather than core runtime code, but once blocker 2 is fixed there is an obvious trim path: drop the sanitize-release prose from this PR and keep the docs aligned to shipped behavior.

## Recommendations

- Pass `defaults.hotReload` through both `installSystemd()` and `installLaunchd()`, then add end-to-end tests that assert the files written by those functions actually contain or omit the envvar.
- Keep the README upgrade section scoped to behavior this branch truly ships, or land the sanitize default-on implementation in the same stack before publishing that prose.
- If the banner is meant to describe the active watcher mode, key it off the effective `watch` state rather than the raw envvar.

## Bottom Line

The watcher gate itself is in the right place and the server-side tests cover the main happy paths, but the install-service opt-in flow currently does not work and the README publishes an additional default flip that this PR does not implement. Because both are operator-facing and load-bearing for a release-default change, this needs another round before merge.

— Codex review
