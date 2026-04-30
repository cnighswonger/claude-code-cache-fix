# Review: PR 94 Session Serializer Directive

Date: 2026-04-30
Reviewed: `docs/directives/proxy-session-serializer.md`
Label applied: `changes-requested`

## What Is Correct

- The two-phase split is the right top-level call for issue #67. The issue text explicitly says "Not picking this up unless we have a fresh reason to," and a short observability sprint is a lower-risk way to answer that than shipping queueing behavior first.
- Keeping Phase 0 observational-only is the right safety bar. The directive is correctly trying to avoid another speculative behavior change when the current failure pattern has not been revalidated.
- Preserving `docs/deferred/proxy-session-serializer.md` as a historical reference instead of rewriting it in place is good discipline. It keeps the original assumptions auditable while allowing a v3-shaped directive to supersede it later.
- The activation shape (`enabled: true` plus runtime env gate) is consistent with the current extension loader behavior in [proxy/pipeline.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/pipeline.mjs:7).

## Blockers

- [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:58), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:74), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:137), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:172), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:195): the Phase 0 measurement path does not line up with the current proxy hook surface. The spec says completion can be detected via callbacks "already available to extensions," but the current pipeline only exposes `onRequest`, `onResponseStart`, `onStreamEvent`, and `onResponse` ([proxy/pipeline.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/pipeline.mjs:49)). There is no extension callback for stream completion, client abort, post-first-byte upstream failure, or the pre-first-byte `forwardRequest()` failure path in [proxy/server.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/server.mjs:58). As written, the directive both declares the needed hook out of scope and omits any `proxy/server.mjs` / `proxy/pipeline.mjs` changes from the file map, so the implementation route is internally inconsistent. The spec needs to explicitly include the server/pipeline seam that will emit terminal outcomes, or narrow the measurement contract to only the outcomes the current hooks can actually observe.

- [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:136), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:141): the success criterion for "pattern still observable" is not defensible as written. "`collision-5xx-rate >= 2x baseline`" with a stop condition of "1 week or 1000 requests" does not control for low collision counts or low base-rate noise. A jump from 1 to 2 events can satisfy 2x while still being statistically meaningless, and a small collision cohort can just as easily hide a real effect. The directive needs a minimum collision sample size and some uncertainty check before Phase 1 is greenlit, or it risks turning Phase 0 into intuition with extra steps.

- [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:97), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:100), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:124): the privacy contract around `session_key` is too weak for a persisted log entry derived from prompt text. A deterministic, truncated SHA-256 of `system[0].text + first user message` is not meaningfully private against dictionary attacks on common prompts, especially when the log is stored long-term in `~/.claude/session-observability.jsonl`. "Hashed, never plaintext" overstates the protection here. The directive should either use a keyed derivation that is not reusable outside the local machine/run, or avoid persisting any stable content-derived key at all.

## What Needs Attention

- [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:97): the document says this body-fingerprint heuristic is "the current `cache-telemetry` extension" behavior, but [proxy/extensions/cache-telemetry.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/cache-telemetry.mjs:47) does not do any session bucketing today. That historical/context claim should be corrected so the directive does not rely on a nonexistent precedent.

- [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:203): the fallback-key test allows "constant or hash-of-headers." A constant fallback would collapse every unkeyed request into one synthetic session and can create artificial collisions. Even if this stays Phase 0-only, unknown-session requests should be excluded from collision analysis or tracked in a separate `"session_key_source":"fallback"` cohort rather than merged into the main metric.

- [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:213): the outcome list does not include the proxy-generated `502 upstream_error` path from [proxy/server.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/server.mjs:64). If those failures are omitted from the denominator, Phase 0 can undercount exactly the class of concurrent-request failures it is trying to detect.

- [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:138): "`latency_ms is what queueing would add to the SECOND request in any pair`" is too strong. Observed end-to-end latency includes upstream service time, not just waiting time, so it is at best an upper bound unless the report explicitly estimates overlap windows or derives queue-only delay from request arrival/completion ordering.

## Recommendations

- Add an explicit terminal-event seam to the Phase 0 scope. The cleanest directive-level fix is to include a small `proxy/server.mjs` / `proxy/pipeline.mjs` change that emits one normalized completion callback with terminal reason, status, and abort/error metadata for both streaming and non-streaming responses.

- Replace the current go/no-go threshold with a bounded rule. At minimum: require a minimum number of collision requests, report absolute counts alongside rates, and gate Phase 1 on a confidence interval or another explicit significance test rather than a bare 2x ratio.

- Tighten the privacy design. Prefer an HMAC or per-install secret over a bare hash if the record has to remain joinable; otherwise store only ephemeral in-memory keys and publish aggregate counts without any stable content-derived identifier.

- Define a first-class `"unknown_session"` path. Requests that cannot be keyed reliably should not participate in the collision-vs-baseline comparison.

## Bottom Line

Reviving the work as "measure first, decide second" is the right product decision, and preserving the deferred draft separately is also right. I cannot approve this directive yet because the current spec does not actually have a coherent way to observe the terminal outcomes it claims to measure, the Phase 1 decision rule is too weak to support a real go/no-go call, and the persisted prompt-derived hash is not a defensible privacy contract in its current form. Revise those three pieces and this becomes approvable for directive stage.
