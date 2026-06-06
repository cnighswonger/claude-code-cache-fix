# Review: PR #202 sanitize default-on wording sweep

Date: 2026-06-06
Reviewed: PR #202 implementation at `35c74d009df473cb0d35ba6715211532ce8853b0` (`README.md`, `proxy/server.mjs`, `proxy/extensions/cache-telemetry.mjs`, `test/proxy-quota-status-pipeline.test.mjs`)
Round: 1
Label applied: `changes-requested`

## What Is Correct

- The four targeted touch points from the PR #201 follow-up note were found and updated in the intended places: `README.md:32`, `proxy/server.mjs:308`, `proxy/extensions/cache-telemetry.mjs:241`, and `test/proxy-quota-status-pipeline.test.mjs:191`.
- The `proxy/server.mjs` rewrite is directionally correct. Hot-reload is default-off and only literal `CACHE_FIX_HOT_RELOAD=on` enables it, while sanitize is default-on and only literal `CACHE_FIX_THINKING_SANITIZE=off` disables it (`proxy/server.mjs:308`, `proxy/server.mjs:317`, `proxy/extensions/thinking-block-sanitize.mjs:195`, `proxy/extensions/thinking-block-sanitize.mjs:203`).
- The English README did not overshoot into legitimate historical or v2-only references. The remaining `CACHE_FIX_THINKING_SANITIZE=on` mentions there are either explicit history (`README.md:218`, `README.md:833`) or back-compat / v2 mode documentation (`README.md:44`, `README.md:837`).

## Blockers

- The new `cache-telemetry` comment is still factually wrong on the current code path. `proxy/extensions/cache-telemetry.mjs:241` now says the v1 spread is absent "when the request had nothing to drop", but `thinking-block-sanitize` unconditionally writes `ctx.meta._thinkingSanitize = { thinking_blocks_dropped: dropped }` whenever sanitize is on and `body.messages` is an array, including zero-drop requests (`proxy/extensions/thinking-block-sanitize.mjs:240`, `proxy/extensions/thinking-block-sanitize.mjs:245`, `proxy/extensions/thinking-block-sanitize.mjs:287`, `proxy/extensions/thinking-block-sanitize.mjs:295`). The existing test suite pins that behavior at zero-drop count, not absence (`test/proxy-thinking-block-sanitize.test.mjs:194`, `test/proxy-thinking-block-sanitize.test.mjs:201`). This PR therefore introduces a new inaccurate comment in one of the four touched files.
- The sweep is still incomplete. There are active, non-historical sanitize-as-opt-in references outside the diff that are neither v2-only nor prior-state prose: `README.zh.md:46`, `README.zh.md:808`, `README.zh.md:814`, `README.zh.md:818`, `proxy/extensions/thinking-block-sanitize.mjs:4`, and `test/proxy-thinking-block-sanitize.test.mjs:194`. Because the PR body explicitly says only v2 and historical references were intentionally left alone, these misses matter for review scope, not just as follow-up nits.

## What Needs Attention

None

## Bloat / Non-Functional

None

## Recommendations

- Fix `proxy/extensions/cache-telemetry.mjs:241` to describe the real contract: `_thinkingSanitize` is absent when sanitize is off or the extension returns early before a messages-array request, but zero-drop requests still emit `thinking_blocks_dropped: 0`.
- Extend the sweep to the remaining current-state wording leftovers, at minimum the active Chinese README sanitize section (`README.zh.md:46`, `README.zh.md:808`, `README.zh.md:814`, `README.zh.md:818`) and the still-current code/test wording at `proxy/extensions/thinking-block-sanitize.mjs:4` and `test/proxy-thinking-block-sanitize.test.mjs:194`.
- Keep the `proxy/server.mjs` rewrite as-is once the factual comment issue above is corrected; that divergence explanation is the strongest part of the PR.

## Bottom Line

Request changes. Three of the four intended cleanup edits landed as expected, and the hot-reload comment rewrite is accurate, but the new `cache-telemetry` wording is itself incorrect and the repo still contains active non-historical sanitize-as-opt-in leftovers the PR body claims were intentionally exhausted. This sweep is close, but it is not complete or fully accurate yet.

— Codex review
