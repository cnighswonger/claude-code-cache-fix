# Directive: Image-retry circuit breaker

**Issue:** TBD (will be filed alongside this directive, referencing CC#66815)
**Upstream:** [anthropics/claude-code#66815](https://github.com/anthropics/claude-code/issues/66815) — *Repeated "image could not be processed" errors consumed ~60% of usage limit — 19 consecutive failures, each resending full 34MB context*
**Priority:** P1
**Branch:** `feature/image-retry-circuit-breaker`
**Stage:** directive — round 2 (addresses Fable round-1 REQUEST_CHANGES on PR #213)
**Milestone:** v4.2.0

## Goal

When an image-bearing messages request returns an `image could not be processed`–class permanent error AND the harness immediately retries with the same image content (same SHA-256 hash) on the same session within a cool-off window, the proxy short-circuits the retry by emitting a synthesized response in the **same wire format** the upstream would have produced (SSE event sequence for streamed requests, JSON body for non-streamed). The response carries an assistant text block explaining the short-circuit and naming the issue.

This bounds the loss from CC#66815's retry storm — 19 retries × 34 MB of context tokens — from "60% of Q5h envelope" to "one upstream call." The harness still surfaces the failure to the user; we just stop letting it pay for the same failure repeatedly.

## Why

Per CC#66815, the harness currently treats "image could not be processed" as a transient error and retries with full conversation context. Each retry is a complete messages request — full system prompt, full message history, the 34 MB image content. Twenty turns of retry can consume the majority of a Max-plan user's Q5h envelope. The reporter filed under direct Anthropic-support direction (Fin). yurukusa's thread analysis identifies the cost mechanism precisely: every retry rebuilds the cache_creation surface because the failure response doesn't update the cached prefix.

The proxy sees every request and every response. When the response signals a permanent image-processing failure AND the immediately-following request carries the same image content (verifiable by hashing the content block), the proxy has the information it needs to break the loop. This is not a server-side fix; it does not require a CC-binary change; it does not require any user configuration beyond enabling the extension.

The framing is **advisory-protective**, not blocking. The proxy returns a wire-format-correct synthesized response identical in shape to what the harness expects from upstream, so the harness can render the failure and the user can decide what to do next. The user is not silenced; they are told once and asked to act, instead of being told nineteen times with the bill arriving at the end.

## Non-Functional Requirements

- **Size/complexity budget:** extension code ~150 LOC; helpers (image-hash, error-class predicate, SSE synthesis) ~100 LOC; tests ~250 LOC. **Total budget ~500 LOC including SSE synthesis path** — accurate for the actual surface, not extension-code only. Flag at review if it grows past that.
- **Threat model:** content hashing reads request body. The proxy already does this (e.g., `prefix-diff`, `signature-surface-hash`). The breaker state is in-memory and per-session; nothing persists to disk beyond the optional structured log of cool-off events.
- **PII discipline (matches `bootstrap-defense`):** the JSONL event log carries hashes, session id, timestamps, remaining-TTL, request_id only — never image bytes, never request bodies, never auth headers. Rotation at 5 MB single-tier (precedent: `bootstrap-defense`'s `rotateIfNeeded`).
- **Activation model:** `enabled: true` in `extensions.json` (always loaded) with internal env-var gate `CACHE_FIX_IMAGE_RETRY_BREAKER` (`on` / `off` / `dry-run`) per the established `prefix-diff` pattern (`proxy/extensions/prefix-diff.mjs:30`). Default-off in v4.2.0 first ship; default-on after one minor-version validation cycle.
- **Failure mode:** if the breaker misfires (false positive on a legitimately-retryable case), the user can disable the extension with one env-var flip and the proxy falls back to forwarding every request. Log the cool-off events so misfires are diagnosable.
- **Tunables:** the cool-off window is operator-configurable via `CACHE_FIX_IMAGE_RETRY_COOLOFF_MS` (default 30,000). State map maximum entries via `CACHE_FIX_IMAGE_RETRY_MAX_ENTRIES` (default 4096) — over which the LRU evicts.

## Pipeline-hook surface (verified against `proxy/pipeline.mjs`)

The pipeline exposes exactly four hooks: `onRequest`, `onResponseStart`, `onStreamEvent`, `onResponse`. The breaker uses:

- **`onRequest`** — inspects the incoming messages request. If the breaker decides to short-circuit, it returns `{ skip: true, status, headers, body, stream }` (see "Synthesized response — wire format" below). The pipeline's `runOnRequest` (`proxy/pipeline.mjs:85-101`) propagates the skip result to `server.mjs:88-95`, which writes the synthesized payload directly to the client.
- **`onResponse`** — the non-streaming response branch (`server.mjs:162-187`). The "image could not be processed" error arrives here when upstream returns an HTTP 400 with `content-type: application/json` (the canonical Anthropic error envelope). The breaker records the failure on this branch.

**Out of scope (explicit):** mid-stream SSE `error` events via `onStreamEvent`. Per `rate-limit-log.mjs:60-64`, the canonical Anthropic error envelope arrives as a non-streaming JSON body. If a future Anthropic change moves image-processing errors to mid-stream SSE events, that path is a follow-up.

## Synthesized response — wire format (closes Fable B3)

The harness sends messages requests with `stream: true` for the interactive path. The skip-path in `server.mjs:88-95` writes a single payload — it currently has no SSE-synthesis branch.

The breaker addresses this with a two-mode synthesis decided at `onRequest` time:

1. **`request.body.stream === false`** (or undefined): the skip-result is a single JSON body identical in shape to the upstream non-streaming success envelope.

2. **`request.body.stream === true`**: the skip-result is a **minimal valid SSE event sequence** that the harness's SDK consumes as a normal completed message. The required event sequence (per `proxy/stream.mjs` and Anthropic's documented protocol):

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_<synth>","type":"message","role":"assistant","model":"<echoed-from-request>","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<short-circuit-message>"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}

event: message_stop
data: {"type":"message_stop"}

data: [DONE]

```

The skip-result envelope is extended to carry both modes:

```
{
  skip: true,
  status: 200,
  headers: { "content-type": "text/event-stream" } | { "content-type": "application/json" },
  body: "<SSE-string>" | { ... non-streaming JSON ... },
  stream: true | false,
}
```

`server.mjs`'s skip handler reads `stream` to decide whether to write `body` as `text/event-stream` bytes (no `JSON.stringify`) or `application/json`. **This is a server.mjs change** (one branch added in the skip-handler block) — call this out explicitly in the Files-modified list.

**Short-circuit message text** (kept minimal/stable to limit transcript-pollution surface):

```
[cache-fix-proxy] Image with content hash <first-8> failed processing on the previous attempt. To avoid burning cache_creation tokens on the same failure, this attempt was short-circuited locally. Please drop or replace the image. (See CC#66815. Cooldown: <remaining-ms>ms.)
```

## Meter-pipeline observability (closes Fable B4)

The skip path returns `{handled: true}` from `preForward` (`server.mjs:90-96`) before any upstream call is made. **No `onResponseStart`, `onStreamEvent`, or `onResponse` runs for the synthesized response.** Both `usage-log.mjs` and `cache-telemetry.mjs` consume SSE stream events (`usage-log.mjs:273-319`, `cache-telemetry.mjs:190-272`) and therefore see nothing from short-circuited requests.

Implication:

- Short-circuited requests produce **no row in `~/.claude/usage.jsonl`**. The previous `usage: 0` framing claimed meter-visibility — this was wrong. The meter-pipeline is correctly bypassed (no upstream cost was incurred), but it does not record the short-circuit.
- The **only observability surface for breaker fires** is the JSONL event log this extension owns at `~/.claude/image-retry-events.jsonl`.

Document this clearly in the directive and in the extension's README entry so operators don't expect meter rows for short-circuited requests.

The `usage: 0` block in the synthesized response remains correct as harness-facing wire format — the harness expects an envelope with a usage block — but the framing claim about meter-pipeline signaling is dropped.

## Detection logic

A retry is identified by the conjunction of all four conditions:

1. The previous response on the same session matched the **image-processing-error predicate** (see "Error-class predicate" below).
2. The current request carries an image content block whose SHA-256 matches an image content block that was on the request that produced the previous failure.
3. The current request arrives within `CACHE_FIX_IMAGE_RETRY_COOLOFF_MS` (default 30,000 ms) of the previous failure.
4. The current request is on the same session, resolved via `resolveSessionId(ctx.headers)` from `cache-telemetry.mjs:64-72` (checks `x-claude-code-session-id`, `x-session-id`, and `x-anthropic-session-id`). If no session id resolves, the bucket key is the string `"unknown"` (matching `sessionFilename` convention) and per-session isolation applies only across requests that also have no session id.

All four must hold. Any one of them being false routes the request through to upstream normally (fail-open).

## Multi-image matching rule (closes Fable attention #2)

The breaker matches on **any** image-hash overlap between the current request and the request that produced the recorded failure. The 30-second cool-off TTL is the mitigation for false positives in the replaced-bad-image-but-shared-good-image case: a user re-editing only the failing image will replace it within seconds, and any wait beyond 30s opens a fresh attempt.

Rationale: per-image-attribution-to-failure cannot be inferred from the response (Anthropic's error envelope names the class, not the specific failed image content). Requiring full-set match would short-circuit only exact re-submits, missing the dominant CC#66815 case where the harness retries the entire message verbatim. Any-hash match with short TTL is the right trade-off.

This is an explicit acceptance, not a documentation gap. A test covers the replaced-bad-image+shared-good-image case to confirm: within the 30s window, it short-circuits (acknowledged trade-off); after the 30s window, it forwards (mitigation works).

## Error-class predicate (closes Fable B2)

The predicate is **inlined** in the extension. No new shared module is introduced. Following `rate-limit-log.mjs:60-65`'s pattern:

```js
function isImageProcessingError(ctx) {
  if (!ctx || typeof ctx.status !== "number") return false;
  if (ctx.status !== 400) return false;
  const body = ctx.body;
  if (!body || typeof body !== "object") return false;
  if (body.type !== "error" || body.error?.type !== "invalid_request_error") return false;
  const msg = body.error?.message || "";
  return /image (could not be processed|format|content)/i.test(msg);
}
```

The exact patterns are validated during sim validation (see Test plan). If sim validation surfaces additional message variants in production traffic, the regex is updated in the same PR before merge. **No `proxy/lib/` directory is introduced**; if the predicate ever has a second consumer, that future PR can promote it to a shared module under the established flat-`proxy/` convention.

## State management (closes Fable attention #4)

Per-session, per-failed-request state machine:

```js
state.failures = new Map(); // key: `${sessionId}:${requestSignature}` → entry
// entry = {
//   sessionId, imageHashes: Set<string>, lastFailureAt, requestId, retryCount,
// }
```

Where `requestSignature` is a stable hash of the failing request (purpose: distinguish per-attempt failures within a session, not just per-session). The map is bounded by `CACHE_FIX_IMAGE_RETRY_MAX_ENTRIES` (default 4096) with LRU eviction; lazy expiry on lookup drops entries past the cool-off window; a throttled sweep (precedent: `sweepStaleSessions`, `cache-telemetry.mjs:132-156`) runs every 60s to bound the resident set.

## Order placement (closes Fable attention #1)

Order **370** in `extensions.json`. Stated correctly: this places the breaker **after** `image-strip` (order 150, which may mutate images via Pass 3 resize) and **after** other early request normalization. The breaker hashes images in the form they would actually go upstream — consistent on both the failing request and the retry — so hash matching is stable. The previous "before any mutation" rationale was wrong; the corrected rationale is "after image-strip so we hash the wire form, not the source form."

The closest pre-existing extension by order is `microcompact-stability` at 350 — name it correctly, not as "request-shape normalization."

## Scope (v4.2.0)

In scope:
- New extension `proxy/extensions/image-retry-circuit-breaker.mjs` registered in `extensions.json` at order 370.
- Image content-block SHA-256 helper at `proxy/image-hash.mjs` (flat `proxy/`, following `image-dimensions.mjs` / `image-resize.mjs` convention).
- Per-session state machine with LRU eviction + throttled sweep.
- Inlined `isImageProcessingError` predicate.
- Two-mode synthesized response: SSE event sequence for `stream: true` requests; non-streaming JSON for `stream: false` requests.
- `server.mjs` skip-handler branch added to read `stream` field on skip-result and write `text/event-stream` bytes vs. `application/json`.
- Structured event log writer at `~/.claude/image-retry-events.jsonl` with 5 MB rotation matching `bootstrap-defense`.
- Env-var gates: `CACHE_FIX_IMAGE_RETRY_BREAKER` (on/off/dry-run), `CACHE_FIX_IMAGE_RETRY_COOLOFF_MS` (default 30000), `CACHE_FIX_IMAGE_RETRY_MAX_ENTRIES` (default 4096).

Out of scope (deferred):
- Persistence of breaker state across proxy restarts. In-memory only.
- Surfacing the cool-off as a status-line signal. The JSONL event log is the data surface; consumers wire it.
- Generalizing the breaker to non-image permanent-error classes (`overloaded_error`, model-not-available, etc.). One error class per directive.
- Mid-stream SSE `error` event handling via `onStreamEvent`. The canonical Anthropic image-processing-error envelope arrives non-streaming.

## Implementation choice

The breaker runs in two hooks:

- **`onRequest`** — inspects the request, stashes the request's image hashes on `ctx.meta._imageRetryHashes` (so the failure recorder on the same request's `onResponse` can find them), and checks the failure state map. If a recorded failure exists for the resolved session whose `imageHashes` intersects the current request's hashes within the cool-off window, the breaker returns `{ skip: true, status: 200, headers, body, stream }` per the wire-format spec above.
- **`onResponse`** — checks `isImageProcessingError(ctx)`. If true, records a failure entry keyed by the resolved session + a stable request signature, with the image hashes stashed on `ctx.meta._imageRetryHashes` at `onRequest` time.

The image-hash utility extracts `content[i].source.data` for `type: "image"` blocks with `source.type: "base64"`, decodes the base64, and SHA-256s the decoded bytes (not the base64 string — the harness may re-encode and we want identical-bytes, not identical-strings).

## Sim validation requirement (Fable B3 follow-through)

This PR carries the `needs-sim-validation` label as a **merge gate**, not an advisory. Sim validation must confirm:

1. The SSE-synthesis path produces a response that the CC harness consumes as a normal completed assistant turn — does not retry as a transport error.
2. The harness's transcript receives the synthesized assistant turn correctly (one text content block, no extra structural events).
3. The synthesized response on `stream: false` (less common but supported) likewise consumes normally.
4. The error-class predicate matches actual production traffic for the "image could not be processed" family — confirm via captured traffic that the regex covers observed message variants.

Sim validation results are attached as a PR comment before reviewer chain progresses to AITL synthesis.

## Test plan

- Unit: `image-hash.mjs` — same image bytes via different base64 encodings produce same hash; different images produce different hashes; non-image content blocks produce no hash.
- Unit: `isImageProcessingError` — matches the documented envelope; rejects `overloaded_error` (the near-miss class); rejects rate-limit-error 429s; rejects success 200s.
- Unit: state machine — failure recording, cool-off expiry, per-session isolation, per-hash isolation, retry counter increment, LRU eviction at cap, throttled sweep removes stale entries.
- Unit: SSE event-sequence builder — produces correctly-formatted SSE bytes matching `proxy/stream.mjs` event-shape expectations (`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop` → `[DONE]`); echoes `model` from request; carries short-circuit text in `content_block_delta`.
- Integration: replay fixture of CC#66815's exact retry pattern (19 consecutive identical-image requests on a streaming session, each preceded by an upstream HTTP-400 "image could not be processed" failure). Assert: first request forwards upstream; failure recorded; second through nineteenth short-circuited with SSE responses; one JSONL event per cool-off; total upstream calls = 1, not 19.
- Integration: replaced-bad-image + shared-good-image within cool-off window → short-circuits (acknowledged trade-off); same case after 30s window → forwards.
- Integration: same image, different session → both forward upstream; per-session isolation preserved.
- Integration: different image, same session → both forward upstream; per-hash isolation preserved.
- Integration: `stream: false` request short-circuit → produces JSON response, not SSE.
- Integration: env-var `dry-run` mode → logs events but does not short-circuit; useful for production debugging.
- Integration: sessionless request (no session-id headers) → keyed as `"unknown"` bucket; isolated from other sessionless requests of different signatures.
- Sim validation: as defined above.

## Files modified / created

Created:
- `proxy/extensions/image-retry-circuit-breaker.mjs`
- `proxy/image-hash.mjs` (flat `proxy/` per existing image-helpers convention)
- `test/extensions/image-retry-circuit-breaker.test.mjs`
- `test/image-hash.test.mjs`
- `test/fixtures/cc-66815-image-retry-replay.json` (~20-call SSE-streamed sequence per CC#66815)
- `test/fixtures/cc-66815-image-processing-error.json` (canonical envelope sample)
- `test/fixtures/replaced-bad-image-multi-image.json` (false-positive test case)

Modified:
- **`proxy/server.mjs`** — skip-handler block in `preForward` (`server.mjs:88-95`) extended to read `stream` field on skip-result and write `text/event-stream` body unchanged (no `JSON.stringify`) when `stream === true`. Tested in the existing server.mjs unit suite for skip behavior.
- `proxy/extensions.json` — register new extension at order 370, default-disabled-internally pending v4.2.0 validation.
- `CHANGELOG.md` — v4.2.0 entry referencing CC#66815.
- `README.md` — extension list addition.
- `docs/extensions.md` — extension reference.

Out of scope (no changes):
- `proxy/extensions/cache-telemetry.mjs`
- `proxy/extensions/usage-log.mjs`
- Any existing extension's logic.
- No new `proxy/lib/` directory.

## Reviewer checklist (cache-fix side)

- [ ] Hook surface uses `onRequest` (returning `{skip: true, status, headers, body, stream}`) and `onResponse` only.
- [ ] `stream: true` requests get an SSE event sequence response; `stream: false` requests get JSON.
- [ ] Server skip-handler branch correctly writes `text/event-stream` bytes without re-stringifying when `stream === true`.
- [ ] Image-processing-error predicate is inlined and tested against `overloaded_error` and rate-limit 429s as negative cases.
- [ ] `resolveSessionId` from `cache-telemetry.mjs` is reused, not re-implemented; sessionless requests bucket to `"unknown"`.
- [ ] State map has lazy expiry on lookup, throttled sweep, and LRU eviction at `MAX_ENTRIES`.
- [ ] Synthesized response `usage: 0` block is present and structurally identical to upstream envelope (harness-facing only — directive explicitly drops the meter-pipeline-signaling claim).
- [ ] Order 370 explicitly placed AFTER `image-strip` (150) and `microcompact-stability` (350); rationale "hash the wire form."
- [ ] JSONL event log carries hashes, session id, timestamps, remaining-TTL, request_id only — no image bytes, no request bodies, no auth headers. Rotation at 5 MB.
- [ ] `dry-run` mode does not short-circuit but does log.
- [ ] Replay fixture matches CC#66815's reported sequence (first upstream call + 18 short-circuited).
- [ ] `needs-sim-validation` label is present; sim results attached as PR comment before merge.
- [ ] No new headers introduced; no request mutation outside the skip-result.
- [ ] CHANGELOG cites CC#66815 explicitly.
- [ ] No new `proxy/lib/` directory introduced.

## Out of scope (explicit)

- Server-side classifier behavior. We do not attempt to fix the underlying image-processing pipeline; we cap the user-facing cost.
- Non-image permanent-error classes (tool-use errors, model-not-available, etc.). Each has different retry semantics; one class per directive.
- Persistence of breaker state across restarts. The cool-off window is short enough that in-memory is sufficient.
- Multi-image messages where some images succeed and others fail. The breaker is any-hash-match within session; partial-replacement-during-cool-off is an acknowledged trade-off mitigated by the 30s TTL; deferring per-image attribution to a follow-up if production data shows it as a problem.
- Mid-stream SSE `error` event handling. Canonical Anthropic image-processing-error envelope arrives non-streaming.

— AI Team Lead
