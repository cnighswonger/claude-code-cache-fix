# Directive: rate-limit event logging in the proxy

**Status:** detection grounded in 88-event burst capture (2026-05-08); reframed in response to Codex review #111 to log all `rate_limit_error` 429s rather than claiming burst-only semantics.
**Author:** Proxy Builder
**References:**
- `~/git_repos/claude/docs/issues/cache-fix-rate-limit-logging-2026-05-07.md` (original brief)
- `~/git_repos/claude/docs/issues/cache-fix-429-burst-data-2026-05-08.md` (capture + analysis, including auto-mode classifier finding)
- Anonymized fixture: `test/fixtures/burst-limit-429.json`

## Problem statement

Anthropic's burst/concurrency rate-limiter is a separate mechanism from Q5h/Q7d quota. It surfaces as **"Server is temporarily limiting requests · Rate limited"** with no `Retry-After` header, fires when the account's concurrent-stream cap is exceeded, and is invisible to per-request quota metrics. The community has converged on it as a real architectural problem — see anthropics/claude-code#53922 and cross-refs at #46037, #38335, #41788, #54750, #8449.

Anthropic's 2026-05-07 announcement doubled Q5h limits and removed peak-hour reductions, but did NOT address burst/concurrency. We're observing burst-limit hits on <internal-host> during multi-agent workloads.

**Hypothesis worth testing:** does the burst limiter still operate on the **old peak-hour schedule** (13:00–19:00 UTC weekdays) even though the Q5h peak-hour reduction is gone?

If yes → events cluster inside that window → useful operational intel.
If no → events distribute differently → still useful (correlate with Q7d, model selection, request size, concurrent agent count, etc.).

Either outcome is worth logging.

## Required: log enough context to test the hypothesis

Per Lead's brief, every detected rate-limit response gets one JSONL row appended to `~/.claude/usage-log/rate-limit-events.jsonl`:

```json
{
  "schema_version": 1,
  "ts": "2026-05-07T11:55:32.490Z",
  "type": "rate_limit",
  "session_id": "b16c607d-...",
  "requested_model": "claude-opus-4-7",
  "request_path": "/v1/messages",
  "request_size_tokens": 50,
  "response_status": 429,
  "response_body_excerpt": "{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",...",
  "concurrent_sessions_estimate": 5,
  "q5h_pct_at_event": 12,
  "peak_hour_old_schedule": false,
  "upstream_request_id": "req_011Cap...",
  "x_should_retry": "true",
  "upstream_connection_id": "cn-7"
}
```

Field semantics:

| Field | Source | Notes |
|---|---|---|
| `schema_version` | const `1` | bumped on backwards-incompatible changes; additive fields don't bump |
| `ts` | `new Date().toISOString()` at event time | UTC, millisecond precision |
| `type` | const `"rate_limit"` | reserved for future event types in same file |
| `session_id` | `ctx.meta._sessionId` (set by `cache-telemetry.onRequest`) | raw value, NOT canonical filename — avoids re-hashing for human inspection |
| `requested_model` | `body.model` captured in `onRequest` | distinguishes auto-mode classifier (Opus 4.7) from main-inference (any model) |
| `request_path` | proxy is `/v1/messages` only today | future-proofing |
| `request_size_tokens` | computed in `onRequest` from `ctx.body` (chars / 4 heuristic over messages + system) | approximate by design |
| `response_status` | `ctx.status` | always 429 today; field exists so future shape changes don't require a schema migration |
| `response_body_excerpt` | first 256 chars of stringified `ctx.body` | bounded so a hostile error body can't bloat the log |
| `concurrent_sessions_estimate` | count of files in `~/.claude/quota-status/sessions/` modified within last 5 minutes | cheap proxy for "how many sessions were active when this fired" |
| `q5h_pct_at_event` | read `~/.claude/quota-status/account.json` `.five_hour.pct` synchronously at event time | latest cached snapshot — written by `cache-telemetry` on the prior 200 response. NOT necessarily contemporaneous with the 429: error responses strip the `anthropic-ratelimit-*` headers, so we can't read live state. The value is "Q5h state shortly before the 429" and may be stale by tens of seconds in a sustained burst. |
| `peak_hour_old_schedule` | computed: `dayOfWeek ∈ Mon-Fri AND hourUTC ∈ {13..18}` | observational; H1 (peak schedule) refuted by the 2026-05-08 capture |
| `upstream_request_id` | Anthropic's `request_id` from body (preferred) or `request-id` response header | traceability; lets users correlate with Anthropic support escalations |
| `x_should_retry` | response header `x-should-retry` | recorded but not used as detection gate |
| `upstream_connection_id` | stable `cn-<int>` assigned in `proxy/upstream.mjs` per TCP socket via WeakMap | persists across keep-alive reuse, recycles on socket close. Distribution across rows distinguishes per-connection limiting (H3) from client-queue saturation (H4). See post-analysis playbook below. |

## Hook placement

The proxy already supports four hooks on the pipeline:

| Hook | Fires for | Sees |
|---|---|---|
| `onRequest` | every request | `body, headers, meta` (request side) |
| `onResponseStart` | every response | `status, headers, meta` (response headers, before body) |
| `onResponse` | non-streamed responses only | `status, headers, body, meta` (parsed JSON body) |
| `onStreamEvent` | each SSE `data:` line of streamed responses | `event, telemetry, meta` (parsed event) |

**`onResponse` is the primary detection hook for this directive.** It fires after the proxy has buffered the full non-streamed response body and successfully `JSON.parse`d it (server.mjs:78–104). 429 responses with a JSON error body will land here.

**Resolved by capture (2026-05-08):** all 88 captured `rate_limit_error` responses had `content-type: application/json` — non-streamed JSON. The `onResponse` hook is sufficient; no `onStreamEvent` branch needed. (If Anthropic ever changes this and returns a 429 over SSE, we'll see it as a missing-row symptom and add the streaming branch as a follow-up.)

## Detection condition (grounded in capture)

From the 2026-05-08 88-event burst (15 min, single account, full HTTP fidelity), every captured response had:

| Field | Value |
|---|---|
| `status` | `429` (88/88) |
| `content-type` | `application/json` (88/88) |
| `body.type` | `"error"` (88/88) |
| `body.error.type` | `"rate_limit_error"` (88/88) |
| `body.error.message` | `"Error"` (88/88 — Anthropic gives no useful sub-classification) |
| `x-should-retry` header | `"true"` (88/88) |
| `Retry-After` header | absent (0/88 — caller must infer backoff) |
| `anthropic-ratelimit-*` headers | absent (0/88 — error responses strip them) |

Predicate:

```js
isRateLimitResponse(ctx) =
  ctx.status === 429 &&
  ctx.body?.type === "error" &&
  ctx.body?.error?.type === "rate_limit_error"
```

Header signals (`x-should-retry`, `request-id`) are recorded in the JSONL row but not used as detection gates — Anthropic could change them independently of the body, and the body schema is the canonical contract.

## Scope: this is a SUPERSET of `rate_limit_error` events

Per Anthropic's public docs and the 2026-05-08 capture + post-incident analysis, the `rate_limit_error` envelope can be triggered by multiple underlying mechanisms. Lead's 2026-05-08 hypothesis revision (see "Hypothesis revision" below) shows the picture is more complicated than a single account-wide concurrent-stream cap:

| Class | Notes |
|---|---|
| **Per-connection / per-process limit** | New leading candidate for OUR observed phenomenon (post-incident reframe). Limiter appears keyed on process / TCP / HTTP keep-alive pool state — only the actively-bursting agent saw 429s; `claude --continue` cleared it without restarting the host or rotating IP. |
| **Account-wide concurrency** | Manuel's #53922 bulk-spawn-fresh-sessions hypothesis. Still plausible for cases other than ours; not our specific incident shape. |
| **RPM (requests-per-minute)** | Classic per-key rate limit. Documented; same envelope. |
| **ITPM / OTPM (input/output tokens-per-minute)** | Classic per-key rate limit. Same envelope. |
| **Auto-mode classifier overflow** | Per Lead's 2026-05-08 follow-up: CC's auto-mode runs a separate Opus-4-7 safety classifier API call before each Edit. These calls share whatever limiter is active, so when it saturates the classifier 429s alongside main-inference traffic. Effectively doubles the API-call rate per visible Edit turn. Sessions on Sonnet are still gated by Opus 4.7 quota via this path. |

The response itself carries no field that distinguishes these classes — `error.message` is literally the string `"Error"`. So we **deliberately log the superset** and let post-analysis split.

### Hypothesis revision (post-incident, 2026-05-08)

Lead's analysis after the 88-event capture flipped the underlying-mechanism story:

- **Only the actively-bursting agent was affected.** Lead, Sim Agent, Web Manager, Proxy Builder all ran concurrently on the same account during the burst window without 429s.
- **`claude --continue` cleared it.** That preserves session UUID, account, IP, model, conversation history — but resets process / TCP / HTTP keep-alive pool / in-process retry queue.

Net: the limiter is **not literally account-wide** in the way Manuel's #53922 framing suggests. It is keyed on something process/connection-specific. This changes the burst-handling design space (Candidate B per-account token bucket is probably wrong for this phenomenon; new Candidate C — per-connection retry absorption with connection-recycle escape hatch — is the most plausible architectural fit). All deferred to follow-up work; not in scope here.

**What this means for the LOGGING extension:** the contract is unchanged — we still log every `rate_limit_error` 429. But the JSONL alone is **not sufficient** to disambiguate process/connection-keyed (H3) from client-side queue saturation (H4). Lead's verification suggestion is to capture upstream connection identity at each 429: if 429s correlate with one specific upstream connection ID, H3 is confirmed. That's a small follow-up enrichment to this extension; flagged in "Out of scope" below.

## Post-analysis playbook

To distinguish the classes from the JSONL stream, use:

| Signal | What it tells you |
|---|---|
| `requested_model` | Opus 4.7 with small `request_size_tokens` ⇒ likely classifier traffic (Lead's finding). Larger size at any model ⇒ likely main-inference. |
| `request_size_tokens` | Tiny (~50-200) suggests classifier; larger suggests main-inference. |
| Inter-arrival timing across rows | Exponential pattern (0.86s → 1.38s → 2.22s → ...) ⇒ a single CC session retrying. Compressed parallel spacing ⇒ multi-agent burst. The 2026-05-08 wave/quiet/wave structure showed both within one 15-min window. |
| `concurrent_sessions_estimate` | Higher count alongside a 429 ⇒ multi-agent contention more likely. |
| `session_id` distribution | Multiple distinct ids in a tight time window ⇒ burst/concurrency. Same id repeating ⇒ single-session retry. |
| `upstream_connection_id` distribution | **H3-vs-H4 verification.** If 429s cluster on a single id (one upstream socket carrying many failures while others succeed) ⇒ per-connection / per-process limiter (H3). If 429s are spread across many ids ⇒ client-side queue saturation (H4) is more likely. The `claude --continue` clearing effect from Lead's 2026-05-08 incident is consistent with H3 at the proxy layer too — closing+reopening a hot socket would mimic that recovery without a full session restart. |

This is exactly the analysis Lead used to identify the wave/quiet/wave structure post-capture. The extension's job is to write the rows; the classification is downstream.

## Pipeline integration

```
onRequest:
  - capture session_id (already done by cache-telemetry; reuse ctx.meta._sessionId)
  - compute request_size_tokens from ctx.body, stash as ctx.meta._requestSizeTokens

onResponse (non-streamed path):
  - if isRateLimitResponse(ctx) → append row to ~/.claude/usage-log/rate-limit-events.jsonl
  - non-mutating; never throws to pipeline
```

`isRateLimitResponse(ctx)` is a single exported predicate so the captured-429 fix is a one-line update without restructuring.

## File path

`~/.claude/usage-log/rate-limit-events.jsonl`

Differences from `~/.claude/usage.jsonl`:
- separate file (different consumer audience: incident analysis, not meter ingestion)
- separate directory (`usage-log/`) so future event types — e.g., `microcompact-fired.jsonl`, `cache-bust-detected.jsonl` — share the directory naming convention
- writer must `mkdir -p` the directory on first append

## Activation

Default `enabled: false` in the module export, matching `usage-log.mjs`. Users opt in by adding `"rate-limit-log": { "enabled": true, "order": 660 }` to `proxy/extensions.json`.

`order: 660` — after `cache-telemetry` (600) so `ctx.meta._sessionId` is set, after `usage-log` (650) so logs share the same per-response sequencing.

No env var enable flag (matches Lead's brief: "Append to a separate file ... so it doesn't pollute the main usage log and is trivially queryable" — opt-in via config, not env, keeps the activation surface narrow).

## Tests

| Test | Status |
|---|---|
| isRateLimitResponse: 429 → true | scaffolded |
| isRateLimitResponse: 200 → false | scaffolded |
| isRateLimitResponse: 500 → false (predicate gates on 429 specifically) | covered |
| onResponse: 429 → JSONL row written with all fields | scaffolded; payload shape will be tightened with real bytes |
| onResponse: 200 → no row written | scaffolded |
| Field accuracy: peak_hour_old_schedule computed correctly across boundaries | scaffolded |
| Body excerpt: bounded to 256 chars even for a 10MB hostile body | scaffolded |
| Concurrent sessions estimate: counts session files modified within last 5 min | scaffolded |
| Streamed-429 path | DEFERRED — depends on captured response path |

## Hypothesis findings (post-capture)

From Lead's 2026-05-08 analysis (`cache-fix-429-burst-data-2026-05-08.md`):

| Hypothesis | Result |
|---|---|
| H1 — burst limiter still operates on old peak schedule (13-19 UTC weekday) | **Refuted.** Capture window 00:06-00:21 UTC, far outside any peak window. |
| H2 — bursts triggered by wake-from-idle activity (multiple agents reconnecting) | **Confirmed.** Burst happened during simultaneous Code Agent + Lead session re-engagement after idle. |
| Latent — CC silently retries with exponential backoff before surfacing the user-visible error | **Confirmed and observable.** First sub-burst showed clean 0.86s → 1.38s → 2.22s → 3.78s spacing. Means the user-visible "Rate limited" error represents an exhausted retry budget, not a single API call. Worth folding into community framing. |
| Classifier-doubles-rate (added 2026-05-08) | **Confirmed via separate error path.** CC's auto-mode runs an Opus-4-7 safety classifier per Edit, so the effective API-call rate is roughly 2x the visible turn rate. Classifier traffic shares the same concurrency limiter and shows up in the 429 stream. |
| Account-wide concurrency limiter (Manuel's #53922 framing for OUR phenomenon) | **REVISED 2026-05-08 (post-incident).** Only the actively-bursting agent was affected; `claude --continue` cleared it. Limiter is process/connection-keyed for our incident shape, not literally account-wide. Manuel's bulk-spawn scenario may still be a different (genuine account-wide) phenomenon. |

`peak_hour_old_schedule` is still emitted on every record — it's now observational data rather than a primary hypothesis test, but cheap to compute and useful for future analysis.

## What ships in this PR

- Directive doc (this file)
- `proxy/extensions/rate-limit-log.mjs` — full extension with capture-grounded predicate; default `enabled: false` (opt-in via `extensions.json`)
- `test/proxy-rate-limit-log.test.mjs` — 27 tests covering predicate (positive on captured fixture, negative on `overloaded_error` / `invalid_request_error` / no body), field extractors (peak-hour boundaries, body excerpt bounding, mtime-window session counting), and end-to-end pipeline integration on a tmpdir-rooted HOME
- `test/fixtures/burst-limit-429.json` — anonymized response payload from the captured burst
- No `extensions.json` activation (extension defaults off; users opt in)

## Out of scope for this PR

These are flagged as separate work in Lead's 2026-05-08 brief, not addressed here:

- **Burst handling.** Candidates A (reactive retry — reframed post-revision: prevent CC's retry queue from inflating in the affected process), B (per-account token bucket — probably wrong for this phenomenon), and C (per-connection retry absorption with connection-recycle escape hatch — new leading candidate). Logging is a prerequisite for deciding which approach pays off; this PR doesn't pre-commit any of them. Whichever lands must include classifier-path traffic.
- ~~Connection-pool / process state at each 429~~ — **shipped** in the follow-up to PR #111. `proxy/upstream.mjs` assigns each upstream TCP socket a stable `cn-<int>` id via WeakMap, threaded through `forwardRequest` → `ctx.meta._upstreamConnectionId` → `upstream_connection_id` field on each JSONL row. Persists across keep-alive reuse, recycles on socket close. See "Post-analysis playbook" above for the H3-vs-H4 distribution test.
- **Streaming-side detection.** Not needed against current capture; will be added if Anthropic shifts the response shape.
- **Server-side request-class detection.** As long as Anthropic returns `error.message: "Error"` with no class hint, splitting burst-vs-RPM/TPM and classifier-vs-main is a post-analysis problem on the JSONL. If Anthropic adds a discriminator field, the extractor in this extension is the natural landing site.

— Proxy Builder
