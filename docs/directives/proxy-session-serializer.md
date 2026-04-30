# Directive: per-session request serializer (revisit)

**Issue:** #67
**Branch:** `directive/session-serializer`
**Stage:** directive
**Milestone:** v3.4.0 (P3)
**Original deferred draft:** `docs/deferred/proxy-session-serializer.md` (2026-04-21)

## Goal

Decide whether to revive the deferred per-session request serializer design and, if so, ship it as a proxy extension. The original concept (FIFO queue per session, only one request in-flight per conversation at a time) was shelved 2026-04-21 because the pre-v3.0 pipeline assumptions had drifted, the gating questions in #67 weren't answered, and the measured failure pattern wasn't load-bearing enough to justify the latency hit.

This directive is a **two-phase split**:

- **Phase 0 (in scope, v3.4.0): a 1-week observability sprint** that answers the four gating questions in #67 with data, not intuition. Outputs: a yes/no decision recorded in this PR's comments + (if "yes") a follow-up directive PR that updates the deferred draft to the v3.x pipeline shape and ships the serializer.
- **Phase 1 (out of scope, conditional on Phase 0): implementation.** Only happens if Phase 0 confirms the concurrent-request failure pattern is still observable AND the cost/benefit math favors serialization. Otherwise this issue closes as obsolete.

The honest framing is: we don't currently know whether this is still worth doing. Building Phase 0 first is cheaper than building the serializer and discovering nobody triggers the bug it solves.

## Why

The original concept came from [@fgrosswig](https://github.com/fgrosswig) via his proxy-based observability work. CC was firing concurrent HTTP requests on the same conversation (parallel tool calls, subagents, simultaneous tool use), and Anthropic's API was responding poorly: request rejection, cache invalidation, degraded model selection. fgrosswig confirmed that serializing requests per session eliminated those modes.

That was a year ago in proxy-time (the draft is from 2026-04-21, near the start of the project). Two things happened since:

1. **The proxy v3.0 multi-extension architecture landed.** The deferred draft references hooks (`onResponseComplete`) that don't exist in the current pipeline. Either we add the hook (substantive runtime change) or we work within `onRequest` / response-stream callbacks. Either path is viable; the choice depends on how complete the response-complete signal needs to be.
2. **Anthropic's API has had several rounds of behavior change since.** The original failure modes may have been mitigated upstream. We have no current data confirming or refuting this.

Issue #67 explicitly says: "Not picking this up unless we have a fresh reason to." Phase 0 is the cheapest way to find out whether there is a fresh reason.

## Source of truth

This directive operationalizes issue #67's "what needs revisiting" list:

1. Is the concurrent-request failure pattern still observable on current CC + current Anthropic API behavior, or has it been mitigated upstream?
2. Does the extension pipeline now provide (or could it cleanly provide) the response-complete signal the serializer needs?
3. What's the actual cost/benefit on real workloads — does serialization help cache stability enough to outweigh the latency impact on subagent-heavy sessions?
4. Single-user localhost only (per the original draft) — still the right scope?

Phase 0 below answers each one with measurement.

Key references:
- Issue #67 — gating questions, deferred status, fgrosswig credit.
- `docs/deferred/proxy-session-serializer.md` — original draft (preserved as historical reference; do NOT update in place — the new v1 directive supersedes it once Phase 1 lands).
- `proxy/pipeline.mjs` — current extension pipeline. The serializer would need a `onResponseComplete` hook OR a stream-end callback that doesn't currently exist.
- `proxy/server.mjs` — response-streaming code. The point at which we can detect "response fully delivered" lives here.

## Scope (v3.4.0 — Phase 0 only)

In scope:

1. New env var `CACHE_FIX_SESSION_OBSERVE=1` — opt-in observability gate. Default off.
2. New extension `proxy/extensions/session-observability.mjs` registered at order 690 (between `usage-log` at 650 and `request-log` at 700; this is observation, not mutation, so order is non-load-bearing — runs late so other extensions' mutations are already counted).
3. **Concurrency observation logic**:
   - Detect a session/conversation identifier per request (see §Session identity below).
   - Track in-flight requests per session in a process-local Map.
   - On every incoming request, record: arrival timestamp, session key, current in-flight count for that session.
   - On response completion (stream end OR non-stream body close OR error OR client abort), record: completion timestamp, latency, outcome (200 / 4xx / 5xx / aborted / timeout).
4. **Concurrent-event detection**:
   - When a request arrives while another is in-flight on the same session, record a "concurrent collision" event.
   - For each collision: record the collision count, the latency of both requests, and the outcomes.
5. **Failure-correlation logging**: for each request, also record whether it landed a 5xx response. The Phase 0 question is whether 5xx rates differ between collision and no-collision requests on the same session.
6. New JSONL log: `~/.claude/session-observability.jsonl` (one line per completed request, including non-collision requests for baseline). Path overridable via `CACHE_FIX_SESSION_OBSERVE_LOG=<path>`.
7. New analysis tool `tools/session-observability-report.mjs` — reads the JSONL log and reports:
   - Collision rate (% of requests that collided with an in-flight request on the same session).
   - 5xx rate by collision-status (collision vs non-collision).
   - Cache-creation tokens by collision-status (proxy for cache invalidation impact).
   - p50 / p95 / p99 latency by collision-status.
8. README env-var table addition; brief monitoring.md entry.

Out of scope:

- **Actual serialization (queue + delay).** Phase 0 observes; it does not change behavior. Decision to serialize comes after data lands.
- **The `onResponseComplete` pipeline hook.** Phase 0 detects response completion via the stream-end / response-close callbacks already available to extensions. If Phase 1 ships, that's where the hook decision gets made.
- **All four operational concerns from the deferred draft** (queue depth limit, queue timeout, depth-exceeded rejection with 429, queued-timeout rejection with 504). All Phase 1 concerns.
- **Multi-user / non-localhost scoping.** Original draft was localhost-only; Phase 0 doesn't change that. Phase 1 may.

## Activation

**Prefix-diff pattern**:

- Extension `enabled: true` in `proxy/extensions.json`, registered at order 690.
- Runtime gate inside `onRequest` (and response callbacks): `if (!isEnabled()) return;` at top.
- No legacy back-compat (extension didn't exist before).
- Observability is non-mutating — turning the env var on is safe in production with no behavior change.

The PR #79 round-1 mistake (`enabled: false` + env-var gate cannot work because the loader skips disabled extensions) is avoided by construction.

## Session identity

The serializer concept keys on whatever session/conversation identifier CC includes in requests. We need to pin this for Phase 0 because the collision detection depends on it.

Candidate sources, in order of preference:

1. **Anthropic-specific session header** — if Anthropic exposes one (e.g., `anthropic-conversation-id`). Inspect a captured request body for any header that looks session-scoped.
2. **CC-emitted session header** — CC may add a `claude-session-id` or similar. The `cc_version` fingerprint is per-process, not per-session, so don't use it.
3. **Request body fingerprint** — derive a session identifier from `body.system[0].text` (the static system prompt) + the first user message text. Stable within a session, differs across sessions. This is the heuristic the current `cache-telemetry` extension uses to bucket sessions.
4. **Connection-level fallback** — same client IP + user-agent within a 30-second window. Imprecise but always available.

Phase 0's observability extension uses (3) — body-fingerprint hashing — as the primary key. If we discover (1) or (2) reliably exists, we promote it in Phase 1. The reason to use (3) for observability: it doesn't depend on hypothetical headers, it's deterministic, and even if it's slightly imprecise (rare cross-session collisions on identical first user messages), the false-positive rate is low enough not to invalidate the collision-rate measurement.

## Telemetry

JSONL log entry shape (one line per completed request):

```json
{
  "ts": "2026-04-30T18:00:00.123Z",
  "session_key": "sha256:abc123...",
  "request_id": "uuid-or-anthropic-request-id",
  "arrival_ts": "2026-04-30T18:00:00.000Z",
  "completion_ts": "2026-04-30T18:00:00.123Z",
  "latency_ms": 123,
  "in_flight_at_arrival": 2,
  "collision": true,
  "collision_count": 1,
  "outcome": "200",
  "model": "claude-opus-4-7-20260101",
  "cache_creation_tokens": 4521,
  "cache_read_tokens": 18234
}
```

`session_key` is hashed (SHA-256, truncated to 16 hex chars displayed) — never the plaintext fingerprint, since the fingerprint contains user prompt text.

`outcome` is one of: `200`, `4xx_<code>`, `5xx_<code>`, `aborted`, `timeout`.

Stats are also surfaced on `ctx.meta.sessionObservabilityStats` for any downstream extension that wants them, with the same fields plus running per-session counters.

## Phase 0 success criteria

After 1 week (or 1000+ logged requests, whichever comes first) of running with `CACHE_FIX_SESSION_OBSERVE=1`, run `tools/session-observability-report.mjs` and answer the gating questions:

| Gating question | Answered by |
|-----------------|-------------|
| 1. Is the failure pattern still observable? | Compare 5xx rate between collision and non-collision requests. If collision-5xx-rate is materially higher (≥ 2× the non-collision baseline), the pattern is observable. If they're statistically indistinguishable, it's been mitigated upstream. |
| 2. Can the pipeline provide the response-complete signal? | Phase 0 implementation is the answer — if we can build the observability extension at all, we can hook response completion. The deferred draft's `onResponseComplete` hook isn't strictly necessary; stream-close callbacks are sufficient. |
| 3. Cost/benefit on real workloads? | Compare cache-creation tokens between collision and non-collision requests (collisions correlate with cache invalidation). Compare p50/p95 latency to estimate the queueing cost (latency_ms is what queueing would add to the SECOND request in any pair). Cost/benefit favorable when (cache-creation savings × $rate) > (queueing latency × user friction). |
| 4. Single-user localhost only — still right scope? | Determined by Phase 0 user mix. If the proxy is only ever single-user, the scope holds. If we see meaningful multi-user deployment by then, Phase 1 needs a per-user partition; doable but additional design. |

The Phase 0 sprint produces a single-paragraph summary in this PR's comments with the answers. Based on those answers:

- All "yes / favorable" → open Phase 1 directive PR with updated v1 design.
- Any "no / unfavorable" → close issue #67 as obsolete with the data attached. The deferred draft stays in `docs/deferred/` as a historical reference.

## Implementation (Phase 0 only — Phase 1 is its own directive if it ships)

### File map

| File | Change |
|------|--------|
| `proxy/extensions/session-observability.mjs` | NEW — observation extension per pipeline above |
| `proxy/extensions.json` | EXTEND — add `"session-observability": { "enabled": true, "order": 690 }` |
| `tools/session-observability-report.mjs` | NEW — analysis CLI for the JSONL log |
| `test/proxy-session-observability.test.mjs` | NEW — collision detection, outcome recording, JSONL shape, session-key derivation |
| `README.md` | EXTEND — env-var table addition; brief "Session observability (Phase 0)" section |
| `docs/monitoring.md` | EXTEND — env-var table rows |

### Pure functions exposed for tests

```js
export {
  deriveSessionKey,                 // (body) → sha256 hex (16 chars displayed)
  recordRequestArrival,             // (sessionMap, sessionKey, requestId, ts) → { in_flight_at_arrival, collision, collision_count }
  recordRequestCompletion,          // (sessionMap, sessionKey, requestId, ts, outcome, ...usage) → JSONL line
  appendObservabilityRecord,        // (path, record) → Promise<void>
};
```

`deriveSessionKey` is the load-bearing function — a key drift bug would invalidate every measurement.

### Pipeline (sketch)

```js
async function onRequest(ctx) {
  if (!isEnabled()) return;
  const sessionKey = deriveSessionKey(ctx.body);
  const arrival = recordRequestArrival(sessionMap, sessionKey, ctx.requestId, Date.now());
  ctx.meta.sessionObservability = { sessionKey, arrival_ts: Date.now(), arrival };
}

async function onResponseEnd(ctx, response) {
  if (!isEnabled()) return;
  const meta = ctx.meta.sessionObservability;
  if (!meta) return;
  const record = recordRequestCompletion(sessionMap, meta.sessionKey, ctx.requestId, Date.now(), classifyOutcome(response), {
    model: ctx.body.model,
    cache_creation_tokens: extractCacheCreation(response),
    cache_read_tokens: extractCacheRead(response),
  });
  await appendObservabilityRecord(getLogPath(), record);
}
```

The `onResponseEnd` hook needs to fire on stream end OR non-stream body close OR error. If the current pipeline doesn't emit a unified callback, the implementation wraps response handling inline in the extension. Either approach is acceptable for Phase 0; Phase 1 (if it ships) might benefit from a proper hook.

## Test plan (Phase 0)

### Session key derivation
1. Two requests with identical `body.system[0].text` + `body.messages[0]` → same key.
2. Two requests differing only in `body.messages[1]` (later in conversation) → same key (key derives from session-stable fields).
3. Two requests differing in `body.system[0].text` (different session) → different keys.
4. Empty / missing body fields → defensive fallback key (constant or hash-of-headers); doesn't crash.

### Collision detection
5. Single request, no in-flight on session → `collision: false`, `collision_count: 0`.
6. Two requests overlap on session → second records `collision: true`, `collision_count: 1`.
7. Three concurrent requests on session → first records 0 collisions; second records 1; third records 2.
8. Two requests on DIFFERENT sessions overlap → both record `collision: false`.
9. Request completes before second arrives → second records `collision: false`.

### Outcome classification
10. 200 OK response → `outcome: "200"`.
11. 429 Too Many Requests → `outcome: "4xx_429"`.
12. 500 Internal → `outcome: "5xx_500"`.
13. Client abort mid-stream → `outcome: "aborted"`.
14. Stream timeout → `outcome: "timeout"`.

### JSONL output
15. Completed request → JSONL line written with all documented fields.
16. `session_key` is hashed; plaintext fingerprint never appears in output.
17. `CACHE_FIX_SESSION_OBSERVE_LOG=<custom>` overrides default path.
18. Default path is `~/.claude/session-observability.jsonl`.

### Activation
19. `CACHE_FIX_SESSION_OBSERVE` unset → extension fires but exits early. No telemetry, no fs activity, no Map mutation.
20. `CACHE_FIX_SESSION_OBSERVE=1` → all observation behavior runs.

### Analysis tool
21. `tools/session-observability-report.mjs` reads a fixture JSONL and reports collision rate, 5xx rate by collision status, cache-creation tokens by collision status, and latency percentiles.
22. `--json` mode produces machine-readable output.

### Regression
23. All v3.3.0 / #90 / #91 / #85 / #63 tests still pass — extension is purely observational, doesn't mutate request bodies.

## Reviewer checklist

- [ ] Activation uses `enabled: true` + runtime env-gate (prefix-diff pattern). `extensions.json` updated.
- [ ] Extension order is 690 (after `usage-log` at 650, before `request-log` at 700).
- [ ] **No mutation of `ctx.body`.** This extension is observational only. Reviewer should grep for any assignment to `ctx.body.*` and confirm none.
- [ ] `deriveSessionKey` produces a hash, not plaintext. Test 16 verifies.
- [ ] Collision detection is correct for overlapping AND non-overlapping cases. Tests 5-9 cover both.
- [ ] Outcome classification handles 200, 4xx, 5xx, aborted, timeout. Tests 10-14 verify.
- [ ] JSONL append is async / non-blocking; doesn't slow request handling.
- [ ] No new top-level npm dependencies (sha256 via Node's built-in `crypto`).
- [ ] CI green on Node 18 / 20 / 22.
- [ ] README + monitoring.md updated.
- [ ] Phase 0 → Phase 1 decision criteria are explicit; the success criteria table in §Phase 0 success criteria is the standard for the post-sprint write-up.

## Out of scope (explicit, deferred to Phase 1 IFF Phase 0 greenlights)

- FIFO queue + serialization behavior (the actual serializer).
- Queue depth limits + 429 rejection.
- Queue timeout + 504 rejection.
- `onResponseComplete` pipeline hook (vs. extension-local response handling).
- Multi-user / per-user partitioning.
- Migration of `docs/deferred/proxy-session-serializer.md` content into a v1 directive (happens IFF Phase 0 greenlights).

— AI Team Lead
