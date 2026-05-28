# Review: session-health early-warning directive

Date: 2026-05-28
Reviewed: `docs/directives/proxy-session-health-warning.md`
Label applied: `changes-requested`

## What Is Correct

- The directive now includes a real `## Non-Functional Requirements` section, and the size, threat-model, maintainability, and performance lines are concrete and non-empty rather than boilerplate (`docs/directives/proxy-session-health-warning.md:70-76`).
- The design remains disciplined. It keeps the feature on the warn-only side of the boundary, explicitly forbids any thinking-block mutation or repair behavior, and leaves auto-retire/auto-clear and cross-host aggregation out of scope (`docs/directives/proxy-session-health-warning.md:20,78-82`).
- The split-by-dimension release plan is still the right shape. Token-gated warning now and block-gated warning only after calibration matches the evidence quality we actually have: a live-context failure point around `~382K`, but no in-context block-count failure distribution yet (`docs/directives/proxy-session-health-warning.md:31,45,55,61,65-68`).
- The implementation surfaces the directive relies on are present in the current codebase. Request bodies are available and rewritten from the post-pipeline `reqCtx.body` before forwarding (`proxy/server.mjs:43-58`), SSE usage is already extracted from `message_start` / `message_delta` (`proxy/stream.mjs:15-29`), and `cache-telemetry` already persists per-session JSON keyed from request-side session headers (`proxy/extensions/cache-telemetry.mjs:158-167,182-238`).
- The load-bearing classification itself is directionally correct: this feature is read-only on request/response bodies, so it does not carry the request-path mutation risk of the sibling sanitize directive, but it does extend a consumed JSON contract and therefore qualifies as load-bearing on the schema-contract dimension (`docs/directives/proxy-session-health-warning.md:73-76`, `CLAUDE.md:86-94`).

## Blockers

- `docs/directives/proxy-session-health-warning.md:76` understates the required review burden for a load-bearing change. The repo standard is explicit that anything touching a wire/schema contract is load-bearing and therefore requires Chris review before merge (`CLAUDE.md:92-94`). The current text says "Recommend ... a brief human (Chris) confirmation," which is weaker than the rule it is trying to satisfy. This should be tightened from a recommendation to an explicit requirement before the directive is treated as approved under the revised workflow.

## What Needs Attention

- `docs/directives/proxy-session-health-warning.md:54` should be made unambiguous before implementation: `CACHE_FIX_THINKING_RISK=off` currently says "disable the warning (telemetry still recorded)," but that still leaves room for disagreement about whether `thinking_desync_risk` continues to be written in JSON or whether only the raw numeric telemetry remains.
- `docs/directives/proxy-session-health-warning.md:26` slightly overstates the current state of the session file. The per-session file already exists, but `first_seen` is new persisted state, not an already-present field; current writes are still limited to `cache`, `timestamp`, and `session_id` (`proxy/extensions/cache-telemetry.mjs:213-227`).
- Implementation should count `thinking_block_count` from the post-pipeline request body that is actually forwarded upstream, not from a raw pre-pipeline snapshot. The current server architecture makes that straightforward and keeps the metric aligned with the true live request shape (`proxy/server.mjs:44-58`).

## Bloat / Non-Functional

- No bloat finding. The stated `~100-200 LOC + tests` budget is reasonable for additive fields on the existing per-session writer, a small threshold computation, and one transition-gated stderr warning. The directive explicitly avoids a new subsystem and stays consistent with the repo's existing telemetry-first patterns (`docs/directives/proxy-session-health-warning.md:72-75`, `preload.mjs:1752-1760,2711-2789`).
- The schema-contract-only load-bearing call is the right strength. It should not be weakened to "non-load-bearing" just because the fields are additive, because the repo rule explicitly treats wire/schema-contract changes as load-bearing. It also does not need to be strengthened to request-path/security-risk parity with `#162`, because this directive is explicitly read-only on request/response bodies (`docs/directives/proxy-session-health-warning.md:73-76`, `CLAUDE.md:92-94`).

## Size Baseline

- `docs/directives/proxy-session-health-warning.md` — 86 LOC — directive is focused, with clear scope boundaries and one new NFR gate to tighten.
- `proxy/extensions/cache-telemetry.mjs` — 248 LOC — natural implementation home for additive session JSON fields and usage-derived risk data.
- `proxy/server.mjs` — 355 LOC — already exposes the post-pipeline request body needed for accurate block counting without new plumbing.
- `proxy/stream.mjs` — 110 LOC — already extracts the token telemetry the warning logic depends on.
- `tools/quota-statusline.sh` — 204 LOC — existing consumer of the per-session JSON; relevant to schema compatibility, intentionally untouched by this release.

## Recommendations

- Update the `Load-bearing?` line so it explicitly says Chris review is required before merge for this directive's schema-contract change, then keep the `schema-change` label on the PR.
- Keep the directive approved on design once that wording is fixed; the core plan is still sound and scoped appropriately for a minor release.
- When implementation begins, lock the `CACHE_FIX_THINKING_RISK=off` behavior in code and README at the same time so stderr behavior and JSON contract stay aligned.

## Bottom Line

The design still looks good, and the new NFR section is materially better than the earlier version. The remaining problem is process correctness, not architecture: the directive correctly identifies itself as load-bearing on the schema-contract dimension, but it phrases the Chris review requirement as optional. Under the revised repo standard, that needs to be made explicit before this directive should carry an approval state again.
