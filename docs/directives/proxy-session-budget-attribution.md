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

- **Size/complexity budget** — ~120–180 LOC across `session-budget-breaker.mjs`
  plus tests. Revised upward from an initial ~80–120 after review: warn-threshold
  parsing, sticky fired-threshold state, dual-share computation, nested agent
  detail, and the sim's mixed-model scenario each carry real weight. Dropping
  eviction in round 3 removed the most intricate part of the estimate, so this
  is revised down from the round-2 figure of 150–220. No new extension, no new
  module. An implementation landing materially
  larger (≈2×) should still be challenged.
- **Threat model** — the fire/warn event log is operator-facing and already
  contains no bodies, no prompt content, and no auth material. Attribution adds
  **model ids and synthesized agent ids only** — both already present in
  `usage.jsonl` via `usage-log`. No new class of data enters the log. Agent ids are
  synthesized (`workflow-agent-id-synthesis`) and never leave the host.
- **Maintainability** — extends existing structures (`_tallies` entries, `logEvent`)
  rather than adding abstractions. The per-`(model, agent)` map is bounded by the
  same LRU that bounds the session tally.
- **Performance** — one extra map write per accrual; the tally is already computed
  on every request. Warn evaluation reuses the ceiling comparison already performed.
- **Load-bearing?** **Yes.** The file gates live credential-bearing traffic. Chris
  review required before merge regardless of Codex verdict.

## Phase 1 — burn attribution on the fire event

Extend each `_tallies` entry with a bounded breakdown:

```
e.by = Map<"model|agentId", { tokens, costUsd, n }>
```

`model` comes from the accrual path (already read for pricing) and is populated on
**every** request. `agentId` comes from `ctx.meta._workflowAgentId`, stashed by
`workflow-agent-id-synthesis` (order **365**) before this extension (order **690**)
and already consumed by `usage-log`.

### Agent id is opportunistic enrichment, not the primary key

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

**Design consequence:** `agent_id` MUST be optional in the emitted shape, and no
consumer may assume it is set. Attribution keyed on model alone still answers the
question that motivated this work — *"78% of this burn was `claude-fable-5`"* is
the Opus→Fable signal; the agent id would only say *which child*, not *which model*.
The directive previously implied agent-level attribution was near-free because the
data was "already there." It is not. Model-level attribution is near-free; agent
level is a bonus when CC happens to send the header.

### Ranking must follow the fired lever

The emitted `top` list is ordered by **the dimension of the lever that fired**:

- `TOKENS` or `RATE_TPM` fire → rank by tokens, `share` is token share
- `COST_USD` fire → rank by cost, `share` is cost share

Ranking a cost fire by tokens would mis-explain exactly the mixed-model case this
feature exists for: a lower-token Fable worker can outspend a higher-token Opus
worker, since Fable is 2× per token class. Emit **both** `token_share` and
`cost_share` on every entry so the log is self-describing, and record
`ranked_by: "tokens" | "cost"` so a reader knows which drove ordering.

### Retention: none needed — model keys are naturally bounded

**Round 2 correction.** The previous revision specified a 64-key cap with
smallest-first eviction and an `__other__` fold. That was solving a problem this
design does not have, and it introduced two of its own: eviction decisions happen
before the fired lever is known (so a token-based eviction can discard the
contributor a later `COST_USD` fire needed), and evicted-key re-entry semantics
were unspecified.

Both dissolve by keying the primary map on **model alone**:

| bound | value |
|---|---|
| distinct models in `tools/rates.json` | 19 |
| max distinct models observed in one real traffic bucket | **6** |

A session cannot use more models than exist. There is no unbounded dimension, so
there is **no eviction, no `__other__` bucket, and no re-entry problem**. The model
map is complete and exact, always.

The unbounded dimension was only ever `agent_id` — which, per the measurements
above, is populated on 0.03% of requests. Agent detail is therefore a **nested,
optional refinement** inside each model entry, with a hard cap of 16 agent keys
per model. On exceeding the cap, stop adding new agent keys and set
`agents_truncated: true` on that model entry. **Model totals remain exact
regardless** — only the within-model agent split becomes partial, and the event
says so.

This is strictly simpler than the evicting design, and it is honest by
construction rather than by a quality flag.

### Share normalization (exact)

Every share is computed over the **complete** model set, so:

```
sum(models[*].token_share) == 1.0    (±0.001 rounding)
sum(models[*].cost_share)  == 1.0    (±0.001 rounding)
```

Both invariants hold on every event, for every value of `ranked_by`. There is no
tail to exclude and no `other_share` field — those existed only to describe the
eviction fold that no longer happens.

`ranked_by` records which dimension drove ordering; the other share is emitted as
**informational** so a reader can see when token share and cost share disagree,
which is exactly the Opus-vs-Fable signal. Neither is "the" share — both are
always present and both always sum to 1.0.

Cost shares are computed from the same `costOf()` pricing the cost lever uses. A
model unknown to `rates.json` prices at 0 (existing fail-open behaviour), so its
`cost_share` is 0 while its `token_share` is accurate; set
`cost_complete: false` at the top level when any contributing model was unpriced,
so a reader knows cost shares understate.

On fire, emit:

```json
"burn_attribution": {
  "ranked_by": "cost",
  "cost_complete": true,
  "models": [
    { "model": "claude-fable-5", "tokens": 8200000, "cost_usd": 41.0,
      "token_share": 0.78, "cost_share": 0.88, "requests": 34,
      "agents": [{ "agent_id": "wf-a1b2", "tokens": 5100000, "requests": 21 }],
      "agents_truncated": false },
    { "model": "claude-opus-5", "tokens": 2300000, "cost_usd": 5.6,
      "token_share": 0.22, "cost_share": 0.12, "requests": 12,
      "agents": [], "agents_truncated": false }
  ]
}
```

`models` is emitted in full — bounded at 19 by construction, and 6 in practice.
No top-N truncation, so nothing can hide.

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
  `token_share`, and `cost_complete: false` at the top level
- agent detail caps at 16 per model, setting `agents_truncated: true`, while the
  model's own `tokens`/`cost_usd`/shares stay exact
- attribution keys on `(model, agent_id)`; absent agent id keys on model alone
- warn fires once per (session, fraction, lever), not per request
- warn stickiness: utilisation crossing 0.75, falling back to 0.60, then
  re-crossing 0.75 emits exactly ONE warn for that fraction
- agent_id absent (the common case) still produces usable model-keyed attribution
- warn fires in `dry-run` and in `on`; never returns a skip result
- `WARN_AT=""` disables warns entirely
- malformed `WARN_AT` (non-numeric, >1, <0) is ignored without throwing — fail-open
- gating behaviour is byte-identical with attribution enabled vs disabled

Extend `tools/sim-session-budget-breaker.mjs` with a mixed-model fan-out
(Opus parent + Fable children) asserting attribution correctly identifies the
Fable children as the dominant contributor. This is the sim's first
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
