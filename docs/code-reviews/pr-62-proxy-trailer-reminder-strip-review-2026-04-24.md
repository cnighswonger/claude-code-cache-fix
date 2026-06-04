# Review: content-strip + tool-input-normalize

Date: 2026-04-24
Reviewed: PR #62 (`feature/proxy-trailer-reminder-strip`)
Label applied: changes-requested

## What Is Correct
- `content-strip` uses exact text equality for the continue trailer, so longer or variant user text is not stripped accidentally.
- `content-strip` preserves the original message when filtering would empty `content`, which avoids producing invalid empty user content arrays.
- `tool-input-normalize` rebuilds `tool_use.input` in declared schema property order and drops non-schema keys.
- Both new extensions are disabled by default (`enabled: false`), which is the right rollout posture for new cache-normalization behavior.
- Focused tests cover the main happy paths for trailer stripping, reminder stripping, key reordering, and extra-key removal.

## Blockers
- `content-strip` does not match the full documented bookkeeping reminder set already defined in [preload.mjs](preload.mjs#L518). The new matcher only handles token usage, output tokens, USD budget, and the task-tools nudge in [proxy/extensions/content-strip.mjs](proxy/extensions/content-strip.mjs#L4), but omits:
  - `The TodoWrite tool hasn't been used recently. …`
  - `Remaining conversation turns: <N>`
  - `Messages until auto-compact: <N>` / `Message until auto-compact: <N>`
  This means PR #62 would leave part of the documented bookkeeping churn in place, and the new tests would still pass because they only assert the reduced subset in [test/proxy-content-strip.test.mjs](test/proxy-content-strip.test.mjs#L30).

## What Needs Attention
- `stripContentBlocks()` increments `trailerCount` / `reminderCount` before the empty-array guard. If a message consists only of removable blocks, the function returns the original message unchanged but still reports non-zero strip stats, so `onRequest()` records `ctx.meta.contentStripStats` for a no-op request. That is an observability bug, not a payload corruption bug.
- The new `content-strip` tests do not cover the documented reminder variants above, so the current regression escaped easily.

## Recommendations
- Align `BOOKKEEPING_PATTERNS` in `content-strip` with the documented bookkeeping matcher already used in `preload.mjs`, then add tests for TodoWrite, remaining-turn counters, and auto-compact counters.
- Change the strip counters to increment only when a block is actually removed from the outbound payload after the empty-content safeguard is applied, or recompute stats from the final transformed message set.

## Bottom Line
Revise before approval. `tool-input-normalize` looks correct for the requested behavior, and `content-strip` gets the continue-trailer handling right, but the reminder matcher is incomplete relative to the repo’s documented bookkeeping formats and should be fixed before this ships.
