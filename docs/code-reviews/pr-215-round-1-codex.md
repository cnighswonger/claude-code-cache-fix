Verdict: REQUEST_CHANGES

# Review: PR #215 Workflow-tool agent-id attribution directive

Date: 2026-06-11
Reviewed: PR #215 at b9037fb05c4a91244d580155481165437a2615c3
Round: 1
Label applied: changes-requested

## What Is Correct

- The round-2 rewrite fixes the original architectural error cleanly: the directive now keeps derivation in-proxy, cites the request-path limits accurately, and no longer claims synthesized headers reach Anthropic (`docs/directives/proxy-workflow-agent-id-synthesis.md:31-40`, `proxy/server.mjs:85-99`, `proxy/server.mjs:132-136`).
- The meter rollout model is conceptually the right one. Gating `agent_id` emission behind `CACHE_FIX_USAGE_LOG_AGENT_ID=on` is the same proven shape as `request_id`, and a cache-fix install talking to an older meter remains a graceful no-op while the gate stays off (`docs/directives/proxy-workflow-agent-id-synthesis.md:115-129`, `proxy/extensions/usage-log.mjs:220-238`, `proxy/extensions/usage-log.mjs:267-319`, `claude-code-meter/src/log/schema.mjs:5-48`).
- The derivation algorithm is materially better than round 1. Removing tools-list input and making the per-leg discriminator conditional on binary inspection is the right directive posture for the `parallel()` fan-out problem (`docs/directives/proxy-workflow-agent-id-synthesis.md:84-113`, `proxy/extensions/deferred-tools-restore.mjs:1-18`).
- The marker-seeding gate is now real rather than implied. Requiring a concrete CC version, npm sha256, and matched strings before implementation starts is the right bar for a load-bearing detector (`docs/directives/proxy-workflow-agent-id-synthesis.md:52-82`).
- The cited code references re-verify cleanly, including `proxy/stream.mjs:63` for stream-hook context, `proxy/extensions/cache-telemetry.mjs:64-72` / `:170-179` for `resolveSessionId` plus request-side `ctx.meta` stash precedent, and `proxy/extensions/deferred-tools-restore.mjs:1-18` for tools-list churn.

## Blockers

- `agent_id_source: "cc-header"` is still unreachable as specified. The directive promises canonical-wins read priority and a Task-subagent path where usage-log uses the canonical id (`docs/directives/proxy-workflow-agent-id-synthesis.md:12-14`, `docs/directives/proxy-workflow-agent-id-synthesis.md:44-50`, `docs/directives/proxy-workflow-agent-id-synthesis.md:196-197`), but the only usage-log hook runs at `onStreamEvent`, where the ctx is `{ event, meta, telemetry, responseHeaders }` and request headers are gone (`proxy/stream.mjs:63`, `proxy/extensions/usage-log.mjs:267-319`). The directive's Files-modified section still says usage-log reads `ctx.meta._workflowDerivedAgentId` / `_workflowDerivedAgentIdSource` (`docs/directives/proxy-workflow-agent-id-synthesis.md:217-218`), which only covers the derived path because detection condition 2 forbids derivation when the canonical header is present. The canonical-priority test cannot pass until the directive gives the synthesis extension ownership of a single request-side `ctx.meta` stash for both cases, following the `cache-telemetry` pattern (`proxy/extensions/cache-telemetry.mjs:170-179`).
- The load-bearing meter dependency is still anonymous. The directive says "Meter PR FIRST" and names a companion PR at `claude-code-meter#TBD` (`docs/directives/proxy-workflow-agent-id-synthesis.md:121-125`, `docs/directives/proxy-workflow-agent-id-synthesis.md:223`), but I could not verify any corresponding open PR or ready branch in `cnighswonger/claude-code-meter`; the current meter mainline still only contains the earlier `request_id` schema addition and no `agent_id` / `agent_id_source` fields (`claude-code-meter/src/log/schema.mjs:40-48`). If the ordering is load-bearing, the directive needs a concrete dependency to point at before this moves past review.

## What Needs Attention

- The drift canary and derivation event log are still assigned to `request-log.mjs` (`docs/directives/proxy-workflow-agent-id-synthesis.md:82`, `docs/directives/proxy-workflow-agent-id-synthesis.md:217-218`), but `request-log` is disabled in `extensions.json` and also no-ops without `CACHE_FIX_REQUEST_LOG` (`proxy/extensions.json:70-76`, `proxy/extensions/request-log.mjs:3-21`). That leaves default installs without the stale-catalog signal the directive claims.
- The proposed order `360` collides with `thinking-display` at the same order (`docs/directives/proxy-workflow-agent-id-synthesis.md:151-152`, `docs/directives/proxy-workflow-agent-id-synthesis.md:216`, `proxy/extensions.json:42-52`). `loadExtensions()` sorts only by numeric order, so any tie breaks by incidental file-name ordering, not by an intentional contract (`proxy/pipeline.mjs:16`, `proxy/pipeline.mjs:49`).
- The catalog shape example omits `marker_id` even though the derivation hashes `marker_id` and the test plan requires it on every entry (`docs/directives/proxy-workflow-agent-id-synthesis.md:63-76`, `docs/directives/proxy-workflow-agent-id-synthesis.md:91-95`, `docs/directives/proxy-workflow-agent-id-synthesis.md:193`).
- A4 is only partially closed. Position anchoring helps for system-prompt markers, but the directive still allows `position: "first-user-message"` entries (`docs/directives/proxy-workflow-agent-id-synthesis.md:48`, `docs/directives/proxy-workflow-agent-id-synthesis.md:71`, `docs/directives/proxy-workflow-agent-id-synthesis.md:180-187`). In a top-level session, that surface is user-controlled unless binary inspection proves those first-message blocks are tool-authored.

## Precision / Tightenings

- `AND meter floor present` is not mechanically checkable from cache-fix (`docs/directives/proxy-workflow-agent-id-synthesis.md:124`, `docs/directives/proxy-workflow-agent-id-synthesis.md:217-218`). The env var is the operator's attestation of the floor, just as it is for `request_id`; the directive should say that directly.
- `usage-log.mjs` is not "separately enabled by the operator per existing pattern" on current main; `extensions.json` already enables it, and the load-bearing gate is the env var, not extension registration (`docs/directives/proxy-workflow-agent-id-synthesis.md:153-155`, `proxy/extensions.json:74-76`, `proxy/extensions/usage-log.mjs:267-271`).
- The front-matter branch value drifts from the actual PR head. The directive says `feature/workflow-agent-id-synthesis` (`docs/directives/proxy-workflow-agent-id-synthesis.md:6`), while PR #215 is on `directive/workflow-agent-id-synthesis`.
- The new `test/extensions/` subdirectory is probably fine, but it is a convention change from today's otherwise-flat test tree and should be called deliberate rather than incidental (`docs/directives/proxy-workflow-agent-id-synthesis.md:140`, `docs/directives/proxy-workflow-agent-id-synthesis.md:210`).

## Bloat / Non-Functional

- The revised 250-350 LOC budget is honest enough for the described scope. I do not see round-1-style budget fiction remaining here (`docs/directives/proxy-workflow-agent-id-synthesis.md:24-29`).

## Recommendations

- Give the synthesis extension one request-side ownership point for both canonical and derived attribution, e.g. `ctx.meta._workflowAgentId = { id, source }`, and have usage-log consume only that normalized stash.
- Open or at least name the concrete `claude-code-meter` dependency before this directive advances. A `#TBD` cross-repo prerequisite is too loose for a load-bearing release-ordering claim.
- Move the event-log writer and drift canary into the synthesis extension, pick a non-colliding order, add `marker_id` to the catalog format, and rewrite the meter-floor language as env-var attestation.
- Either forbid `first-user-message` markers outright or state the additional proof required to treat them as machine-authored rather than user-authored.

## Bottom Line

The round-2 directive is much closer: the architecture is now in the right place, the citations hold up, the rollout pattern matches the repo's `request_id` precedent, and the derivation story is honest about what binary inspection still has to prove. But two load-bearing gaps remain at `b9037fb`: usage-log still has no path to emit the canonical `cc-header` source, and the directive still points at a `claude-code-meter#TBD` dependency instead of a real companion PR or ready branch. Those are concrete, fixable directive issues, and they need to be resolved before this should clear Codex review.

— Codex review
