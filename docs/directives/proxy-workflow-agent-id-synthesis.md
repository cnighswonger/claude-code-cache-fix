# Directive: Workflow-tool agent-id attribution (proxy-derived)

**Issue:** TBD (will be filed alongside this directive, referencing CC#66761)
**Upstream:** [anthropics/claude-code#66761](https://github.com/anthropics/claude-code/issues/66761) — *Workflow-tool agent() subagents omit x-claude-code-agent-id / parent-agent-id (Task subagents are tagged)* (state: closed; gap remains and the upstream fix will not be retroactive)
**Priority:** P2
**Branch:** `feature/workflow-agent-id-synthesis`
**Stage:** directive — round 2 (addresses Fable round-1 REQUEST_CHANGES at PR #215)
**Milestone:** v4.2.0 (cache-fix); meter schema change must land FIRST

## Goal

When CC's `/v1/messages` request originates from a Workflow-tool–spawned subagent (no canonical `x-claude-code-agent-id` header), the proxy derives a stable agent-id and parent-agent-id from request-side signals and stashes them on `ctx.meta`. Downstream attribution consumers — `usage-log` (proxy-side) and the meter dashboard (after the meter schema floor is in place) — read the derived ids when canonical ones are absent. The derived ids never reach Anthropic upstream; they exist only as in-proxy attribution keys.

The derived id is explicitly non-canonical. Once CC backfills the canonical headers upstream, the canonical id wins on every read path and the derivation becomes inert. The extension is structurally self-retiring.

## Why

Per CC#66761 (now closed), `x-claude-code-agent-id` and `x-claude-code-parent-agent-id` are set on `Task` / Agent-tool subagent requests but NOT on agents spawned by the Workflow tool's `agent()`, `parallel()`, or `pipeline()` fan-out. Workflow-spawned requests carry only the parent conversation's `x-claude-code-session-id`, making them indistinguishable from top-level traffic at the proxy layer.

The closed-issue status means Anthropic acknowledges the gap but has not committed to a fix timeline, and any future fix will not be retroactive. Operators running fan-out workflows have a real visibility gap today. The cache-fix v4.1.0 `request_id` field closes the post-hoc join half (meter row → CC transcript JSONL); this directive closes the from-the-other-end half by giving Workflow agents a stable attribution key.

The framing is **derived-not-authoritative**, and the round-1 mistake of claiming the headers would also reach Anthropic is corrected: nothing this extension produces is sent upstream.

## Non-Functional Requirements

- **Size/complexity budget:** ~250–350 LOC across the extension + helper + tests, honestly counted. Round 1's 80–150 budget did not include tests; restated.
- **Threat model:** the derivation reads request body + headers (both visible in `onRequest`'s `ctx`). No new sensitive surface. The derived ids are present only in proxy memory and in the optional `usage.jsonl` field (when the meter floor is in place and the env-var enables emission).
- **Activation model:** `enabled: true` in `extensions.json` (always loaded) with internal env-var gate `CACHE_FIX_WORKFLOW_AGENT_DERIVATION` (`on` / `off`). The activation surface is the derived-id attribution extension itself, not the consumers — `usage-log` separately gates emission of the `agent_id` field per the staged-rollout pattern (see "Meter compatibility / release ordering" below).
- **Failure mode:** if the derivation produces no markers (no-Workflow-traffic case), no derived ids are populated and behavior matches current state. If the meter floor is not present, `usage-log` does not emit the field.

## What does NOT happen (closes Fable B1)

The previous directive claimed the derived ids would be added to **request headers** sent to Anthropic. This is architecturally impossible through the existing pipeline:

- `preForward` hands extensions a *copy* of the client headers (`server.mjs:86`), and only `reqCtx.body` is re-serialized into `forwardBody` after `runOnRequest` (`server.mjs:97-99`). Header mutations to `ctx.headers` are discarded.
- `forwardRequest` rebuilds upstream headers from the original `clientReq.headers` (`server.mjs:132-136`, `upstream.mjs:204`).

So no extension can add headers visible to upstream through the existing surface. The round-1 directive proposed plumbing changes to make this work; the round-2 directive does the simpler thing: keep the derivation entirely in-proxy. The attribution surfaces this directive cares about (usage-log rows, structured event log, meter dashboard) are all in-proxy; nothing here needs to go upstream.

This also makes the "additive only, no request mutation" claim true (round 1 was self-contradictory — adding headers IS mutation).

## Detection logic

A request is identified as a Workflow-tool subagent invocation by the conjunction of all three:

1. `x-claude-code-session-id` (or equivalent via `resolveSessionId`) is present.
2. `x-claude-code-agent-id` is **absent** — this is the load-bearing distinguisher between Task subagents (which carry it) and Workflow agents (which do not, per CC#66761).
3. The request system-prompt or one of its first user messages contains a Workflow-tool marker from the catalog at `proxy/workflow-markers.mjs`.

If any condition is false, no derivation runs and the request flows through unchanged.

## Markers catalog discovery (closes Fable B5)

The round-1 directive named `workflow-markers.mjs` as the catalog source but did not specify any actual markers. The round-2 directive treats marker discovery as a **gating prerequisite**: implementation cannot start until the catalog is seeded with binary-verified markers, and the directive must include them by version + sha256 + matched strings.

The discovery procedure (per `playbook_cc_binary_inspection.md`):

1. Pull the npm tarball for the targeted CC version. Record the sha256.
2. Run the cc-watch inspection script that locates Workflow-tool prompt fragments.
3. Validate the candidate marker strings against captured Workflow fan-out traffic on visits-01.
4. Record findings in `workflow-markers.mjs` with the format:

```js
export const WORKFLOW_MARKERS = [
  {
    cc_version: "2.1.170",
    cc_npm_sha256: "<64-hex>",
    discovered_at: "2026-06-11",
    discovered_by: "cc-watch-agent",
    marker: "<exact string from binary inspection>",
    position: "system-prompt" | "first-user-message",
    notes: "<context>",
  },
  // ...
];
```

**Implementation cannot proceed** until at least one entry exists. If no markers can be verified, the directive is wrong — Workflow agents may be indistinguishable from top-level traffic, in which case this attribution surface is unbuildable and the directive should be withdrawn.

The implementation PR must cite the binary sha256 of the inspected CC version. Future marker-drift tracking is a manual handoff to cc-watch; the directive names it honestly as a manual watch surface (Fable round-1 attention #7).

A throttled fail-safe canary: when conditions 1+2 hold but no marker matches, log a counter (`workflow-derivation-drift`) to the event log. That's the early signal for "Anthropic shipped a new Workflow sentinel; our catalog has gone stale" — exactly the drift-detection Fable round 1 recommended.

## Derivation algorithm (closes Fable B3)

The round-1 algorithm `sha256(session_id + marker_substring + shape_signature)` where `shape_signature = hash(tools[*].name sorted)` could not produce distinct ids for three legs of a `parallel()` fan-out (same session, same marker, same tools list → same id). And tools-list churn from `deferred-tools-restore`'s documented MCP reconnect race would split one leg's traffic across two derived ids.

Round-2 algorithm:

```js
derived_agent_id = sha256(
  session_id +
  marker_id +              // catalog ID for the matched marker (not the raw text)
  per_leg_discriminator    // from the marker's matched context block — see below
).slice(0, 16)

derived_parent_agent_id = sha256(
  session_id +
  "workflow-root"
).slice(0, 16)
```

The **per-leg discriminator** is sourced from inside the matched marker's context block. The exact field name depends on what binary inspection surfaces — candidates the discovery procedure must evaluate include:

- An agent name / role string embedded in the Workflow context (`<workflow-agent-context name="reviewer">…`)
- A fan-out index if Workflow tags its legs (`<workflow-agent-context index="2"...>`)
- A digest of the agent's system prompt section (deterministic; survives MCP tools churn because it does not include tools list)

The implementation PR must cite which field (or composite) was found in binary inspection and chosen as the discriminator. If none is available, the headline acceptance test (3 distinct ids in a `parallel()` fan-out) cannot pass; in that case the directive is again wrong and must be withdrawn or rescoped.

**Tools-list churn is no longer in the hash input.** `deferred-tools-restore`'s MCP reconnect race (`deferred-tools-restore.mjs:1-10`) makes `tools[*].name` non-invariant across consecutive turns of the same Workflow leg. Eliminating it from the discriminator keeps the id stable across reconnects.

64-bit truncation matches house precedent (`hashOrgId`, `sessionFilename`). Document that derived ids are NOT globally unique — fine for per-session attribution, but cross-session aggregation must factor in the ~2^32 birthday bound.

## Meter compatibility / release ordering (closes Fable B2)

`MeterRowSchema` is `z.strictObject` (`claude-code-meter/src/log/schema.mjs:5`) — unknown keys are rejected. Round 1's claim that "the schema field on the meter side does not need to change" was false: there is no `agent_id` and no `source` field today. Emitting either on a `usage.jsonl` row would make every current meter install reject it.

The fix is the established staged-rollout pattern from `request_id` (cache-fix v4.1.0 → v4.2.0):

**Release ordering (load-bearing):**

1. **Meter PR FIRST.** Companion meter PR adds `agent_id` (string, max 64, optional) AND `agent_id_source` (enum: `"cc-header" | "cache-fix-derived"`, optional) to `MeterRowSchema`. Both fields strict-typed. Ships in claude-code-meter v0.8.0.
2. **Cache-fix PR THEN.** The Workflow-derivation extension lands with `usage-log.mjs` emission gated **default-off** via `CACHE_FIX_USAGE_LOG_AGENT_ID=on`. Operators who upgrade meter to v0.8.0+ can flip the env-var; operators on older meter installs see no row changes.
3. **One minor release later.** Default flip to on, exactly as `request_id` did v4.1.0 → v4.2.0.

The release-ordering rule is `usage-log.mjs`'s own template (verified at `usage-log.mjs:40-44` documenting the request_id story). Reuse it explicitly.

**Documentation:** the directive's CHANGELOG must call out the meter version floor and the env-var, exactly as cache-fix v4.1.0's CHANGELOG documented the request_id rollout.

## Module layout (closes Fable B4)

Per the PR #213 round-2 resolution: shared helpers live flat at `proxy/`, not under a new `proxy/lib/` directory. Same for the test tree.

Round-2 placement:

- `proxy/extensions/workflow-agent-id-synthesis.mjs` — the extension proper (registered in `extensions.json`).
- `proxy/workflow-agent-derivation.mjs` — pure-function derivation helper (flat).
- `proxy/workflow-markers.mjs` — markers catalog (flat).
- `test/extensions/workflow-agent-id-synthesis.test.mjs`
- `test/workflow-agent-derivation.test.mjs`
- `test/workflow-markers.test.mjs`
- `test/fixtures/workflow-parallel-fanout-replay.json`

No `proxy/lib/` or `test/lib/` introduced.

## Activation model details (closes Fable round-1 attention #2)

The pipeline's `loadExtensions` only loads `proxy/extensions/*.mjs`. Helpers in `proxy/` are imported transitively — they need no `extensions.json` entry.

`extensions.json` adds exactly one entry: `"workflow-agent-id-synthesis": { "enabled": true, "order": 360 }` (before `cache-control-normalize` at 400, after `microcompact-stability` at 350 and `thinking-display` at 360 — the exact position is verified during implementation).

`usage-log.mjs` is separately enabled by the operator per existing pattern. The Workflow-derivation extension running with no `usage-log` consumer simply populates `ctx.meta._workflowDerivedAgentId` for nothing — no harm.

The `default-on in v4.2.0` framing applied only to the extension's *evaluation*, not to the meter-row emission. Round-2 separates these: extension default-on (runs detection, populates meta), `usage-log` emission default-off (per the staged-rollout pattern), meter dashboard surfaces fields after v0.8.0.

## Event log + PII discipline (closes Fable round-1 attention #3)

Event log path: `~/.claude/workflow-derivation-events.jsonl` (NOT `~/.cache-fix-proxy/`).

Per-record fields:

```json
{
  "ts": "<ISO8601>",
  "session_id": "<resolved>",
  "marker_id": "<catalog id, NOT raw matched text>",
  "marker_position": "system-prompt" | "first-user-message",
  "derived_agent_id": "<hex>",
  "derived_parent_agent_id": "<hex>",
  "cc_version": "<from binary inspection at startup>",
  "schema_version": 1
}
```

**Never log:** the matched marker text itself (prompt-derived content), the request body, auth headers.

Rotation: 5 MB single-tier per `bootstrap-defense.rotateIfNeeded` precedent.

## Marker false positives from user-controlled content (closes Fable round-1 attention #4)

Detection condition 3 ("system-prompt or first user message contains marker") could fire on a user message that quotes the marker text — e.g., someone discussing this feature.

Mitigation in two parts:

1. **Position-anchored matches preferred.** The markers catalog records `position: "system-prompt"` vs `position: "first-user-message"`. The detection only matches against the configured position.
2. **Negative test.** A test case where the user message contains the marker text inside backtick quotes asserts NO derivation fires (the user-text position does not match a system-prompt-position marker).

## Test plan

- Unit: detection — all three conditions checked; missing any one → no derivation.
- Unit: derivation — deterministic; same inputs → same id; different per-leg discriminators → different ids; tools-list churn does NOT change the id.
- Unit: markers catalog — every entry has the required fields (cc_version, cc_npm_sha256, marker, position, marker_id).
- Unit: position-anchored matching — system-prompt-position markers do not match user-message positions and vice versa.
- Integration: `parallel()` fan-out fixture — 3 subagent calls; all three carry distinct `derived-agent-id` with the same `derived-parent-agent-id`. The fixture must be either a real captured Workflow fan-out (preferred, named in the PR) or hand-synthesized with the discriminator field present (acceptable as a fallback if real capture isn't available; PR must state which).
- Integration: Task subagent (canonical `agent-id` present) — derivation does NOT fire; canonical id used by `usage-log`; no derived headers added.
- Integration: sessionless request → no derivation.
- Integration: marker-text-in-user-content false-positive case → no derivation.
- Integration: env-var off → no behavior change from current state.
- Integration: drift canary — request matches conditions 1+2 but no marker → counter logged to event log.
- Integration: usage-log emission off (default) → no `agent_id` field on rows; meter validation passes.
- Integration: usage-log emission on, meter v0.8.0+ → `agent_id` + `agent_id_source` present on rows; meter validation passes.

## Files modified / created

Created:
- `proxy/extensions/workflow-agent-id-synthesis.mjs`
- `proxy/workflow-agent-derivation.mjs` (flat)
- `proxy/workflow-markers.mjs` (flat)
- `test/extensions/workflow-agent-id-synthesis.test.mjs`
- `test/workflow-agent-derivation.test.mjs`
- `test/workflow-markers.test.mjs`
- `test/fixtures/workflow-parallel-fanout-replay.json`

Modified:
- `proxy/extensions.json` — register `workflow-agent-id-synthesis` at order 360 (or verified neighbor position).
- `proxy/extensions/usage-log.mjs` — read `ctx.meta._workflowDerivedAgentId` and `_workflowDerivedAgentIdSource`; emit `agent_id` + `agent_id_source` on the row when `CACHE_FIX_USAGE_LOG_AGENT_ID=on` AND meter floor present. Default-off in v4.2.0 first ship.
- `proxy/extensions/request-log.mjs` — log derivation events to `~/.claude/workflow-derivation-events.jsonl` when derivation fires.
- `CHANGELOG.md` — v4.2.0 entry citing CC#66761, the meter v0.8.0 floor, and the env-var-gated rollout.
- `README.md` — extension docs.
- `docs/extensions.md` — updated entries for the three touched extensions.

**Companion PR (meter side, MUST land first):** `claude-code-meter#TBD` — add optional `agent_id` + `agent_id_source` fields to `MeterRowSchema`, ship in v0.8.0.

Out of scope (no changes):
- `proxy/pipeline.mjs`, `proxy/stream.mjs`, `proxy/server.mjs` — no pipeline modifications. No upstream header emission.
- No `proxy/lib/` or `test/lib/` directory.

## Reviewer checklist (cache-fix side)

- [ ] No upstream header emission; derivation lives entirely on `ctx.meta`.
- [ ] `workflow-markers.mjs` contains at least one binary-verified marker with cc_version + cc_npm_sha256 + matched string. (Implementation cannot ship without this.)
- [ ] Per-leg discriminator chosen from a binary-verified marker context field; documented in PR body. (3-distinct-ids acceptance test depends on this.)
- [ ] Derivation deterministic; tools-list churn does NOT affect the id.
- [ ] Position-anchored matching; user-content quote test passes.
- [ ] Helpers flat at `proxy/`, NOT `proxy/lib/`.
- [ ] Event log at `~/.claude/workflow-derivation-events.jsonl`; marker_id (catalog id), not raw matched text; 5 MB rotation.
- [ ] `usage-log` emission default-off behind `CACHE_FIX_USAGE_LOG_AGENT_ID`; companion meter v0.8.0 schema change MUST be released first.
- [ ] CHANGELOG cites CC#66761 + the meter v0.8.0 floor + the env-var rollout, matching the `request_id` v4.1.0 → v4.2.0 template.
- [ ] Drift canary logs `workflow-derivation-drift` event when conditions 1+2 hold but no marker matches.

## Out of scope (explicit)

- Upstream header emission. The derivation never leaves the proxy.
- Reverse-engineering CC's canonical agent-id derivation algorithm for when Anthropic ships the fix. Our derived id is independent; the canonical id wins on every read when it arrives.
- Tools other than Workflow. MCP, hooks, etc. are out of scope.
- Visualizing Workflow agent trees in the meter dashboard.
- Persistence of the markers catalog across cache-fix releases — vacuous (source persists by definition); the round-1 wording is dropped.
- Automated marker-drift detection. Manual watch surface via cc-watch + the drift canary; named honestly.

— AI Team Lead
