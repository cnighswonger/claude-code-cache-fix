# Directive: Session budget circuit breaker

Status: DRAFT (directive stage — AITL scope approved; Codex round-1 REQUEST_CHANGES addressed in this revision)
Author: Proxy Builder
Refs: [anthropics/claude-code#68285](https://github.com/anthropics/claude-code/issues/68285)

> **Rename note (r2):** originally "subagent budget circuit breaker." Renamed to
> **session** budget circuit breaker because the reliable, wire-supported unit is
> the session, not the individual subagent (see Scope). This is honest framing:
> the ceiling is per-session, and once crossed it blocks the next `/v1/messages`
> in that session — including a top-level turn, not only fan-out children.

## Goal

Give the proxy an opt-in **hard per-session spend ceiling**: once a session's
cumulative token consumption (or our estimated cost, or its consumption *rate*)
crosses an operator-configured limit, further `/v1/messages` for that session are
short-circuited locally with a clean synthesized stop, so they never reach
Anthropic and therefore cannot consume credits, trigger auto-purchase, or (for
direct API-key users) keep billing the card. It serves **both billing models** —
subscription/OAuth and pay-as-you-go API key — since the tally is body-sourced and
auth-independent; for API-key users the cost lever is a literal dollar ceiling (see
Billing models covered). This is a **circuit breaker, not a precise meter** — it
stops the bleeding, it does not price each request to the cent.

## Why (refs CC#68285)

A Workflow fan-out of 700+ subagents inherited a premium-tier default
(`claude-fable-5[1m]`) with **no per-agent model ceiling and no spend gate**. The
tier × fan-out multiplication consumed ~$350 of pre-purchased credits and
triggered ~$800 of auto-purchased overage across three card transactions before
the user could intervene; the spend limit was hit 3× mid-run, corrupting workflow
results with partial verdicts. The critical ask, verbatim:

> "The spend-limit mechanism should not auto-purchase credits without explicit
> user consent when the overage is caused by a system-side defect."

**Why per-session is the correct and sufficient lever for this exact issue:** the
runaway was one workflow fan-out inside **one session** — all 700 subagents are
children of a single session id. A per-session cumulative ceiling caps that
session before it can drive the account quota up into auto-purchase territory. We
cannot change Anthropic's auto-purchase; but every request in a proxy deployment
passes through us first, and refusing a session's requests once *its own* tally
crosses the ceiling stops the offending session at the source. **This directive
does not ship unless it demonstrably caps the #68285 fan-out pattern** (see Sim
validation).

## What changed since Codex round 1 (design corrections)

Codex's round-1 directive review (`docs/code-reviews/directive-subagent-budget-circuit-breaker-codex.md`) found three design-level gaps, all verified against code. This revision fixes them:

1. **Do NOT use Anthropic's account-global `q5h` header as a per-session lever.**
   `usage-log.mjs:145` reads `anthropic-ratelimit-unified-5h-utilization` straight
   from the response header — that is the **account's** rolling 5h window, which
   already includes every other session/client/machine on the account. Blocking a
   session on it would trip an innocent session because another one burned quota.
   **Fix:** the blocking lever is a **per-session tally we compute ourselves** from
   the per-session-tagged usage rows we already write (each carries `sid` + `ts` +
   full token counts). Anthropic's account `q5h` is used only for an *observational*
   attribution signal (below), never as a blocking gate.
2. **`scope=workflow` is not implementable from the cited primitive.**
   `deriveParentAgentId(sessionId)` = `sha16(sessionId + "workflow-root")` — one
   constant per session, so all derived Workflow legs (across all runs in a
   session) collapse into one bucket. There is no wire-visible per-workflow-run
   discriminator. **Fix:** v1 is **session-scoped only.** `scope=workflow` is
   removed; a v2 note records what a real per-run key would require.
3. **Explicit `Load-bearing?` declaration** was missing from the NFR section. Added
   below.

## Billing models covered (both — and the API-key case is the more severe one)

The breaker serves **both** billing models, because the mechanism is
billing-agnostic: the proxy forwards whatever auth the client sends (`x-api-key`
or OAuth bearer — both already in the redaction set at `server.mjs:30-36`), and
the token counts it tallies come from the response **body** (`msg.usage`,
`usage-log.mjs:89-90`), which every Messages API response carries regardless of
how the request authenticated. So the per-session token tally and the cost lever
work identically for a subscription client and a raw API-key client.

- **Subscription (OAuth, e.g. Max) — the #68285 case.** Tokens are quota-until-
  overage; the danger is the auto-purchase wall the account `q5h` gates. The
  token/rate levers cap the runaway *session* before it drives the account into
  auto-purchase. This is the referenced incident.
- **Direct API key (pay-as-you-go) — the more severe case, and arguably the
  primary audience for the cost lever.** There is **no quota buffer at all**: every
  token is billed immediately at API list price. The same 700-subagent fan-out on
  an API key has *no* spend circuit whatsoever — it charges the card until the
  key's own tier limit or the bank intervenes (worse than #68285, which at least
  had a Max-plan spend rail that fired, badly, 3×). For these users
  `CACHE_FIX_SESSION_BUDGET_COST_USD` is a **literal dollar ceiling** —
  `tools/rates.json` is Anthropic's API list pricing
  (source: platform.claude.com/docs/pricing), so `tokens × rates.json` is real
  money out of pocket, per token. Cost is their **primary** lever; tokens/rate are
  the plan-agnostic backstops.
- **Graceful degradation of the observational signal.** The per-session account-
  `q5h` contribution signal is subscription-specific (it derives from the
  `anthropic-ratelimit-unified-*` headers). API-key traffic is unlikely to carry
  those, so the signal reads absent (`?? 0`) and simply doesn't render — which is
  fine, since it was already demoted to non-blocking and fail-opens on absence. No
  behavior change for API-key users; they rely on the cost/token/rate levers, all
  of which are body-sourced and auth-independent.

**Implication for the cost lever (sharpens the staleness caveat below):** because
`_COST_USD` is a *real dollar ceiling* for API-key users, `rates.json` staleness
matters more than for a notional subscription estimate. If `rates.json` lags a new
model's price, the cost lever silently under-counts (an unknown model contributes
0 to the cost tally — fail-open by design). The **token** and **rate** levers stay
exact regardless, so the guidance for API-key users who want a hard dollar cap is:
set a `_TOKENS` ceiling too, so a stale/unknown rate can't let cost run past the
intended dollar figure unbounded. The implementation and README must state this
plainly.

## The signals (all derived from data we already write)

Every `~/.claude/usage.jsonl` row already carries, per request: `sid` (boot-sticky
8-char session id), `ts`, `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`, and the account
`q5h`/`q7d` plus `q5h_delta`/`q7d_delta` (`usage-log.mjs:145-146,201-202`). From
the rows for a given `sid` the breaker computes, in-memory:

- **Cumulative tokens** — running sum of `input + cache_creation` (the cost-bearing
  inputs; cache_read is cheap and output is post-hoc) for the session.
- **Estimated cost (USD)** — cumulative tokens × the per-model rates in
  `tools/rates.json` (already maintained in-repo). Best-effort: rates.json may lag
  a new model; unknown model → cost signal unavailable for that request (fail-open,
  below), token signal still works.
- **Consumption rate** — tokens/min (or $/min) over a sliding window using the
  per-row `ts`. **This is the early-fan-out signal:** 700 subagents firing
  near-simultaneously produce a rate spike detectable in the first 1-2s, so a rate
  trip can fire on the *slope* and cut the runaway earlier than a pure cumulative
  ceiling (which only trips after the tokens land — the concurrency-overshoot
  limitation). Rate trips are the main mitigation for overshoot.
- **Per-session account-q5h contribution (OBSERVATIONAL ONLY, never a block gate)**
  — attribute the account's `q5h_delta` to the session that caused it by the
  session's token share of the window, giving "this session is responsible for ~X%
  of the account's 5h quota burn" and its rate. Useful for operators to see *which*
  session is driving the account quota, and surfaced in the event log / statusline
  follow-up. It is **not** a blocking lever (it's derived from an account-global
  number); it informs humans, it does not gate traffic.

## Blocking levers (opt-in; no ceiling set by default)

At least one must be set for the breaker to ever fire. All per-session:

- `CACHE_FIX_SESSION_BUDGET_TOKENS` — hard-stop when cumulative `input +
  cache_creation` tokens for the session cross this integer. Plan-agnostic;
  the primary lever for subscription users and the exact-signal backstop for
  API-key users.
- `CACHE_FIX_SESSION_BUDGET_COST_USD` — hard-stop when estimated cost (tokens ×
  rates.json) crosses this float. Requires a known model in rates.json; falls back
  to token-only if the rate is unknown. **The primary lever for direct API-key
  users** (a literal dollar ceiling). Because an unknown/stale rate makes this
  under-count (fail-open), an API-key user who wants a guaranteed dollar cap should
  ALSO set `_TOKENS` as a belt-and-suspenders bound — a stale rate then cannot let
  spend run past the token bound unbounded.
- `CACHE_FIX_SESSION_BUDGET_RATE_TPM` — hard-stop when the session's
  tokens/min over the sliding window crosses this integer (early fan-out catch).
- `CACHE_FIX_SESSION_BUDGET_RATE_WINDOW_MS` — sliding window for the rate levers
  (default 60000).

Gate: `CACHE_FIX_SESSION_BUDGET` — `off` (default) / `on` / `dry-run`. With `on`
but no ceiling set, inert + a one-shot stderr note (armed-but-toothless).
`CACHE_FIX_SESSION_BUDGET_MAX_ENTRIES` — LRU cap on the per-session tally map
(default 4096).

## Non-Functional Requirements

- **Size/complexity budget:** extension ~180 LOC; tally/rate/cost helpers ~120 LOC;
  the synthesized-stop wire format is **reused** from `image-retry-circuit-breaker`
  (shared helper, extract if not already shared); tests ~320 LOC. **Total ~620
  LOC.** Flag at review if it grows past that.
- **Threat model:** reads response `usage` blocks + quota headers (same source
  `usage-log` parses) and request bodies only to the extent the existing derivation
  already does (for the `sid`). Tally state is **in-memory, per-session**; nothing
  new persists beyond the optional event log. **Never** log request/response
  bodies, model-input content, or auth headers — the event log carries `sid`,
  cumulative tally, estimated cost, the crossed limit, `request_id` (nullable — see
  below), `ts` only. 5 MB single-tier rotation (matches `bootstrap-defense` /
  `image-retry`).
- **Load-bearing? YES.** This blocks live, credential-bearing `/v1/messages`
  traffic on a spend condition. It requires **human (Chris) review before any
  implementation merge**, not just Lead + Codex, and sim-validation against a real
  fan-out (below).
- **Failure mode — fail-OPEN, always.** If accounting is uncertain, state is
  missing, a header/usage field is unparseable, the model is unknown to rates.json
  (for the cost lever only), or anything throws: **forward the request.** A budget
  breaker that failed closed would wedge a whole session on a proxy bug — worse than
  the overage. The fail-open contract is specified as a table (below), not left to
  the implementer. One env-var flip (`=off`) fully disables it.
- **Performance:** the tally update is O(1) per response (increment + sliding-window
  prune); the map is LRU-bounded. No disk I/O on the request path beyond the
  optional append-only event log on a fire.

## Fail-open contract (explicit — closes Codex attention item)

Per metric, per request. The breaker BLOCKS only when the gate is `on` AND at
least one lever is **confidently** at/over its ceiling. Everything else forwards.

| Condition | Token lever | Cost lever | Rate lever | Overall |
|---|---|---|---|---|
| Gate `off` | — | — | — | **forward** |
| Gate `on`, no ceiling set | inert | inert | inert | **forward** (one-shot note) |
| `usage` block present, tokens parse | tally updates; block if ≥ ceiling | as tokens, × known rate | window updates; block if ≥ ceiling | block if ANY lever confidently over |
| `usage` missing / token field unparseable | **this metric not updated; not a block** | not updated | not updated | **forward** (no confident tally) |
| Model unknown to rates.json | token lever unaffected | **cost lever unavailable this request; not a block** | unaffected | token/rate can still block; cost cannot |
| Tally/map entry missing (first request, post-restart) | starts at 0 | 0 | empty window | **forward** |
| Any throw in the extension | — | — | — | **forward** (pipeline catches) |

Key rule: an unparseable/missing metric invalidates **only that metric**, never the
whole decision, and never flips a forward into a block. A block requires a
positive, numerically-confident over-ceiling on at least one lever.

## Pipeline-hook surface (verified against `proxy/pipeline.mjs`)

- **`onResponse` / `onStreamEvent`** — read the response `usage` + quota headers
  (same source `usage-log` parses at `usage-log.mjs:306-350`) and **update the
  per-session tally** keyed by `sid`. Cost is learned here (output post-hoc), which
  is why the tally gates the *next* request.
- **`onRequest`** — before forwarding, check the session's current tally/rate
  against the ceilings. If confidently over → `{ skip: true, ... }` synthesized
  stop. Else forward (fail-open). The `sid` for keying is available from the same
  header the usage-log/derivation path already reads; **no dependency on
  `workflow-agent-id-synthesis`** now that scope is session-only (removes the
  ordering constraint from round 1).

## Synthesized stop — wire format (reuse image-retry breaker)

Reuse the image-retry breaker's validated `{ skip: true, ... }` shape and SSE
sequence (`image-retry-circuit-breaker.mjs:216-269`), changing only the message:

```
[cache-fix-proxy] Session token/cost ceiling reached (<lever>=<limit>, observed=<tally>). This request was stopped locally to prevent further spend — it never reached Anthropic, so no credits were consumed and no auto-purchase can be triggered by it. Raise or clear the ceiling (CACHE_FIX_SESSION_BUDGET_*) to resume. (See CC#68285.)
```

`status: 200` with the standard synthesized envelope so the harness consumes it as
a completed turn, not a hard error that triggers its own retry storm. **The
wire-format sim-validation gate is mandatory** — re-validate against a real fan-out,
do not assume the image-breaker format transfers unchanged.

## Observability

A skipped request returns before any upstream call → **no `usage.jsonl` row** for
the blocked request (correct — no cost incurred, but note it's not in the meter).
The only observability surface for fires is this extension's JSONL event log at
`~/.claude/session-budget-events.jsonl` (`sid`, cumulative tally, estimated cost,
crossed lever+limit, per-session account-q5h contribution, `request_id`, `ts`; 5 MB
single-tier rotation). `dry-run` writes the same events with `would_block: true`
and forwards.

**`request_id` is nullable (closes Codex attention item):** the usual source is the
upstream `request-id` response header, which a locally-blocked request does not
have. Populate it from the client-supplied request header if present, else null.
Never fabricate one.

## Scope

- **v1: session-scoped only.** Per-`sid` cumulative tokens + cost + rate, with
  hard ceilings. Fully supported by primitives verified in-tree. Solves #68285 (the
  runaway fan-out shares one `sid`).
- **Removed from v1: `scope=workflow`.** The derivation helper only provides a
  session-wide synthetic root (`sha16(sessionId + "workflow-root")`), not a
  per-run bucket — verified at `workflow-agent-derivation.mjs:30-32`. Session
  scope already caps the #68285 case, so nothing is lost for the required fix.
- **v2 note (not this directive):** a real per-workflow-run ceiling would need a
  wire-visible run discriminator. CC keeps the workflow-run id in in-process state,
  not the request body (per the workflow-agent-id-synthesis directive's binary
  finding), so this is blocked on an upstream change or a new derivation input;
  out of scope until one exists.
- **Explicitly OUT of scope:** model downgrade-on-budget (silent result changes —
  block, don't rewrite); dollar-precise accounting (we estimate from rates.json);
  anything touching Anthropic's auto-purchase directly (we refuse requests, not
  billing); persisting the tally across restarts.

## Known limitations (state honestly in README + PR)

- **Concurrency overshoot.** A large fan-out fires near-simultaneously; a pure
  cumulative ceiling trips only after the in-flight batch's tokens land, so it
  overshoots by ~that batch. **The rate lever (`_RATE_TPM`) mitigates this** by
  firing on the slope before the batch completes; measure and report the actual
  overshoot for both levers in sim.
- **Output cost is post-hoc** — the tally gates the next request, not the current.
- **Cost is an estimate** — tokens × rates.json, which may lag a new model; the
  token and rate levers are exact, the cost lever is best-effort.
- **Restart resets the tally** — in-memory; a mid-session restart zeroes it.
  Acceptable for a safety backstop; documented.
- **Per-session, not per-account** — caps the offending *session*; it cannot lower
  Anthropic's account-global quota or stop auto-purchase directly. For a
  single-session runaway (#68285), capping that session is the right and
  sufficient action.

## Sim validation requirement (mandatory; gates default-on AND merge per #68285 bar)

Carries `needs-sim-validation`. Validate against a **real workflow fan-out**:

1. **The #68285 case is demonstrably capped:** a fan-out that would exceed the
   ceiling is stopped, with the measured overshoot for both the cumulative and rate
   levers reported in the PR. This is the ship gate — no merge if it doesn't cap the
   referenced pattern.
2. The synthesized stop is consumed as a completed turn with **no retry storm** on
   blocked subagents.
3. The tally accumulates correctly across concurrent legs; the rate lever fires on
   the slope earlier than the cumulative lever.
4. `dry-run` forwards every request and logs `would_block` at the right point.
5. Fail-open holds: gate `on` + deliberately corrupted/missing state → every
   request forwards.

## Test plan

- Unit: cumulative token/cost/rate accounting across a response sequence; each
  lever's predicate at/under/over; sliding-window rate math with injected
  timestamps (note: `Date.now()` is available in the extension at runtime, but tests
  inject `ts`); LRU eviction; unknown-model cost fallback.
- Block path: `onRequest` returns the correct `{ skip: true, ... }` for
  `stream:true`/`false`; envelope matches the image-breaker shape.
- **Fail-open:** every row of the fail-open table above is a test case — this is the
  highest-value class; assert exhaustively.
- Tri-state gate; nullable `request_id`; event-log fields + no bodies/creds +
  rotation.

## Files modified / created

- `proxy/extensions/session-budget-breaker.mjs` (new).
- `proxy/extensions.json` — register `enabled:true` (order is unconstrained now
  that there's no derivation dependency; place near other observability extensions).
- Shared SSE-synthesis helper — extract from `image-retry-circuit-breaker.mjs` if
  not already shared.
- `test/proxy-session-budget-breaker.test.mjs` (new).
- `tools/rates.json` — consumed read-only (no change; note the staleness caveat).
- `README.md` — new section: tunables, circuit-breaker-not-meter framing, the
  per-session-not-per-account boundary, overshoot + rate-lever, meter-bypass
  observability.
- This directive.

## Reviewer checklist (cache-fix side)

- The blocking levers are **all per-session tallies we compute**; Anthropic's
  account `q5h` header is used ONLY for the observational contribution signal, never
  as a block gate.
- Fail-open is provably the default for every row of the fail-open table.
- Never reads/logs message content, bodies, or auth headers.
- scope=session only; no dependency on `workflow-agent-id-synthesis`.
- Default-off; no ceiling by default; `dry-run` genuinely forwards.
- Synthesized stop reuses (not forks) the image-breaker wire format.
- **Load-bearing → human (Chris) review before merge**, and sim proves the #68285
  fan-out is capped before merge.

## Out of scope (explicit)

Model downgrade-on-budget; dollar-precise pricing; account-global quota blocking or
changing auto-purchase; per-workflow-run ceilings; persisting the tally across
restarts. Each is a separate directive if ever wanted.
