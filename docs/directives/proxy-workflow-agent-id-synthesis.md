# Directive: Workflow-tool agent-id header synthesis

**Issue:** TBD (will be filed alongside this directive, referencing CC#66761)
**Upstream:** [anthropics/claude-code#66761](https://github.com/anthropics/claude-code/issues/66761) — *Workflow-tool agent() subagents omit x-claude-code-agent-id / parent-agent-id (Task subagents are tagged)* (status: closed; gap remains and the upstream fix will not be retroactive)
**Priority:** P2
**Branch:** `feature/workflow-agent-id-synthesis`
**Stage:** directive
**Milestone:** v4.2.0

## Goal

The proxy synthesizes a `x-cache-fix-proxy-derived-agent-id` and `x-cache-fix-proxy-derived-parent-agent-id` header pair onto request-attribution surfaces (usage-log rows, structured event log) for requests originating from Workflow-tool–spawned subagents. Detection is heuristic — based on session-id correlation and request-shape markers — but provides a stable attribution key that lets meter consumers and dashboards distinguish Workflow-spawned subagent traffic from top-level conversation traffic, which is currently indistinguishable at the header level.

The synthesized id is derived, not authoritative. Headers carry the `derived-` prefix to make the provenance explicit. When CC eventually backfills the canonical `x-claude-code-agent-id` for Workflow agents, our derived id becomes redundant and the extension can be retired — but the data captured between now and then remains correctly attributed.

## Why

Per CC#66761 (now closed), the agent-identification headers `x-claude-code-agent-id` and `x-claude-code-parent-agent-id` are correctly set on `Task` / Agent-tool subagent requests but **not** on agents spawned by the `Workflow` tool's `agent()`, `parallel()`, or `pipeline()` fan-out. Workflow-spawned requests carry only the parent conversation's `x-claude-code-session-id`, making them indistinguishable from top-level traffic at the proxy layer.

The closed-issue status means Anthropic acknowledges the gap but has not committed to a fix timeline. Even when the fix lands, it will not be retroactive — usage data captured before the fix remains unattributed. Operators running fan-out workflows for cost-attribution have a real visibility gap today.

Our `request_id` field (cache-fix v4.1.0 / meter v0.7.1) closes one half of the gap: post-hoc joins between meter rows and CC's per-session transcript JSONLs are now possible. But CC's transcript JSONL itself doesn't carry Workflow-agent attribution either — the same gap propagates downstream. A proxy-derived agent id, captured at the request layer, gives operators a stable key without waiting for the upstream fix.

The framing is **derived-not-authoritative**. We do not claim the synthesized id is canonical. We claim it is consistent within a Workflow tree and stable across the proxy's view of a given fan-out.

## Non-Functional Requirements

- **Size/complexity budget:** small — extend `usage-log.mjs` and `request-log.mjs` with the derivation logic, plus a shared helper in `proxy/lib/workflow-agent-derivation.mjs` (~80–150 LOC). State is request-scoped; no cross-request memory needed.
- **Threat model:** the synthesized id is derived from already-visible headers and request shape. No new sensitive surface. Header carries the `derived-` prefix unambiguously.
- **Activation model:** `enabled: true` in `extensions.json` for the helper module (always loaded) with env-var gate `CACHE_FIX_WORKFLOW_AGENT_DERIVATION` (`on` / `off`). Default-on in v4.2.0 — additive only, no request mutation.
- **Failure mode:** if the derivation heuristic returns `undefined` (no Workflow markers detected), no derived id is added and behavior is unchanged from current.

## Detection logic

A request is identified as a Workflow-tool subagent invocation by the conjunction of:

1. `x-claude-code-session-id` is present.
2. `x-claude-code-agent-id` is **absent** (Task subagents carry this; Workflow agents do not — this is the load-bearing distinguisher).
3. The request system-prompt or first-user-message contains a Workflow-tool marker: either a `<workflow-agent-context>` XML block, a `[workflow-agent]` text marker, or one of the Workflow-spawned-agent prompt sentinels documented in `proxy/lib/workflow-markers.mjs` (extracted from binary inspection per `playbook_cc_binary_inspection.md`).

When 1 + 2 + 3 hold:

```
derived_agent_id = sha256(
  session_id +
  workflow_marker_substring +
  request_shape_signature
).slice(0, 16)

derived_parent_agent_id = sha256(
  session_id +
  "workflow-root"
).slice(0, 16)
```

The `workflow_marker_substring` is the longest matched marker from the prompt; this keeps the id stable for repeated calls within a Workflow leg. The `request_shape_signature` is a hash of `tools[*].name` sorted, so different agent calls within the same Workflow tree get distinct ids while repeat calls from the same leg get the same id.

## Synthesis

When the derivation fires:

- Add `x-cache-fix-proxy-derived-agent-id: <derived>` to the request headers (visible to upstream — harmless, ignored by Anthropic).
- Add `x-cache-fix-proxy-derived-parent-agent-id: <derived-parent>` similarly.
- Emit a structured event log record at `~/.cache-fix-proxy/workflow-derivation-events.jsonl` showing the inputs and derived ids (operator diagnostics).
- The `usage-log.mjs` extension reads these headers (in addition to canonical `x-claude-code-agent-id`) when populating the optional `agent_id` field on `MeterRowSchema v:1` rows — falling back to derived ids only when canonical ones are absent.

The schema field on the meter side does not need to change: it remains `agent_id` (optional), and the source field documents whether the value is canonical (`source: "cc-header"`) or derived (`source: "cache-fix-derived"`).

## Scope (v4.2.0)

In scope:
- New helper `proxy/lib/workflow-agent-derivation.mjs` — pure-function derivation given request inputs.
- New `proxy/lib/workflow-markers.mjs` — catalog of Workflow-tool prompt markers, extracted from binary inspection (cc-watch runbook: `playbook_cc_binary_inspection.md`).
- Extend `proxy/extensions/usage-log.mjs` to consume derived ids when canonical ones are absent.
- Extend `proxy/extensions/request-log.mjs` to log derivation events.
- Env-var gate `CACHE_FIX_WORKFLOW_AGENT_DERIVATION` (`on` / `off`).
- Companion update to `claude-code-meter` (separate PR): document the `source: "cache-fix-derived"` value on the `agent_id` field; dashboard distinguishes derived from canonical visually (footnote / tooltip).

Out of scope (deferred):
- Persisting the derivation map across proxy restarts. Each derivation is deterministic from request inputs, so a fresh proxy boot reproduces the same ids.
- Cross-tool derivation (e.g., for MCP-spawned background processes). v4.2.0 is Workflow-tool specific.
- Backfilling derived ids onto historical usage-log rows. The derivation runs at request time only.

## Implementation choice

The derivation belongs in a shared library module because two extensions consume it (`usage-log` and `request-log`). Per the directive's own no-abstraction-unless-2+-consumers rule, the helper has a declared home in `proxy/lib/` rather than being duplicated.

The Workflow-markers catalog is the only piece that requires ongoing maintenance: when CC ships a new Workflow-tool variant with a new prompt sentinel, the catalog needs to be updated. The cc-watch dedicated agent's binary-inspection runbook covers this discovery surface; future updates land via the same diff-the-binary process that produced the v2.1.170 findings.

## Test plan

- Unit: derivation helper — same inputs produce same id (deterministic); different session-ids produce different ids; different Workflow markers within same session produce different agent-ids; same marker repeated produces same id.
- Unit: marker catalog — every known marker is detected; non-Workflow prompts produce `undefined`.
- Integration: replay fixture of a Workflow `parallel()` fan-out → 3 subagent calls; assert all three carry distinct `derived-agent-id` with the same `derived-parent-agent-id`; canonical `agent-id` headers absent throughout.
- Integration: same fixture but with the env-var off — no derived headers added; usage-log rows have no `agent_id` field; behavior matches current state.
- Integration: Task subagent (canonical `agent_id` present) — derivation does not fire; canonical id used; no derived headers added.
- Smoke: env-var on + Workflow fan-out → meter dashboard correctly attributes the three subagent calls separately.

## Files modified / created

Created:
- `proxy/lib/workflow-agent-derivation.mjs`
- `proxy/lib/workflow-markers.mjs`
- `test/lib/workflow-agent-derivation.test.mjs`
- `test/lib/workflow-markers.test.mjs`
- `test/fixtures/workflow-parallel-fanout-replay.json`

Modified:
- `proxy/extensions/usage-log.mjs` — consume derived ids; document `source` field.
- `proxy/extensions/request-log.mjs` — log derivation events.
- `proxy/extensions.json` — no order change; libs are loaded transitively.
- `CHANGELOG.md` — v4.2.0 entry referencing CC#66761.
- `README.md` — extension docs.
- `docs/extensions.md` — usage-log + request-log updated entries.

## Reviewer checklist (cache-fix side)

- [ ] Derivation is deterministic; same inputs always produce same id.
- [ ] Workflow markers catalog reflects the v2.1.170 binary state (cc-watch inspection used as source).
- [ ] Derived headers carry the `derived-` prefix explicitly; canonical headers are never overwritten.
- [ ] `source: "cache-fix-derived"` on meter rows is documented and dashboard-distinguishable.
- [ ] Env-var-off → no behavior change from current state.
- [ ] CHANGELOG cites CC#66761 explicitly.

## Out of scope (explicit)

- Reverse-engineering the canonical agent-id derivation Anthropic will use when they fix the gap upstream. Our derived id is independent and will coexist with the canonical id once it lands.
- Tool other than Workflow. MCP, hooks, etc. are out of scope; the load-bearing distinguisher (`agent-id` absence + Workflow markers) is Workflow-specific.
- Visualizing Workflow agent trees in the meter dashboard. The attribution surface is `agent_id` + `source`; visualization is a separate concern.
- Persistence of the markers catalog across cache-fix releases. The catalog lives in source; updates ride normal release cycle.

— AI Team Lead
