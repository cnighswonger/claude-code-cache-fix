# Review: PR #143 statusline time bar

Date: 2026-05-24
Reviewed: tools/quota-statusline.sh, test/quota-statusline-smoke.test.mjs
Label applied: changes-requested

## What Is Correct

- `tools/quota-statusline.sh` now centralizes duration rendering in a single `fmt_time()` helper, which keeps Q5h on the existing `h/m` shape while fixing the Q7d `< 1 day` case that previously surfaced as `0d13h`.
- The shared `BURN_WARMUP_SEC = 5 * SECS_PER_MIN` gate is implemented consistently for both windows, which matches the stated goal of a single 5-minute warmup policy instead of separate 1-minute and 6-minute thresholds.
- The smoke coverage is materially better. `test/quota-statusline-smoke.test.mjs` updates the existing format assertions for the compact `d/h` output and adds `T15` to pin the under-one-day Q7d rendering path.
- I reran `node --test test/quota-statusline-smoke.test.mjs` locally; all 16 tests passed. A broader `npm test` run surfaced an unrelated existing failure in `dispatch back-compat: --proxy-port + claude-arg passes through to wrapper mode`, so I did not treat the full-suite result as a signal on this PR.

## Blockers

- `tools/quota-statusline.sh:107-110,135-143,180-181` and `test/quota-statusline-smoke.test.mjs:189-203,278-290,313-329` intentionally move the public statusline contract, but `README.md:361,370,373` still documents the old one. The shipped README still shows `3d 13h` / `3d 0h` examples and still says `exhaust` is suppressed for the first minute (Q5h) or six minutes (Q7d), while the implementation now emits `3d13h` / `3d0h` and uses one shared 5-minute warmup. Because this script's output is a documented user-facing surface, merging the code/test change without updating the README leaves the primary docs wrong on day one.

## What Needs Attention

- None beyond the README drift above.

## Recommendations

- Update the statusline section in `README.md` in the same PR: change the Q7d examples to the compact `d/h` format, refresh the full sample line, and rewrite the warmup explanation to describe the unified 5-minute gate.

## Bottom Line

Revise before approval. The implementation itself looks coherent and the targeted smoke coverage is good, but the PR currently changes a documented user-visible contract without updating the documentation that publishes that contract.
