# Review: session-health early-warning directive

Date: 2026-05-28
Reviewed: `docs/directives/proxy-session-health-warning.md`
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- The warn-only boundary is explicit and appropriately narrow. The directive states twice that cache-fix must not try to repair or mutate thinking blocks and keeps auto-retire, auto-clear, and cross-host aggregation out of scope, which is the right safety cut for an upstream Claude Code failure mode rather than a proxy-owned one (`docs/directives/proxy-session-health-warning.md:16-18,68-72`).
- The split-by-dimension release shape is sound. Shipping token-gated warning now while holding block-gated warning for a calibrated fast-follow matches the evidence quality we actually have: one live-context trip point at ~382K tokens, but no in-context block-count distribution yet (`docs/directives/proxy-session-health-warning.md:27-30,43,50-53,57-59`).
- The measurability claims are real against the current proxy surfaces. Request bodies are fully parsed and passed through `runOnRequest()` before forwarding (`proxy/server.mjs:26-61`), SSE `usage` is already captured from `message_start` / `message_delta` (`proxy/stream.mjs:15-29`), and `cache-telemetry` already resolves session id on the request side and writes the per-session file on stream completion (`proxy/extensions/cache-telemetry.mjs:158-239`).
- The telemetry extension point is backward-safe as described, provided the existing cache fields stay intact. Current shipped consumers read `cache.ttl_tier`, `cache.hit_rate`, and the top-level `timestamp`; additive top-level risk fields will not break that contract (`proxy/extensions/cache-telemetry.mjs:213-229`, `tools/quota-statusline.sh:85-99,185-194`).
- Keeping statusline changes out of v3.8.0 is the right coordination boundary. Per-session JSON plus a stderr signal is enough to ship the warning without pulling community-owned UI code into the same change set (`docs/directives/proxy-session-health-warning.md:44-46,61-65`).

## Blockers

None.

## What Needs Attention

- `docs/directives/proxy-session-health-warning.md:52` should be tightened before implementation/docs fan-out so `CACHE_FIX_THINKING_RISK=off` has one unambiguous meaning. As written, "telemetry still recorded" leaves room for two materially different behaviors: raw counts only, or raw counts plus a still-populated `thinking_desync_risk` field. The implementation should not have to guess whether "off" suppresses only stderr or every built-in warning surface.
- `docs/directives/proxy-session-health-warning.md:24` slightly overstates today's surface. The current per-session file does not already carry `first_seen`; it only writes `cache`, `timestamp`, and `session_id` today (`proxy/extensions/cache-telemetry.mjs:214-227`). That does not block the design, but the wording should reflect that `first_seen` is part of the new persisted state, not an already-available field.
- The eventual implementation should count `thinking_block_count` from the post-pipeline request body that is actually forwarded upstream, not a raw pre-pipeline snapshot. The server runs the full request pipeline before serializing `reqCtx.body` back to `forwardBody` (`proxy/server.mjs:43-58`), and using that final shape gives the most accurate "live risk driver" measurement if any earlier extension has normalized the body.

## Recommendations

- Approve the directive and move to implementation, but lock the `CACHE_FIX_THINKING_RISK=off` behavior in the implementation PR and README so JSON consumers and stderr behavior stay consistent.
- In the implementation review checklist, require the one-time stderr signal to be keyed on a per-session transition into `high` rather than "every request while high." The directive already implies that outcome; making it explicit will keep tests and implementation aligned.
- Preserve the current per-session JSON keys exactly and append the new risk fields additively at the top level. That keeps `tools/quota-statusline.sh` and other current readers compatible while still exposing the new telemetry.

## Bottom Line

Ship this directive. The scope boundary is disciplined, the token/block split matches the current evidence, and the underlying proxy already has the measurement surfaces the design relies on. I do not see a directive-level blocker to implementation; only a few wording clarifications should be tightened so the env toggle and persisted-state contract are interpreted the same way by every implementer and consumer.
