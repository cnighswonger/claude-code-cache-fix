# Review: PR #197 observability for extension load failures

Date: 2026-06-06
Reviewed: `proxy/pipeline.mjs`, `proxy/server.mjs`, `test/proxy-pipeline.test.mjs`, `test/proxy-server.test.mjs`, the PR thread, and rebase delta `2c4f896..c2e9f29`
Round: 3
Label applied: `approved-by-codex-agent`

## What Is Correct

- The approved observability path is unchanged at HEAD. Extension-load failures are still recorded in `failedExtensions`, logged with the same supervisor-neutral `[CRITICAL]` message, and surfaced through a defensive-copy accessor for `/health` consumers ([proxy/pipeline.mjs](proxy/pipeline.mjs#L8), [proxy/pipeline.mjs](proxy/pipeline.mjs#L33), [proxy/pipeline.mjs](proxy/pipeline.mjs#L66)).
- `/health` still reports `503` + `{"status":"degraded", ...}` with the same supervisor-neutral restart hint and failed-extension payload, while preserving the healthy `200` + `{"status":"ok"}` path ([proxy/server.mjs](proxy/server.mjs#L240)).
- The regression coverage that mattered in round 2 is still intact at HEAD: pipeline tests still prove the failed-load state is recorded, cleared on successful reload, and returned as a defensive copy, and the server test still requires the supervisor-neutral hint, still cites `#196`, and still rejects a regression to `cache-fix-proxy.service` wording ([test/proxy-pipeline.test.mjs](test/proxy-pipeline.test.mjs#L173), [test/proxy-server.test.mjs](test/proxy-server.test.mjs#L313)).
- The one conflict-resolved file from the rebase, `test/proxy-server.test.mjs`, now contains both `hot-reload opt-in (#196)` and `proxy server /health degraded (#196)` describe blocks exactly once each; the degraded-health block itself is unchanged from the round-2-approved tree and still sits cleanly after the hot-reload block ([test/proxy-server.test.mjs](test/proxy-server.test.mjs#L69), [test/proxy-server.test.mjs](test/proxy-server.test.mjs#L286)).
- Comparing `2c4f896..c2e9f29` shows the expected rebase-only delta: `proxy/pipeline.mjs` and `test/proxy-pipeline.test.mjs` are unchanged, while `proxy/server.mjs` and `test/proxy-server.test.mjs` only pick up the already-merged PR #200 hot-reload opt-in work ahead of this PR's existing `/health` degradation contract ([proxy/server.mjs](proxy/server.mjs#L303), [test/proxy-server.test.mjs](test/proxy-server.test.mjs#L69)).
- `git log --oneline origin/main..c2e9f29` matches the expected four commits on the PR branch: the original implementation commit, the round-1 review artifact, the supervisor-neutral wording fix, and the round-2 review artifact.
- I re-ran `node --test test/proxy-pipeline.test.mjs test/proxy-server.test.mjs` at `c2e9f29`; the rebased slice passed with `28` tests and `0` failures.

## Blockers

None.

## What Needs Attention

None.

## Bloat / Non-Functional

None.

## Recommendations

- Refresh the dismissed approval and the two Codex-owned freshness labels only; no implementation changes are needed on this round.

## Bottom Line

The rebase onto current `main` did not alter the code or test behavior that was approved at round 2. The supervisor-neutral `[CRITICAL]` log line, the `/health` `503` degraded contract, and the regression guard against `cache-fix-proxy.service` wording are all still present at `c2e9f29`, and the conflict resolution in `test/proxy-server.test.mjs` preserved both `#196` describe blocks cleanly. This is ready for renewed approval.

— Codex review
