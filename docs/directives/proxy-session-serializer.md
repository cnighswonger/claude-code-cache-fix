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
2. **New pipeline hook `onResponseEnd(ctx)`** added to `proxy/pipeline.mjs` and invoked from `proxy/server.mjs` after BOTH the non-streaming response (`clientRes.end(JSON.stringify(resCtx.body))`) and the streaming response (`clientRes.end()` at end of `streamResponse`), AND on the upstream-error / client-abort paths (Codex blocker fix from review #1). Audit confirmed: the current pipeline exposes `onRequest`, `onResponseStart`, and `onResponse` (the latter only fires for non-streaming JSON responses per `proxy/server.mjs:92`; the streaming path at `proxy/stream.mjs:108` bypasses it). Phase 0's collision-completion measurement requires a hook that fires for BOTH paths AND on error / abort. The seam work is scoped INTO Phase 0 here rather than punted to Phase 1.

   Hook contract:
   ```js
   await ext.onResponseEnd(ctx);
   // ctx contains: status, headers (snapshot), meta,
   //   outcome ("200"|"4xx_NNN"|"5xx_NNN"|"aborted"|"timeout"|"error"),
   //   start_ts, end_ts
   ```
   Errors thrown from `onResponseEnd` are logged and swallowed (same convention as other pipeline hook errors).

3. New extension `proxy/extensions/session-observability.mjs` registered at order 690 (between `usage-log` at 650 and `request-log` at 700; this is observation, not mutation, so order is non-load-bearing — runs late so other extensions' mutations are already counted).
4. **Concurrency observation logic**:
   - Detect a session/conversation identifier per request (see §Session identity below).
   - Track in-flight requests per session in a process-local Map.
   - On every incoming request, record: arrival timestamp, session key, current in-flight count for that session.
   - On response completion via the new `onResponseEnd` hook (which fires on stream end, non-stream body close, error, AND client abort), record: completion timestamp, latency, outcome (200 / 4xx / 5xx / aborted / timeout / error).
5. **Concurrent-event detection**:
   - When a request arrives while another is in-flight on the same session, record a "concurrent collision" event.
   - For each collision: record the collision count, the latency of both requests, and the outcomes.
6. **Failure-correlation logging**: for each request, also record whether it landed a 5xx response. The Phase 0 question is whether 5xx rates differ between collision and no-collision requests on the same session.
7. New JSONL log: `~/.claude/session-observability.jsonl` (one line per completed request, including non-collision requests for baseline). Path overridable via `CACHE_FIX_SESSION_OBSERVE_LOG=<path>`.
8. New analysis tool `tools/session-observability-report.mjs` — reads the JSONL log and reports:
   - Collision rate (% of requests that collided with an in-flight request on the same session).
   - 5xx rate by collision-status (collision vs non-collision).
   - Cache-creation tokens by collision-status (proxy for cache invalidation impact).
   - p50 / p95 / p99 latency by collision-status.
   - **Sample-size-aware decision summary** per §Phase 0 success criteria below.
9. README env-var table addition; brief monitoring.md entry.

Out of scope:

- **Actual serialization (queue + delay).** Phase 0 observes; it does not change behavior. Decision to serialize comes after data lands.
- **All four operational concerns from the deferred draft** (queue depth limit, queue timeout, depth-exceeded rejection with 429, queued-timeout rejection with 504). All Phase 1 concerns.
- **Multi-user / non-localhost scoping.** Original draft was localhost-only; Phase 0 doesn't change that. Phase 1 may.

NOTE: the new `onResponseEnd` pipeline hook IS in scope (per §Scope item #2 above) — it's required for Phase 0's collision-completion measurement and could not be punted to Phase 1. The prior draft of this section listed it as out-of-scope; that was wrong and is corrected here.

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
3. **Structural fingerprint** (revised — Codex blocker fix from review #1) — derive a session identifier from STRUCTURAL fields only, NOT from user-prompt content:
   - `body.model`
   - `body.system[*].cache_control` markers (presence + position only, not content)
   - Number of `body.system[]` blocks
   - Number of `body.tools[]` entries (as a stable count)
   - Process-side ephemeral salt (random per proxy startup, persisted in memory only)

   The combination is hashed (SHA-256, then truncated to 16 hex chars for display). Rationale: this is stable WITHIN a session (the model + system block layout doesn't change turn-to-turn for a given CC process) but does NOT include any user prompt text, so the hash cannot be dictionary-attacked back to the user's prompt content.
4. **Connection-level fallback** — same client IP + user-agent within a 30-second window. Imprecise but always available.

Phase 0's observability extension uses (3) — **structural fingerprint with process-side salt** — as the primary key. If we discover (1) or (2) reliably exists, we promote it in Phase 1.

**Why NOT use the prompt-text fingerprint** (the prior draft's choice): a deterministic SHA-256 of `body.system[0].text + body.messages[0]` was vulnerable to dictionary attack — an attacker with access to the `session-observability.jsonl` log AND a guess at the user's prompt corpus could recover plaintext prompt content by hashing candidate prompts and matching. Even truncated to 16 chars, the hash still leaks enough to enable confirm-attacks on specific candidate prompts. The structural fingerprint approach above carries no prompt-derived bits and isn't vulnerable.

The trade-off: structural fingerprint may be LESS unique than a prompt-text fingerprint (two different sessions with the same model + tool layout would collide). For Phase 0's collision-rate measurement that's actually fine — we're measuring "concurrent requests on the same session," and false-merging two distinct concurrent sessions would OVER-report collisions, not under-report. The Phase 0 result is a worst-case upper bound on the collision rate, which is the right side to err on.

The process-side ephemeral salt prevents cross-process and cross-restart correlation (a fresh proxy restart produces fresh keys), reducing the long-term re-identification risk further.

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

`session_key` is the structural fingerprint hash (SHA-256 over the structural fields + process-side ephemeral salt, truncated to 16 hex chars). Per §Session identity, the inputs are STRUCTURAL ONLY — no user prompt text enters the hash — and the salt is per-proxy-startup, ephemeral, in-memory only (not persisted to disk). This means the JSONL log cannot be dictionary-attacked back to user prompt content, AND keys do not correlate across proxy restarts.

`outcome` is one of: `200`, `4xx_<code>`, `5xx_<code>`, `aborted`, `timeout`, `error`. (`error` covers upstream connection failures and any other non-HTTP termination — added per Test 23 in §Outcome classification, which the prior draft of this enum was missing.)

Stats are also surfaced on `ctx.meta.sessionObservabilityStats` for any downstream extension that wants them, with the same fields plus running per-session counters.

## Phase 0 success criteria

After 1 week (or 1000+ logged requests, whichever comes first) of running with `CACHE_FIX_SESSION_OBSERVE=1`, run `tools/session-observability-report.mjs` and answer the gating questions:

| Gating question | Answered by |
|-----------------|-------------|
| 1. Is the failure pattern still observable? | Sample-size-aware comparison of 5xx rate between collision and non-collision requests. **Minimum samples**: ≥ 50 collision events AND ≥ 50 non-collision events from the same observation window. **Decision rule**: compute Wilson 95% confidence intervals for both 5xx rates; pattern is "observable" only if the LOWER bound of collision-5xx CI exceeds the UPPER bound of non-collision-5xx CI by a factor of ≥ 2. (See §Decision rigor below for the rationale.) If samples are insufficient, the answer is "not enough data; extend the observation window" — NOT "no". |
| 2. Can the pipeline provide the response-complete signal? | **Yes — answered by the §Scope item #2 work above.** Phase 0 adds an `onResponseEnd` pipeline hook to `proxy/pipeline.mjs` and wires it from both streaming and non-streaming paths in `proxy/server.mjs`. The current pipeline's `onResponse` hook fires only on non-streaming JSON responses (audited at `proxy/server.mjs:92` and `proxy/stream.mjs:108` — streaming bypasses it). Adding the seam is in scope, not deferred. |
| 3. Cost/benefit on real workloads? | Compare cache-creation tokens between collision and non-collision requests (collisions correlate with cache invalidation). Compare p50/p95/p99 latency between the two populations. Sample-size-aware: same minimum-50 rule per population as question 1. Cost/benefit favorable when (cache-creation token-cost savings) > (estimated queueing latency × user friction quantified as p99 increase). |
| 4. Single-user localhost only — still right scope? | Determined by Phase 0 user mix. If the proxy is only ever single-user, the scope holds. If we see meaningful multi-user deployment by then, Phase 1 needs a per-user partition; doable but additional design. |

### Decision rigor (Codex blocker fix from review #1)

The original "≥ 2× baseline" rule had no minimum-sample requirement and no uncertainty bounds — so it could fire on 3 collisions vs 100 non-collisions with one 5xx in the collision sample (33% rate vs 1% baseline = 33× difference, meaningless). The corrected rule:

1. **Minimum samples**: ≥ 50 collision events and ≥ 50 non-collision events. Below that, the report says "insufficient data" and recommends extending the observation window.
2. **Wilson 95% confidence interval** computed for each population's 5xx rate. Wilson is preferred over normal-approximation because it stays well-behaved at small N and rate boundaries (0% and 100%).
3. **Decision rule**: pattern is "observable" only if `lower_bound(collision_5xx_CI) ≥ 2 × upper_bound(non_collision_5xx_CI)`. The 2× factor is the effect-size threshold; the CI bounds make it statistically defensible at the 95% level.
4. **Three possible outcomes** per the report:
   - `OBSERVABLE` — proceed to Phase 1 design.
   - `NOT_OBSERVABLE` — confidence intervals overlap or the multiplier is < 2; close issue #67 as obsolete.
   - `INSUFFICIENT_DATA` — at least one population is below 50 samples; extend observation, re-run report.

The `tools/session-observability-report.mjs` outputs all three components (sample counts, both Wilson CIs, decision verdict) so the human reading it can audit the math.

The Phase 0 sprint produces a single-paragraph summary in this PR's comments with the answers. Based on those answers:

- All "yes / favorable" → open Phase 1 directive PR with updated v1 design.
- Any "no / unfavorable" → close issue #67 as obsolete with the data attached. The deferred draft stays in `docs/deferred/` as a historical reference.

## Implementation (Phase 0 only — Phase 1 is its own directive if it ships)

### File map

| File | Change |
|------|--------|
| `proxy/pipeline.mjs` | EXTEND — add `runOnResponseEnd(ctx, snapshot)` invoking `ext.onResponseEnd(ctx)` for every loaded extension. Same error-swallow convention as the other hook runners. |
| `proxy/server.mjs` | EXTEND — call `runOnResponseEnd` after both `clientRes.end(JSON.stringify(resCtx.body))` (non-streaming path, around line 94) AND after `streamResponse` returns (streaming path, around line 117), AND in the upstream-error / client-abort branches. The `outcome` and `start_ts`/`end_ts` fields on the ctx are computed at the call site, not by the extension. |
| `proxy/stream.mjs` | EXTEND — capture stream-end / error timestamps so server.mjs can populate the ctx for `onResponseEnd`. May not need any change if server.mjs computes timestamps before/after the `await streamResponse(...)`. Verify during implementation. |
| `proxy/extensions/session-observability.mjs` | NEW — observation extension per pipeline above; only consumes the new `onResponseEnd` hook. |
| `proxy/extensions.json` | EXTEND — add `"session-observability": { "enabled": true, "order": 690 }` |
| `tools/session-observability-report.mjs` | NEW — analysis CLI for the JSONL log; computes Wilson 95% CIs and emits the OBSERVABLE / NOT_OBSERVABLE / INSUFFICIENT_DATA verdict per §Decision rigor. |
| `test/proxy-session-observability.test.mjs` | NEW — collision detection, outcome recording, JSONL shape, structural-fingerprint derivation, all four `onResponseEnd` paths (stream-end, non-stream, error, abort). |
| `test/proxy-pipeline-on-response-end.test.mjs` | NEW — unit test for the new pipeline hook itself; verifies it fires once per request across all four paths and swallows errors per convention. |
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

The `onResponseEnd` hook fires on stream end, non-stream body close, upstream error, AND client abort — all four termination paths, per the §Scope item #2 contract. The pipeline change to add this hook IS part of Phase 0's scope; the implementation does NOT fall back to inline extension-side response handling. (The prior draft's "fall back to inline" text was a holdover from before the hook was scoped in; corrected here.)

## Test plan (Phase 0)

### Session key derivation (structural fingerprint per Codex blocker fix)
1. Two requests with identical `body.model` + system block layout + tool count → same key (regardless of `body.messages` content).
2. Two requests where `body.messages[0]` text DIFFERS but model + structural fields match → SAME key (verifies prompt text is NOT in the hash inputs — Codex blocker fix #3).
3. Two requests differing in `body.model` → different keys.
4. Two requests differing in number of `body.system[]` blocks → different keys.
5. Two requests differing in number of `body.tools[]` entries → different keys.
6. Two requests across a proxy-process restart with otherwise identical inputs → DIFFERENT keys (verifies the process-side ephemeral salt rotates on startup).
7. Empty / missing body fields → defensive fallback key (deterministic constant); doesn't crash.

### Collision detection
8. Single request, no in-flight on session → `collision: false`, `collision_count: 0`.
9. Two requests overlap on session → second records `collision: true`, `collision_count: 1`.
10. Three concurrent requests on session → first records 0 collisions; second records 1; third records 2.
11. Two requests on DIFFERENT sessions overlap → both record `collision: false`.
12. Request completes before second arrives → second records `collision: false`.

### Pipeline hook (new — Codex blocker fix #1)
13. `runOnResponseEnd` fires once per request on the non-streaming JSON path.
14. `runOnResponseEnd` fires once per request on the streaming path (after `streamResponse` resolves).
15. `runOnResponseEnd` fires on the upstream-error path with `outcome: "error"` (or specific 5xx if upstream gave one).
16. `runOnResponseEnd` fires on client-abort with `outcome: "aborted"`.
17. Errors thrown from an `onResponseEnd` handler are caught and logged to stderr; do NOT propagate; subsequent extensions still run.

### Outcome classification
18. 200 OK response → `outcome: "200"`.
19. 429 Too Many Requests → `outcome: "4xx_429"`.
20. 500 Internal → `outcome: "5xx_500"`.
21. Client abort mid-stream → `outcome: "aborted"`.
22. Stream timeout → `outcome: "timeout"`.
23. Upstream connection error (non-HTTP) → `outcome: "error"`.

### JSONL output
24. Completed request → JSONL line written with all documented fields.
25. `session_key` is the structural-fingerprint hash; verify the input `body.messages[0].content` is NOT recoverable from the JSONL output (test: write a JSONL line, then dump the file and grep for any prompt-text substring; should be 0 matches).
26. `CACHE_FIX_SESSION_OBSERVE_LOG=<custom>` overrides default path.
27. Default path is `~/.claude/session-observability.jsonl`.

### Activation
28. `CACHE_FIX_SESSION_OBSERVE` unset → extension fires but exits early. No telemetry, no fs activity, no Map mutation.
29. `CACHE_FIX_SESSION_OBSERVE=1` → all observation behavior runs.

### Analysis tool (Codex blocker fix #2 — sample-size-aware Wilson CIs)
30. `tools/session-observability-report.mjs` reads a fixture JSONL and reports collision rate, 5xx rate by collision status (with Wilson 95% CIs), cache-creation tokens by collision status, and latency percentiles.
31. With < 50 samples in either population → verdict is `INSUFFICIENT_DATA`; the recommend-extending-window text is included in the human output.
32. With ≥ 50 samples in both populations AND `lower(collision_5xx_CI) ≥ 2 × upper(non_collision_5xx_CI)` → verdict is `OBSERVABLE`.
33. With ≥ 50 samples in both populations AND CI bounds don't satisfy the 2× rule → verdict is `NOT_OBSERVABLE`.
34. `--json` mode produces machine-readable output including all CI bounds + sample counts + verdict.

### Regression
35. All v3.3.0 / #90 / #91 / #85 / #63 tests still pass — observation extension is purely additive, doesn't mutate request bodies. The new `onResponseEnd` pipeline hook is also additive (extensions without that handler are skipped per the existing convention).

## Reviewer checklist

- [ ] Activation uses `enabled: true` + runtime env-gate (prefix-diff pattern). `extensions.json` updated.
- [ ] Extension order is 690 (after `usage-log` at 650, before `request-log` at 700).
- [ ] **`onResponseEnd` pipeline hook added** (Codex blocker fix #1) and wired in `proxy/server.mjs` for ALL four termination paths: non-streaming end, streaming end, upstream error, client abort. Verify each path is covered by the new pipeline test.
- [ ] **No mutation of `ctx.body`.** This extension is observational only. Reviewer should grep for any assignment to `ctx.body.*` and confirm none.
- [ ] **Structural fingerprint** (Codex blocker fix #3) — `deriveSessionKey` consumes only structural fields (model, system block layout counts, tool count, process-side ephemeral salt). NO user prompt text in inputs. Verify by inspecting the implementation; tests should include a fixture with prompt-text changes that doesn't change the key.
- [ ] **Wilson 95% confidence intervals** (Codex blocker fix #2) computed in `tools/session-observability-report.mjs`; minimum-50-samples-per-population threshold enforced before producing OBSERVABLE/NOT_OBSERVABLE verdict. INSUFFICIENT_DATA is the third valid output.
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
- Multi-user / per-user partitioning.
- Migration of `docs/deferred/proxy-session-serializer.md` content into a v1 directive (happens IFF Phase 0 greenlights).

NOTE: the `onResponseEnd` pipeline hook is IN scope for Phase 0 (per §Scope item #2). The deferred draft's `onResponseComplete` was a different proposed name; we're shipping `onResponseEnd` in this PR.

— AI Team Lead
