# Directive: session-budget-breaker — burn attribution, early warning, and routing telemetry

Status: draft
Refs: #258 (parent directive), #262 (impl), CC#68285, CC#38335
Load-bearing: **yes** — touches a live spend gate on the API-key path.

## Goal

Make the session-budget-breaker explain *what* drove a session's burn, warn before
the ceiling rather than only at it, and record the data needed to decide whether a
per-model cost weight (deferred, see § Phase 2) is worth building.

Three changes, all **additive to the event log**. None alters gating behaviour, and
none touches the fail-open contract in #258 § Fail-open contract.

## Why

Community analysis in [CC#38335](https://github.com/anthropics/claude-code/issues/38335)
— principally by **@fgrosswig**, with the model-routing question raised by
**@TheAuditorTool** — established three things our breaker currently cannot see:

1. **Agent fan-out multiplies contexts, not just requests.** A single visible task
   can carry the parent context plus N independently-growing child contexts, each
   with its own cache creation and repeated reads. Request-count charts look normal
   while consumption climbs.

2. **A parent can spawn a child on a different, more expensive model.** Confirmed
   in that thread: an Opus 5 parent emitted `Agent(model: "fable")`, Claude Code
   resolved `claude-fable-5`, and the child billed separately as overage. Our
   `tools/rates.json` confirms Fable is exactly **2×** Opus in every logged token
   class, so *where* an expensive model sits in the tree dominates cost. Their
   measured result: Fable-as-worker ran ~1.68× the cost per child request of
   Fable-as-orchestrator.

3. **A session can walk to exhaustion in visible steps.** One reported Pro session
   moved 32% → 41% → 56% → 80% → 92% → 100% of the 5h window. Every step was an
   opportunity to intervene; a breaker that only speaks at 100% is silent through
   all of them.

Our breaker already caps the whole fan-out tree, because subagent requests inherit
the parent's `x-claude-code-session-id` (verified locally: ~33K requests resolving
to 10 distinct session ids, against tens of thousands of `isSidechain` transcript
entries). What it cannot currently do is say *which model or agent* consumed the
budget — which is exactly the information an operator needs to act on (2).

## Non-Functional Requirements

- **Size/complexity budget** — ~100–150 LOC across `session-budget-breaker.mjs`
  plus tests. Revised upward from an initial ~80–120 after review: warn-threshold
  parsing, sticky fired-threshold state, dual-share computation, and the sim's
  mixed-model scenario each carry real weight. Dropping
  eviction in round 3 removed the most intricate part of the estimate, so this
  is revised down from 150–220 (round 2) and again from 120–180 after round 3
  dropped nested agent detail. No new extension, no new
  module. An implementation landing materially
  larger (≈2×) should still be challenged.
- **Threat model** — the fire/warn event log is operator-facing and already
  contains no bodies, no prompt content, and no auth material. Phase 1 attribution
  adds **model ids only** — upstream-supplied identifiers already written to
  `usage.jsonl` on every row. No new class of data enters the log. Agent ids are
  not emitted in Phase 1 at all (see § Agent-level detail), so the
  prompt-digest-derivation question they raise does not arise here; it must be
  revisited if a follow-up adds them.
- **Maintainability** — extends existing structures (`_tallies` entries, `logEvent`)
  rather than adding abstractions. The per-model map lives on the existing tally
  entry, so it is discarded with that entry under the same LRU that bounds the
  session tally. The map itself has no internal cap — see § Retention for why that
  is safe and what the real bound is.
- **Performance** — one extra map write per accrual; the tally is already computed
  on every request. Warn evaluation reuses the ceiling comparison already performed.
- **Load-bearing?** **Yes.** The file gates live credential-bearing traffic. Chris
  review required before merge regardless of Codex verdict.

## Phase 1 — burn attribution on the fire event

Extend each `_tallies` entry with a bounded breakdown:

```
e.byModel = Map<modelId, { tokens, costUsd, requests }>
```

**One structure, not two.** Attribution is a model-primary map. There is no flat
`(model, agent)` key space anywhere in this design — an earlier revision specified
one, and that wording is gone.

`model` comes from the accrual path (already read for pricing) and is populated on
**every** request. That is the only input Phase 1 needs.

### Why there is no agent dimension (provenance)

An earlier revision keyed on `(model, agentId)`, sourcing the agent from
`ctx.meta._workflowAgentId` — stashed by `workflow-agent-id-synthesis`
(order **365**) ahead of this extension (order **690**) and already read by
`usage-log`. That path exists and works. It is not used here, for the reasons
measured below.

**Model is the primary key. Agent id refines it when present, and it is usually
absent.** Measured on the maintainer's host:

| signal | count |
|---|---|
| requests carrying canonical `x-claude-code-agent-id` | **38 / 121,685** (0.03%) |
| `workflow-derivation` events yielding an id | **0** — all 3,747 are `drift_canary` |
| `usage.jsonl` rows with `agent_id` populated | **0 / 176,344** |

Two paths can populate it, and both are narrow today:

1. **Canonical pass-through** — `x-claude-code-agent-id` sent by CC. Real, but
   present on 0.03% of requests here.
2. **Workflow-marker synthesis** — fires only when the marker catalog matches.
   It currently matches nothing on this host; every attempt emits a drift canary,
   which means the catalog has gone stale against current CC versions. Tracked
   separately — that staleness is a pre-existing bug this directive does not fix.

**Design consequence:** Phase 1 does not emit `agent_id` **at all** (see
§ Agent-level detail is out of scope for Phase 1). The measurements above are
recorded here as *provenance* — why an agent layer was considered and rejected —
not as a description of an emitted field. Attribution keyed on model alone still
answers the question that motivated this work — *"78% of this burn was `claude-fable-5`"* is
the Opus→Fable signal; the agent id would only say *which child*, not *which model*.
The directive previously implied agent-level attribution was near-free because the
data was "already there." It is not. Model-level attribution is near-free; agent
level is a bonus when CC happens to send the header.

### Ranking must follow the fired lever

The emitted `models` array is ordered by **the dimension of the lever that fired**:

- `TOKENS` or `RATE_TPM` fire → sort by `tokens`, descending
- `COST_USD` fire → sort by `cost_usd`, descending

Ranking a cost fire by tokens would mis-explain exactly the mixed-model case this
feature exists for: a lower-token Fable worker can outspend a higher-token Opus
worker, since Fable is 2× per token class. Emit **both** `token_share` and
`cost_share` on every entry so the log is self-describing, and record
`ranked_by: "tokens" | "cost"` so a reader knows which drove ordering.

**Determinism (so two implementations agree byte-for-byte):**

- `models` is **sorted**, never insertion-ordered.
- Ties on the ranking dimension break by **model id, ascending lexicographic**.
  Ties are realistic — two models with identical token counts is unlikely, but two
  models both at `cost_usd: 0` (both unpriced) is not.
- Shares are rounded to **4 decimal places**; `cost_usd` to **4**; `tokens` and
  `requests` are integers. Rounding is applied at emit time only — the running
  tally keeps full precision, so rounding never feeds back into a gate decision.
- Because shares are rounded independently, their sum may differ from 1.0 in the
  last place. The stated invariant is therefore `|sum − 1.0| <= 0.001`, not exact
  equality.

### Retention: none needed — model keys are bounded in practice

**Round 2 correction.** The previous revision specified a 64-key cap with
smallest-first eviction and an `__other__` fold. That was solving a problem this
design does not have, and it introduced two of its own: eviction decisions happen
before the fired lever is known (so a token-based eviction can discard the
contributor a later `COST_USD` fire needed), and evicted-key re-entry semantics
were unspecified.

Both dissolve by keying the primary map on **model alone**.

**Precise statement of the bound.** The map keys on the model string as it arrives,
not on `rates.json` membership — a model absent from `rates.json` still creates a
key (priced at 0, per existing fail-open behaviour). So `rates.json`'s 19 entries
are *not* the bound. The real bound is **the number of distinct model strings
Anthropic returns for one session**, which matters because:

- The model is read from the **response** (`message_start.message.model` for
  streaming, `body.model` for non-streaming), i.e. it is Anthropic's echo of what
  actually served the request — not a client-supplied string. A caller cannot
  inject arbitrary keys by varying the request.
- Measured: **9** distinct model strings across the entire usage history on this
  host, **6** in the largest single traffic bucket, and **0** strings seen that
  were absent from `rates.json`.
- The realistic growth path is Anthropic shipping new models or dated snapshots,
  which adds keys at the rate models are released — single digits per year, not
  per session.

So the map is bounded by a small, slow-growing, **upstream-controlled** vocabulary.
No cap, no eviction, no `__other__`, no re-entry question. The model map is
complete and exact.

**Residual risk, stated rather than engineered around:** if a future CC or API
change caused per-request model variance (aliases, region-tagged ids, per-call
snapshot pins), key count would grow. This is judged unlikely and low-impact — each
entry is four numbers, so even a pathological 100 keys is a few KB on an event
that fires rarely. If it ever materialises, the fix is a cap *then*, informed by
what the real distribution looks like. Adding one now would repeat the round-1
mistake of designing against unmeasured cardinality.

### Agent-level detail is out of scope for Phase 1

**Round 3 correction.** The previous revision nested a 16-agent cap inside each
model entry with an `agents_truncated` flag. Review correctly identified that as
first-16-wins — the same "a later dominant contributor silently disappears"
problem this directive already rejected at the model layer, just one level down.

Defending it properly would need heavy-hitter retention and an omitted-tail
quantity: exactly the machinery removed in round 3, reintroduced for a field that
is populated on **0.03% of requests** and blocked on #271 regardless.

So Phase 1 emits **no agent detail at all.** The `burn_attribution` shape carries
model entries only.

This is not a permanent decision. Once #271 restores agent-id population, a
follow-up can add agent attribution — and it will have to meet the same
truthfulness standard as the model layer, with real cardinality data available to
design against instead of the guesswork that produced two bad caps here.

Dropping it now also removes the last unbounded dimension from the design.

### Share normalization (exact)

Every share is computed over the **complete** model set, so:

```
sum(models[*].token_share) == 1.0    (±0.001 rounding)
sum(models[*].cost_share)  == 1.0    (±0.001 rounding)
```

Both invariants hold on every event, for every value of `ranked_by`. There is no
tail to exclude and no `other_share` field — those existed only to describe the
eviction fold that no longer happens.

`ranked_by` records which dimension drove ordering; the non-ranking share is
emitted alongside it so a reader can see when token share and cost share disagree,
which is exactly the Opus-vs-Fable signal. Neither is "the" share — both are
always present and both always sum to 1.0.

Cost shares are computed from the same `costOf()` pricing the cost lever uses. A
model unknown to `rates.json` prices at 0 (existing fail-open behaviour), so its
`cost_share` is 0 while its `token_share` stays accurate.

Two rules make this unambiguous:

- **`unpriced_models`** — a list of the model ids that priced at 0, so a reader
  knows *which* entries understate rather than only *that* some do. Empty list is
  the normal case. (A top-level boolean alone would say the cost picture is
  incomplete without saying where the hole is.)
- **Degenerate case:** if total session cost is 0 — every contributing model
  unpriced — `cost_share` is emitted as `null` on every entry rather than `0` or
  `NaN`, and the `sum(cost_share) == 1.0` invariant does **not** apply. In that
  state `ranked_by` MUST be `"tokens"` even for a `COST_USD` fire, since cost
  ordering is meaningless; the event still records which lever fired, so the
  mismatch is visible and explicable rather than silently wrong.

A `COST_USD` fire with a *partially* unpriced set still ranks by cost — the priced
portion is the part that drove the ceiling — with `unpriced_models` naming what is
missing.

On fire, emit:

```json
"burn_attribution": {
  "ranked_by": "cost",
  "unpriced_models": [],
  "models": [
    { "model": "claude-fable-5", "tokens": 8200000, "cost_usd": 41.0,
      "token_share": 0.78, "cost_share": 0.88, "requests": 34 },
    { "model": "claude-opus-5", "tokens": 2300000, "cost_usd": 5.6,
      "token_share": 0.22, "cost_share": 0.12, "requests": 12 }
  ]
}
```

`models` is emitted in full, with no top-N truncation, so nothing can hide. Its
length is the number of distinct model strings Anthropic returned for the session
— see § Retention for why that vocabulary is small and upstream-controlled rather
than bounded by `rates.json`.

## Phase 1 — early warning events

Add `CACHE_FIX_SESSION_BUDGET_WARN_AT`, a comma-separated list of fractions
(default `0.5,0.75,0.9`; empty string disables).

When a session's highest lever utilisation first crosses each fraction, emit:

```json
{ "event": "session_budget_warn", "sid": "…", "lever": "TOKENS",
  "limit": 100000000, "observed": 75200000, "fraction": 0.75,
  "burn_attribution": { … }, "ts": "…" }
```

Rules:

- **Fires at most once per (session, fraction, lever), and the crossing is STICKY.**
  Track fired fractions on the tally entry. Once a fraction has fired it never
  re-arms for that session, **even if utilisation later falls back below it**.
  This matters specifically for `RATE_TPM`: it is a sliding window, so utilisation
  oscillates as old events age out. A non-sticky rule would let one sustained
  fan-out emit a warn every time the window breathes across 0.75.
  This is the failure mode that put ~34K synthetic events in an operator's log
  during sim development (#267) — do not repeat it.
- **Never gates.** Warn is log-only in every gate mode, including `on`.
- **Emitted in `dry-run` too** — that is where it is most useful.

This is what makes an armed-but-quiet dry-run period informative instead of silent:
today, a session at 92% of its ceiling looks identical to one at 2%.

## Phase 2 (deferred) — per-model cost weighting

Do **not** build this yet. The hypothesis is that an operator may want the cost
lever to trip earlier when expensive models are doing the *volume* rather than the
orchestration — targeting finding (2) directly rather than via total dollars.

A plain `_COST_USD` ceiling may already cover this adequately, since Fable's 2×
price is reflected in the dollar figure. **Phase 1's attribution data is what
decides it.** Revisit when we have fire or warn events from a real fan-out showing
either (a) expensive workers dominating a burn that a dollar ceiling caught too
late, or (b) that the dollar ceiling was sufficient.

Phase 1 is deliberately the instrument that answers this, which is why it ships
first and alone.

## Test requirements

Extend `test/proxy-session-budget-breaker.test.mjs`:

- attribution present on fire; `models` emitted in full with no truncation
- **both** `sum(token_share)` and `sum(cost_share)` equal 1.0 (±0.001) on every
  event, for every `ranked_by` value
- `ranked_by` follows the fired lever; a COST_USD fire ranks by cost, and a
  low-token/high-cost contributor outranks a high-token/low-cost one
- a model unknown to `rates.json` yields `cost_share: 0`, an accurate
  `token_share`, and its id listed in `unpriced_models`
- all-unpriced session: `cost_share` is `null` on every entry, the cost-sum
  invariant is waived, and `ranked_by` falls back to `"tokens"` even on a
  COST_USD fire
- a model string absent from `rates.json` still creates its own map key (keys
  follow arriving model strings, not `rates.json` membership)
- no agent fields are emitted in Phase 1, regardless of whether
  `ctx.meta._workflowAgentId` is populated
- attribution is keyed on model only; no `(model, agent)` composite key exists
- warn fires once per (session, fraction, lever), not per request
- warn stickiness: utilisation crossing 0.75, falling back to 0.60, then
  re-crossing 0.75 emits exactly ONE warn for that fraction
- `ctx.meta._workflowAgentId` present or absent produces identical output
- warn fires in `dry-run` and in `on`; never returns a skip result
- `WARN_AT=""` disables warns entirely
- malformed `WARN_AT` (non-numeric, >1, <0) is ignored without throwing — fail-open
- gating behaviour is byte-identical with attribution enabled vs disabled

Extend `tools/sim-session-budget-breaker.mjs` with a mixed-model fan-out
(Opus parent + Fable children) asserting attribution correctly identifies the
`claude-fable-5` as the dominant contributing **model** — Phase 1 emits no
child/agent detail, so the assertion is at model granularity, which is the
granularity the Opus→Fable case turns on. This is the sim's first
multi-model scenario and is the closest reproduction we have of the
Opus→Fable shape reported in CC#38335.

## Rollout

1. Phase 1 behind the existing gate; attribution always on when the breaker fires
   (no separate flag — it is a field on an event that already exists).
2. Continue dogfooding in `dry-run` with warns enabled, so the currently-silent
   period starts producing the data Phase 2 needs.
3. Publish a **beta npm** once Phase 1 lands and the sim's mixed-model scenario
   passes, to get the breaker in front of testers with fan-out workloads we do
   not run ourselves.

## Credits

The analysis motivating this work is **@fgrosswig**'s, in CC#38335 — the
fan-out cost function, the confirmed Opus→Fable child spawn with separate
billing, the Fable-as-worker vs Fable-as-orchestrator cost comparison, and the
Pro-plan Q5/Q7 exhaustion data. The question of whether Claude Code can spawn
a Fable child unprompted was raised by **@TheAuditorTool**. Credit them by
GitHub handle in the CHANGELOG and any release notes.
