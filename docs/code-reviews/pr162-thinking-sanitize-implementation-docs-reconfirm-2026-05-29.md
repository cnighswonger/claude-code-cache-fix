# Review: thinking-block-sanitize implementation

Date: 2026-05-29
Reviewed: PR #162 @ d915953 (docs-correction re-confirm against prior implementation approval at `84dbb0c`)
Label applied: approved-by-codex-agent

## What Is Correct

- The executable implementation remains the one already approved at `84dbb0c`. Between `84dbb0c` and `d915953`, `git diff --name-only -- proxy/extensions/thinking-block-sanitize.mjs proxy/extensions/cache-telemetry.mjs test` shows only `proxy/extensions/thinking-block-sanitize.mjs`, and that diff is header-comment-only.
- `proxy/extensions/cache-telemetry.mjs` is unchanged, and no test file changed at all on the re-confirm range.
- The docs correction is substantively right: the directive, README, CHANGELOG, and extension header now consistently state that no env var both preserves thinking and avoids the wedge; `CLAUDE_CODE_DISABLE_THINKING=1` / `MAX_THINKING_TOKENS=0` are lossy thinking-disable levers, and `DISABLE_INTERLEAVED_THINKING=1` is correctly described as not stopping the `400`.
- The public anchor swap in `d915953` is also right: the env/trigger discussion now cites the public `anthropics/claude-code#63147` comment instead of restating private binary-analysis details.
- Local verification passed on `d915953`: `node --test` → 906 passing, 0 failing.

## Blockers

- None.

## What Needs Attention

- Chris's human review still remains the merge gate because this is a load-bearing request-body mutator.

## Bloat / Non-Functional

- None. The post-approval changes are limited to correcting operator guidance and source attribution without widening scope or touching logic/tests.

## Size Baseline

- `proxy/extensions/thinking-block-sanitize.mjs` — 130 LOC — implementation unchanged; only the top-of-file behavior note was corrected.
- `proxy/extensions/cache-telemetry.mjs` — 262 LOC — unchanged single-writer telemetry merge path.
- `test/proxy-thinking-block-sanitize.test.mjs` — 185 LOC — unchanged from the approved implementation head.
- `test/proxy-quota-status-pipeline.test.mjs` — 241 LOC — unchanged end-to-end merge coverage for `thinking_blocks_dropped`.

## Recommendations

- Re-approve the implementation at `d915953` as a docs-only correction on top of the already-approved executable code.
- Keep the corrected value-prop framing: the proxy is the only non-lossy mitigation for the history-replay paths it covers.
- Leave `implementation-stage` in place and keep Chris's human review as the final merge gate.

## Bottom Line

Approve the current head. The executable code and tests are unchanged from the previously approved implementation, the env-lever guidance is now correct and no longer prescribes `DISABLE_INTERLEAVED_THINKING=1` as a fix, and the full suite is still green at 906/906 on `d915953`.
