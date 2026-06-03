# Review: auto-1m-guard implementation — Codex review

Date: 2026-06-03
Reviewed: PR #186 implementation (`proxy/extensions/auto-1m-guard.mjs`, `proxy/extensions/cache-telemetry.mjs`, `test/proxy-auto-1m-guard.test.mjs`, `README.md`) at `d233e99`
Label applied: reviewed-by-codex-agent, approved-by-codex-agent

## What Is Correct

- The extension behavior matches the directive contract. `modeFromEnv()` exposes `off` / `warn` / `strip` with `warn` as the default, `order: 520` lands cleanly between `ttl-management` and `thinking-block-sanitize`, header lookup is case-insensitive, token matching is exact-token, and strip mode removes all duplicate `context-1m-2025-08-07` occurrences while rejoining with canonical `, ` and preserving the single-token empty-string case (`proxy/extensions/auto-1m-guard.mjs:35-38`, `proxy/extensions/auto-1m-guard.mjs:45-78`, `proxy/extensions/auto-1m-guard.mjs:87-115`).
- The telemetry handoff matches the approved shape. `ctx.meta._auto1mGuard` is a flat `auto_1m_*` object, and `cache-telemetry` spreads `...(ctx.meta._auto1mGuard || {})` top-level into the per-session JSON alongside the existing `_sessionHealth` / `_thinkingSanitize` pattern (`proxy/extensions/auto-1m-guard.mjs:104-108`, `proxy/extensions/cache-telemetry.mjs:232-245`).
- The directive test matrix is covered and the promised pure helpers are exported and unit-tested individually. `findBetaHeader`, `parseBetaTokens`, `planSanitizeBetaHeader`, and `joinBetaTokens` all have direct tests, and the integration cases cover off/warn/strip, absent header, absent token, single-element strip, whitespace-tolerant detection, exact-token no-false-positive, duplicate-token stripping, and original-key rewrite for mixed-case header names (`test/proxy-auto-1m-guard.test.mjs:33-190`).
- The edge-case assumptions are consistent with the proxy runtime. `findBetaHeader(null)` is safe, array-valued headers are accepted and strip mode writes back a string, and the absence of a `body.anthropic_beta` fallback matches the directive's explicit header-only scope rather than a contract miss. `ctx.meta` is assumed present, which matches the server's request-context construction and neighboring extensions' onRequest usage (`proxy/server.mjs:26-45`, `proxy/pipeline.mjs:64-77`).
- README coverage is accurate and restrained. It describes the three modes, the CC-side kill switch, and why the proxy watches `anthropic-beta` instead of `req.body.model`, without claiming tier auto-detection or future 2M handling (`README.md:234-242`).

## Blockers

None.

## What Needs Attention

- There is no dedicated end-to-end assertion that a request-side `_auto1mGuard` stash survives through the shared `meta` object and lands in the per-session JSON file. The implementation is a direct extension of an already-used spread pattern and I do not consider this blocking, but one pipeline-style test would harden the telemetry handoff now owned by `cache-telemetry` (`test/proxy-auto-1m-guard.test.mjs:113-190`, `proxy/extensions/cache-telemetry.mjs:239-243`).

## Bloat / Non-Functional

- The file is 37 LOC over the directive's nominal `<=80` budget, but almost all of that overage is the explanatory header comment. The executable logic itself stays small, single-purpose, and free of unnecessary abstraction. I do not see safe simplifications that would materially improve the implementation.

## Size Baseline

- `proxy/extensions/auto-1m-guard.mjs` — 117 LOC — compact logic; most overage is comment header, not control-flow sprawl.
- `test/proxy-auto-1m-guard.test.mjs` — 191 LOC — within budget; clear split between helper unit tests and onRequest integration cases.
- `proxy/extensions/cache-telemetry.mjs` — 267 LOC total, +5 touched here — additive spread only, low-complexity delta.
- `README.md` — 842 LOC total, +10 touched here — concise operator-facing addition.

## Recommendations

- Merge from Codex's side.
- If this surface is touched again, add one pipeline test that exercises `auto-1m-guard` plus `cache-telemetry` together so the request-mutation path and session-JSON handoff are pinned in one place.

## Bottom Line

Approve. The load-bearing request mutation behavior matches the directive, the telemetry contract matches the approved handoff shape, the order placement is clean, and the full suite passed at `950/950`. The remaining gate is the separate Chris human review required by repo policy for billing-relevant outbound wire changes.
