# Directive: Port 5m-tier detection to proxy `ttl-management`

**Issue:** #97
**Branch:** `feature/proxy-ttl-tier-detection`
**Stage:** directive (revised after Codex review — see `docs/code-reviews/pr-100-ttl-tier-detection-directive-review-2026-05-03.md`)

## Goal

Make the proxy adapt its injected TTL marker when the request payload itself shows the conversation has already moved to the 5m tier. Mirrors the in-payload detection that `preload.mjs` performs at lines 1815–1828, which proxy users currently lose.

## Why

When a user saturates their Q5h quota, Anthropic's serving layer downgrades cache writes from the 1h tier to the 5m tier. The Claude Code client reflects this by emitting `cache_control.ttl: "5m"` markers in subsequent requests. Today the proxy's `ttl-management` ignores those markers and unconditionally injects `1h` (modulo `CACHE_FIX_TTL_*` env overrides), producing a heterogeneous payload where some blocks request 5m and others request 1h. Per Anthropic's documented processing order (`tools → system → messages`), 1h-after-5m is rejected — the request fails or the cache misses.

`preload.mjs` solves this with a simple rule: if any block in the *incoming* payload already carries `ttl: "5m"`, all injected markers must use 5m too. Users on the preload do not see this bug; users on proxy mode (everyone post-CC-2.1.113) do.

## Pipeline-order constraint (from Codex review)

The first draft of this directive proposed adding `detectExistingTier(body)` directly inside `ttl-management.onRequest`. Codex flagged this as blocking: `cache-control-normalize` runs at order **400** and strips every `cache_control` block from user messages (`proxy/extensions/cache-control-normalize.mjs:34–45`, proven by `test/cacheControlNormalize.test.mjs:30–43`). `ttl-management` runs at order **500** — by then any `ttl: "5m"` marker that lived on a user-message block has already been wiped. The detection would only see `body.system` markers, missing half of what preload inspects.

Three repair directions are possible:

1. **Detect before normalization runs** (separate early extension; this directive adopts).
2. **Preserve `ttl` through normalization** (modify `cache-control-normalize` to retain the field while stripping the placement marker — invasive, changes the normalize contract).
3. **Reorder the two extensions** (move `ttl-management` before `cache-control-normalize` — breaks the existing semantics where ttl-management injects onto canonicalized markers).

Option 1 is the cleanest: detection becomes a small standalone extension whose only job is to read the original payload, with no behavioural coupling to normalize or ttl-management. The other two options conflate concerns or risk regressions in unrelated code paths.

## Design

Two extensions, single responsibility each:

### New: `proxy/extensions/ttl-tier-detect.mjs`

- `name`: `"ttl-tier-detect"`
- `description`: `"Detect existing TTL tier from incoming payload before cache_control normalization"`
- `enabled`: `true` (module default)
- `order`: `350` — sits between `identity-normalization` (300) and `cache-control-normalize` (400). At this point no upstream extension has touched `cache_control`, so the original markers are still present.
- Hook: `onRequest(ctx)` only. Pure detection. Sets `ctx.meta._ttlTier = "5m" | "1h"`. **Does not mutate `ctx.body`.**

Algorithm — port of `preload.mjs:1815–1828`:

```js
function detectExistingTier(body) {
  const blocks = [
    ...(Array.isArray(body?.system) ? body.system : []),
    ...(Array.isArray(body?.messages)
      ? body.messages.flatMap(m => Array.isArray(m?.content) ? m.content : [])
      : []),
  ];
  for (const block of blocks) {
    if (block?.cache_control?.ttl === "5m") return "5m";
  }
  return "1h";
}
```

Exported alongside `default` so unit tests can call it without driving the full extension.

### Modified: `proxy/extensions/ttl-management.mjs`

- Reads `ctx.meta._ttlTier` (default `"1h"` if undefined — graceful degradation when `ttl-tier-detect` is disabled).
- Computes `ttlParam` per `preload.mjs:2457`:

  ```js
  const detectedTier = ctx.meta?._ttlTier || "1h";
  const ttlParam =
    ttlValue === "5m" || detectedTier === "5m" ? "5m" : "1h";
  ```

- `CACHE_FIX_TTL_MAIN` / `CACHE_FIX_TTL_SUBAGENT` semantics unchanged (`"1h"`, `"5m"`, `"none"`).
- Auto-detection only **upgrades** an effective `1h` to `5m`. Never the reverse, never overrides explicit `"none"`.
- No new exports; no signature changes.

### Modified: `proxy/extensions.json`

Add one entry:

```json
"ttl-tier-detect": { "enabled": true, "order": 350 },
```

## Why not put detection in cache-control-normalize?

Tempting (one fewer file), but normalize is already doing two things — strip and canonical-pin — and adding "tier detection" would entangle three concerns in one extension. Keeping detection separate also means it survives untouched if normalize is later modified or disabled by config; the detection contract has zero coupling to normalize's internals. The cost is a single small file in a directory that already has eight extensions.

## Why a per-request flag, not module state

Each request must be evaluated independently — a `ttl: "5m"` signal in one request must not leak into the next. Module-scope state would also misbehave under hot-reload (the existing extension reload pattern would either reset state or carry it stale). `ctx.meta` is request-scoped by construction.

## Tests

### Unit: `test/proxy-ttl-tier-detect.test.mjs` (new file)

On the exported `detectExistingTier(body)`:

1. Empty body → `"1h"`.
2. `body.system` is array, no `cache_control` blocks → `"1h"`.
3. `body.system` block with `cache_control: { type: "ephemeral" }` (no `ttl`) → `"1h"`.
4. `body.system` block with `cache_control: { type: "ephemeral", ttl: "1h" }` → `"1h"`.
5. `body.system` block with `cache_control: { type: "ephemeral", ttl: "5m" }` → `"5m"`.
6. `body.system` is `"1h"`-only but a `messages[i].content[j]` block has `ttl: "5m"` → `"5m"`.
7. `body.system` is non-array (string) → `"1h"` (no scan).
8. `body.messages` missing → `"1h"`.

On the extension `default.onRequest`:

9. Sets `ctx.meta._ttlTier` to detected value.
10. Does not mutate `ctx.body` (deep structural equality before/after).
11. Idempotent: running twice on the same `ctx` yields the same `_ttlTier`.

### Unit (extending `test/proxy-ttl-management.test.mjs` if present, else new)

12. `ctx.meta._ttlTier === "5m"` + default env → all unmarked `ephemeral` blocks (system + messages) get `ttl: "5m"`.
13. `ctx.meta._ttlTier === "1h"` (or undefined) + default env → all unmarked `ephemeral` blocks get `ttl: "1h"`.
14. `CACHE_FIX_TTL_MAIN=5m` env override + `_ttlTier === "1h"` → all blocks get `5m` (env wins, behaviour unchanged from today).
15. `CACHE_FIX_TTL_MAIN=none` env override + `_ttlTier === "5m"` → no injection (env "none" suppresses, including over auto-detection).
16. Subagent path: `CACHE_FIX_TTL_SUBAGENT=1h` + `_ttlTier === "5m"` → blocks get `5m` (auto-detection upgrades subagent path too).
17. Existing markers that already carry `ttl: "5m"` are not overwritten (the `!block.cache_control.ttl` guard in `injectTtl` already enforces this; assert it explicitly).

### Pipeline-level integration: `test/proxy-ttl-tier-pipeline.test.mjs` (new file, addresses Codex's non-blocking note)

This is the test the first directive draft was missing. It locks in the rewire by exercising the **real extension order**, not isolated `onRequest` calls.

18. Load the full pipeline via `loadExtensions(extensionsDir, extensionsConfig)` against the real `proxy/extensions/` directory and `proxy/extensions.json`. Construct a `ctx.body` whose only `ttl: "5m"` marker is on a user-message block that `cache-control-normalize` will strip. Run `runOnRequest(ctx, snapshot)`. Assert:
    - `cache-control-normalize` ran (the original user-message marker was stripped, replaced by canonical `{ type: "ephemeral" }` at the last block of the last user message).
    - `ttl-tier-detect` ran first and set `ctx.meta._ttlTier === "5m"`.
    - `ttl-management` ran after and injected `ttl: "5m"` (not `"1h"`) on the canonical marker.
    - System-block markers also receive `ttl: "5m"`.

19. Same harness, payload with no `5m` markers anywhere → `_ttlTier === "1h"` and all injected blocks use `1h`. (Negative case proving auto-detection didn't trigger.)

20. Same harness, `_ttlTier` would be `5m` but `CACHE_FIX_TTL_MAIN=none` → no injection at all, env wins. (Locks in the env-override precedence under the real pipeline.)

## Out of scope

- Quota-header subscription / cross-request state. Defer to a v2 PR if v1 leaves a real gap.
- Reading `~/.claude/quota-status.json`. Same.
- Bootstrapping tier from disk on proxy startup. Same.
- Modifying `cache-control-normalize` to preserve `ttl`. Rejected per `Pipeline-order constraint` above — the standalone-detection approach has zero coupling.
- README changes. The existing TTL section already covers `CACHE_FIX_TTL_*`; no user-visible config knob is added.

## Acceptance

- All new tests pass; full proxy test suite green.
- `proxy/extensions/ttl-tier-detect.mjs` exists, runs at order 350, sets `ctx.meta._ttlTier`, mutates nothing.
- `proxy/extensions/ttl-management.mjs` reads `ctx.meta._ttlTier` and respects the upgrade-only rule.
- `proxy/extensions.json` registers `ttl-tier-detect`.
- Pipeline-level integration test (#18) verifies the rewire works end-to-end against the real extension order.
- Codex re-review with no blocking findings.

— Proxy Builder
