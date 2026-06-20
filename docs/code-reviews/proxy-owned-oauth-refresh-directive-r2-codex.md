APPROVE

# Review: proxy-owned OAuth refresh directive r2

Date: 2026-06-20
Reviewed: PR #236 (`docs/directives/proxy-owned-oauth-refresh.md`) at `28ae720`
Round: 2
Label applied: `reviewed-by-codex-agent`

This is a LOAD-BEARING directive review. This Codex verdict does not satisfy the required human review; #236 still needs @cnighswonger's review before merge regardless of this approval.

Blocker resolved. The directive now locks the stale-window safety rule in §2a: `CACHE_FIX_OAUTH_POST_TIMEOUT_MS` defaults to 8000 ms, strictly below the client's 10000 ms stale threshold, and the whole lock-held critical section must complete before that stale window expires (`docs/directives/proxy-owned-oauth-refresh.md:67`, `docs/directives/proxy-owned-oauth-refresh.md:71`). Timeout handling is now conservative and distinct: UNKNOWN outcome, no credential write, no retry this cycle, `oauth_refresh_timeout` rather than `oauth_refresh_error`, and back-off for at least one stale window (`docs/directives/proxy-owned-oauth-refresh.md:72`, `docs/directives/proxy-owned-oauth-refresh.md:86`). The ordering argument is also explicit: the proxy aborts at 8 s before the client stale-breaks at 10 s, so a slow proxy refresh fails by not re-POSTing rather than by re-POSTing concurrently (`docs/directives/proxy-owned-oauth-refresh.md:73`). This closes the r1 blocker at the directive level.

Threat-model attention item resolved. The Non-Functional Requirements now state that existing `SENSITIVE_HEADERS` redaction only covers header maps and not request/response bodies, error objects, or event payloads; the refresher's POST body and token-endpoint response body must never reach generic `debugLog`/stderr/JSONL writers (`docs/directives/proxy-owned-oauth-refresh.md:48`, `docs/directives/proxy-owned-oauth-refresh.md:50`). The directive requires token-free refresher-owned records containing only `{ event, outcome, status_code, expires_at }`, and makes "never log the raw response body" an explicit implementation-review checkpoint (`docs/directives/proxy-owned-oauth-refresh.md:50`).

Dependency nit resolved. §2 now states that the implementation adds `proper-lockfile` as a runtime dependency and acquires the client lock through that library rather than hand-rolling `mkdir`, preserving on-disk protocol compatibility with the client (`docs/directives/proxy-owned-oauth-refresh.md:64`, `docs/directives/proxy-owned-oauth-refresh.md:65`). The implementation surface also names the `package.json` dependency addition directly (`docs/directives/proxy-owned-oauth-refresh.md:99`). The repo spot-check confirms the claim that today's runtime dependencies contain only `hpagent` (`package.json:32`).

No new contradictions found. The new timeout path is internally consistent with proactive timing, atomic persistence, and failure handling: proactive timing makes contention rare (`docs/directives/proxy-owned-oauth-refresh.md:77`, `docs/directives/proxy-owned-oauth-refresh.md:79`), successful persistence remains atomic and lock-held (`docs/directives/proxy-owned-oauth-refresh.md:81`, `docs/directives/proxy-owned-oauth-refresh.md:82`), and `oauth_family_revoked`, `oauth_refresh_timeout`, and `oauth_refresh_error` are now three distinct, non-overlapping cases (`docs/directives/proxy-owned-oauth-refresh.md:84`, `docs/directives/proxy-owned-oauth-refresh.md:88`). The implementation surface requires a §2a deadline test proving delayed endpoint timeout, no credential write, and back-off (`docs/directives/proxy-owned-oauth-refresh.md:100`). Public-repo hygiene scan found no origin IP, hostname, SSH target, absolute operator path, pasted token, or pasted client_id in the amended directive.

Residual risk: the 8 s vs 10 s margin is acceptable for a directive, but thin enough that implementation review should verify the timeout is enforced with real abort semantics and that the non-POST work while the lock is held stays sub-second in ordinary conditions. A delayed POST plus >2 s of event-loop scheduling or disk/fsync delay could still age the lock past the client stale threshold, so the 2 s margin must be treated as a hard engineering budget, not commentary.

Bottom line: approve the directive for automated r2. The r1 blocker and follow-up items are folded, but because this is LOAD-BEARING credential handling, merge still requires @cnighswonger's human review.
