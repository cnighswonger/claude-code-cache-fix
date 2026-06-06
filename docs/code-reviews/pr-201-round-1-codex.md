# Review: PR #201 thinking-block-sanitize v1 default-on

Date: 2026-06-06
Reviewed: PR #201 at 6f8d988
Round: 1
Label applied: reviewed-by-codex-agent, approved-by-codex-agent

## What Is Correct

- `proxy/extensions/thinking-block-sanitize.mjs:202` implements the intended gate exactly: the literal `off` disables, `v2` stays its own opt-in path, and unset / `on` / unknown values resolve to v1. Given the new default-on contract, permissive unknown -> on is the safer choice because a typo cannot silently turn the mitigation off.
- The v2 non-flip is clearly intentional rather than forgotten scope. The PR body states both reasons explicitly, and the in-file rationale around `proxy/extensions/thinking-block-sanitize.mjs:58` and `proxy/extensions/thinking-block-sanitize.mjs:195` makes the same distinction in code context.
- The test updates cover the behavior change in the right places. `test/proxy-thinking-block-sanitize.test.mjs:144` now proves that the default path mutates and emits telemetry, while `test/proxy-thinking-block-sanitize.test.mjs:163` preserves an explicit no-op check for `=off`.
- The `[pipeline #160]` adjustment in `test/proxy-quota-status-pipeline.test.mjs:122` is the right isolation mechanism for a full-pipeline merge test. It keeps session-health + writer behavior under real extension ordering while avoiding accidental sanitize coupling; the separate `[pipeline #162]` coverage continues to exercise the post-sanitize merge path.
- The committed docs are materially aligned with the v4.0.0 upgrade framing from PR #200. `README.md:218`, `README.md:833`, and `CHANGELOG.md:7` all explain the default flip, the explicit disable path, and the continued `=v2` opt-in.
- Verification matched the claims: `node --test test/proxy-thinking-block-sanitize.test.mjs test/proxy-quota-status-pipeline.test.mjs` passed, and `npm test` passed `999/999`.

## Blockers

None.

## What Needs Attention

- A few repo-local wording leftovers will be inaccurate after merge even though behavior is correct: `README.md:32` still says the request pipeline has "one opt-in" extension, `proxy/server.mjs:295` still cites sanitize as a strict `=== "on"` precedent, `proxy/extensions/cache-telemetry.mjs:241` still describes the sanitize metadata as opt-in-only, and `test/proxy-quota-status-pipeline.test.mjs:191` still labels the merge test "(opt-in)". These are non-blocking, but they are now the main source of future-reader confusion.

## Bloat / Non-Functional

- No speculative code or unnecessary surface area showed up in the diff. The change is appropriately narrow: gate semantics, tests, and operator-facing docs.
- The committed diff does not add new operator-local paths or environment leakage. The only operator-local source reference I saw is in the PR narrative, not in repo content.

## Recommendations

- Land this as approved, then do a short follow-up wording sweep for the remaining opt-in / `=on`-only references outside the diff.
- For future public PR descriptions, prefer repo-hosted artifacts or issue links over operator-local memory-note paths as evidence sources.

## Bottom Line

Ship it. The default-on flip is implemented consistently, the permissive on-path is well-documented and well-tested, v2's non-default status is clearly intentional, and the pipeline test isolation change is the right tradeoff for preserving end-to-end coverage. Only minor wording cleanup remains outside the touched files.

— Codex review
