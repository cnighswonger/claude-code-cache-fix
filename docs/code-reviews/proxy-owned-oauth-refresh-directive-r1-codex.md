REQUEST_CHANGES

# Review: proxy-owned OAuth refresh directive

Date: 2026-06-20
Reviewed: PR #236 (`docs/directives/proxy-owned-oauth-refresh.md`) at `58d9514b8cd7cc13ca3a365d5ca15ebb4720c501`
Round: 1
Label applied: `changes-requested`

This is a LOAD-BEARING directive review. This Codex verdict does not satisfy the required human review; #236 still needs @cnighswonger's review before merge regardless of the automated verdict.

## Findings

### Blockers

1. The directive does not lock the failure mode that matches its own corrected root cause: a refresh held past the client's 10-second stale window. The Background says the real race hole is `proper-lockfile` stale-breaking after `10000` ms, allowing a second client to proceed and POST the same refresh token while the first refresh is still in flight (`docs/directives/proxy-owned-oauth-refresh.md:21-23`). The locked contract then asserts the proxy holds the same client lock only for a "~1 s" refresh and therefore stays "far under" that window (`docs/directives/proxy-owned-oauth-refresh.md:59-61`), but it never requires a token-endpoint deadline below the stale threshold, never specifies what happens if the proxy's POST is still in flight near/after 10 seconds, and never defines unknown-outcome handling after a client-side timeout. Because slow token endpoint latency is the stated trigger for family revocation, the implementation contract needs an explicit safety rule for proxy refreshes that exceed or approach the stale window. Leaving this as an assumption can recreate the same double-spend path with the proxy as the first refresher.

### Attention Items

- The main corrected-root-cause reasoning is internally coherent once the long-refresh blocker is fixed. The directive explains that the installed client has a shared `.oauth_refresh.lock` with `stale: 10000`, re-reads credentials inside the lock, and bails if the token changed or is no longer expired (`docs/directives/proxy-owned-oauth-refresh.md:21-24`, `docs/directives/proxy-owned-oauth-refresh.md:35-37`). A proactive proxy refresher that acquires the same lock before clients enter their refresh window follows from that mechanism: clients that wake after the proxy persists a fresh token should short-circuit instead of POSTing (`docs/directives/proxy-owned-oauth-refresh.md:37`, `docs/directives/proxy-owned-oauth-refresh.md:63-65`).

- The six locked contract points are mostly concrete and implementable. The directive pins credential path/shape/security checks, lock path/protocol, proactive timing, atomic write/preservation semantics, distinct `oauth_family_revoked` handling, and default-off lifecycle/backout (`docs/directives/proxy-owned-oauth-refresh.md:54-77`). The `proper-lockfile` compatibility claim is specific enough to test because it names atomic `mkdir`, mtime touch, `realpath:false`, and the exact lock path (`docs/directives/proxy-owned-oauth-refresh.md:58-61`). The fallback is honestly scoped because it admits the residual race if exact compatibility cannot be guaranteed (`docs/directives/proxy-owned-oauth-refresh.md:61`), though that fallback should not be treated as equivalent to the primary contract.

- The directive's threat model is directionally right for a crown-jewel credential change. It requires 0600, owner, and symlink checks on every read before trust (`docs/directives/proxy-owned-oauth-refresh.md:42-47`, `docs/directives/proxy-owned-oauth-refresh.md:54-56`), atomic temp-write/fsync/rename/fsync-parent persistence while preserving non-token fields (`docs/directives/proxy-owned-oauth-refresh.md:67-68`), token-material-free events/logging (`docs/directives/proxy-owned-oauth-refresh.md:43-45`, `docs/directives/proxy-owned-oauth-refresh.md:70-73`), and default-off gating (`docs/directives/proxy-owned-oauth-refresh.md:47`, `docs/directives/proxy-owned-oauth-refresh.md:75-77`). The existing proxy currently has a gated debug log and redacts sensitive headers (`proxy/server.mjs:9-10`, `proxy/server.mjs:23-40`, `proxy/server.mjs:335-337`), but the new refresher must not pass token-bearing response bodies, request bodies, errors, or event payloads through generic `debugLog`, stderr, or JSONL writers because current redaction only covers header maps.

- The current proxy is pure auth pass-through today. `forwardRequest()` copies incoming request headers except hop-by-hop/proxy headers, then sets `host` and `accept-encoding`; it does not read, replace, or persist `authorization` (`proxy/upstream.mjs:8-39`, `proxy/upstream.mjs:200-219`). The directive correctly treats bearer injection as out of scope because overriding outbound `authorization` would not stop the installed client from running its own credential refresh loop (`docs/directives/proxy-owned-oauth-refresh.md:86-90`).

- The achievability constraint is honest. The directive explicitly says 2.1.148 cannot be made to stop reading/refreshing `.credentials.json`, and reframes #234's "clients stop touching the file" as aspirational for a future external-token-injection client (`docs/directives/proxy-owned-oauth-refresh.md:33-37`). That avoids over-promising a behavior the proxy cannot enforce on this client version.

- The load-bearing classification is correct. The directive says the proxy will write the shared OAuth credential and handle the refresh token, requires human review for this directive and the implementation PR, and ships no code (`docs/directives/proxy-owned-oauth-refresh.md:7`, `docs/directives/proxy-owned-oauth-refresh.md:13`, `docs/directives/proxy-owned-oauth-refresh.md:39-50`, `docs/directives/proxy-owned-oauth-refresh.md:96-97`). The PR file list confirms #236 changes only `docs/directives/proxy-owned-oauth-refresh.md`.

- The size budget is plausible but tight. The directive targets ~120 LOC of implementation plus ~130 LOC of tests and asks reviewers to flag material drift past 2x (`docs/directives/proxy-owned-oauth-refresh.md:41`). Given lock compatibility tests, atomic persistence, credential validation, token-endpoint mocking, and event assertions, the test budget may need to grow, but the 2x guardrail is a reasonable bloat control.

- Public-repo hygiene looks clean in this directive. I found references to public issue #234, `~/.claude` paths, public endpoint hostnames, token field names, and an internal-note pointer, but no origin IP, operator hostname, SSH target, absolute operator home path, pasted token, or pasted client_id material (`docs/directives/proxy-owned-oauth-refresh.md:3-5`, `docs/directives/proxy-owned-oauth-refresh.md:26-31`, `docs/directives/proxy-owned-oauth-refresh.md:43-46`, `docs/directives/proxy-owned-oauth-refresh.md:55-61`).

### Nits

- `package.json` currently has only `hpagent` as a runtime dependency (`package.json:32-34`), while the directive says not to add a new HTTP/lock abstraction and also relies on `proper-lockfile` compatibility (`docs/directives/proxy-owned-oauth-refresh.md:48`, `docs/directives/proxy-owned-oauth-refresh.md:58-61`). If the implementation should add `proper-lockfile` as a dependency, say that directly. If it should implement the protocol without the package, say how compatibility will be verified against the client behavior.

## Bottom Line

Revise before implementation. The directive is otherwise clear, scoped, and honest about the corrected client behavior and the achievability limits, but the load-bearing lock contract must explicitly handle proxy token refreshes that exceed or approach the client's 10-second stale-break window. That edge is the root cause this directive exists to eliminate.
