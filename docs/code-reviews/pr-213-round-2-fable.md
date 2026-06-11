Verdict: APPROVE_WITH_NITS

# PR #213 — image-retry circuit breaker directive — round 2 (Fable)

Focused re-review of the round-2 directive push at `e584817`, verifying the round-1 REQUEST_CHANGES findings (4 blockers, 6 attention items) against the directive text and current `main` (`pipeline.mjs`, `server.mjs`, `stream.mjs`, `rate-limit-log.mjs`, `cache-telemetry.mjs`, `usage-log.mjs`, `bootstrap-defense.mjs`, `extensions.json`).

## Round 1 → Round 2 status

| # | Finding | Status | Note |
|---|---------|--------|------|
| B1 | Hook surface (`onRequestStart`/`onResponseEnd` don't exist) | **ADDRESSED** | Directive now names the real four-hook surface and uses `onRequest` returning `{skip, status, headers, body, stream}` + `onResponse` for recording, matching the bootstrap-defense precedent (`bootstrap-defense.mjs:176-182`, skip handled in `server.mjs:88-94`); the recording branch is correctly pinned to the non-streaming path (`server.mjs:162-187`) and mid-stream SSE `error` events are now explicitly out of scope with the `rate-limit-log` non-streaming-envelope rationale. The `ctx.meta._imageRetryHashes` stash closes the round-1 plumbing gap (attention #6) — the same `meta` object does flow request→response in `preForward`/`handleMessages`. |
| B2 | Phantom `proxy/lib/anthropic-error-classes.mjs` | **ADDRESSED** | Predicate is inlined with full contract (400 + `type:"error"` + `error.type:"invalid_request_error"` + message regex), structurally matching the `isRateLimitResponse` precedent (`rate-limit-log.mjs:68-74`); no `proxy/lib/` introduced; `image-hash.mjs` lands flat in `proxy/` per existing convention. Regex breadth (`image (could not be processed\|format\|content)`) is acceptable given the four-condition conjunction and the sim-validation predicate check (item 4). |
| B3 | SSE / `stream: true` ignored | **ADDRESSED** | Two-mode synthesis specified; the SSE sequence is complete and ordered correctly (`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`), carries `usage` on `message_start`/`message_delta` (the two events `stream.mjs:15-30` telemetry extraction reads), echoes `model`, and sets `stop_reason: "end_turn"`. `server.mjs` skip-handler change is declared in Files-modified, and `needs-sim-validation` is a merge gate with the harness-consumes-synth check as item 1. See N1/N2 below for two minor wire-fidelity nits. |
| B4 | False `usage: 0` meter-pipeline claim | **ADDRESSED** | Claim retracted with the correct mechanism stated: skip path returns `{handled: true}` before any upstream call, so no `onResponseStart`/`onStreamEvent`/`onResponse` fires; both consumers are `onStreamEvent`-driven (verified: `usage-log.mjs:273-319`, `cache-telemetry.mjs:190-272`); no `usage.jsonl` row; JSONL event log named as sole observability surface; `usage: 0` kept as harness-facing wire shape only. |
| A1 | Order-370 rationale inconsistent | **ADDRESSED** | Rationale corrected to "hash the wire form" after `image-strip` (150); `microcompact-stability` named correctly. One residual inaccuracy: the *closest* pre-existing extension by order is `thinking-display` at 360, not `microcompact-stability` at 350 (`extensions.json`). Immaterial to the placement logic — 370 is still correct — but fix the sentence. |
| A2 | Multi-image any-hash false positive | **ADDRESSED** | Explicitly accepted with the 30s-TTL mitigation argued (per-image attribution genuinely isn't inferable from the error envelope), and the replaced-bad-image + shared-good-image case has both-sides test coverage (short-circuits within window, forwards after). |
| A3 | `sid` fallback ambiguity | **ADDRESSED** | `resolveSessionId` from `cache-telemetry.mjs:64-72` reused (verified — exact lines, three header names); sessionless bucket `"unknown"` matches the `sessionFilename` convention. Correctly calls it on `ctx.headers` directly rather than relying on `ctx.meta._sessionId`, which cache-telemetry (order 600) hasn't populated yet at order 370. |
| A4 | State-map eviction unspecified | **ADDRESSED** | LRU at `CACHE_FIX_IMAGE_RETRY_MAX_ENTRIES` (4096) + lazy expiry on lookup + 60s throttled sweep per the `sweepStaleSessions` precedent (`cache-telemetry.mjs:132-156`). Note the `${sessionId}:${requestSignature}` keying makes the onRequest intersection check a scan rather than a keyed lookup — fine at 4096 entries, just don't let the cap grow without an index. |
| A5 | LOC budget not credible | **ADDRESSED** | Restated as ~500 total (150 ext + 100 helpers + 250 tests) including the SSE path. 250 LOC for four unit suites + seven integration cases is tight; treat as a soft target — the budget is now honest, which was the point. |
| A6 | JSONL PII / rotation / env-var naming | **ADDRESSED** | PII allowlist pinned (hashes, session id, timestamps, remaining-TTL, request_id; never bytes/bodies/auth headers); 5 MB single-tier rotation per `bootstrap-defense.rotateIfNeeded`; `CACHE_FIX_IMAGE_RETRY_COOLOFF_MS` properly declared as an env-var tunable. |
| A7 | Test plan gaps (round-1 item 7) | **ADDRESSED** | All five gaps closed: `stream:true` replay fixture, `stream:false` JSON case, replaced-bad-image case, sessionless case, predicate negative cases (`overloaded_error`, 429), and sim validation as a merge gate. |

## New issues (net-new sweep)

None blocking. Three nits and one spec gap:

**N1 — `data: [DONE]` trailer fidelity.** The synthesized SSE sequence ends with `data: [DONE]`. The proxy's own stream handler tolerates it pass-through (`stream.mjs:40-44`), but Anthropic's documented Messages stream terminates at `message_stop` — whether real upstream emits a `[DONE]` sentinel is exactly the kind of wire detail that decides whether the harness SDK consumes the synth cleanly or chokes on a non-JSON data line. The safest synthesis byte-mimics real upstream. Make sim-validation item 1 explicitly compare against a captured real stream tail and drop `[DONE]` if upstream doesn't send it.

**N2 — the `server.mjs` change may be unnecessary.** The existing skip handler already does `clientRes.end(typeof body === "string" ? body : JSON.stringify(body))` with caller-supplied headers (`server.mjs:88-94`). If the breaker returns the SSE payload as a *string* body with `content-type: text/event-stream` in `headers`, the current code writes it verbatim — no re-stringify, no new branch, and the `stream` field on the skip-result envelope becomes dead weight. Recommend dropping the `server.mjs` modification and the `stream` field entirely: same behavior, zero core-file churn, smaller LOC. If a reason emerges to keep the explicit branch (e.g., future chunked SSE writes), fine — but then the directive should say why the existing string path doesn't suffice.

**N3 — cool-off window semantics unspecified.** The directive doesn't say whether `lastFailureAt` refreshes on each short-circuited retry (sliding window) or stays fixed from the original failure. With a fixed window, a retry storm spanning >30s leaks one upstream call per window — the replay-fixture assertion "total upstream calls = 1, not 19" only holds if all 18 retries land within 30s of the first failure. Recommend sliding (refresh on each breaker fire, since a fire proves the harness is still looping) and one sentence in the directive either way; add a fixture timing note so the test doesn't silently encode the assumption.

**N4 — minor line-ref drift.** `runOnRequest` is `pipeline.mjs:85-99` (directive says 85-101) and the skip block is `server.mjs:88-94` (directive says 88-95). Cosmetic; no action needed beyond a sweep at implementation time.

## Recommendations

1. Simplify per N2: string-body SSE through the existing skip contract; drop the `stream` field and the `server.mjs` diff unless a concrete need is stated.
2. Pin cool-off semantics (N3) — recommend sliding-on-fire — and reflect it in the replay fixture timing.
3. Add "compare synth tail against captured real upstream stream (incl. presence/absence of `[DONE]`)" to sim-validation item 1 (N1).
4. Fix the closest-extension sentence (A1 nit: `thinking-display` at 360).

## Bottom Line

All four round-1 blockers are correctly and verifiably fixed — the hook surface, predicate, SSE synthesis, and observability claims now all survive contact with the codebase, and the riskiest path (SSE) is backstopped by a mandatory sim-validation gate. The remaining items are refinements, not defects: one likely-unnecessary core-file change, one wire-fidelity detail the sim gate will catch anyway, and one timing-semantics sentence. None warrant a third directive round; all four can be resolved in the implementation PR. Approve with nits; proceed to implementation per the playbook.

— Fable 5 Review Agent
