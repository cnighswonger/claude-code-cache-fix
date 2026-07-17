# Directive: Subagent budget circuit breaker

Status: DRAFT (directive stage — pending AITL scope approval + Codex review)
Author: Proxy Builder
Refs: [anthropics/claude-code#68285](https://github.com/anthropics/claude-code/issues/68285)

## Goal

Give the proxy an opt-in **hard spend ceiling** for a session (and, where the wire allows, a workflow fan-out): once cumulative cost/quota-utilization crosses an operator-configured limit, further `/v1/messages` requests are short-circuited locally with a clean synthesized stop, so they never reach Anthropic and therefore cannot consume credits or trigger auto-purchase. This is a **circuit breaker, not a precise meter** — it stops the bleeding, it does not price each request to the cent.

## Why

CC#68285: a Workflow fan-out of 700+ subagents inherited a premium-tier default (`claude-fable-5[1m]`) with **no per-agent model ceiling and no spend gate**. The tier × fan-out multiplication consumed ~$350 of pre-purchased credits and triggered ~$800 of auto-purchased overage across three card transactions before the user could intervene; the spend limit was hit 3× mid-run, corrupting workflow results with partial verdicts. The critical ask from the issue, verbatim:

> "The spend-limit mechanism should not auto-purchase credits without explicit user consent when the overage is caused by a system-side defect."

We cannot change Anthropic's auto-purchase behavior. But auto-purchase is fed by requests, and **every request in a proxy deployment passes through us first.** If we refuse requests once a ceiling is crossed, we starve the overage at its source. The proxy is uniquely positioned here because the two hard primitives already ship:

- **Per-subagent attribution** — `workflow-agent-id-synthesis` already derives a stable per-leg agent id from the wire (`sha256(sessionId + markerId + sha256(first-user-message text))`) for exactly the `parallel()` / `pipeline()` fan-out this issue is about (`proxy/extensions/workflow-agent-id-synthesis.mjs`).
- **Cost/quota signal per request** — `usage-log` already captures full token counts plus `q5h` / `q7d` quota utilization from the `anthropic-ratelimit-unified-*` response headers on every row (`proxy/extensions/usage-log.mjs:145-147`). For a Max-plan overage — which is what bit the #68285 user — quota utilization is a **more direct** signal than dollar estimation, and we already have it.
- **Block mechanism** — the pipeline's `onRequest` → `{ skip: true, ... }` short-circuit (used by `bootstrap-defense`, `image-retry-circuit-breaker`) already refuses a request and synthesizes a response before any upstream call (`proxy/pipeline.mjs:85-99` → `proxy/server.mjs` skip handler).

The gap is precisely **warn → block.** We already ship `overage-warning`, which fires at q5h thresholds but only writes stderr + a JSONL record; it does not stop traffic. This directive adds the hard stop, reusing the SSE-synthesis wire format the image-retry breaker already validated in sim.

## Non-Functional Requirements

- **Size/complexity budget:** extension code ~180 LOC; cumulative-accounting + limit-predicate helpers ~80 LOC; the synthesized-stop wire format is **reused verbatim** from `image-retry-circuit-breaker` (shared helper, not re-implemented); tests ~300 LOC. **Total budget ~600 LOC.** Flag at review if it grows past that. If the SSE synthesis is not already a shared helper by implementation time, extracting it from `image-retry-circuit-breaker` is in scope (and reduces net LOC).
- **Threat model:** the breaker reads request bodies (to identify the model and the workflow/subagent id via the existing derivation helper) and response usage/quota headers. The proxy already does both. Breaker state (cumulative tallies) is **in-memory and per-session**; nothing new persists to disk beyond the optional structured event log of breaker fires. **Never** log request/response bodies, model-input content, or auth headers — the event log carries session id, agent id, cumulative tally, the crossed limit, timestamp, request_id only (matches `bootstrap-defense` / `image-retry` PII discipline). 5 MB single-tier rotation.
- **Activation model:** `enabled: true` in `extensions.json` (always loaded) with an internal env-var gate `CACHE_FIX_SUBAGENT_BUDGET` (tri-state `on` / `off` / `dry-run`, following the `image-retry-circuit-breaker` precedent). **Default OFF** — a spend cap that blocks live traffic must never turn on without an operator deliberately setting a limit. `dry-run` logs what it *would* block without blocking, for tuning the ceiling before arming it.
- **Failure mode — fail-OPEN, always.** This is the load-bearing safety inversion vs. the image breaker. If the accounting is uncertain, the state is missing, a header is unparseable, or anything throws: **forward the request.** A budget breaker that fails closed would wedge a user's entire session on a proxy bug — far worse than the overage it prevents. The only path that blocks is: gate is `on` AND a numerically-confident cumulative tally AND the tally is at/over an explicitly-configured ceiling. Everything else forwards. A single env-var flip (`=off`) fully disables it.
- **Tunables (all opt-in; no ceiling is set by default):**
  - `CACHE_FIX_SUBAGENT_BUDGET` — `off` (default) / `on` / `dry-run`.
  - `CACHE_FIX_SUBAGENT_BUDGET_Q5H_LIMIT` — hard-stop when session `q5h` utilization crosses this float (e.g. `0.90`). Quota-based; the recommended primary lever for Max-plan users (directly matches #68285).
  - `CACHE_FIX_SUBAGENT_BUDGET_TOKENS` — hard-stop when cumulative `input + cache_creation` tokens for the session cross this integer. Plan-agnostic secondary lever.
  - `CACHE_FIX_SUBAGENT_BUDGET_SCOPE` — `session` (default) / `workflow`. `workflow` tallies per derived workflow-root id (see Scope); `session` tallies per `sid`.
  - `CACHE_FIX_SUBAGENT_BUDGET_MAX_ENTRIES` — LRU cap on the tally map (default 4096).
  - At least one of `_Q5H_LIMIT` / `_TOKENS` must be set for the breaker to ever fire; with the gate `on` but no limit set, it is inert (and logs a one-shot stderr note so the operator knows it's armed-but-toothless).

## Pipeline-hook surface (verified against `proxy/pipeline.mjs`)

Four hooks exist: `onRequest`, `onResponseStart`, `onStreamEvent`, `onResponse`. The breaker uses:

- **`onResponse` / `onStreamEvent`** — reads the response `usage` block and the `anthropic-ratelimit-unified-*` quota headers (same source `usage-log` already parses) and **updates the cumulative tally** for this request's session (and workflow-root, if scope=workflow). This is where cost is learned. Output tokens are only known here (post-hoc), which is why the tally gates the *next* request, not the current one.
- **`onRequest`** — before forwarding, checks the current cumulative tally against the configured ceiling for this request's scope key. If at/over: return `{ skip: true, status, headers, body }` with the synthesized stop (below). If under, or if the tally is missing/uncertain: return nothing and forward (fail-open).

**Ordering:** the breaker's `onRequest` must run **after** `workflow-agent-id-synthesis` (so `ctx.meta._workflowAgentId` is populated for scope=workflow). Place its order value after the derivation extension's; verify against `extensions.json` at implementation time.

## Synthesized stop — wire format (reuse image-retry breaker)

**Do not re-implement.** The image-retry circuit breaker already solved clean local short-circuit for both streaming and non-streaming `/v1/messages`, validated in sim (`docs/directives/proxy-image-retry-circuit-breaker.md`, "Synthesized response — wire format"). Reuse the same `{ skip: true, ... }` result shape and SSE event sequence, changing only the short-circuit message text:

```
[cache-fix-proxy] Session budget ceiling reached (<limit-kind>=<limit>, observed=<tally>). This request was stopped locally to prevent further spend — it never reached Anthropic, so no credits were consumed and no auto-purchase can be triggered by it. Raise or clear the ceiling (CACHE_FIX_SUBAGENT_BUDGET_*) to resume. (See CC#68285.)
```

`status: 200` with the standard synthesized envelope so the harness consumes it as a completed turn rather than a hard error that triggers its own retry storm — the exact failure mode the image breaker had to avoid. **The wire-format sim-validation gate below is mandatory; do not merge on the assumption that the image breaker's format transfers unchanged — re-validate against a real fan-out.**

## Observability (matches image-retry breaker's meter-bypass reality)

A skipped request returns before any upstream call, so **no `usage.jsonl` row is written** for the blocked request (correct — no cost was incurred, but note it does not appear in the meter). The **only** observability surface for breaker fires is this extension's JSONL event log at `~/.claude/subagent-budget-events.jsonl` (session id, scope key, agent id, cumulative tally, crossed limit, request_id, ts; 5 MB single-tier rotation). Document this in the extension's README entry so operators don't expect meter rows for blocked requests. `dry-run` mode writes the same events with a `would_block: true` flag and forwards the request.

## Scope

- **v1 (this directive): scope=session is the reliable path.** Per-`sid` cumulative tally + hard ceiling is fully supported by primitives we already have (usage/quota per response, keyed by the boot-sticky `sid`). This alone solves the #68285 shape: the runaway fan-out shares one session, so a session ceiling caps the whole fan-out.
- **v1: scope=workflow is best-effort.** `workflow-agent-id-synthesis` derives `parentId` per leg; tallying to a workflow-root key is feasible where the derivation fires, but carries the same known limitation the derivation directive documents (identical-prompt `parallel()` legs collide on the discriminator). Ship scope=workflow behind the tunable with that caveat explicit; scope=session is the default and the recommended lever.
- **Explicitly OUT of scope:** (1) per-*model-tier* ceilings / model downgrade-on-budget — silently rewriting a subagent's model to a cheaper tier changes results invisibly; block-on-budget is cleaner than rewrite-on-budget, and rewrite is a separate directive if ever wanted. (2) Dollar-precise accounting — we gate on tokens/quota, not a live price table. (3) Anything touching Anthropic's auto-purchase directly — we can only refuse requests, not change billing behavior.

## Known limitations (state honestly in README + PR)

- **Concurrency overshoot.** A large fan-out fires near-simultaneously; by the time the first responses update the tally, many requests are already in flight. The breaker stops the bleeding but **overshoots by roughly the in-flight batch** — realistic outcome is stopping ~tens of dollars over the ceiling, not at it. This is a circuit breaker, not a precise cap. Say so plainly; a user expecting cent-precision will be surprised, and #68285's ask is "don't silently 10×," which this delivers.
- **Output cost is post-hoc.** Accurate cumulative tracking gates the next request; it cannot price the current one in advance.
- **Restart resets the tally.** In-memory state; a proxy restart mid-session zeroes the cumulative count. Acceptable for a safety backstop (a restart is a deliberate operator action); documented, not worked around.

## Sim validation requirement (mandatory before default-on consideration)

Carries `needs-sim-validation` as a merge gate. Validate against a **real workflow fan-out** (not a synthetic single request):

1. The synthesized stop is consumed by the CC harness as a completed turn with **no retry storm** on the blocked subagents (the image-breaker risk, re-verified for the fan-out case).
2. The tally correctly accumulates across concurrent legs and the ceiling fires within the overshoot bound claimed above (measure the actual overshoot; put the number in the PR).
3. `dry-run` forwards every request and logs `would_block` at the right point.
4. Fail-open holds: with the gate `on` but state deliberately corrupted/missing, every request forwards.

## Test plan

- Unit: cumulative-tally accounting across a sequence of responses (tokens + q5h); limit predicate at/under/over for both `_Q5H_LIMIT` and `_TOKENS`; scope=session vs scope=workflow keying; LRU eviction at `_MAX_ENTRIES`.
- Block path: `onRequest` returns the correct `{ skip: true, ... }` for `stream:true` and `stream:false`; the synthesized envelope matches the image-breaker shape.
- **Fail-open:** every throw / missing-state / unparseable-header path forwards (this is the highest-value test class — assert it exhaustively).
- Tri-state gate: `off` inert; `on` + no limit set inert (one-shot stderr note); `dry-run` forwards + logs `would_block`.
- Event log: fields present, no bodies/creds, rotation at 5 MB.

## Files modified / created

- `proxy/extensions/subagent-budget-breaker.mjs` (new) — the extension.
- `proxy/extensions.json` — register `enabled:true`, order after `workflow-agent-id-synthesis`.
- Shared SSE-synthesis helper — extract from `image-retry-circuit-breaker.mjs` if not already shared, and reuse (net LOC reduction).
- `test/proxy-subagent-budget-breaker.test.mjs` (new).
- `README.md` — new section documenting the tunables, the circuit-breaker-not-meter framing, the overshoot limitation, and the meter-bypass observability note.
- This directive.

## Reviewer checklist (cache-fix side)

- Fail-open is provably the default for every non-happy path (grep every `catch` and every early return; none block).
- The breaker never reads or logs message content, bodies, or auth headers.
- Order runs after `workflow-agent-id-synthesis`; scope=workflow degrades to session-equivalent when derivation doesn't fire, rather than mis-keying.
- Default-off; no ceiling set by default; `dry-run` genuinely forwards.
- The synthesized stop reuses (not forks) the image-breaker wire format, and the sim-validation gate is satisfied before any default-on discussion.
- **Load-bearing** (blocks live credential-bearing traffic on a spend condition): requires human (Chris) review before merge, not just Lead + Codex.

## Out of scope (explicit)

Model downgrade-on-budget; dollar-precise pricing; changing Anthropic auto-purchase; persisting the tally across restarts; per-model-tier ceilings. Each is a separate directive if ever wanted.
