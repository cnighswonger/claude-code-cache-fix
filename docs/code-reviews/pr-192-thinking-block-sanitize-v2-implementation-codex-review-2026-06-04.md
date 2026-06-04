# Review: thinking-block-sanitize v2 implementation — Codex review

Date: 2026-06-04
Reviewed: PR #192 implementation at `3257e6e` (`proxy/extensions/thinking-block-sanitize.mjs`, `proxy/extensions/signature-surface-hash.mjs`, `proxy/extensions/cache-telemetry.mjs`, `test/proxy-thinking-block-sanitize.test.mjs`)
Label applied: reviewed-by-codex-agent, approved-by-codex-agent

## What Is Correct

- The implementation matches the directive's mode contract. `modeFromEnv()` cleanly gates `off` / `on` / `v2`, keeps unknown values fail-open, and preserves v1 behavior unchanged under `on` while making `v2` a strict superset (`proxy/extensions/thinking-block-sanitize.mjs:186-191,224-299`).
- The v2 predicate and state threading are correct. The extension resolves the session id inline at order `550`, seeds one in-memory baseline per canonical session filename from disk on first encounter, computes the hash via `computeSignatureSurfaceHash({ tools: body.tools })`, no-ops on canonical `"unknown"`, and strips signed `thinking` plus `redacted_thinking` on cross-request mismatch while preserving the active-tool-continuation guard from v1 (`proxy/extensions/thinking-block-sanitize.mjs:117-128,200-209,236-299`).
- The AITL-pinned baseline advance rule is implemented correctly. The baseline is only advanced from `onResponseStart()` on HTTP `2xx`, while `4xx` / `5xx` and non-numeric statuses leave it unchanged (`proxy/extensions/thinking-block-sanitize.mjs:302-327`). I verified this both from the automated tests and with direct runtime probes for the uncovered `ctx.status === undefined` edge.
- The hash helper is disciplined and directive-aligned. It recursively sorts object keys, preserves array order, uses the `"none"` sentinel for absent / empty tools, emits a 16-hex sha256 prefix, and accepts forward-compatible `system` / `anthropic_beta` parameters without using them in v2 (`proxy/extensions/signature-surface-hash.mjs:33-60`).
- The `cache-telemetry` changes are correct and additive. `resolveSessionId()` is exported without a behavioral change, and the writer now spreads `...(ctx.meta._thinkingSanitizeV2 || {})` alongside the existing additive extension payloads (`proxy/extensions/cache-telemetry.mjs:59-72,237-252`). Existing readers continue to use optional field access; I found no consumer that assumes a closed session-file schema.
- The implementation handles the edge cases called out in the review brief: `body.tools === undefined` still hashes to the `"none"` sentinel and participates in baseline comparison; `!ctx.body` / non-array `messages` return before any v2 state work; no-assistant-turn requests stay safe because `latestAssistantIndex()` returns `-1`; undefined headers flow through `resolveSessionId(undefined) -> null -> "unknown"` and correctly no-op the v2 path (`proxy/extensions/thinking-block-sanitize.mjs:104-109,224-248`; `proxy/extensions/cache-telemetry.mjs:64-71`).
- The implementation is not hiding meaningful bloat. Most of the LOC increase is state handoff and failure-mode commentary, not abstraction churn. The runtime logic remains a small helper module plus one extension file with a single in-memory map and one response hook. There is no unnecessary frameworking or duplicate state channel.
- Verification is strong overall. The full suite passes at `978/978`, the targeted v2 tests pass, and I additionally spot-validated the uncovered runtime contracts manually: v2 fields land in `sessions/<sid>.json`, a restart-style re-seed from disk is honored, and the deliberate "two pipelined requests, same new hash" behavior strips both requests before the shared baseline advances.

## Blockers

None

## What Needs Attention

- The directive's test plan is not mirrored one-for-one in automated tests yet. I did not find dedicated tests for the "two pipelined requests with the same new hash" case, the proxy-restart re-seed case, or the v2-specific writer merge into `sessions/<sid>.json`; I manually validated all 3 behaviors during review, so this is not a ship blocker, but they are worth pinning in follow-up coverage.
- The new in-memory `v2SessionState` map has the same process-lifetime growth profile as `session-health`'s existing module-scope state: entries accumulate for every distinct session seen until process restart (`proxy/extensions/thinking-block-sanitize.mjs:193-214`; `proxy/extensions/session-health.mjs:22-29`). The footprint per entry is tiny, so I do not view this as a merge blocker, but the NFR language should be read as "small in practice" rather than "actively pruned."

## Bloat / Non-Functional

None

## Size Baseline

- `proxy/extensions/thinking-block-sanitize.mjs` — 328 LOC — moderate extension file; added state handoff and response-hook logic are proportional to the new contract.
- `proxy/extensions/signature-surface-hash.mjs` — 60 LOC — small focused helper with one canonicalization primitive and one hash export.
- `proxy/extensions/cache-telemetry.mjs` — 276 LOC — tiny additive delta; export plus one new spread input.
- `test/proxy-thinking-block-sanitize.test.mjs` — 658 LOC — large but still readable; most of the growth is concrete scenario coverage rather than fixture indirection.

## Recommendations

- Add explicit automated coverage for the 3 directive-pinned scenarios that I had to verify manually: pipelined same-new-hash, restart re-seed from disk, and v2 session-file merge.
- If long-lived proxy instances start seeing very high session cardinality, consider a shared cleanup policy for module-scope session maps across `thinking-block-sanitize` and `session-health`.

## Bottom Line

Approve. At `3257e6e`, the implementation matches the v2 directive's behavioral contract, preserves v1 semantics, keeps the schema change additive, and passes the full suite at `978/978`. The remaining gaps are in automation completeness for a few directive-plan rows, not in observed runtime correctness. Chris's human load-bearing review remains required before merge.
