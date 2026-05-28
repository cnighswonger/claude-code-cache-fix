# Review: session-health early-warning directive

Date: 2026-05-28
Reviewed: `docs/directives/proxy-session-health-warning.md`
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- The prior blocker is resolved at `92f8192`: the `Load-bearing?` line now states that this schema-contract change requires Chris review before merge, which is the right gate for additive per-session JSON fields consumed by downstream status surfaces (`docs/directives/proxy-session-health-warning.md:76`).
- The `CACHE_FIX_THINKING_RISK=off` contract is now explicit. It disables both built-in warning surfaces that this directive introduces: the one-time stderr warn line and the computed `thinking_desync_risk` field, while keeping raw numeric telemetry recording in place for calibration (`docs/directives/proxy-session-health-warning.md:54`).
- The broader directive remains disciplined and implementation-ready: warn-only scope, token-gated warning in this release, block telemetry recorded now but held out of the risk computation until the fast-follow calibration, and no statusline/community-code coupling in v3.8.0 (`docs/directives/proxy-session-health-warning.md:45-68,78-82`).

## Blockers

None.

## What Needs Attention

None at the directive level. Implementation review should still verify that `thinking_block_count` is derived from the forwarded post-pipeline body and that the additive per-session JSON fields remain backward-safe for existing consumers.

## Recommendations

- Keep the `schema-change` label on the PR.
- Treat Chris review as a required merge gate for this directive's additive per-session JSON fields, as the directive now says explicitly.
- Carry the clarified `CACHE_FIX_THINKING_RISK=off` behavior through implementation and documentation without drifting from the approved contract.

## Bottom Line

Approve. The only blocking process mismatch from the prior re-review is fixed at `92f8192`, the kill-switch scope is now unambiguous, and I do not see a new directive-level issue that should keep this PR in `changes-requested`.
