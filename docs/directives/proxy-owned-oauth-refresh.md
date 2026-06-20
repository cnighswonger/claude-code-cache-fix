# Directive: proxy-owned OAuth refresh (prevent refresh-token rotation races)

**Public issue:** [#234](https://github.com/cnighswonger/claude-code-cache-fix/issues/234) — proxy-owned OAuth refresh to prevent refresh-token rotation races across concurrent clients
**Internal driver:** a fleet-wide 401 incident on a multi-agent host, 2026-06-20 (postmortem + root-cause correction in internal deployment notes)
**Branch:** `feature/proxy-owned-oauth-refresh`
**Stage:** directive — round 2 (automated r1 REQUEST_CHANGES folded; awaiting r2 + human review)
**Status:** **LOAD-BEARING** — the proxy will write the shared OAuth credential every client depends on, and it handles the refresh token. Requires **human review** before merge, in addition to Lead + automated review. Implementation lands in a SEPARATE PR after this contract is approved; that PR also returns to human review.

## Revision history
- **r1 → r2:** folded the automated r1 REQUEST_CHANGES.
  - **Blocker — the stale-window failure mode wasn't contracted.** The corrected root cause IS the client's 10 s `proper-lockfile` stale-break, but the contract only assumed a "~1 s" proxy refresh and never required a deadline below 10 s, never defined behavior if the proxy's POST hangs near/after the stale window. Fixed: new **§2a hard refresh deadline** — `CACHE_FIX_OAUTH_POST_TIMEOUT_MS` default 8000 ms (below the 10 000 ms stale threshold); on timeout the outcome is treated as UNKNOWN → no credential write, no retry, distinct `oauth_refresh_timeout` event, back off ≥ one stale window. Ordering guarantee added: the proxy aborts at 8 s before the client stale-breaks at 10 s, so a slow proxy refresh loses by *not re-POSTing*, never by POSTing concurrently. §5 and the test plan updated to match.
  - **Threat-model tightening (attention):** the existing `SENSITIVE_HEADERS` redaction only covers header maps, not request/response bodies — and the refresher's POST body and token-endpoint response both carry raw token material. Made explicit that those must never reach the generic log/event writers; the refresher builds its own token-free records.
  - **Dependency nit:** stated directly that the implementation adds `proper-lockfile` as a runtime dep (today only `hpagent`) and acquires the client lock through that library, so the on-disk protocol is guaranteed-compatible rather than hand-rolled.

## Goal

Make the cache-fix proxy the **single, proactive, lock-cooperative refresher** of the one OAuth credential shared by all concurrent Claude Code clients running as the same OS user. This eliminates the refresh-token rotation race that revokes the whole token family and 401s the entire fleet at once — a failure no client-side restart can recover (only an interactive `/login`).

This directive locks the client-side contract. It ships no code.

## Background — the actual failure (corrected root cause)

When N Claude Code clients run as one OS user they share one `~/.claude/.credentials.json`: one OAuth access token + one **rotating** refresh token. Anthropic's refresh tokens rotate on use — each refresh returns a new access token *and* a new refresh token, invalidating the prior one; reusing a consumed refresh token is treated as theft and **revokes the entire token family**.

A prior postmortem concluded the installed client (2.1.148) had **no** refresh-coordination lock. That was drawn from grepping `cli.js`, which does not exist in this install — the client ships a compiled native binary. Inspecting the actual binary (`strings`, read-only) shows:

- The client **does** have a cross-process lock: `lockfilePath = join(<dir>, ".oauth_refresh.lock")`, where `<dir>` resolves to the **shared** config dir (`CLAUDE_SECURESTORAGE_CONFIG_DIR ?? ~/.claude`), with `stale: 10000` ms.
- So the lock is a `~/.claude/.oauth_refresh.lock`, shared across the fleet — but it has a **hole**: a 10-second staleness break. If one client's refresh runs longer than 10 s (slow overnight API latency), a second client's stale-check passes, it proceeds **without** the lock, and both POST the same refresh token to the token endpoint → family revoked.
- The lock serializes the **disk write**, but the stale-break opens a window where two clients reach the **token endpoint** with the same refresh token. That is the revocation trigger.
- The installed binary does **not** contain the kill-on-401 forced-exit (`CLAUDE_CODE_AUTH_FAIL_EXIT_MS`) that a later client version added. So this version is lock-yes / kill-on-401-no.

Verified token-endpoint facts (from the binary, for the refresher's own request):
- `POST https://platform.claude.com/v1/oauth/token`
- body `{ grant_type: "refresh_token", refresh_token, client_id, scope }`
- the client_id is the client's public OAuth client id (extracted from the binary; the implementation reads it from config/binary, does not hard-code a guessed value).

**Why now, after ~a year:** a 24/7 keepalive ("warmer") removed the overnight idleness that used to keep the fleet from doing concurrent unattended refreshes. The warmer didn't cause the bug; it removed the conditions that hid it. The forced ~8h refresh now lands unattended, where the race fires.

## Achievability constraint (read before reviewing scope)

We **cannot** make 2.1.148 stop reading/refreshing `.credentials.json` — the client owns its auth loop; a proxy change can't disable it. The "clients stop touching the file" framing in #234 is aspirational for a future client that supports external-token injection.

What IS achievable and fully closes the race on 2.1.148: the proxy as a **proactive, lock-cooperative single-refresher**. The binary shows the client, before refreshing, re-reads the credential **inside its lock** and short-circuits if the token already changed (`accessToken !== <captured> → "race recovered"`) or isn't yet expired (`!expired → bail`). So if the proxy keeps the shared token fresh **and** holds the client's own `.oauth_refresh.lock` during its ~1 s refresh, a waking client finds a fresh token and short-circuits without POSTing. Net result: exactly one party ever reaches the token endpoint → no double-spend → no family revocation. Same outcome as "clients stop," via the client's existing race-recovery path.

## Non-Functional Requirements

- **Size/complexity budget:** ~120 LOC implementation (refresher module + lifecycle wiring + config knobs + events) + ~130 LOC tests (mock token endpoint, atomic-persist + lock-compat assertions). Flag if it drifts materially past 2×.
- **Threat model (mandatory — new on-disk credential surface):**
  - **What the refresher reads/writes:** `~/.claude/.credentials.json` — the live access token + the rotating refresh token (the crown jewel). It also POSTs the refresh token to the token endpoint.
  - **What must NEVER leak:** the refresh token and access token must never be logged, never appear in the proxy debug log, never be written anywhere but the credential file. The existing `SENSITIVE_HEADERS` redaction (`proxy/server.mjs:26-32`) only covers **header maps** — it does NOT cover request/response *bodies*, error objects, or event payloads. The refresher's POST request body and the token-endpoint response body both contain raw token material, so the implementation must NEVER pass them through the generic `debugLog`/stderr/JSONL writers. Concretely: the refresher constructs its own log/event records carrying only `{ event, outcome, status_code, expires_at }` — never the token strings, never the raw response body. The token-endpoint response is parsed for the rotated fields and the parsed object is written ONLY to the credential file; the raw response string is never logged. This is an explicit implementation-review checkpoint, not just a redaction-list extension.
  - **On-disk surface:** the credential file is mode `0600`, owned by the running uid. The refresher validates (not-a-symlink, mode, owner) on every read before trusting it — same discipline the warmer file-secret uses (`proxy/warmer/admin.mjs` 0600 + symlink/owner checks). It writes atomically (temp-write + fsync + rename + fsync-parent, the warmer registry pattern at `proxy/warmer/registry.mjs`) so a crash mid-write can never strand a half-written token family.
  - **Trust boundary:** the token endpoint host is fixed (`platform.claude.com`), overridable only by an explicit operator env var for tests. No untrusted input reaches the endpoint URL or the credential path.
  - **Default-off:** the whole subsystem is gated `CACHE_FIX_OAUTH_REFRESH === "on"`, default OFF. Inert until an operator deliberately enables it and restarts the proxy. A bug cannot affect anyone who hasn't opted in.
- **Maintainability:** one new self-contained subsystem (`proxy/oauth/`), structurally mirroring `proxy/warmer/` (background tick loop, events log, lifecycle start/stop). No new HTTP/lock abstraction beyond reusing the same libraries already present. No retry/backoff subsystem (single-shot per tick).
- **Performance/reliability:** one credential read per ~5-min tick; a token POST only when within the refresh margin (a few times per day). A publish/refresh failure must never corrupt the credential file or crash the proxy — fail-open to stderr + event, leave the existing token in place.
- **Load-bearing? YES.** Writes the shared credential the whole fleet authenticates with; handles the refresh token. Human review required before merge for both this directive and the implementation PR.

## The locked contract

### 1. Credential source & validation
- Path: `CACHE_FIX_OAUTH_CRED_PATH || join(homedir(), ".claude", ".credentials.json")`.
- On every read, validate before trusting: reject if symlink; require mode `0600`; require owner == running uid; require JSON-valid with `claudeAiOauth.{accessToken, refreshToken, expiresAt}` present. On any failure → emit `oauth_cred_unreadable` / `oauth_cred_symlink_rejected` / `oauth_cred_mode_warning` and skip the tick (never POST on an untrusted file).

### 2. Lock compatibility (the load-bearing correctness point)
- The refresher acquires the **same** `~/.claude/.oauth_refresh.lock` the client uses, via the **same `proper-lockfile` mkdir-based protocol** (atomic `mkdir` of the lock path + mtime touch; the client uses `proper-lockfile`'s `lock()` with `realpath:false`). Holding it mutually-excludes the proxy and any waking client. The implementation **adds `proper-lockfile` as a runtime dependency** and acquires the lock through that library (not a hand-rolled mkdir), so the on-disk protocol is byte-for-byte the one the client honors — the only way to guarantee mutual exclusion across the client/proxy boundary. (Today the proxy's only runtime dep is `hpagent`; this adds one.)

#### 2a. Hard refresh deadline — the stale-window safety rule (load-bearing)
This is the failure mode the whole directive exists to eliminate, so it is contracted explicitly, not assumed: **the proxy's own token-endpoint POST is the thing that must never outlive the client's 10 s stale window.** If the proxy holds the lock but its refresh hangs past ~10 s, `proper-lockfile` lets a waking client stale-break and POST the same refresh token — the proxy becomes the very second-refresher this fix prevents.

Contract:
- The refresh POST has a **hard deadline of `CACHE_FIX_OAUTH_POST_TIMEOUT_MS`, default 8000 ms** — strictly below the client's 10 000 ms stale threshold, with margin for the lock acquire + disk write inside the same held-lock window. The whole locked critical section (acquire → re-read → POST → persist → release) must complete under the stale threshold; the implementation must keep the non-POST steps fast (sub-second) so the POST owns essentially the whole budget.
- If the POST exceeds the deadline (abort/timeout), the outcome is **UNKNOWN** — the server may or may not have already rotated the token. Treat unknown like a possible double-spend in the making: do **not** retry the POST this cycle, do **not** write anything to the credential file (a write on an unknown outcome could clobber a rotation that did land), release the lock, emit a distinct `oauth_refresh_timeout` event (NOT `oauth_refresh_error`), and **back off for at least one full stale window** before any next attempt so a racing client's own refresh can settle first. The existing on-disk token is left untouched.
- Because the proxy aborts at 8 s but the client stale-breaks at 10 s, the ordering guarantees that if the proxy ever loses the timing race, it loses by *not POSTing again*, not by POSTing concurrently.

- **Belt-and-suspenders, not sole guarantee:** the proactive timing margin (§3) means the proxy refreshes well before the client would, so contention is rare even before the lock. The lock makes a simultaneous wake safe; 2a makes a *slow* proxy refresh safe. If, at implementation time, exact `proper-lockfile` protocol compatibility cannot be guaranteed (library version drift), the fallback is: (a) widen the proactive margin so the proxy always wins the race by timing, (b) keep the in-process serialize, (c) keep the 2a hard deadline regardless, and (d) document the residual (a client waking in the narrow refresh window could still double-spend) — but the primary contract is real lock compatibility plus the 2a deadline.

### 3. Refresh timing (proactive)
- Refresh when `expiresAt - now <= REFRESH_MARGIN_MS`, default margin large enough that the proxy always refreshes well before the client's own forced-refresh (default ≈ 25% of the ~8 h token life ≈ 2 h; `CACHE_FIX_OAUTH_REFRESH_MARGIN_MS` overridable). Tick interval `CACHE_FIX_OAUTH_TICK_MS`, default 300000 (5 min).
- Inside the lock, re-read the credential; if already refreshed by someone else (token changed, or no longer within margin) → release and no-op (idempotent).

### 4. Atomic persistence
- On success, write the rotated `{accessToken, refreshToken, expiresAt, ...}` back, **preserving** the file's other fields (`scopes`, `subscriptionType`, `rateLimitTier`, `trustedDeviceToken`). Atomic: temp-write + fsync + rename + fsync-parent (`proxy/warmer/registry.mjs` pattern). Mode `0600`. Then release the lock.

### 5. Failure handling & the loud signal
- Token endpoint `401` / `invalid_grant` (family revoked — proxy cannot self-heal): emit a **distinct, loud** `oauth_family_revoked` event (separate from routine expiry), set a back-off so the proxy does not hammer the dead token, and surface an operator-visible signal. The proxy leaves the (dead) credential file untouched — recovery requires human `/login`. This event must be impossible to confuse with ordinary `oauth_refreshed`.
- POST exceeds the §2a hard deadline (unknown outcome): handled per §2a — `oauth_refresh_timeout`, no write, back off ≥ one stale window. Distinct from `oauth_refresh_error` because the outcome is genuinely unknown (the token may have rotated server-side), so the response is more conservative.
- 5xx / network error (clean failure, definitely no rotation): single-shot, no retry this tick; leave the existing token in place; emit `oauth_refresh_error`; try again next tick (still within margin).
- All failures fail-open: never crash the proxy, never corrupt the file.

### 6. Lifecycle, gating, backout
- Gated `CACHE_FIX_OAUTH_REFRESH === "on"`, **default OFF**. Started after the warmer monitor in `startProxy()`, stopped before `server.close()` (the warmer-monitor start/stop wiring is the template). try/catch around start — a refresher failure must never prevent the proxy from serving.
- **Backout:** set the gate off + restart → proxy reverts to pure auth pass-through; clients self-manage exactly as today (they always read the file, so the fallback is automatic — no migration to undo).

## Implementation surface (for the SEPARATE implementation PR)
- `proxy/oauth/refresher.mjs` (NEW) — the tick loop + lock + refresh + atomic persist (warmer heartbeat-monitor template).
- `proxy/oauth/events.mjs` (NEW, or reuse the warmer events log) — `oauth_refreshed`, `oauth_family_revoked`, `oauth_cred_*`, `oauth_lock_contended`, `oauth_refresh_error`.
- `proxy/server.mjs` — start/stop wiring, gated; extend redaction discipline to the new paths.
- `proxy/config.mjs` — `CACHE_FIX_OAUTH_*` knobs (the `envInt` + getter pattern at `proxy/config.mjs:4-12`): `CACHE_FIX_OAUTH_REFRESH` (on/off, default off), `CACHE_FIX_OAUTH_CRED_PATH`, `CACHE_FIX_OAUTH_TOKEN_URL`, `CACHE_FIX_OAUTH_REFRESH_MARGIN_MS`, `CACHE_FIX_OAUTH_TICK_MS`, `CACHE_FIX_OAUTH_POST_TIMEOUT_MS` (default 8000, the §2a deadline).
- `package.json` — add `proper-lockfile` runtime dependency (§2).
- `test/oauth-refresher.test.mjs` (NEW) — mock token endpoint via `http.createServer` + `CACHE_FIX_OAUTH_TOKEN_URL`, test seams (`__runTickForTests`), atomic-persist + lock-compat + revoked-family assertions, **plus a §2a deadline test: a mock endpoint that delays past `POST_TIMEOUT_MS` must produce `oauth_refresh_timeout`, NO credential write, and a back-off — proving a slow proxy refresh cannot become the second refresher.**

## Out of scope
- **Bearer injection at the outbound request** (overriding `authorization` in `forwardRequest`). It's defense-in-depth but does NOT stop the client's independent refresh loop, so it doesn't close the race on its own. Defer; revisit when a client supports external-token injection (which would also let clients truly stop touching the file).
- **Server-side anything** — the fix is entirely client-side (the proxy is the "client" of the token endpoint here).
- **Client upgrade as mitigation** — deferred by decision: a later client adds the lock-fix but also the kill-on-401 forced-exit that interacts badly with a 24/7 warmer fleet. Treat any upgrade as a separate, tested change, not a substitute for this structural fix.
- **Multi-host / multi-user credential coordination** — single OS user on one host is the scope.

## Open items resolved in this directive
- **proper-lockfile compatibility** — resolved: use the same `proper-lockfile` mkdir-protocol the client uses; documented fallback (timing margin + in-process serialize + residual note) if version drift prevents guaranteed compatibility.
- **Does the client re-read `expiresAt` from disk or cache it?** — the binary shows it re-reads the credential inside its lock and short-circuits on a fresh token; the lock makes the proxy safe regardless, so this is a confidence point, not a blocker.

## Process
Directive PR (this) → Lead + automated review + **human review** (load-bearing). Implementation in a SEPARATE PR after the contract is approved; that PR also returns to human review. The public #234 is closed by the implementation, not this directive.

— Proxy Builder
