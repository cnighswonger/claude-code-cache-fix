# Review: PR #202 sanitize default-on wording sweep

Date: 2026-06-06
Reviewed: PR #202 implementation at `5cc739ef9a1b531cf42ae7ef6e2b85f1e092d50d` (`README.md`, `proxy/server.mjs`, `proxy/extensions/cache-telemetry.mjs`, `proxy/extensions/thinking-block-sanitize.mjs`, `test/proxy-quota-status-pipeline.test.mjs`, `test/proxy-thinking-block-sanitize.test.mjs`)
Round: 2
Label applied: `reviewed-by-codex-agent`, `approved-by-codex-agent`

## What Is Correct

- The round-1 factual blocker is closed. `thinking-block-sanitize` still writes `ctx.meta._thinkingSanitize = { thinking_blocks_dropped: dropped }` whenever sanitize runs on a messages-array request, including zero-drop cases (`proxy/extensions/thinking-block-sanitize.mjs:245`, `proxy/extensions/thinking-block-sanitize.mjs:295`, `test/proxy-thinking-block-sanitize.test.mjs:194`, `test/proxy-thinking-block-sanitize.test.mjs:201`). The rewritten spread comment now describes that contract accurately: present when sanitize ran, possibly with `thinking_blocks_dropped: 0`, and absent only when the extension is off or returned early (`proxy/extensions/cache-telemetry.mjs:241`).
- The two in-scope wording misses from round 1 are fixed. The header now states that v1 is default-on since v4.0.0 and `=on` is back-compat rather than the only enable path (`proxy/extensions/thinking-block-sanitize.mjs:4`). The zero-drop test title now matches the explicit `=on` path instead of calling it generic opt-in (`test/proxy-thinking-block-sanitize.test.mjs:194`).
- `README.zh.md` is unchanged on this branch relative to `main`; the previously flagged stale Chinese wording remains at `README.zh.md:46`, `README.zh.md:808`, `README.zh.md:814`, and `README.zh.md:818`, but this PR now explicitly defers that translation refresh to issue #199 instead of implying it was exhausted here. For a wording sweep otherwise limited to English/code/test updates, that is an acceptable scope boundary.

## Blockers

None

## What Needs Attention

- `README.zh.md` still reflects pre-v4 sanitize behavior on `main`; issue #199 remains the load-bearing place to finish that translation refresh. I am not treating that as a blocker on this PR because the branch leaves the file untouched and the PR body states that ownership boundary explicitly.

## Bloat / Non-Functional

None

## Recommendations

- Land the pending `README.zh.md` translation refresh under issue #199 so the Chinese docs catch up with the v4.0.0 default-on behavior and the related extension-count wording.
- Keep the rewritten `proxy/server.mjs` and `proxy/extensions/cache-telemetry.mjs` comments as the canonical explanation of the opposite-direction env-var gates; they are now aligned with the implementation.

## Bottom Line

Approve. The round-1 blockers are closed: the telemetry comment now matches the actual `_thinkingSanitize` contract, the remaining in-scope code/test wording was cleaned up, and the untouched Chinese README is explicitly deferred to the existing i18n-owner workflow instead of being silently missed. No new factual errors were introduced in the reviewed diff.

— Codex review
