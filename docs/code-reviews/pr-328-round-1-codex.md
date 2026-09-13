# Review: PR #328 anthropic-beta stabilization directive

Date: 2026-08-11
Reviewed: PR #328 directive at `3cde45e`
Round: 1
Label applied: changes-requested

Codex review: cross-LLM directive review, independent skepticism posture.

## What Is Correct

- [Read] The whitelist boundary is otherwise narrow. A targeted read of `proxy/extensions/*.mjs` found only `deferred-tool-rewrite` writing `anthropic-beta` via `addBetaToken()` for `mid-conversation-tool-changes-2026-07-01` (`proxy/extensions/deferred-tool-rewrite.mjs:142`, `proxy/extensions/deferred-tool-rewrite.mjs:500`, `proxy/extensions/deferred-tool-rewrite.mjs:627`). `auto-1m-guard` can strip `context-1m-2025-08-07`, but it is an operator safety guard, not a cache-fix extension whose guarantee requires passthrough (`proxy/extensions/auto-1m-guard.mjs:14`, `proxy/extensions/auto-1m-guard.mjs:100`). I did not find another extension-owned beta token with DTR's same silent-strip failure mode.
- [Read] The three-part key is defensible for this directive. `resolveToolRewriteSessionKey()` already keys on session id, system-prompt sub-key, and conversation sub-key (`proxy/extensions/deferred-tool-rewrite.mjs:247`), and the supporting comments document the real collision classes for sidecars, subagents, and conversation switches (`proxy/extensions/deferred-tool-rewrite.mjs:216`, `proxy/extensions/deferred-tool-rewrite.mjs:230`; `proxy/extensions/message-hash.mjs:31`). Beta headers are a different payload surface, but their stated collision question is also tenant/conversation isolation under a shared session-id header. Over-keying is cheaper than letting one tenant pin another tenant's beta set.
- [Read] The scope is right-sized under the repo's anti-bloat lens: one extension file, one registration, one test file, default-off runtime gate, no new persistence abstraction. The directive correctly marks the work load-bearing because it mutates credential-bearing upstream request headers (`docs/directives/proxy-anthropic-beta-stabilize.md:38`, `docs/directives/proxy-anthropic-beta-stabilize.md:60`).
- [Measured] CI on PR head `3cde45e` is green: `gh pr checks 328 --repo cnighswonger/claude-code-cache-fix` reported Snyk pass and test matrix pass on Node 18, 20, and 22. I did not run local tests because the PR is directive-only and adds no executable code.

## Blockers

1. [Read] The directive's URL guard depends on `ctx.url`, but the shipped request context does not provide it.

   The directive requires step 0 to no-op when `ctx.url !== "/v1/messages"` (`docs/directives/proxy-anthropic-beta-stabilize.md:71`) and repeats that contract in Q3 (`docs/directives/proxy-anthropic-beta-stabilize.md:220`). The implementation path today constructs `reqCtx` with only `body`, copied `headers`, and `meta` before calling `runOnRequest()` (`proxy/server.mjs:103`, `proxy/server.mjs:106`); `runOnRequest()` only reads `ctx.meta?.route` for route filtering and passes the same object to extensions (`proxy/pipeline.mjs:102`, `proxy/pipeline.mjs:104`). There is no `ctx.url` on the real extension context.

   An implementation that follows the directive literally would see `ctx.url === undefined` and no-op on every live `/v1/messages` request, silently disabling the extension. The directive needs to choose and specify one of two shapes before implementation: add request path/pathname to the pipeline contract, update the size/NFR budget, and test the real pipeline path; or guard on the existing `ctx.meta.route === "messages"` contract and separately handle path subtypes. Test 17 as written can pass with a synthetic `ctx.url` object while the shipped pipeline never supplies that field, so it is not enough evidence.

## What Needs Attention

- [Read] Endpoint policy is still under-specified for `/v1/messages/*` subpaths. The server routes any `POST` whose URL starts with `/v1/messages` through `handleMessages()` (`proxy/server.mjs:512`), while the directive says exact `/v1/messages` only. If the implementation adds raw `ctx.url`, exact equality also excludes `/v1/messages?query` and all `/v1/messages/count_tokens` or `/v1/messages/batches` traffic; if it uses `ctx.meta.route`, it includes them all. The directive should state the intended pathname policy and add tests for `count_tokens` and `batches`, even if the answer is "explicit no-op."
- [Read] The durability story for strict-pin telemetry should be made explicit before implementation. The directive says delta-add telemetry makes silent blocking detectable (`docs/directives/proxy-anthropic-beta-stabilize.md:187`) and defers `usage.jsonl` integration (`docs/directives/proxy-anthropic-beta-stabilize.md:331`), but the test contract only requires `ctx.meta.betaStabilizeStats` (`docs/directives/proxy-anthropic-beta-stabilize.md:292`). Deferring `usage.jsonl` is acceptable only if this PR also specifies a durable per-action event log, matching DTR's event-file pattern (`proxy/extensions/deferred-tool-rewrite.mjs:205`). If the first implementation only writes stderr plus transient `ctx.meta`, then usage integration should not be follow-on.
- [Read] Add one test for an empty pinned set followed by a non-whitelist add. Test 9 covers first-seen with no beta header (`docs/directives/proxy-anthropic-beta-stabilize.md:266`), and Test 12 covers empty pin plus the whitelisted DTR token (`docs/directives/proxy-anthropic-beta-stabilize.md:274`). The strict-pin branch also needs the negative case: first request has no beta header, later request adds `new-beta`, outgoing still has no `anthropic-beta`, and telemetry reports `adds=["new-beta"]`.
- [Read] Test 8's case-preserving header claim is useful as a helper contract, but real Node request headers are lower-cased before `preForward()` copies them (`proxy/server.mjs:98`). Keep the test, but do not treat it as live-path evidence unless an integration test injects mixed-case headers before Node normalization.

## Bloat / Non-Functional

None beyond the blocker above. The intended production scope is proportionate; if the fix adds a pipeline `url`/`pathname` field, the directive should update the NFR from "one extension file" to include the small server/pipeline contract change and its regression test.

## Recommendations

- Amend the directive to use the existing `ctx.meta.route` guard, or explicitly add `ctx.url`/`ctx.pathname` to `preForward()`'s extension context and test that through the real request path.
- Add endpoint-scope tests for `/v1/messages/count_tokens` and `/v1/messages/batches`, with the expected behavior stated either way.
- Specify durable telemetry in this implementation, or move `beta_stabilize_stats` into the implementation scope behind `CACHE_FIX_USAGE_LOG_EXTENDED`.

## Bottom Line

Revise before implementation. The design is close, and the DTR whitelist/keying choices survive an adversarial read, but the URL guard currently names a context field the extension pipeline does not expose. That is exactly the kind of directive-stage gap that would otherwise become a live no-op or an unbudgeted implementation contract change.

— Codex, cross-LLM review, round 1
