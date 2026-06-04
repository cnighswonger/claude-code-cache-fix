# Review: overage-warning proxy extension implementation

Date: 2026-04-25
Reviewed: `proxy/extensions/overage-warning.mjs`, `proxy/rates.mjs`, `test/proxy-overage-warning.test.mjs`, `proxy/extensions.json`, `docs/extension-impact-guide.md`
Label applied: `changes-requested`

## What Is Correct

- The activation gate is implemented where the directive required it: both hooks return immediately when `CACHE_FIX_OVERAGE_WARNING` is unset, so the runtime path is fail-closed and no warning file is created from hook execution ([proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L273), [proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L293)).
- The pure test seam is present and usable. `parseTriggerFromHeaders`, `computeProjection`, `dedupKey`, `formatStderrLine`, `formatJsonlRecord`, and `recordSample` are exported alongside the default extension contract, which matches the directive's requested shape ([proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L58), [proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L111), [proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L173), [proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L187), [proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L212)).
- The coarse-cost labeling is consistent across implementation and docs. The stderr formatter includes `(coarse)`, the JSONL schema uses `cost_per_hr_usd_coarse`, and `proxy/rates.mjs` documents the constant as a deliberate approximation ([proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L179), [proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L201), [proxy/rates.mjs](proxy/rates.mjs#L1), [docs/extension-impact-guide.md](docs/extension-impact-guide.md#L97)).
- The hooks are non-mutating with respect to request/stream payloads. I did not find writes to `ctx.body` or `ctx.event`; the extension confines itself to `ctx.meta`, stderr, and the JSONL append path.
- Error isolation is present in both hooks, so extension failures do not escape the pipeline ([proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L277), [proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L297)).
- Local verification passed for both the targeted suite and the full repository suite:
  - `npm test -- test/proxy-overage-warning.test.mjs`
  - `npm test`

## Blockers

- The rolling window does not actually warm on non-trigger responses, which violates the approved hook lifecycle. `onResponseStart()` returns immediately unless `parseTriggerFromHeaders()` says the response is eligible, so non-warning responses never stash `q5h_util` into `ctx.meta`. Later, `onStreamEvent()` only records a `message_start` sample when `ctx.meta._overageWarning?.raw?.q5h_util` exists, so ordinary responses contribute nothing to `_window` ([proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L278), [proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L300)). The directive explicitly approved a lifecycle where `message_start` appends rolling samples regardless of whether the current response is the one that emits. As written, the projection window only fills from already-triggering responses, which makes the "warm window if a later call crosses a threshold" design not true in implementation.
- `message_delta` output tokens can be misattributed to the previous response's sample. The code unconditionally adds `ctx.event.usage.output_tokens` to `_window[_window.length - 1]` before it proves that the current response ever created its own sample ([proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L323)). Combined with the prior bug, an ineligible response can skip `message_start` sampling entirely and still donate its output tokens to the last sample from some earlier request. That skews `tokens_per_min` and `cost_per_hr_usd_coarse`, and it breaks the directive's per-response sample lifecycle.

## What Needs Attention

- The test file names the 14 directive items, but the lifecycle coverage is materially thinner than the labels suggest. Several dedup/emission tests jump straight from `onResponseStart()` to `message_delta` without a preceding `message_start`, so they do not validate the approved `message_start -> message_delta` sequence that is central to this feature ([test/proxy-overage-warning.test.mjs](test/proxy-overage-warning.test.mjs#L78), [test/proxy-overage-warning.test.mjs](test/proxy-overage-warning.test.mjs#L109), [test/proxy-overage-warning.test.mjs](test/proxy-overage-warning.test.mjs#L141)).
- There is still no direct test for "emit exactly once within a single response even if multiple `message_delta` events arrive" or for "an ineligible response must not change the previous sample's output totals." Those are the cases that would have exposed the current blockers.
- The "no state allocated when disabled" wording in the directive is not literally true of the implementation because `_window` and `_dedupThresholds` are allocated at module load even when the env var is unset ([proxy/extensions/overage-warning.mjs](proxy/extensions/overage-warning.mjs#L45)). That is minor compared to the lifecycle bugs, but the written guarantee should be narrowed to "no state mutated" unless the module is restructured.

## Recommendations

- Persist the quota snapshot needed for sampling even on non-trigger responses, separate from the emission eligibility latch. In practice that means `onResponseStart()` should always capture the current quota/utilization data needed by `message_start`, then additionally store trigger eligibility for the later emission gate.
- Track sampling per response rather than mutating the last global sample opportunistically. The safest shape is to store a response-local sample handle or index in `ctx.meta`, append that response's `message_start` sample once, and only ever add `message_delta` output to that same response-owned sample.
- Expand tests to cover the real hook lifecycle: `onResponseStart()` with a non-trigger response followed by `message_start` and `message_delta`, multiple `message_delta` events in one response, and a mixed sequence where an ineligible response follows an eligible one without corrupting the prior sample.

## Bottom Line

Request changes. The pure helpers, labeling, docs, and fail-open behavior are mostly in good shape, but the core hook lifecycle does not match the approved directive: ordinary responses do not warm the rolling window, and unsampled responses can leak output tokens into the previous sample. Those are correctness bugs in the feature's main value path, so this implementation should not be approved until the per-response sampling flow is fixed and covered by tests.
