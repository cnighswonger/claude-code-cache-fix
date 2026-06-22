# Review: proxy-owned OAuth refresh implementation r2

Date: 2026-06-22
Reviewed: PR #237 at `a53ace5f7a1e4a3c3d17922ac4b5d1a43d952b4c`
Round: 2
Label applied: `approved-by-codex-agent`

## Verdict

APPROVE from Codex r2. The r1 blockers and attention item are folded correctly, the GitGuardian-triggering fixture strings have been replaced with non-token-shaped fixtures, and I found no new blocking findings in the fold.

This is a LOAD-BEARING implementation touching credential refresh and local token persistence. Human review by Chris is still required before merge regardless of this automated approval.

## r1 Blockers

1. PASS — client-compatible lock path.

   `lockOpts()` now passes `lockfilePath: join(dirname(credPath()), ".oauth_refresh.lock")` while retaining `realpath: false` and `stale: 10_000`, so `properLockfile.lock(path, lockOpts())` locks the client's directive-mandated `.oauth_refresh.lock`, not the library default `.credentials.json.lock` (`proxy/oauth/refresher.mjs:46`, `proxy/oauth/refresher.mjs:48`, `proxy/oauth/refresher.mjs:49`, `proxy/oauth/refresher.mjs:50`, `proxy/oauth/refresher.mjs:247`).

   The r2 test holds the client-style lock with `properLockfile.lock(credPath, { lockfilePath: lockPath, realpath: false, stale: 10_000, retries: 0 })`, then asserts the proxy does not POST, emits `oauth_lock_contended`, and never creates `${credPath}.lock` (`test/oauth-refresher.test.mjs:343`, `test/oauth-refresher.test.mjs:349`, `test/oauth-refresher.test.mjs:355`, `test/oauth-refresher.test.mjs:361`, `test/oauth-refresher.test.mjs:363`, `test/oauth-refresher.test.mjs:368`).

2. PASS — body-read deadline.

   `postRefresh()` now keeps the same `AbortController` signal live through `res.text()` and clears the timeout only after the body resolves or after fetch/body abort handling. Both fetch-time and body-read `AbortError` return `{ kind: "timeout" }`, which `runOnce()` classifies as `oauth_refresh_timeout` with UNKNOWN outcome, no credential write, and stale-window backoff (`proxy/oauth/refresher.mjs:179`, `proxy/oauth/refresher.mjs:180`, `proxy/oauth/refresher.mjs:187`, `proxy/oauth/refresher.mjs:197`, `proxy/oauth/refresher.mjs:199`, `proxy/oauth/refresher.mjs:200`, `proxy/oauth/refresher.mjs:203`, `proxy/oauth/refresher.mjs:290`, `proxy/oauth/refresher.mjs:293`, `proxy/oauth/refresher.mjs:294`).

   The new headers-before-body test writes 200 headers plus a partial body, stalls the remainder for 2 seconds against the 500 ms test deadline, and asserts the tick returns near the deadline, the credential file is unchanged, and the event is `oauth_refresh_timeout` rather than `oauth_refresh_error` (`test/oauth-refresher.test.mjs:287`, `test/oauth-refresher.test.mjs:290`, `test/oauth-refresher.test.mjs:292`, `test/oauth-refresher.test.mjs:294`, `test/oauth-refresher.test.mjs:298`, `test/oauth-refresher.test.mjs:305`, `test/oauth-refresher.test.mjs:308`, `test/oauth-refresher.test.mjs:311`, `test/oauth-refresher.test.mjs:312`).

3. PASS — in-lock race-recovery test.

   The test seam is isolated to the internal module's `__*ForTests` exports and is not used by the runtime import path, where `proxy/server.mjs` imports only `startOAuthRefresher` and `stopOAuthRefresher` (`proxy/oauth/refresher.mjs:257`, `proxy/oauth/refresher.mjs:384`, `proxy/oauth/refresher.mjs:392`, `proxy/server.mjs:8`). The hook fires after lock acquisition and before the in-lock credential re-read, exactly where the r1 gap was (`proxy/oauth/refresher.mjs:247`, `proxy/oauth/refresher.mjs:257`, `proxy/oauth/refresher.mjs:272`).

   The two new tests mutate the credential between reads and prove both skip paths: changed access token emits `oauth_refresh_skipped` with `reason=already_rotated`, while unchanged access token plus fresh expiry emits `reason=no_longer_due`. Both assert no POST (`test/oauth-refresher.test.mjs:395`, `test/oauth-refresher.test.mjs:411`, `test/oauth-refresher.test.mjs:419`, `test/oauth-refresher.test.mjs:421`, `test/oauth-refresher.test.mjs:422`, `test/oauth-refresher.test.mjs:425`, `test/oauth-refresher.test.mjs:437`, `test/oauth-refresher.test.mjs:446`, `test/oauth-refresher.test.mjs:447`, `test/oauth-refresher.test.mjs:449`, `test/oauth-refresher.test.mjs:450`).

## r1 Attention Item

PASS — `err.message` is removed from the fail-open event payload. The last-resort catch now emits only `err_class: "unhandled"` plus bounded `err_code`, and the adjacent comment documents why message strings are intentionally excluded (`proxy/oauth/refresher.mjs:353`, `proxy/oauth/refresher.mjs:355`, `proxy/oauth/refresher.mjs:359`).

## GitGuardian Fixture Strings

PASS — the token-shaped fixture values were replaced with `FIXTURE-`-prefixed low-entropy strings (`test/oauth-refresher.test.mjs:39`, `test/oauth-refresher.test.mjs:43`). The only `sk-ant-oat01` / `sk-ant-ort01` occurrences I found are explanatory comment text describing the avoided token shapes, not fixture values (`test/oauth-refresher.test.mjs:39`).

## New Findings

None.

Public-repo hygiene scan found no new operator home paths, internal hostnames, or private project names in the changed implementation/test files. The loopback `127.0.0.1` values are test/default bind addresses, and existing repo metadata remains unchanged.

## Verification

- `node --test test/oauth-refresher.test.mjs` — PASS, 17/17.
- `node --test test/*.test.mjs` — PASS, 1213/1213.

## Bottom Line

Ship after the required human review. Codex r2 approves the automated side of #237, but this load-bearing credential-handling PR still requires Chris's review before merge.
