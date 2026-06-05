# Review: PR #197 observability for extension load failures

Date: 2026-06-05
Reviewed: `proxy/pipeline.mjs`, `proxy/server.mjs`, `test/proxy-pipeline.test.mjs`, `test/proxy-server.test.mjs` at `1578df6`
Round: 1
Label applied: `changes-requested`

## What Is Correct

- The core degraded-state plumbing is correct. `loadExtensions()` now records per-load failures, clears them on a subsequent clean reload, and `getFailedExtensions()` returns a defensive copy instead of leaking module internals ([proxy/pipeline.mjs](proxy/pipeline.mjs#L19), [proxy/pipeline.mjs](proxy/pipeline.mjs#L45), [proxy/pipeline.mjs](proxy/pipeline.mjs#L66), [test/proxy-pipeline.test.mjs](test/proxy-pipeline.test.mjs#L173)).
- The `/health` contract preserves the existing healthy path (`200` + `{"status":"ok"}`) and flips to `503` + `{"status":"degraded", ...}` when the last extension load had failures ([proxy/server.mjs](proxy/server.mjs#L240), [proxy/server.mjs](proxy/server.mjs#L256)).
- The new server integration test exercises the real cold-start failure path by booting a proxy against a broken extension directory and asserting that `/health` returns degraded ([test/proxy-server.test.mjs](test/proxy-server.test.mjs#L72)).
- `failed_extensions[].file` is the basename from the extension directory scan, not a full host path ([proxy/pipeline.mjs](proxy/pipeline.mjs#L15), [proxy/pipeline.mjs](proxy/pipeline.mjs#L45)).

## Blockers

- The new operator hint hardcodes `cache-fix-proxy.service` in both the stderr log line and the `/health` JSON body ([proxy/pipeline.mjs](proxy/pipeline.mjs#L43), [proxy/server.mjs](proxy/server.mjs#L252)). That is Linux systemd-user-specific, but this project also supports macOS launchd installs, and PR #200 already moved adjacent restart guidance to supervisor-neutral wording for exactly that reason. Because the whole point of this PR is operator-actionable observability, shipping a degraded contract that tells macOS operators to restart a non-existent systemd unit is not correct enough to approve. Make the remediation text supervisor-neutral and update the server test assertion to match.

## What Needs Attention

- `failedExtensions` is module-scoped state, so `/health` degradation remains process-global across multiple `startProxy()` instances in the same process, just like `registry` ([proxy/pipeline.mjs](proxy/pipeline.mjs#L5), [proxy/server.mjs](proxy/server.mjs#L240)). I am not treating that as a blocker because the codebase already behaves as one proxy pipeline per process, but it is still an assumption worth keeping explicit for embedders.
- The PR body is now slightly stale after PR #200. Its historical framing is still true for #196 and for opt-in hot reload, but once #200 lands the primary value here is cold-start import failures plus `CACHE_FIX_HOT_RELOAD=on` deployments, not the default install path.

## Bloat / Non-Functional

None. The added state plus accessor is the minimum surface needed to expose extension-load degradation cleanly.

## Recommendations

- Replace the service-specific recovery text with supervisor-neutral wording in both places, for example “restart the proxy via your supervisor to recover,” and keep the stale-ESM-cache explanation separate if you still want that context visible.
- Refresh the PR description before merge so it explicitly notes the relationship to PR #200: PR #200 suppresses the default-install watcher race, while PR #197 remains the observability backstop for cold-start failures and opt-in hot-reload users.

## Bottom Line

The observability mechanics are sound and the tests cover the intended failure path, but the recovery hint that this PR exposes as its primary operator signal is too platform-specific to ship as-is. Fix the restart wording, keep the degraded contract otherwise intact, and I would expect this to be approvable on the next round.

— Codex review
