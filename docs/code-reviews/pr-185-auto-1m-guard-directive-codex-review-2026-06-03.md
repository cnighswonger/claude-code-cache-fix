# Review: auto-1m-guard directive

Date: 2026-06-03
Reviewed: PR #185 directive (`docs/directives/proxy-auto-1m-guard.md`) at `0f65e38`
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- The binary-walk-based scope correction is right. I spot-checked the installed `claude.exe` and confirmed `kJ("long_context","context-1m-2025-08-07")`, `xKH()` reading `CLAUDE_CODE_DISABLE_1M_CONTEXT`, `W2(H)` testing `/\[1m\]/i`, `sL(H)` stripping `/\[(1|2)m\]/gi`, the non-streaming fallback call site `beta.messages.create({...J,model:sL(J.model)}`, and the main request builder returning `{ model:sL(A.model), ... }`. That supports the directive's claim that `[1m]` is internal-only and the observable wire signal is the `anthropic-beta` token `context-1m-2025-08-07` (`docs/directives/proxy-auto-1m-guard.md:7-59`).
- The revised scope follows correctly from that evidence: header-based detect/warn/strip is the right surface; `req.body.model` detection is not. The exact-token, comma-split, trim-check rule is the right matching shape for the currently hard-coded beta string, and the out-of-scope cuts for Pro-tier auto-detection, SessionStart-hook behavior, `[2m]`, and block mode are justified for this PR (`docs/directives/proxy-auto-1m-guard.md:61-65,79-88,109-116,160-162`).
- `warn` as the default is a reasonable directive-stage choice. It adds observability without mutating traffic, while `strip` remains explicit opt-in for the billing-relevant intervention path (`docs/directives/proxy-auto-1m-guard.md:71-77,160-161`).
- The NFR section covers the five required topics and classifies the change correctly as load-bearing, which matches the repo rule for wire-contract and billing-relevant behavior (`docs/directives/proxy-auto-1m-guard.md:150-156`, `CLAUDE.md:86-94`).
- The test matrix covers the critical behavior axes: all three modes, exact-token matching, absent-header no-op, single-element strip, and whitespace-tolerant detection (`docs/directives/proxy-auto-1m-guard.md:126-142`).

## Blockers

None.

## What Needs Attention

- Clarify the strip-mode rewrite contract. The implementation notes say "split / trim / rejoin with `,`" and the test plan pins comma-join behavior, which normalizes separator whitespace, while the threat model says to preserve surrounding whitespace if it is wire-significant. Either explicitly bless whitespace normalization as acceptable for this header, or specify a whitespace-preserving removal rule so the implementation and NFR are not pulling in different directions (`docs/directives/proxy-auto-1m-guard.md:83-88,139-153`).
- Make the `ctx.meta._auto1mGuard` handoff shape explicit. The directive promises a nested session JSON object named `_auto1mGuard`, but the current writer pattern is selective object spreading, not generic `ctx.meta` serialization, so the implementation needs a precise contract for whether `ctx.meta._auto1mGuard` is itself `{ _auto1mGuard: ... }` or whether cache-telemetry will wrap it (`docs/directives/proxy-auto-1m-guard.md:74-77,92-101,121`, `proxy/extensions/cache-telemetry.mjs:220-240`).

## Bloat / Non-Functional

None. The directive stays narrow, keeps the intervention on the wire-visible surface only, and does not overbuild tier-classification or SessionStart-side machinery into this PR.

## Size Baseline

- `docs/directives/proxy-auto-1m-guard.md` — 171 LOC — compact for a load-bearing directive; most of the size is justified binary evidence and test coverage.
- `proxy/extensions/cache-telemetry.mjs` — 262 LOC — existing persistence baseline the directive intends to hook into for session JSON annotations.
- `proxy/extensions/upstream-change-detection.mjs` — 533 LOC — existing request-header parsing baseline; relevant because it already documents the proxy's `anthropic-beta` access pattern.

## Recommendations

- Approve the directive and apply `plan-approved`.
- During implementation, mirror the existing case-insensitive / whitespace-tolerant `anthropic-beta` extraction pattern already used in `upstream-change-detection` so the header reader is robust without inventing a new abstraction (`proxy/extensions/upstream-change-detection.mjs:195-207`).
- Add one defensive test for repeated `context-1m-2025-08-07` tokens in the header so strip semantics are pinned if upstream or an intermediary ever duplicates the beta token.

## Bottom Line

Approve. The binary evidence supports the core scope correction away from `req.body.model` and toward the `anthropic-beta` header, the NFR/load-bearing classification is correct, and the remaining open points are implementation clarifications rather than directive-stage blockers.

— Codex review
