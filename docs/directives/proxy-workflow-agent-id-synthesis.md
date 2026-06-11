# Directive: Workflow-tool agent-id attribution (proxy-derived)

**Issue:** TBD (will be filed alongside this directive, referencing CC#66761)
**Upstream:** [anthropics/claude-code#66761](https://github.com/anthropics/claude-code/issues/66761) — *Workflow-tool agent() subagents omit x-claude-code-agent-id / parent-agent-id (Task subagents are tagged)* (state: closed; gap remains and the upstream fix will not be retroactive)
**Priority:** P2
**Directive branch:** `directive/workflow-agent-id-synthesis` (current PR #215). **Implementation branch (planned):** `feature/workflow-agent-id-synthesis` (round-2 directive accidentally used the implementation branch name as the directive's own branch field — corrected).
**Stage:** directive — round 2 (addresses Fable round-1 REQUEST_CHANGES at PR #215)
**Milestone:** v4.2.0 (cache-fix); meter schema change must land FIRST

## Goal

For CC's `/v1/messages` requests, the synthesis extension's `onRequest` stashes a normalized agent-attribution object on `ctx.meta._workflowAgentId = { id, parentId, source }`. There are exactly three states the request can be in:

1. **Canonical present** (Task subagent) — the extension stashes the canonical `x-claude-code-agent-id` value pass-through with `source: "cc-header"`.
2. **Workflow-derived** (no canonical header, marker detected, conditions met) — the extension stashes a deterministically-derived id with `source: "cache-fix-derived"`.
3. **Neither** (top-level conversation, sessionless request, no marker) — no stash; downstream consumers see no `_workflowAgentId` and emit no agent_id field.

Downstream attribution consumers (`usage-log`, the meter dashboard once schema v0.8.0 is in place) read exactly one meta key — `_workflowAgentId` — and never touch request headers. The derived ids never reach Anthropic upstream; they exist only as in-proxy attribution keys.

The derived id is explicitly non-canonical, and the `source` field makes the provenance machine-readable. Once CC backfills the canonical headers upstream for Workflow subagents, the canonical-present case applies to ALL traffic and the derivation path goes inert. The extension is structurally self-retiring.

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
    marker_id: "<stable-kebab-case-id, used as hash input — e.g. workflow-agent-context-v1>",
    cc_version: "2.1.170",
    cc_npm_sha256: "<64-hex>",
    discovered_at: "2026-06-11",
    discovered_by: "cc-watch-agent",
    marker: "<exact string from binary inspection>",
    position: "system-prompt" | "first-user-message",
    // Required ONLY for position: "first-user-message" entries — see
    // "Marker false positives" section below.
    first_message_authorship: "tool" | "user",
    notes: "<context>",
  },
  // ...
];
```

`marker_id` is the stable identifier hashed into derived agent ids; the raw `marker` string is never hashed. This decoupling lets us evolve the matched strings across CC versions while keeping derived id stability for unchanged Workflow legs (closes Fable N4 / Codex precision finding — round 2 hashed `marker_id` and required it in the test plan but omitted it from the catalog format).

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

1. **Meter directive + PR FIRST** — `meter-agent-id-schema-addition`. Companion meter directive must be filed in `cnighswonger/claude-code-meter` adding `agent_id` (string, max 64, optional) AND `agent_id_source` (enum: `"cc-header" | "cache-fix-derived"`, optional) to `MeterRowSchema`. Both fields strict-typed. Ships in claude-code-meter v0.8.0. **As of this directive's commit, the meter PR is not yet open.** Round-2 directive incorrectly referenced it as `#TBD`, implying it existed; round-3 fix names it concretely and pins it as a hard prerequisite. The cache-fix implementation PR for this directive must NOT be opened until the meter directive has been filed; the cache-fix implementation PR must NOT merge until meter v0.8.0 is released.
2. **Cache-fix PR THEN.** The Workflow-derivation extension lands with `usage-log.mjs` emission gated **default-off** via `CACHE_FIX_USAGE_LOG_AGENT_ID=on`. Operators who upgrade meter to v0.8.0+ can flip the env-var; operators on older meter installs see no row changes regardless of the env-var (the row is constructed but the field never populates unless meter v0.8.0+ is installed).
3. **One minor release later.** Default flip to on, exactly as `request_id` did v4.1.0 → v4.2.0. The flip release MUST validate live emitted rows against a v0.8.0 meter install on real Workflow fan-out traffic — sim-validation precondition, same caution that gated the `request_id` flip (closes Fable round-2 sim/real-traffic recommendation).

The release-ordering rule is `usage-log.mjs`'s own template (verified at `usage-log.mjs:40-44` documenting the request_id story). Reuse it explicitly.

**Operator attestation, not version probe** (closes Fable N5 / Codex precision): the cache-fix proxy cannot mechanically detect the operator's installed meter version. The env-var `CACHE_FIX_USAGE_LOG_AGENT_ID=on` IS the operator's attestation that meter v0.8.0+ is installed — exactly the contract `CACHE_FIX_USAGE_LOG_REQID=on` shipped. The directive's previous "AND meter floor present" language was wrong because it implied a runtime check that cannot exist; corrected.

**Documentation:** the directive's CHANGELOG must call out the meter version floor and the env-var, exactly as cache-fix v4.1.0's CHANGELOG documented the request_id rollout.

## Module layout (closes Fable B4)

Per the PR #213 round-2 resolution: shared helpers live flat at `proxy/`, not under a new `proxy/lib/` directory. Same for the test tree.

Round-2 placement:

- `proxy/extensions/workflow-agent-id-synthesis.mjs` — the extension proper (registered in `extensions.json`); owns the event-log writer.
- `proxy/workflow-agent-derivation.mjs` — pure-function derivation helper (flat).
- `proxy/workflow-markers.mjs` — markers catalog (flat).
- `test/extensions/workflow-agent-id-synthesis.test.mjs` — extension integration tests live in `test/extensions/` (a new subdirectory; the existing `test/` tree on main is otherwise flat, verified). The subdir is a deliberate convention shift mirrored from the testing pattern used by `proxy/extensions/`: extension-tests-under-extensions, helper-tests at top level. Codex/Fable round-2 flagged this as needing to be called deliberate; it is.
- `test/workflow-agent-derivation.test.mjs` (flat — helper test).
- `test/workflow-markers.test.mjs` (flat — helper test).
- `test/fixtures/workflow-parallel-fanout-replay.json`

No `proxy/lib/` introduced. `test/extensions/` is a new subdirectory adopted deliberately for this PR's extension tests; helper tests remain flat at `test/`.

## Activation model details (closes Fable round-1 attention #2)

The pipeline's `loadExtensions` only loads `proxy/extensions/*.mjs`. Helpers in `proxy/` are imported transitively — they need no `extensions.json` entry.

`extensions.json` adds exactly one entry: `"workflow-agent-id-synthesis": { "enabled": true, "order": 365 }` — verified against current `main` (`thinking-display` occupies 360; `cache-control-normalize` is at 400; 365 is a free slot in the same band). The round-2 directive proposed 360 which collides with `thinking-display`; tie-breaking by stable-sort + file-name order is an accident, not a contract. Closes Codex precision finding + Fable N3.

`usage-log.mjs` is enabled by the operator separately. As of current `main`, `extensions.json` does not include a `usage-log` entry at all (verified against `main` HEAD); operators add `"usage-log": { "enabled": true, "order": 650 }` themselves per the documentation. The Workflow-derivation extension running with no `usage-log` consumer simply populates `ctx.meta._workflowAgentId` for nothing — no harm.

The `default-on in v4.2.0` framing applies only to the extension's *evaluation*, not to the meter-row emission. Extension default-on (runs detection, populates meta), `usage-log` emission default-off (per the staged-rollout pattern), meter dashboard surfaces fields after v0.8.0.

## Canonical-vs-derived ownership (closes Codex blocker 1 + Fable N1)

Round 2 left an unreachable enum value. The directive promised `agent_id_source: "cc-header"` for Task subagents whose canonical `x-claude-code-agent-id` is present, but specified only a stash of derived ids — and detection condition 2 (canonical header ABSENT) forbids the derivation path from firing when the canonical header IS present. `usage-log` runs at `onStreamEvent` where request headers are no longer in scope (`stream.mjs:63` ctx is `{event, meta, telemetry, responseHeaders}` — verified). With round 2's spec, the `"cc-header"` enum value is unreachable and the canonical-priority test cannot pass.

**Round-3 fix:** the synthesis extension's `onRequest` stashes a SINGLE normalized attribution object on `ctx.meta` for BOTH cases:

```js
// At onRequest end:
if (canonical_present) {
  ctx.meta._workflowAgentId = {
    id: ctx.headers["x-claude-code-agent-id"],
    parentId: ctx.headers["x-claude-code-parent-agent-id"] || null,
    source: "cc-header",
  };
} else if (workflow_marker_detected) {
  ctx.meta._workflowAgentId = {
    id: derived_agent_id,
    parentId: derived_parent_agent_id,
    source: "cache-fix-derived",
  };
}
// otherwise undefined — no agent_id emission
```

This follows the established `cache-telemetry.onRequest` pattern (`cache-telemetry.mjs:170-179`, verified) of stashing request-side state on `ctx.meta` for downstream `onStreamEvent`-time consumers.

`usage-log.mjs` then reads exactly one meta key:

```js
// In onStreamEvent at message_delta-emit time:
const attr = ctx.meta._workflowAgentId;
if (attr && process.env.CACHE_FIX_USAGE_LOG_AGENT_ID === "on") {
  record.agent_id = attr.id;
  record.agent_id_source = attr.source;
  // (parentId surface is reserved for a future emission decision —
  // not in v4.2.0 row scope; the meta carries it for the event log only.)
}
```

The "canonical wins" priority is structural: when both could populate, `canonical_present` is checked first. The Task-subagent integration test asserts the row emits `agent_id_source: "cc-header"` and the canonical id value matches the input header.

## Event log + PII discipline (closes Fable round-1 attention #3 + round-2 N2)

The event-log writer lives in the **synthesis extension itself**, not in `request-log.mjs`. Round 2 incorrectly assigned the writer to `request-log.mjs`, which is `enabled: false` in mainline `extensions.json` AND additionally no-ops without `CACHE_FIX_REQUEST_LOG` set (verified at `proxy/extensions/request-log.mjs:3,21`). Default installs would therefore get zero drift-canary signal — defeating the purpose of the canary, which is the early warning when the marker catalog goes stale. The synthesis extension is `enabled: true` in v4.2.0; its own writer is the right home.

Event log path: `~/.claude/workflow-derivation-events.jsonl` (NOT `~/.cache-fix-proxy/`).

Per-record fields:

```json
{
  "ts": "<ISO8601>",
  "session_id": "<resolved>",
  "agent_id_source": "cc-header" | "cache-fix-derived",
  "marker_id": "<catalog id, NOT raw matched text — only on cache-fix-derived records>",
  "marker_position": "system-prompt" | "first-user-message",
  "agent_id": "<id>",
  "parent_agent_id": "<id>",
  "cc_version": "<from binary inspection at startup>",
  "schema_version": 1
}
```

Drift-canary records (conditions 1+2 hold but no marker matches) carry `agent_id_source: "drift-canary"` with no `agent_id` / `marker_id` fields. The canary surface is what tells operators their marker catalog has gone stale.

**Never log:** the matched marker text itself (prompt-derived content), the request body, auth headers.

Rotation: 5 MB single-tier per `bootstrap-defense.rotateIfNeeded` precedent (verified to exist at `bootstrap-defense.mjs`).

## Marker false positives from user-controlled content (closes Fable round-1 attention #4 + round-2 A4 residual)

Detection condition 3 ("system-prompt or first user message contains marker") could fire on a user message that quotes the marker text — e.g., someone discussing this feature.

Mitigations:

1. **Position-anchored matches.** The markers catalog records `position: "system-prompt"` vs `position: "first-user-message"`. The detection only matches against the configured position. This kills the system-prompt-position spoof.
2. **`first-user-message` markers require additional proof** (closes round-2 A4 residual / Codex). A `position: "first-user-message"` entry is only acceptable in the catalog if binary inspection confirms the first-user-message slot is **tool-authored** (CC injects Workflow context blocks programmatically), not user-authored. In a top-level CC session, the first user message IS user-authored — any `first-user-message` marker is user-controlled there, and the position-anchoring mitigation does NOT close the surface. The catalog format MUST include a field `first_message_authorship: "tool" | "user"` for every `first-user-message` entry; only `"tool"` entries are eligible. If binary inspection cannot confirm tool authorship, the entry is rejected from the catalog.
3. **Negative test.** A test case where the user message contains the marker text inside backtick quotes asserts NO derivation fires (the user-text position does not match a system-prompt-position marker, AND any `first-user-message` marker has been validated as tool-authored).
4. **Consequence is bounded:** even if a false positive slips through, the impact is one mis-attributed `usage.jsonl` row — not a data-loss or correctness path. The drift canary is a separate observability surface.

## Test plan

- Unit: detection — all three conditions checked; missing any one → no derivation; canonical-header path produces canonical stash without firing derivation.
- Unit: derivation — deterministic; same inputs → same id; different per-leg discriminators → different ids; tools-list churn does NOT change the id; `marker_id` (catalog field) is hashed, not raw `marker` string.
- Unit: markers catalog — every entry has `marker_id` + cc_version + cc_npm_sha256 + marker + position; `position: "first-user-message"` entries additionally require `first_message_authorship: "tool"`.
- Unit: position-anchored matching — system-prompt-position markers do not match user-message positions and vice versa.
- Unit: `_workflowAgentId` stash shape — `{ id, parentId, source }` always; `source` is exactly `"cc-header"` for canonical, `"cache-fix-derived"` for derived; no other values.
- Integration: `parallel()` fan-out fixture — 3 subagent calls; all three carry distinct derived agent ids with the same derived parent-agent-id. The fixture must be either a real captured Workflow fan-out (preferred, named in the PR) or hand-synthesized with the discriminator field present (acceptable as a fallback if real capture isn't available; PR must state which).
- **Integration: Task subagent (canonical `x-claude-code-agent-id` header present) — derivation does NOT fire; `ctx.meta._workflowAgentId.source === "cc-header"`; `usage-log` row emits `agent_id: <canonical>` + `agent_id_source: "cc-header"`. (Closes Codex blocker 1 / Fable N1 — this test cannot pass without the round-3 normalized-stash spec.)**
- Integration: sessionless request → no derivation, no stash, no row field.
- Integration: marker-text-in-user-content false-positive case → no derivation.
- Integration: env-var off → no behavior change from current state.
- Integration: drift canary — request matches conditions 1+2 but no marker → event logged with `agent_id_source: "drift-canary"` to the synthesis extension's own writer (not request-log).
- Integration: usage-log emission off (default) → no `agent_id` field on rows; meter validation passes against current schema.
- Integration: usage-log emission on, meter v0.8.0+ → `agent_id` + `agent_id_source` present on rows; meter validation passes against the v0.8.0 schema.
- Integration: order verification — extension loaded at order 365; runs after `thinking-display` (360) and before `cache-control-normalize` (400).

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
- `proxy/extensions.json` — register `workflow-agent-id-synthesis` at order **365** (free slot between `thinking-display` 360 and `cache-control-normalize` 400; verified against mainline).
- `proxy/extensions/usage-log.mjs` — read `ctx.meta._workflowAgentId` (the normalized `{ id, parentId, source }` stash that handles BOTH canonical and derived cases — see "Canonical-vs-derived ownership" section); emit `agent_id` + `agent_id_source` on the row when `CACHE_FIX_USAGE_LOG_AGENT_ID=on` (the env-var IS the operator's attestation of meter v0.8.0+ — no runtime version probe). Default-off in v4.2.0 first ship.
- (No modification to `proxy/extensions/request-log.mjs`. Round-2 directive incorrectly assigned the event-log writer to `request-log.mjs`, which is `enabled: false` in mainline `extensions.json` AND env-gated by `CACHE_FIX_REQUEST_LOG` — default installs would receive zero drift signal. The synthesis extension owns its own writer.)
- `CHANGELOG.md` — v4.2.0 entry citing CC#66761, the meter v0.8.0 floor, and the env-var-gated rollout.
- `README.md` — extension docs.
- `docs/extensions.md` — updated entries for the three touched extensions.

**Companion PR (meter side, MUST land first):** `claude-code-meter` — directive named `meter-agent-id-schema-addition` to be filed before this directive's implementation PR opens. Adds optional `agent_id` (string, max 64) + `agent_id_source` (enum: `"cc-header" | "cache-fix-derived"`) fields to `MeterRowSchema`. Ships in claude-code-meter v0.8.0. **As of the round-3 commit on this directive, the meter directive has not yet been filed.** The cache-fix implementation PR for this directive is BLOCKED until the meter directive is filed; the cache-fix implementation PR cannot merge until meter v0.8.0 is released. The round-2 `#TBD` reference was misleading and is corrected.

Out of scope (no changes):
- `proxy/pipeline.mjs`, `proxy/stream.mjs`, `proxy/server.mjs` — no pipeline modifications. No upstream header emission.
- No `proxy/lib/` or `test/lib/` directory.

## Reviewer checklist (cache-fix side)

- [ ] No upstream header emission; derivation lives entirely on `ctx.meta`.
- [ ] **Single normalized stash** `ctx.meta._workflowAgentId = { id, parentId, source }` for BOTH canonical and derived cases; canonical path stashes too, not only the derived path. Canonical-priority Task-subagent test asserts row emits `agent_id_source: "cc-header"`.
- [ ] `workflow-markers.mjs` contains at least one binary-verified marker with `marker_id` + cc_version + cc_npm_sha256 + matched string. (Implementation cannot ship without this.)
- [ ] Any `position: "first-user-message"` entry has `first_message_authorship: "tool"` AND binary inspection proof attached to the PR body. User-authored first messages are NOT eligible.
- [ ] Per-leg discriminator chosen from a binary-verified marker context field; documented in PR body. (3-distinct-ids acceptance test depends on this.)
- [ ] Derivation deterministic; tools-list churn does NOT affect the id; `marker_id` (catalog field) is hashed, not the raw `marker` string.
- [ ] Position-anchored matching; user-content quote test passes.
- [ ] Helpers flat at `proxy/`, NOT `proxy/lib/`. `test/extensions/` subdir is documented as a deliberate convention shift.
- [ ] Event log at `~/.claude/workflow-derivation-events.jsonl`; **owned by the synthesis extension itself, NOT request-log.mjs** (request-log is `enabled: false` in mainline `extensions.json`); marker_id (catalog id), not raw matched text; 5 MB rotation.
- [ ] Extension registered at order **365** (NOT 360 — collides with `thinking-display`). Verified against mainline `extensions.json`.
- [ ] `usage-log` emission default-off behind `CACHE_FIX_USAGE_LOG_AGENT_ID`; env-var IS the operator's attestation of meter v0.8.0+ (no runtime version probe). Companion meter v0.8.0 schema PR must be open before this PR opens, and released before this PR merges.
- [ ] CHANGELOG cites CC#66761 + the meter v0.8.0 floor + the env-var rollout, matching the `request_id` v4.1.0 → v4.2.0 template.
- [ ] Drift canary logs records with `agent_id_source: "drift-canary"` when conditions 1+2 hold but no marker matches.
- [ ] Sim/real-traffic validation precondition for the v4.3.0 default-on flip: live emitted rows validated against a v0.8.0 meter install on real Workflow fan-out traffic.

## Out of scope (explicit)

- Upstream header emission. The derivation never leaves the proxy.
- Reverse-engineering CC's canonical agent-id derivation algorithm for when Anthropic ships the fix. Our derived id is independent; the canonical id wins on every read when it arrives.
- Tools other than Workflow. MCP, hooks, etc. are out of scope.
- Visualizing Workflow agent trees in the meter dashboard.
- Persistence of the markers catalog across cache-fix releases — vacuous (source persists by definition); the round-1 wording is dropped.
- Automated marker-drift detection. Manual watch surface via cc-watch + the drift canary; named honestly.

— AI Team Lead
