# Review: proxy-thinking-block-sanitize directive

Date: 2026-05-29
Reviewed: PR #162 directive (`docs/directives/proxy-thinking-block-sanitize.md`)
Label applied: reviewed-by-codex-agent

## What Is Correct
- The revised directive is internally coherent again after the Open Question 1 resolution. Goal, Behavior #1, Behavior #3, Out of scope, and the resolved Open Question now all describe the same v1 rule: drop omitted `thinking` blocks from prior assistant turns and also from the latest assistant turn unless that latest turn is still an active tool-continuation ([directive lines 6-16, 28-34, 42-47, 49-58](../directives/proxy-thinking-block-sanitize.md)).
- The turn-selection rule is now defensible against both the PR’s empirical evidence and Anthropic’s current docs. The PR thread’s 24 captured `400 ... cannot be modified` errors show the API naming the latest assistant message every time, so the old prior-turn-only rule would not have covered the documented failure. Anthropic’s current extended-thinking docs also still distinguish between prior assistant turns, whose thinking can be omitted, and active tool-use continuations, where the complete unmodified thinking block must be round-tripped. That makes the new exclusion boundary the right one for v1: latest completed turn is droppable; latest active tool-continuation is not.
- The `redacted_thinking` deferral still holds technically and empirically. The directive keeps it fully out of the active v1 predicate, explains the correct opaque `{ "type":"redacted_thinking", "data":"..." }` schema, and the PR evidence says the motivating worst-case transcript contained zero such blocks ([directive lines 28-29, 47, 51](../directives/proxy-thinking-block-sanitize.md)).
- The NFR section remains sound. `Load-bearing? yes` is the correct classification for a shared request-path body mutator, the Chris-review requirement is explicit, determinism/cache-stability are called out, and the size/maintainability budget still points implementation toward one small extension reusing the existing pipeline/body-walk patterns rather than a new subsystem ([directive lines 18-24](../directives/proxy-thinking-block-sanitize.md), [proxy/pipeline.mjs](../../proxy/pipeline.mjs), [preload.mjs](../../preload.mjs)).
- The opt-in posture is still the right release boundary. The directive now correctly treats the live A/B as the gate for future default-on reconsideration, not as a blocker to an opt-in v1 that is already narrowed to the completed-turn-resume class ([directive lines 34-36, 51, 53, 57-58](../directives/proxy-thinking-block-sanitize.md)).

## Blockers
None

## What Needs Attention
- Chris human review remains required before implementation/merge because this is still a load-bearing request-body mutator. That is a process gate, not a directive flaw ([directive line 24](../directives/proxy-thinking-block-sanitize.md), [CLAUDE.md](../../CLAUDE.md)).
- The remaining live A/B belongs to rollout posture, not directive correctness: keep v1 opt-in until a captured completed-turn repro proves the transform clears the 400 without surfacing a different rejection ([directive lines 36, 51, 58](../directives/proxy-thinking-block-sanitize.md)).
- Open Question 2 is still worth covering in implementation tests even though it is not blocking the directive anymore: if stripping leaves an assistant message empty, the chosen behavior is to drop the message, so that path should be exercised in live integration as well as unit tests ([directive lines 35, 52, 57-58](../directives/proxy-thinking-block-sanitize.md)).

## Bloat / Non-Functional
None

## Size Baseline
- `docs/directives/proxy-thinking-block-sanitize.md` — 58 LOC — compact directive; the behavioral change is substantive but still contained.
- `proxy/pipeline.mjs` — 120 LOC — existing extension execution surface; no new pipeline abstraction is warranted.
- `preload.mjs` — 2881 LOC — large incumbent helper surface; the directive still correctly biases toward reusing existing body-walk patterns instead of inventing new machinery.

## Recommendations
- Approve the directive for implementation at the current scope.
- Keep `redacted_thinking` out of v1 unless a real repro demonstrates that it participates in this failure mode and justifies a separate schema-accurate rule.
- Treat the latest-turn exclusion exactly as written: only active tool-continuation turns are protected; latest completed assistant turns belong in the drop set.
- Keep the opt-in/default-off posture until the live proxy A/B is complete, even though the directive itself is now ready.

## Bottom Line
Approve. The revised directive fixes the one load-bearing ambiguity that mattered: it no longer claims a prior-turn-only transform can solve an error the API consistently attributes to the latest assistant message, and it draws the correct no-touch boundary around active tool continuations. The remaining gates are operational, not architectural: Chris still needs to sign off on this load-bearing mutator, and default-on still waits for live validation.
