# Directive: rate-limit event logging in the proxy

**Status:** scaffolded; detection branch BLOCKED on a captured upstream 429 response.
**Author:** Proxy Builder, codifying AI Team Lead's 2026-05-07 brief
**Reference:** `~/git_repos/claude/docs/issues/cache-fix-rate-limit-logging-2026-05-07.md` (lead workspace)

## Problem statement

Anthropic's burst/concurrency rate-limiter is a separate mechanism from Q5h/Q7d quota. It surfaces as **"Server is temporarily limiting requests · Rate limited"** with no `Retry-After` header, fires when the account's concurrent-stream cap is exceeded, and is invisible to per-request quota metrics. The community has converged on it as a real architectural problem — see anthropics/claude-code#53922 and cross-refs at #46037, #38335, #41788, #54750, #8449.

Anthropic's 2026-05-07 announcement doubled Q5h limits and removed peak-hour reductions, but did NOT address burst/concurrency. We're observing burst-limit hits on visits-01 during multi-agent workloads.

**Hypothesis worth testing:** does the burst limiter still operate on the **old peak-hour schedule** (13:00–19:00 UTC weekdays) even though the Q5h peak-hour reduction is gone?

If yes → events cluster inside that window → useful operational intel.
If no → events distribute differently → still useful (correlate with Q7d, model selection, request size, concurrent agent count, etc.).

Either outcome is worth logging.

## Required: log enough context to test the hypothesis

Per Lead's brief, every detected rate-limit response gets one JSONL row appended to `~/.claude/usage-log/rate-limit-events.jsonl`:

```json
{
  "ts": "2026-05-07T11:55:32.490Z",
  "type": "rate_limit",
  "session_id": "b16c607d-...",
  "request_path": "/v1/messages",
  "request_size_tokens": 50,
  "response_status": 429,
  "response_body_excerpt": "Server is temporarily limiting requests...",
  "concurrent_sessions_estimate": 5,
  "q5h_pct_at_event": 12,
  "peak_hour_old_schedule": false
}
```

Field semantics:

| Field | Source | Notes |
|---|---|---|
| `ts` | `new Date().toISOString()` at event time | UTC, millisecond precision |
| `type` | const `"rate_limit"` | reserved for future event types in same file |
| `session_id` | `ctx.meta._sessionId` (set by `cache-telemetry.onRequest`) | raw value, NOT canonical filename — avoids re-hashing for human inspection |
| `request_path` | `ctx.request_path` (proxy is `/v1/messages` only today, but record it) | future-proofing |
| `request_size_tokens` | computed in `onRequest` from `ctx.body` (chars / 4 heuristic over messages + system) | approximate by design |
| `response_status` | `ctx.status` | typically 429; record actual value so 5xx-shaped burst-limits are also captured |
| `response_body_excerpt` | first 256 chars of stringified `ctx.body` | bounded so a hostile error body can't bloat the log |
| `concurrent_sessions_estimate` | count of files in `~/.claude/quota-status/sessions/` modified within last 5 minutes | cheap proxy for "how many sessions were active when this fired" |
| `q5h_pct_at_event` | read `~/.claude/quota-status/account.json` `.five_hour.pct` synchronously at event time | file was just written by `cache-telemetry` on the prior response, so it's fresh |
| `peak_hour_old_schedule` | computed: `dayOfWeek ∈ Mon-Fri AND hourUTC ∈ {13..18}` | matches the manual tracker's column |

## Hook placement

The proxy already supports four hooks on the pipeline:

| Hook | Fires for | Sees |
|---|---|---|
| `onRequest` | every request | `body, headers, meta` (request side) |
| `onResponseStart` | every response | `status, headers, meta` (response headers, before body) |
| `onResponse` | non-streamed responses only | `status, headers, body, meta` (parsed JSON body) |
| `onStreamEvent` | each SSE `data:` line of streamed responses | `event, telemetry, meta` (parsed event) |

**`onResponse` is the primary detection hook for this directive.** It fires after the proxy has buffered the full non-streamed response body and successfully `JSON.parse`d it (server.mjs:78–104). 429 responses with a JSON error body will land here.

**Open question (BLOCKED on captured 429):** if upstream returns a 429 with `content-type: text/event-stream` — i.e., the SSE stream opens, then upstream emits a single error event and closes — our `onResponse` hook won't fire. We'd need a parallel detection branch in `onStreamEvent` keyed off an SSE error event type. Until we have a real captured response, we don't know which path Anthropic uses for burst-limit 429s. The interim tee/socat capture Lead is running will tell us.

## Detection condition (BLOCKED on captured 429)

The captured response will pin down:

1. Is it `status === 429` only, or also some 5xx?
2. Does the body include `error.type === "rate_limit_error"` (or similar)?
3. Is there a discriminating response header (`anthropic-error-type`, `cf-ray` patterns, etc.)?
4. What's the actual body string format — do we match on a substring or on the JSON shape?
5. Is the response streamed or non-streamed?

**Until then, scaffold uses a conservative v0 predicate: `status === 429`.** That over-triggers (will catch classic RPM/TPM 429s that aren't the burst-limit), but for the hypothesis test we'd rather have superset data we can filter than miss the targeted events. Once the captured response is in hand, we tighten the predicate and update the directive.

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
| isRateLimitResponse: 500 → false (v0 predicate); will revisit when burst-limit shape is captured | scaffolded |
| onResponse: 429 → JSONL row written with all fields | scaffolded; payload shape will be tightened with real bytes |
| onResponse: 200 → no row written | scaffolded |
| Field accuracy: peak_hour_old_schedule computed correctly across boundaries | scaffolded |
| Body excerpt: bounded to 256 chars even for a 10MB hostile body | scaffolded |
| Concurrent sessions estimate: counts session files modified within last 5 min | scaffolded |
| Streamed-429 path | DEFERRED — depends on captured response path |

## What ships in this PR vs. what waits for captured 429

**Ships (groundwork, this PR):**
- Directive doc (this file)
- `proxy/extensions/rate-limit-log.mjs` skeleton with v0 detection predicate
- Test scaffold with above tests, marked `t.todo` where they need real capture data
- No `extensions.json` activation (default-off)

**Waits for captured 429 (follow-up PR):**
- Tighten `isRateLimitResponse()` to match the actual body/header signature
- Add streamed-detection branch if Anthropic returns 429-as-SSE
- Replace `t.todo` markers with real assertions against captured-bytes fixture
- Document the captured response shape in this directive

— Proxy Builder
