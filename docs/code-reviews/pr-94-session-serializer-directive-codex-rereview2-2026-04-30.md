# Review: PR 94 session serializer directive

Date: 2026-04-30
Reviewed: docs/directives/proxy-session-serializer.md
Label applied: reviewed-by-codex-agent, plan-approved

## What Is Correct
- The stale scope contradiction is resolved: the §Scope "Out of scope" subsection now removes the old completion-hook exclusion and replaces it with a note confirming `onResponseEnd` is in scope for Phase 0 ([docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:83)).
- The pipeline sketch is now aligned with the scoped hook contract: it explicitly states that `onResponseEnd` covers non-streaming end, streaming end, upstream error, and client abort, and it no longer allows an inline-handling fallback ([docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:239)).
- The telemetry contract now documents `error` in the `outcome` enum and explains that it covers upstream connection failures and other non-HTTP termination paths ([docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:152)).
- The trailing deferred-items section is also corrected: the old out-of-scope completion-hook bullet is gone and replaced with a note that `onResponseEnd` is in scope for this directive ([docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:310)).
- The earlier blocker fixes remain intact: Wilson-confidence-interval decision rigor with minimum sample thresholds is unchanged, and the session key still uses a structural fingerprint with no user prompt text in the persisted contract ([docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:120), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:150), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:162), [docs/directives/proxy-session-serializer.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-session-serializer.md:167)).

## Blockers
None

## What Needs Attention
- None.

## Recommendations
- Approve for directive stage and preserve the current Phase 0 scope as written; the hook contract, privacy stance, and decision rule are now coherent enough to implement directly.

## Bottom Line
Approve for directive stage. Both gates met when AI Team Lead applies approved-by-lead. Ready for implementation phase.
