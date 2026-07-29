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

- **Size/complexity budget** — ~80–120 LOC across `session-budget-breaker.mjs`
  plus tests. No new extension, no new module. An implementation landing materially
  larger (≈2×) should be challenged.
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

`model` comes from the accrual path (already read for pricing). `agentId` comes
from `ctx.meta._workflowAgentId` — stashed by `workflow-agent-id-synthesis`
(order **365**), well before this extension (order **690**), and already consumed
by `usage-log`. Absent agent id → key on model alone.

On fire, emit the top contributors:

```json
"burn_attribution": {
  "top": [
    { "model": "claude-fable-5", "agent_id": "wf-…", "tokens": 8200000,
      "cost_usd": 41.0, "share": 0.78, "requests": 34 },
    { "model": "claude-opus-5", "agent_id": null, "tokens": 2300000,
      "cost_usd": 11.5, "share": 0.22, "requests": 12 }
  ],
  "distinct_models": 2,
  "distinct_agents": 5
}
```

Cap `top` at 5 entries (highest `tokens` first) so a wide fan-out cannot bloat a
log line. `distinct_*` counts convey breadth without enumerating it.

**Bounding:** cap the map at 64 keys per session. On overflow, fold further keys
into a single `{ model: "__other__", agent_id: null }` bucket rather than growing
without limit — a 700-leg fan-out must not create 700 map entries.

This turns *"session hit its ceiling"* into *"session hit its ceiling, and 78% of
it was a Fable child on agent X"* — actionable, and directly aimed at finding (2).

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

- **Fires at most once per (session, fraction, lever).** Track fired fractions on
  the tally entry; a session must not emit a warn per request once past a threshold.
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

- attribution present on fire, shares sum to ~1.0, `top` capped at 5
- attribution keys on `(model, agent_id)`; absent agent id keys on model alone
- map bounded at 64 keys; overflow folds into `__other__`
- warn fires once per (session, fraction, lever), not per request
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
