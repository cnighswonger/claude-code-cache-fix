# Directive: Port 5m-tier detection to proxy `ttl-management`

**Issue:** #97
**Branch:** `feature/proxy-ttl-tier-detection`
**Stage:** directive

## Goal

Make `proxy/extensions/ttl-management.mjs` adapt its injected TTL marker when the request payload itself shows the conversation has already moved to the 5m tier. Mirrors the in-payload detection that `preload.mjs` performs at lines 1815–1828, which proxy users currently lose.

## Why

When a user saturates their Q5h quota, Anthropic's serving layer downgrades cache writes from the 1h tier to the 5m tier. The Claude Code client reflects this by emitting `cache_control.ttl: "5m"` markers in subsequent requests. Today the proxy's `ttl-management` ignores those markers and unconditionally injects `1h` (modulo `CACHE_FIX_TTL_*` env overrides), producing a heterogeneous payload where some blocks request 5m and others request 1h. Per Anthropic's documented processing order (`tools → system → messages`), 1h-after-5m is rejected — the request fails or the cache misses.

`preload.mjs` solves this with a simple rule: if any block in the *incoming* payload already carries `ttl: "5m"`, all injected markers must use 5m too. Users on the preload do not see this bug; users on proxy mode (everyone post-CC-2.1.113) do.

## Design rationale: why in-payload detection (not quota-header subscription)

Issue #97's body suggests subscribing to `cache-telemetry`'s quota signal — i.e., reading response headers (`anthropic-ratelimit-unified-5h-utilization ≥ 1.0`) and switching tier on cross-request state. That is a *more powerful* signal but a *more complex* one, and it is not what preload does.

The in-payload approach is sufficient because the CC client itself adapts on Q5h saturation: once the server has downgraded any single response, the client begins emitting `ttl: "5m"` markers in subsequent requests. The proxy needs only to respect what the client is asking for. This is the mechanism that has worked in production for preload users since v1.9.0.

A quota-header-driven approach would help only in the narrow window where:
1. The server has downgraded.
2. The CC client has not yet adapted (still emitting unmarked `cache_control` blocks).
3. The proxy has seen at least one response carrying the saturation header.

That window is small and uncertain; reproducing the failure would require contradicting preload's success record. **Defer quota-signal augmentation to a v2 PR if real-world telemetry shows v1 leaves a gap.** This directive ships v1 only.

## Adaptation from preload behavior

Two functional changes vs the existing proxy extension:

1. **Detect** — at the top of `onRequest`, scan `body.system` and every `block` inside `body.messages[*].content` for any `cache_control.ttl === "5m"`. Set a per-request flag. (Module-scope state is not appropriate here because each request must be evaluated independently — a 5m signal in one request must not leak into the next.)

2. **Inject** — when computing `ttlParam`, the rule becomes:

   ```js
   const ttlParam =
     ttlValue === "5m" || detectedTier === "5m"
       ? "5m"
       : "1h";
   ```

   matching `preload.mjs:2457`.

The `CACHE_FIX_TTL_MAIN` / `CACHE_FIX_TTL_SUBAGENT` env vars retain their existing semantics (`"1h"`, `"5m"`, `"none"`). Auto-detection only *upgrades* an effective `1h` to `5m` — never the reverse — and never overrides an explicit `"none"`.

## Extension contract

Existing file: `proxy/extensions/ttl-management.mjs`. No new files in `proxy/extensions/`.

- Add a `detectExistingTier(body)` helper, exported alongside the default object so it can be unit-tested.
  - Returns `"5m"` if any block in `body.system` (when array) or `body.messages[*].content[*]` carries `cache_control?.ttl === "5m"`. Returns `"1h"` otherwise.
  - Pure function, no I/O, no module state.
- Modify `onRequest` to call `detectExistingTier(body)` once and feed it into the `ttlParam` decision.
- Keep `injectTtl(block, ttlParam)`, `detectRequestType(system)`, and the `CACHE_FIX_TTL_*` env-var reads as-is.

No changes to `proxy/extensions.json`, `pipeline.mjs`, `server.mjs`, or `cache-telemetry.mjs`.

## Tests (in `test/proxy-ttl-management.test.mjs`)

Add to the existing test file. Mirror the spirit of `test/normalizeSessionStartText.test.mjs` style — small, focused cases.

Unit on `detectExistingTier`:

1. Empty body → `"1h"`.
2. `body.system` is array, no `cache_control` blocks → `"1h"`.
3. `body.system` block with `cache_control: { type: "ephemeral" }` (no `ttl`) → `"1h"`.
4. `body.system` block with `cache_control: { type: "ephemeral", ttl: "1h" }` → `"1h"`.
5. `body.system` block with `cache_control: { type: "ephemeral", ttl: "5m" }` → `"5m"`.
6. `body.system` is `"1h"`-only but a `messages[i].content[j]` block has `ttl: "5m"` → `"5m"`.
7. `body.system` is non-array (string) → `"1h"` (no scan).
8. `body.messages` missing → `"1h"`.

Integration on `onRequest` (drives the full extension):

9. Mixed payload with one `5m` marker in messages → all unmarked `ephemeral` blocks (system + messages) get `ttl: "5m"`, none get `1h`.
10. Pure-1h payload (no existing 5m markers) under default env → all unmarked `ephemeral` blocks get `ttl: "1h"`.
11. `CACHE_FIX_TTL_MAIN=5m` env override + no existing 5m markers → all blocks get `5m` (env wins, same as today).
12. `CACHE_FIX_TTL_MAIN=none` env override + existing 5m marker → no injection (env "none" suppresses, including over auto-detection).
13. Subagent path (system contains `AGENT_SDK_PREFIX`): `CACHE_FIX_TTL_SUBAGENT=1h` + existing 5m marker → all blocks get `5m` (auto-detection upgrades the subagent path too).
14. Existing markers that already carry `ttl: "5m"` are not overwritten (the `!block.cache_control.ttl` guard in `injectTtl` already enforces this; assert it explicitly).
15. Auto-detection does not downgrade: env `CACHE_FIX_TTL_MAIN=1h` + payload with existing 5m markers → blocks injected as 5m. (Restated from #9 to lock in the "upgrade-only" rule.)

## Out of scope

- Quota-header subscription / cross-request state. Defer to a v2 PR if v1 leaves a real gap.
- Reading `~/.claude/quota-status.json`. Same.
- Bootstrapping tier from disk on proxy startup. Same.
- README changes. The existing TTL section already covers `CACHE_FIX_TTL_*`; no user-visible config knob is added by this directive.

## Acceptance

- All new tests pass; full proxy test suite green.
- `proxy/extensions/ttl-management.mjs` contains an exported `detectExistingTier` and the `onRequest` body-injection respects it.
- Manual verification: a payload with one `cache_control: { type: "ephemeral", ttl: "5m" }` marker injected upstream of the extension causes every unmarked `ephemeral` block downstream to also receive `ttl: "5m"`.
- Codex review with no blocking findings.

— Proxy Builder
