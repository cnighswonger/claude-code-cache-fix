# Review: proxy-thinking-block-sanitize directive

Date: 2026-05-28
Reviewed: PR #162 directive (`docs/directives/proxy-thinking-block-sanitize.md`)
Label applied: reviewed-by-codex-agent

## What Is Correct

- The remaining schema blocker is cleared. `redacted_thinking` is no longer part of the active v1 strip rule in either the threat model or behavior section, and the directive now explicitly defers it to Out of scope with the correct opaque `{ "type":"redacted_thinking", "data":"..." }` schema rationale ([directive lines 21, 28, 43](../directives/proxy-thinking-block-sanitize.md)).
- The v1 behavior is now internally consistent: the transform is scoped to prior-turn omitted `thinking` blocks only, non-empty `thinking` stays untouched, the latest assistant message remains protected pending empirical coverage validation, and empty-content assistant messages are dropped rather than rewritten ([directive lines 28-32](../directives/proxy-thinking-block-sanitize.md)).
- The non-functional framing is still sound. `Load-bearing? yes` remains correct for a request-path body mutator, the Chris-review gate is present, the determinism requirement is explicit, and the v1 default-off posture is still the right safety call until Open Question 1 is answered with a real captured repro ([directive lines 18-24, 32, 47-49](../directives/proxy-thinking-block-sanitize.md)).
- Open Question 1 remains correctly framed as the pre-implementation empirical gate: prove whether prior-turn dropping alone clears the latest-message-named 400, and widen only if a captured repro shows the latest completed non-continuation turn also needs stripping. The no-touch boundary for an active tool-continuation latest turn is preserved ([directive lines 30, 47-49](../directives/proxy-thinking-block-sanitize.md)).

## Blockers

None.

## What Needs Attention

- Resolve Open Question 1 against a captured wedged request before implementation locks. Approval here is for directive precision and scope, not for skipping the live coverage check.
- Resolve Open Question 2 toward dropping the now-empty assistant message, which the current behavior section already states. Keep implementation and tests aligned with that choice.
- When implementation starts, keep telemetry counts-only as specified and do not let the request walker expand past the directive's stated small-extension budget.

## Bloat / Non-Functional

None. The directive is now tighter than the previous pass and removes the only remaining schema overreach instead of adding a special-case abstraction.

## Size Baseline

- `docs/directives/proxy-thinking-block-sanitize.md` — 54 LOC — compact directive with a clear v1 boundary; the remaining work is empirical coverage validation, not spec expansion.
- `preload.mjs` — 2881 LOC — existing implementation surface; the directive still sets the right expectation that this should land as a small extension reusing current body-walk patterns.

## Recommendations

- Start implementation only after the captured-request validation in Open Question 1 settles the exact turn-selection rule.
- Keep `redacted_thinking` out of v1 unless a real repro demonstrates it participates in the rejection and a separate schema-accurate rule is added.
- Preserve the opt-in release posture for the first implementation cut.

## Bottom Line

Approve the directive for implementation. The one remaining blocker from the last pass is resolved: `redacted_thinking` is cleanly out of the v1 empty-text predicate, and the spec now hands implementation a precise, internally consistent v1 scope while keeping the load-bearing coverage question as an explicit pre-implementation gate.
