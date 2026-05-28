# Review: proxy-thinking-block-sanitize directive

Date: 2026-05-28
Reviewed: PR #162 directive (`docs/directives/proxy-thinking-block-sanitize.md`)
Label applied: changes-requested

## What Is Correct

- Blocker 1 is cleared. The directive now explicitly states that the omitted `{"type":"thinking","thinking":"","signature":"..."}` shape is normal, not corruption, and it reframes the transform as dropping prior-turn optional history rather than claiming a uniquely broken wire shape ([directive lines 8-16](../directives/proxy-thinking-block-sanitize.md)).
- The NFR section is still valid: it is present and non-empty, `Load-bearing? yes` is the correct classification for a shared request-path body mutator, and the Chris-review gate remains appropriate for this risk class ([directive lines 18-24](../directives/proxy-thinking-block-sanitize.md)).
- The v1 opt-in posture is the right release-safety call. A request-body mutator with unresolved live-coverage validation should not ship default-on, and the directive now reflects that clearly with `CACHE_FIX_THINKING_SANITIZE=on` defaulting to off ([directive lines 30-32, 46-48](../directives/proxy-thinking-block-sanitize.md)).
- Open Question 1 is the right place to hold the remaining coverage uncertainty. The spec no longer pretends that a prior-turn-only drop is already proven to clear every latest-message-named 400, and the "never touch an active tool-continuation turn" boundary is sound ([directive lines 30, 46-48](../directives/proxy-thinking-block-sanitize.md)).

## Blockers

- `redacted_thinking` is still specified with the wrong predicate. The directive's threat-model and behavior text still groups `redacted_thinking` under the same omitted/empty-text rule as regular `thinking` blocks ([directive lines 21, 28](../directives/proxy-thinking-block-sanitize.md)), but Anthropic's current extended-thinking docs define `redacted_thinking` as a distinct opaque block, `{ "type":"redacted_thinking", "data":"..." }`, and explicitly distinguish it from omitted `thinking` blocks with empty `thinking` text. If `redacted_thinking` is meant to be in scope as optional prior-turn history, it needs its own schema-aware rule and justification; otherwise it should be removed from v1 scope. As written, blocker 2 is not resolved and the directive is still not precise enough to hand to implementation. Source: https://platform.claude.com/docs/en/build-with-claude/extended-thinking

## What Needs Attention

- Resolve Open Question 1 into a concrete turn-selection rule before implementation starts. I agree with the directive's gating posture: validate against a captured wedged request whether dropping prior completed turns is sufficient, and only widen to the latest completed non-continuation turn if the capture proves that is the failing case. Do not generalize this to an active tool-continuation turn.
- Open Question 2 should resolve to dropping the now-empty assistant message, not synthesizing placeholder text. A placeholder mutates conversation bytes and semantics for no benefit, while the proxy is already operating on a wire-format message list rather than transcript node IDs.
- The testing section should regain an explicit `redacted_thinking` case once the rule is corrected, because the current unit list only names omitted `thinking` coverage ([directive lines 52-53](../directives/proxy-thinking-block-sanitize.md)).

## Bloat / Non-Functional

None. The directive is tighter than the prior version, and the remaining problem is rule precision, not size or abstraction.

## Size Baseline

- `docs/directives/proxy-thinking-block-sanitize.md` — 53 LOC — compact directive; the main remaining risk is schema precision around `redacted_thinking` and final turn coverage, not sprawl.
- `preload.mjs` — 2881 LOC — existing implementation surface; the directive still sets the right expectation that this should stay a small extension rather than grow a new subsystem.

## Recommendations

- Remove `redacted_thinking` from the v1 behavior unless you can define a separate, documented predicate for it that matches the actual `{type:"redacted_thinking", data:"..."}` schema.
- Keep v1 opt-in until Open Question 1 is answered with a real captured replay request and the exact turn-selection rule is written into the behavior and testing sections.
- Once coverage is validated, encode the rule explicitly in behavior/tests rather than leaving "latest completed non-continuation" as an implementation-time inference.

## Bottom Line

Changes requested again for directive stage, but the scope is much narrower now. The prior "normal omitted shape vs corruption" blocker is cleared, the opt-in posture is correct, and the coverage question is being handled in the right place. The remaining blocker is that `redacted_thinking` is still written as if it participated in an empty-text omitted-shape matcher, even though Anthropic documents it as a separate opaque `data` block. Fix that schema mismatch and then this is ready for another pass.
