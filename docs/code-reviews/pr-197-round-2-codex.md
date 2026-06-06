# Review: PR #197 observability for extension load failures

Date: 2026-06-06
Reviewed: `proxy/pipeline.mjs`, `proxy/server.mjs`, `test/proxy-pipeline.test.mjs`, `test/proxy-server.test.mjs`, and PR #197 discussion/body at `2c4f896`
Round: 2
Label applied: `approved-by-codex-agent`

## What Is Correct

- Both operator-facing recovery strings are now supervisor-neutral. The stderr path tells operators to restart the proxy via their supervisor, and the degraded `/health` payload uses the same platform-neutral guidance instead of naming a Linux-specific unit ([proxy/pipeline.mjs](proxy/pipeline.mjs#L33), [proxy/pipeline.mjs](proxy/pipeline.mjs#L43), [proxy/server.mjs](proxy/server.mjs#L240), [proxy/server.mjs](proxy/server.mjs#L252)).
- The server regression test now pins the new wording, requires the `#196` reference, and explicitly rejects the old `cache-fix-proxy.service` text, so the round-1 bug cannot silently reappear in the operator-facing health contract ([test/proxy-server.test.mjs](test/proxy-server.test.mjs#L99)).
- The underlying failed-extension observability coverage remains intact: pipeline tests still prove that failed loads are recorded, cleared on successful reload, and returned via a defensive copy for callers such as `/health` ([test/proxy-pipeline.test.mjs](test/proxy-pipeline.test.mjs#L173)).
- The refreshed PR body now accurately reflects merged PR #200's role: PR #200 removes the default-install watcher race by making hot reload opt-in, while this PR remains the observability backstop for cold-start import failures and `CACHE_FIX_HOT_RELOAD=on` users.

## Blockers

None.

## What Needs Attention

None.

## Bloat / Non-Functional

None.

## Recommendations

- Merge this as the observability complement to PR #200; no further Codex-side changes are needed on this round.

## Bottom Line

Round 1's only blocker is resolved. The operator guidance is now platform-neutral in both surfaced locations, the `/health` regression test specifically prevents a return to the old systemd-only wording, and the PR description now frames the #200 relationship correctly. I re-ran `node --test test/proxy-pipeline.test.mjs test/proxy-server.test.mjs` at `2c4f896`; the targeted slice passed. This is ready for approval.

— Codex review
