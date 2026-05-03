# Directive: Port 5m-tier detection to proxy `ttl-management`

**Issue:** #97
**Branch:** `feature/proxy-ttl-tier-detection`
**Stage:** directive (revised twice after Codex review — see `docs/code-reviews/pr-100-ttl-tier-detection-directive-review-2026-05-03.md` and `docs/code-reviews/pr-100-ttl-tier-detection-directive-rereview-2026-05-03.md`)

## Goal

Make the proxy adapt its injected TTL marker when the request payload itself shows the conversation has already moved to the 5m tier. Mirrors the in-payload detection that `preload.mjs` performs at lines 1815–1828, which proxy users currently lose.

## Why

When a user saturates their Q5h quota, Anthropic's serving layer downgrades cache writes from the 1h tier to the 5m tier. The Claude Code client reflects this by emitting `cache_control.ttl: "5m"` markers in subsequent requests. Today the proxy's `ttl-management` ignores those markers and unconditionally injects `1h` (modulo `CACHE_FIX_TTL_*` env overrides), producing a heterogeneous payload where some blocks request 5m and others request 1h. Per Anthropic's documented processing order (`tools → system → messages`), 1h-after-5m is rejected — the request fails or the cache misses.

`preload.mjs` solves this with a simple rule: if any block in the *incoming* payload already carries `ttl: "5m"`, all injected markers must use 5m too. Users on the preload do not see this bug; users on proxy mode (everyone post-CC-2.1.113) do.

## Pipeline-order constraint (revised after Codex review × 2)

The first draft proposed inline detection inside `ttl-management.onRequest`. Codex flagged that `cache-control-normalize` (order 400) runs first and strips user-message markers (`proxy/extensions/cache-control-normalize.mjs:34–45`).

The second draft moved detection to a new extension at order **350** and claimed "no upstream extension has touched `cache_control` by then." That claim was wrong: `fresh-session-sort` (order **250**) destructures and discards `cache_control` from relocatable user blocks (`proxy/extensions/fresh-session-sort.mjs:140` and `:164`) when remediating split/scattered blocks. A `ttl: "5m"` marker on, say, a relocated `<deferred-tools>` or `<skills>` block is gone by order 350.

This third revision moves detection to order **75** — before *every* extension that mutates `cache_control` or replaces user-message blocks. The audit below enumerates every existing extension and proves order 75 is safe.

### Audit: extensions that touch `cache_control` or rebuild user-message blocks

| Extension | Order | Touches `cache_control`? | Pre/post 75 | Notes |
|-----------|-------|--------------------------|-------------|-------|
| `upstream-change-detection` | 50 | reads only (counts/positions for stats) | pre-75 | observability hook; no `ctx.body.*` writes verified by grep |
| `output-efficiency-rewrite` | 90 | no | post-75 | rewrites `body.system` text only |
| `fingerprint-strip` | 100 | no | post-75 | rewrites `cc_version` in billing header system block |
| `image-strip` | 150 | no | post-75 | strips/resizes images inside tool_result content; doesn't touch top-level cache_control |
| `sort-stabilization` | 200 | no | post-75 | sorts skills/tools blocks; preserves block identity |
| `fresh-session-sort` | 250 | **strips** on relocatable blocks | post-75 | `:140`, `:164` — destructures `cache_control` and discards |
| `tool-input-normalize` | 280 | no | post-75 | normalizes tool_use input field shapes |
| `identity-normalization` | 300 | no | post-75 | strips session_knowledge, normalizes SessionStart text |
| `smoosh-split` | 320 | no | post-75 | splits smooshed reminder blocks; doesn't touch cache_control |
| `microcompact-stability` | 350 | no | post-75 | content-based, no cache_control touch |
| `content-strip` | 350 | no | post-75 | strips content blocks (not cache_control) |
| `deferred-tools-restore` | 350 | no | post-75 | restores deferred-tools blocks; doesn't touch cache_control |
| `cache-control-normalize` | 400 | **strips** all user-message cache_control | post-75 | `:34–45` |
| `messages-cache-breakpoint` | 410 | injects breakpoint #3 (5m default) | post-75 | adds new marker but doesn't read existing tier |
| `ttl-management` | 500 | injects ttl on existing ephemeral markers | post-75 | this directive's consumer |
| `cache-telemetry` | 600 | no | post-75 | response-side observability |
| `overage-warning` | 610 | no | post-75 | response-side advisory |
| `usage-log` | 650 | no | post-75 | response-side log |
| `prefix-diff` | 680 | reads only (stripped in snapshot copy) | post-75 | snapshot-and-diff observability; live ctx.body untouched |
| `request-log` | 700 | no | post-75 | timing log |

Order **75** sits between `upstream-change-detection` (50, read-only) and `output-efficiency-rewrite` (90). Any future extension added between 50 and 75 must explicitly preserve `cache_control` if it mutates user-message blocks; the directive's regression coverage (test #18 below) provides a guardrail.

Three other repair directions were considered:

1. **Detect at order 75 (separate early extension)** — this directive adopts.
2. **Preserve `ttl` through normalize** — invasive; changes normalize's contract; doesn't help with `fresh-session-sort` strip.
3. **Reorder existing extensions** — breaks tested semantics where each later stage relies on prior ones.

## Design

Two extensions, single responsibility each:

### New: `proxy/extensions/ttl-tier-detect.mjs`

- `name`: `"ttl-tier-detect"`
- `description`: `"Detect existing TTL tier from incoming payload before cache_control normalization"`
- `enabled`: `true` (module default)
- `order`: `75` — sits between `upstream-change-detection` (50, read-only observability) and `output-efficiency-rewrite` (90). Pre-mutation by every extension that touches `cache_control` (per audit table above).
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
"ttl-tier-detect": { "enabled": true, "order": 75 },
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

### Pipeline-level integration: `test/proxy-ttl-tier-pipeline.test.mjs` (new file)

These tests lock in the rewire by exercising the **real extension order** via `loadExtensions(extensionsDir, extensionsConfig)` against the real `proxy/extensions/` directory and `proxy/extensions.json`, then `runOnRequest(ctx, snapshot)` once. Assertions are on **observable output state**, not on which extension "ran first" (the order is a property of `extensions.json`, not something a downstream test should re-derive).

18. **Cache-control-normalize regression case.** Construct `ctx.body` whose only `ttl: "5m"` marker is on a user-message block that `cache-control-normalize` (order 400) will strip. After the full pipeline runs, assert:
    - `ctx.meta._ttlTier === "5m"` (detection captured the signal pre-strip).
    - The canonical marker that `cache-control-normalize` re-applied at the last block of the last user message now carries `cache_control: { type: "ephemeral", ttl: "5m" }` (not `1h`).
    - Every system-block `ephemeral` marker also carries `ttl: "5m"`.
    - The original user-message block where the `5m` marker lived no longer carries `cache_control` (proving normalize did run).

19. **Fresh-session-sort regression case (relocatable block carrying `ttl: "5m"`).** Construct `ctx.body` whose only `ttl: "5m"` marker is on a relocatable user block (e.g. a `<skills>` block on a non-first user message that `fresh-session-sort` will strip and relocate, per `proxy/extensions/fresh-session-sort.mjs:140`/`:164`). After the full pipeline runs, assert:
    - `ctx.meta._ttlTier === "5m"` (detection captured the signal before fresh-session-sort discarded it).
    - The canonical `cache-control-normalize` marker carries `ttl: "5m"`.
    - The relocated block exists at the canonical position (proving fresh-session-sort did run and dropped the original `cache_control`).

20. **Negative case: pure-1h payload.** No `5m` markers anywhere. After the pipeline runs, assert `ctx.meta._ttlTier === "1h"` and every injected `ephemeral` marker carries `ttl: "1h"`.

21. **Env override precedence.** Set `CACHE_FIX_TTL_MAIN=none`. Build a payload that would otherwise produce `_ttlTier === "5m"`. After the pipeline runs, assert `ctx.meta._ttlTier === "5m"` (detection still fires) **and** no `ttl` field has been injected on any ephemeral marker (env "none" suppresses injection). Locks in env-override precedence under the real pipeline.

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
- Pipeline-level integration tests (#18–#21) verify the rewire works end-to-end against the real extension order, including the `fresh-session-sort` relocatable-block path.
- Codex re-review with no blocking findings.

— Proxy Builder
