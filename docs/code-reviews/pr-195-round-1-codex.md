Codex review:

# Review: PR #195 AGENTS.md slim-to-global

Date: 2026-06-05
Reviewed: PR #195 at b12cfd4e1f528c088ad2143517aa04fab87ee535
Round: 1
Label applied: approved-by-codex-agent

## What Is Correct
- The new header correctly makes `~/.codex/AGENTS.md` the first-read baseline while keeping this file as the cache-fix-specific overlay. That removes duplicated cross-repo review mechanics without de-loading repo context. `AGENTS.md:3`
- The cache-fix-specific operational context that would be risky to drop remains present: owner/bot/workflow metadata, the `docs/code-reviews/` artifact-path override, the `ANTHROPIC_BASE_URL` interception model, and `preload.mjs` as the 162-test behavioral baseline for extension ports. `AGENTS.md:11` `AGENTS.md:19` `AGENTS.md:30` `AGENTS.md:43` `AGENTS.md:57`
- The repo-specific review posture is still explicit: directive NFR / `Load-bearing?` checks are delegated back to the global discipline, security and schema-sensitive changes remain called out, and the public-MIT / first-time-contributor handling plus `needs-sim-validation` guidance are still local. `AGENTS.md:51` `AGENTS.md:61` `AGENTS.md:64` `AGENTS.md:74` `AGENTS.md:78` `AGENTS.md:85`
- I verified `docs/code-reviews/` is already the established review-artifact convention in this repo, so retaining that override is correct. The only other diffed file also stays inside that path and does not change review policy. `docs/code-reviews/pr-189-install-service-env-vars-codex-rereview-2026-06-05.md:1`

## Blockers
None.

## What Needs Attention
None.

## Bloat / Non-Functional
None.

## Recommendations
None.

## Bottom Line
Ship it. This is the same safe slim-to-global pattern already approved in `restore-claude-history-linux` PR #32: duplicated cross-repo Codex review discipline moves to the global baseline, while the cache-fix-specific instructions needed for a competent first review remain local, explicit, and operational.
