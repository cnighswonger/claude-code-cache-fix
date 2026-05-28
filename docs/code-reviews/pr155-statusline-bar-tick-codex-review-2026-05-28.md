# Review: statusline bar-tick rounding

Date: 2026-05-28
Reviewed: PR #155 (`tools/quota-statusline.sh`, `test/quota-statusline-smoke.test.mjs`)
Label applied: changes-requested

## What Is Correct
- The patch targets the reported regression directly: T17 reproduces the 15% consumed / 19.64% elapsed case and the shared cell conversion moves the tick back to the fill boundary.
- The T8 expectation change is internally consistent with the new cell mapping, and the requested smoke suite still passes on the PR branch (`node --test test/quota-statusline-smoke.test.mjs`: 18/18).
- Bounds handling remains safe: both percentages are clamped to `[0, 100]`, and the tick is still clamped to the 10-cell bar.

## Blockers
- `draw_bar()` now uses `round()` for both fill and tick in `tools/quota-statusline.sh:118-124`, but under `python3` that is banker's rounding, not always-up `.5` rounding. That collapses some genuine over-pace states back to the boundary instead of keeping the tick inside the filled run. Reproducer: `consumed_pct=25`, `elapsed_pct=15` now renders `[██┃░░░░░░░]` because `round(2.5) == 2` and `round(1.5) == 2`, while the previous logic rendered `[█┃█░░░░░░░]`. The same loss of signal appears at 45/35 and 65/55. Since the bar's stated purpose is to preserve the under-pace vs over-pace read, this is a behavioral regression, not just a cosmetic shift. The updated tests in `test/quota-statusline-smoke.test.mjs:209-223` and `:354-369` do not cover an exact `.5` over-pace boundary, so the regression currently passes unnoticed.

## What Needs Attention
- `draw_bar()` still cannot represent the right-edge boundary once `fill == width`; equal high-end cases such as 95%/95% still place the tick at index 9 because of the `width - 1` clamp. That is pre-existing rather than introduced here, but if the bar semantics are being tightened it is worth keeping explicit in comments or tests.

## Recommendations
- Replace `round()` with an explicit half-up cell conversion, or keep symmetric rounding but post-adjust the relationship so `consumed_pct > elapsed_pct` still forces `tick < fill` whenever there is room inside the bar.
- Add a regression test for an exact `.5` over-pace boundary, for example 25% consumed with 45 minutes elapsed in Q5h (15% elapsed), so the intended warning signal is contract-tested.

## Bottom Line
Revise before merge. This patch fixes the reported community bug, but the current implementation trades it for false-neutral readings on exact half-cell over-pace cases because Python's rounding semantics are not the ones the patch rationale assumes.
