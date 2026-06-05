# Review: PR #198 hot-reload opt-in directive

Date: 2026-06-05
Reviewed: PR #198 directive ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L1)) at `3015cc7`
Round: 1
Label applied: `changes-requested`

## What Is Correct

- Gating at the `startWatcher` call site is the right production seam. `startProxy()` is where the embeddable API, the CLI entrypoint, the wrapper `server` subcommand, and wrapper-mode child fork all converge, so flipping the default there changes the real runtime behavior without widening the surface or touching `proxy/watcher.mjs` ([proxy/server.mjs](proxy/server.mjs#L288), [proxy/server.mjs](proxy/server.mjs#L333), [bin/claude-via-proxy.mjs](bin/claude-via-proxy.mjs#L17), [bin/claude-via-proxy.mjs](bin/claude-via-proxy.mjs#L83)).
- Keeping strict `=== "on"` matching is the better contract. The repo already uses explicit mode tokens rather than generic truthiness for behavior gates, and the existing tests pin unknown values to the safe-off path (`[docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L47)`, [proxy/extensions/thinking-block-sanitize.mjs](proxy/extensions/thinking-block-sanitize.mjs#L186), [test/proxy-thinking-block-sanitize.test.mjs](test/proxy-thinking-block-sanitize.test.mjs#L211)).
- The complement claim versus PR #197 is directionally right. The pipeline still does a cold `loadExtensions()` at boot, and the observability PR only changes how load failures surface after that; it does not remove the hot-reload trigger path this directive is targeting ([proxy/server.mjs](proxy/server.mjs#L296), [proxy/pipeline.mjs](proxy/pipeline.mjs#L7)).
- The anti-bloat posture is good. Leaving `proxy/watcher.mjs` intact and adding a narrow gate is the smallest behaviorally coherent fix; the rejected worker-thread refactor would be a large new subsystem for a feature the directive itself describes as marginal ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L35)).

## Blockers

- The release target conflicts with the repo's own semver policy. This directive explicitly targets `v3.10.0` while changing default behavior for every downstream user, but the canonical release workflow classifies "changed default behavior" as a **major** release, not a minor one ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L3), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L100), [docs/release-workflow.md](docs/release-workflow.md#L11)). Either retarget this to the next major release or record an explicit Chris-approved exception in the directive before implementation starts.
- The refined "npm + restart bypasses the race" section is still too strong to approve as written. The running proxy is documented as starting directly out of the installed package tree, the default watched paths are that same tree's `proxy/extensions` and `proxy/extensions.json`, and `startProxy()` still enables watching by default today ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L15), [README.md](README.md#L17), [proxy/config.mjs](proxy/config.mjs#L18), [proxy/server.mjs](proxy/server.mjs#L288)). That means an `npm install -g` against a still-running proxy can touch the watched package files before the operator performs the later restart. The directive can say a cold restart clears the stale cache; it has not yet shown that the install step itself is immune. Separately, the repo does not currently contain the claimed documented upgrade flow with an explicit restart step, so the sentence about users "following the documented upgrade flow" is not accurate against current HEAD ([README.md](README.md#L17), [README.md](README.md#L50)).
- The opt-in restore path is underspecified for the project's recommended service install flow, and the current size budget hides that. The public docs say `install-service` is the recommended deployment path and that the generated service config only captures `CACHE_FIX_PROXY_PORT`, `CACHE_FIX_PROXY_UPSTREAM`, and `CACHE_FIX_DEBUG` at install time; there is no current place for `CACHE_FIX_HOT_RELOAD` in either renderer or template ([README.md](README.md#L50), [README.md](README.md#L82), [bin/install-service.mjs](bin/install-service.mjs#L21), [bin/install-service.mjs](bin/install-service.mjs#L89), [templates/cache-fix-proxy.service.template](templates/cache-fix-proxy.service.template#L11), [templates/com.cnighswonger.cache-fix-proxy.plist.template](templates/com.cnighswonger.cache-fix-proxy.plist.template#L12)). As written, "set `CACHE_FIX_HOT_RELOAD=on` to restore prior behavior" is incomplete for the main supported deployment mode, and the stated `<= 4 files` / `<= 100 LOC` budget does not leave room for the installer/template/test work if the project wants this opt-in path to be first-class.

## What Needs Attention

- The directive currently understates the documentation sweep. The top-level Chinese and Korean READMEs also advertise hot-reload as the normal behavior, so updating only `README.md` would leave stale public technical guidance behind ([README.zh.md](README.zh.md#L17), [README.ko.md](README.ko.md#L15)). If the implementation PR is not going to translate immediately, the directive should at least call out translation-needed markers or an explicit follow-up.
- `docs/directives/proxy-hot-reload-opt-in.md:71,94` overstate the current watcher-test baseline. I did not find direct `startWatcher()` coverage in `test/`, and the existing server/embeddable/bootstrap suites all force `watch: false` ([test/proxy-server.test.mjs](test/proxy-server.test.mjs#L27), [test/proxy-server-embeddable.test.mjs](test/proxy-server-embeddable.test.mjs#L25), [test/proxy-server-bootstrap.test.mjs](test/proxy-server-bootstrap.test.mjs#L62)). The implementation PR therefore likely needs a slightly larger test addition than the current 20-LOC estimate suggests.
- The runtime banner should not carry a version pin. "default since v3.10.0" is useful in release notes, but it will rot in long-lived service logs. I would keep the banner timeless and leave versioned framing to README/CHANGELOG.

## Bloat / Non-Functional

- No bloat finding on the chosen design. The problem here is directive accuracy and rollout completeness, not over-engineering.

## Recommendations

- Keep the `startProxy()` call-site gate and the strict `=== "on"` contract. I do **not** think a generic `truthy()` helper is warranted here.
- Rewrite the refined impact-scope section so it distinguishes "restart clears the stale cache" from "the install path cannot trigger hot reload before that restart." The former is structurally true; the latter is not yet demonstrated.
- Decide explicitly whether service installs get a first-class opt-in path in this same change. If yes, expand scope to cover `install-service` renderers/templates/tests. If no, document the exact manual systemd/launchd edit flow and say so plainly in the directive.
- Reconcile release coordination with `docs/release-workflow.md` before implementation. My read is that bundling both defaults flips into one "Behavior changes" release note section is fine, but only if the release vehicle itself matches the repo's major-release rule for default changes.
- On open question 1: keep strict `=== "on"`; do not add a truthy helper.
- On open question 2: strip the version from the stderr banner and keep versioned wording in README/CHANGELOG.
- On open question 3: prefer a dedicated "Upgrading from v3.9.x" section, optionally linked from the proxy overview, because this scales better as more behavior-change notes accumulate.

## Bottom Line

The core shape is sound: default-off at the `startWatcher` seam is the right minimal fix, and PR #197 is a real complement rather than a substitute. I am still requesting changes because the directive currently overstates the refined impact scope, leaves the recommended service-install opt-in path underspecified, and targets a minor release even though the repo's own workflow classifies default-behavior changes as major.

— Codex review
