# Directive: Image-retry circuit breaker

**Issue:** TBD (will be filed alongside this directive, referencing CC#66815)
**Upstream:** [anthropics/claude-code#66815](https://github.com/anthropics/claude-code/issues/66815) — *Repeated "image could not be processed" errors consumed ~60% of usage limit — 19 consecutive failures, each resending full 34MB context*
**Priority:** P1
**Branch:** `feature/image-retry-circuit-breaker`
**Stage:** directive
**Milestone:** v4.2.0

## Goal

When an image-bearing request returns an `image could not be processed`–class permanent error and the harness immediately retries with the same image content (same SHA-256 hash), the proxy short-circuits the retry. It synthesizes a structured error response that returns control to the harness with a clear instruction to drop or replace the image, without forwarding the request upstream. The cool-off is per-image-hash and per-session, with a small TTL so genuinely-fresh attempts (e.g., user re-edits and re-submits) are not blocked.

This bounds the loss from CC#66815's retry storm — 19 retries × 34 MB of context tokens — from "60% of Q5h envelope" to "one upstream call." The harness still surfaces the failure to the user; we just stop letting it pay for the same failure repeatedly.

## Why

Per CC#66815, the harness currently treats "image could not be processed" as a transient error and retries with full conversation context. Each retry is a complete request — full system prompt, full message history, the 34 MB image content. Twenty turns of retry can consume the majority of a Max-plan user's Q5h envelope. The reporter filed under direct Anthropic-support direction (Fin). yurukusa's thread analysis identifies the cost mechanism precisely: every retry rebuilds the cache_creation surface because the failure response doesn't update the cached prefix.

The proxy sees every request and every response. When the response signals a permanent image-processing failure AND the immediately-following request carries the same image content (verifiable by hashing the content block), the proxy has the information it needs to break the loop. This is not a server-side fix; it does not require a CC-binary change; it does not require any user configuration beyond enabling the extension.

The framing is **advisory-protective**, not blocking. The proxy returns an HTTP-200 synthesized response with a structured error block, identical in shape to what the harness expects from upstream, so the harness can render the failure and the user can decide what to do next. The user is not silenced; they are told once and asked to act, instead of being told nineteen times with the bill arriving at the end.

## Non-Functional Requirements

- **Size/complexity budget:** new extension `image-retry-circuit-breaker.mjs` (~150–250 LOC including state machine + content-hash helpers + tests). State is in-memory per-proxy-boot — restart resets the breaker. Document this.
- **Threat model:** content hashing reads request body. The proxy already does this (e.g., `prefix-diff`, `signature-surface-hash`). The breaker state is in-memory and per-session; nothing persists to disk beyond the optional structured log of cool-off events.
- **Activation model:** `enabled: true` in `extensions.json` (always loaded) with an internal env-var gate per the established `prefix-diff` pattern. Default-on after one minor-version validation cycle.
- **Failure mode:** if the breaker misfires (false positive on a legitimately-retryable case), the user can disable the extension with one env-var flip and the proxy falls back to forwarding every request. Log the cool-off events to `~/.claude/image-retry-events.jsonl` so misfires are diagnosable.

## Detection logic

A retry is identified by the conjunction of:

1. The previous response on the same session carried an Anthropic API error whose body matches the "image could not be processed" family (the exact error-class taxonomy lives in `proxy/lib/anthropic-error-classes.mjs`; this extension reuses it rather than introducing its own).
2. The current request carries an image content block whose SHA-256 matches an image content block in the previous request.
3. The current request arrives within `IMAGE_RETRY_COOLOFF_MS` (default 30,000 ms) of the previous failure.
4. The current request is on the same session (`x-claude-code-session-id` header, with fallback to the proxy's `sid` if absent).

All four must hold. Any one of them being false routes the request through to upstream normally.

## Synthesized response shape

When the breaker fires, the proxy returns an HTTP-200 response identical in envelope to a successful Anthropic API call, with the assistant message carrying a single content block of type `text`:

```
{
  "id": "msg_<synthesized>",
  "type": "message",
  "role": "assistant",
  "model": "<echoed-from-request>",
  "content": [
    {
      "type": "text",
      "text": "[cache-fix-proxy] Image content with SHA-256 <first-8-chars-of-hash> failed processing on the previous attempt and is being retried with identical content. To avoid burning additional cache_creation tokens on the same failure, this attempt was short-circuited locally. To proceed, please drop or replace the image and try again. See cache-fix-proxy issue <issue#> and upstream CC#66815 for context. Retry cooldown for this image-hash on this session: <remaining-ms>ms."
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

The `usage: 0` block is load-bearing: it signals to the meter pipeline that no upstream cost was incurred for this synthesized response. The structured event log captures the same information for operator diagnostics.

## Scope (v4.2.0)

In scope:
- New extension `proxy/extensions/image-retry-circuit-breaker.mjs` registered in `extensions.json` at order 370 (after request-shape normalization at 350 but before cache-control-normalize at 400 — the breaker needs to see image content blocks before any potential mutation).
- Image content-block SHA-256 hash helper (reusable utility in `proxy/lib/image-hash.mjs`).
- Per-session, per-image-hash state machine: `{ sessionId, imageHash, lastFailureAt, retryCount, cooledUntil }`.
- Synthesized response shape per the spec above.
- Structured event log writer at `~/.claude/image-retry-events.jsonl`.
- Env-var gate `CACHE_FIX_IMAGE_RETRY_BREAKER` (`on` / `off` / `dry-run`); `dry-run` logs would-have-fired events without short-circuiting.

Out of scope (deferred):
- Persistence of breaker state across proxy restarts. In-memory only.
- Surfacing the cool-off as a status-line signal. The JSONL event log is the data surface; consumers wire it.
- Generalizing the breaker to non-image permanent-error classes. This directive is image-specific; the pattern is extensible but the v4.2.0 scope is one error class.

## Implementation choice

The breaker is a stateful watcher with one decision: "should this request be short-circuited?" It runs in `onRequestStart` to inspect the request and decide; if it decides to short-circuit, it sets `ctx.response` directly to the synthesized payload and the pipeline returns without forwarding upstream. This is the same mechanism `bootstrap-defense` uses.

Recording the failure happens in `onResponseEnd` when a failure response matches the error-class predicate; the recorder writes into the per-session map keyed by image-hash. Subsequent `onRequestStart` calls in the cool-off window check the map.

The image-hash utility (`proxy/lib/image-hash.mjs`) extracts the base64 source from `content[i].source.data` for image-content blocks and SHA-256 hashes the decoded bytes (not the base64 string — the harness may re-encode and we want to detect identical-bytes, not identical-strings).

## Test plan

- Unit: `image-hash.mjs` — same image bytes via different base64 encodings produce same hash; different images produce different hashes; non-image content blocks produce no hash.
- Unit: state machine — failure recording, cool-off expiry, per-session isolation, per-hash isolation, retry counter increment.
- Integration: replay fixture of CC#66815's exact retry pattern (19 consecutive identical-image requests, each preceded by an upstream "image could not be processed" failure). Assert: first request forwards upstream; failure recorded; second through nineteenth short-circuited; one JSONL event per cool-off; total upstream calls = 1, not 19.
- Integration: same image, different session — both forward upstream; per-session isolation preserved.
- Integration: different image, same session — both forward upstream; per-hash isolation preserved.
- Integration: cool-off expiry — request inside window short-circuits; request after window forwards.
- Smoke: env-var `dry-run` mode — logs events but does not short-circuit; useful for production debugging.

## Files modified / created

Created:
- `proxy/extensions/image-retry-circuit-breaker.mjs`
- `proxy/lib/image-hash.mjs`
- `test/extensions/image-retry-circuit-breaker.test.mjs`
- `test/lib/image-hash.test.mjs`
- `test/fixtures/cc-66815-image-retry-replay.json` (~20-call sequence based on the issue body)

Modified:
- `proxy/extensions.json` — register new extension at order 370, default-disabled-internally pending v4.2.0 validation.
- `CHANGELOG.md` — v4.2.0 entry referencing CC#66815.
- `README.md` — extension list addition.
- `docs/extensions.md` — extension reference.

Out of scope (no changes):
- `proxy/extensions/cache-telemetry.mjs`
- `proxy/extensions/usage-log.mjs`
- Any existing extension's logic.

## Reviewer checklist (cache-fix side)

- [ ] Hash utility correctly handles all image-content-block shapes (`type: "image"` with `source.type: "base64"` and `source.media_type` set).
- [ ] State machine is per-session AND per-image-hash, not global.
- [ ] Synthesized response `usage: 0` block is present and structurally identical to upstream successful-response envelope.
- [ ] Error-class predicate references `proxy/lib/anthropic-error-classes.mjs` rather than inlining a regex.
- [ ] `dry-run` mode does not short-circuit but does log.
- [ ] Replay fixture matches CC#66815's reported sequence (first upstream call + 18 short-circuited).
- [ ] No new headers introduced; no request mutation.
- [ ] CHANGELOG cites CC#66815 explicitly.

## Out of scope (explicit)

- Server-side classifier behavior. We do not attempt to fix the underlying image-processing pipeline; we cap the user-facing cost.
- Non-image permanent-error classes (tool-use errors, model-not-available, etc.). Each has different retry semantics; one class per directive.
- Persistence of breaker state across restarts. The cool-off window is short enough that in-memory is sufficient.
- Multi-image messages where some images succeed and others fail. The breaker is per-image-hash, so partially-failing messages will see partial short-circuits — this is the correct behavior; deferring complexity around aggregate-message-retry to a follow-up if needed.

— AI Team Lead
