# Review: proxy-owned OAuth refresh implementation

Date: 2026-06-22
PR: #237
Reviewed head: edf054b23166b172ec2169ca306a8e074f0c68bf
Directive: docs/directives/proxy-owned-oauth-refresh.md
Verdict: REQUEST_CHANGES

This is a LOAD-BEARING implementation. It writes the shared OAuth credential and handles the rotating refresh token. This automated review does not satisfy the directive's required human review; Chris's review is still required before merge regardless of this verdict.

## Critical Findings

1. **The proxy is not taking the client's `.oauth_refresh.lock`.**

   The directive requires the proxy to acquire the same `~/.claude/.oauth_refresh.lock` that Claude Code uses, with `proper-lockfile`, `realpath:false`, and `stale:10000` (docs/directives/proxy-owned-oauth-refresh.md:64). The implementation calls `properLockfile.lock(path, LOCK_OPTS)` where `path` is the credential file path (proxy/oauth/refresher.mjs:209, proxy/oauth/refresher.mjs:221). With `proper-lockfile`, that locks `${file}.lock`, so this code locks `.credentials.json.lock`, not `.oauth_refresh.lock`.

   That breaks the load-bearing exclusion guarantee: a client waking during the proxy's refresh will not see the proxy's lock, so both can still POST the same refresh token. Fix by deriving the lock path as `join(dirname(credPath), ".oauth_refresh.lock")` and passing it through `lockfilePath` while keeping the locked file/canonical path usage compatible with `proper-lockfile` and `realpath:false`. Add a test that proves the on-disk lock path is `.oauth_refresh.lock` and that a held client lock causes `oauth_lock_contended`.

2. **The hard deadline does not cover the response body, so the lock can still outlive the client's 10 s stale window.**

   The directive says the refresh POST must never outlive the client's stale window and the whole locked critical section must complete under that threshold (docs/directives/proxy-owned-oauth-refresh.md:67, docs/directives/proxy-owned-oauth-refresh.md:71). The implementation starts an `AbortController` timer before `fetch()`, but clears it immediately after `fetch()` resolves headers (proxy/oauth/refresher.mjs:159, proxy/oauth/refresher.mjs:163, proxy/oauth/refresher.mjs:174). It then awaits `res.text()` with no deadline (proxy/oauth/refresher.mjs:176).

   A token endpoint can send headers before 8 s and stall the body past 10 s. In that case the proxy still holds the lock, the client can stale-break, the credential file is still old, and the client can become the second refresher. The current tests cover a server that delays headers + body together (test/oauth-refresher.test.mjs:218, test/oauth-refresher.test.mjs:255), but not a headers-before-body stall. Keep the abort signal active until the body is consumed, classify body-read abort as `oauth_refresh_timeout`, and add the missing late-body test with no write + timeout event + backoff.

3. **The in-lock idempotent skip path is not actually tested.**

   The directive requires the proxy to re-read inside the lock and bail if the access token changed or the credential is no longer within margin (docs/directives/proxy-owned-oauth-refresh.md:77). The code has the right branches (proxy/oauth/refresher.mjs:242, proxy/oauth/refresher.mjs:245, proxy/oauth/refresher.mjs:250), but the test named for this path only performs a successful refresh, then a second tick that no-ops before acquiring the lock because the token is not due (test/oauth-refresher.test.mjs:300, test/oauth-refresher.test.mjs:333, test/oauth-refresher.test.mjs:338). It never asserts `oauth_refresh_skipped`, never changes the file between the pre-lock read and in-lock re-read, and never proves the POST is skipped while inside the lock.

   This is a required race-recovery proof for the implementation PR. Add a seam or controlled lock-contention setup that mutates the credential between those reads, then assert no POST and `oauth_refresh_skipped` with `already_rotated` or `no_longer_due`.

## Attention Items

- `emitOAuthEvent` only checks top-level forbidden keys (proxy/oauth/events.mjs:34). Current call sites use flat scalar fields, so this is acceptable for this PR, but keep that invariant explicit if future event payloads grow nested objects.
- The fail-open catch emits a truncated exception message to the OAuth event log (proxy/oauth/refresher.mjs:323, proxy/oauth/refresher.mjs:325). The normal token-endpoint failure paths avoid response bodies and request payloads, so I did not make this blocking, but the safest follow-up is to remove `message` entirely from the token-handling subsystem or emit only an internal error class.

## Audit Checklist

**A. §2a hard refresh deadline: FAIL.** `AbortController` is present and timeout/backoff handling exists (proxy/oauth/refresher.mjs:159, proxy/oauth/refresher.mjs:260), and the test asserts no write, `oauth_refresh_timeout`, and `backoff_ms >= 10000` for a delayed response (test/oauth-refresher.test.mjs:219, test/oauth-refresher.test.mjs:234, test/oauth-refresher.test.mjs:239, test/oauth-refresher.test.mjs:244). However, the timer is cleared before `res.text()` (proxy/oauth/refresher.mjs:174, proxy/oauth/refresher.mjs:176), so a headers-before-body stall can still violate the stale-window ordering.

**B. No token material in logs/events/stderr: PASS with attention.** The POST payload is only passed to `fetch()` (proxy/oauth/refresher.mjs:153, proxy/oauth/refresher.mjs:163), parsed response body is only used for persistence (proxy/oauth/refresher.mjs:288), revoked stderr banner has no token material (proxy/oauth/refresher.mjs:273, proxy/oauth/refresher.mjs:275), and the suite checks success + revoke event logs for synthetic token substrings (test/oauth-refresher.test.mjs:361, test/oauth-refresher.test.mjs:383). See attention item on the generic catch message.

**C. Atomic persistence + permissions: PASS.** Temp file is in the same directory, written mode `0600`, fsynced, renamed, and the parent directory is fsynced (proxy/oauth/refresher.mjs:124, proxy/oauth/refresher.mjs:127, proxy/oauth/refresher.mjs:129, proxy/oauth/refresher.mjs:131, proxy/oauth/refresher.mjs:133). Success preserves other credential fields through object spread (proxy/oauth/refresher.mjs:300, proxy/oauth/refresher.mjs:303), and tests verify mode-preserving rotation and no temp stragglers (test/oauth-refresher.test.mjs:160, test/oauth-refresher.test.mjs:186, test/oauth-refresher.test.mjs:204).

**D. Lock compatibility with client: FAIL.** Runtime dependency placement is correct (package.json:32), options include `realpath:false` and `stale:10000` (proxy/oauth/refresher.mjs:42), and release is under `finally` (proxy/oauth/refresher.mjs:320). The locked path is wrong because the code locks the credential path (proxy/oauth/refresher.mjs:221), not `.oauth_refresh.lock`.

**E. In-lock idempotent re-read: FAIL on test proof.** The implementation has the access-token and no-longer-due skip branches (proxy/oauth/refresher.mjs:242, proxy/oauth/refresher.mjs:245, proxy/oauth/refresher.mjs:250), but the test does not exercise a between-read rotation and does not assert `oauth_refresh_skipped` (test/oauth-refresher.test.mjs:300).

**F. Failure event taxonomy: PASS.** Distinct events are emitted for refreshed, family revoked, timeout, generic refresh error, credential failures, lock contention, and skipped refresh (proxy/oauth/refresher.mjs:82, proxy/oauth/refresher.mjs:86, proxy/oauth/refresher.mjs:95, proxy/oauth/refresher.mjs:224, proxy/oauth/refresher.mjs:247, proxy/oauth/refresher.mjs:264, proxy/oauth/refresher.mjs:273, proxy/oauth/refresher.mjs:284, proxy/oauth/refresher.mjs:315). Family revoke backs off for 1 h (proxy/oauth/refresher.mjs:272). 5xx/network errors are single-shot per tick (proxy/oauth/refresher.mjs:283).

**G. Default-OFF gating + lifecycle: PASS.** Gate is strict equality to `"on"` (proxy/config.mjs:41), start is wrapped after `server.listen()` (proxy/server.mjs:434, proxy/server.mjs:437, proxy/server.mjs:441), stop happens before `server.close()` (proxy/server.mjs:451, proxy/server.mjs:453, proxy/server.mjs:457), and interval timers are unref'd (proxy/oauth/refresher.mjs:336, proxy/oauth/refresher.mjs:337).

**H. Anti-bloat / size: PASS.** The implementation is larger than the directive estimate, but the extra code is doing real work: validation, lock lifecycle, timeout taxonomy, atomic persistence, and threat-model event hygiene. I do not see a safe fold of the seven outcomes without losing useful semantics.

**I. Public-repo information hygiene: PASS.** I found no internal hostnames or project names in the implementation/test files. The literal `127.0.0.1` usages are loopback test/default bind values (proxy/config.mjs:20, test/oauth-refresher.test.mjs:73). The `9d1c250a-e61b-44d9-88ed-5944d1962f5e` client id is publicly visible in Claude Code OAuth authorize flows; for example, public issue `anthropics/claude-code#39445` quotes it as the `client_id` in the OAuth URL, so this does not appear to be a baked secret.

**J. Tests cover load-bearing path: FAIL until blockers are fixed.** The focused suite passes locally: `node --test test/oauth-refresher.test.mjs` reports 13 pass / 0 fail. The full suite passes locally: `node --test test/*.test.mjs` reports 1209 pass / 0 fail. Coverage still misses the wrong-lock-path proof and the headers-before-body timeout hole.

## Shared Label Recommendations

- Keep `needs-sim-validation` until the corrected lock path and body-deadline behavior are verified against live Claude Code traffic.
- Do not move to `ready-for-merge` until this receives human review, per the load-bearing directive.

## Bottom Line

Request changes. The implementation has the right shape and most of the security/persistence/lifecycle details are solid, but the current code does not yet close the actual fleet race because it locks the wrong on-disk path and the hard deadline can be bypassed by a stalled response body. Fix those, add the missing tests, and this should be close to approval.

— Codex review
