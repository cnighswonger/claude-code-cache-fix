Verdict: APPROVE_WITH_NITS

# PR #215 — Workflow-tool agent-id attribution directive — round 2 of 2 (Fable)

Re-reviewed at HEAD `b9037fb` against round-1 findings at `387bcf8`. Verified against `proxy/server.mjs`, `proxy/pipeline.mjs`, `proxy/stream.mjs`, `proxy/upstream.mjs`, `proxy/extensions.json`, `proxy/extensions/{usage-log,request-log,cache-telemetry,deferred-tools-restore}.mjs`, `claude-code-meter/src/log/schema.mjs`, the flat `proxy/` + `test/` trees on current main, and `bootstrap-defense.mjs`'s `rotateIfNeeded`. All five blockers are materially fixed; the remaining items are spec-level nits the implementation PR can and must absorb.

## Round-1 → Round-2 Status

| # | Round-1 finding | Status | Note |
|---|---|---|---|
| B1 | Upstream header synthesis architecturally impossible; nothing owns derivation | **ADDRESSED** | "What does NOT happen" section acknowledges the impossibility with correct citations (`server.mjs:86,97-99,132-136` — re-verified accurate); restructured to a named extension stashing on `ctx.meta`; upstream emission dropped entirely and pinned out-of-scope ("no pipeline modifications"). |
| B2 | Meter schema claim false; default-on breaks every unpatched meter install | **ADDRESSED** | Now correctly states `MeterRowSchema` is `z.strictObject` with neither field (verified: `schema.mjs:5`, no `agent_id`/`source` today); companion meter PR adds both optional fields and MUST land first (v0.8.0); cache-fix emission default-off behind `CACHE_FIX_USAGE_LOG_AGENT_ID`; flip one minor release later — the exact `request_id` v4.1.0→v4.2.0 template (`usage-log.mjs:40-44`). |
| B3 | Derivation can't pass its own 3-distinct-ids test; tools-list churn splits ids | **ADDRESSED** | Tools-list removed from the hash entirely (churn per `deferred-tools-restore.mjs:1-10` acknowledged); per-leg discriminator sourced from inside the marker context block, gated on binary inspection confirming such a field exists, with an explicit withdrawal/rescope condition if it doesn't. Honest conditional rather than asserted mechanics — the right posture for a directive. |
| B4 | `proxy/lib/` reintroduces layout rejected in PR #213 round 2 | **ADDRESSED** | Helpers flat at `proxy/`, tests flat-ish at `test/` (one `test/extensions/` subdir; see N6), explicit "No `proxy/lib/` or `test/lib/`" in scope and checklist. |
| B5 | Markers catalog has no concrete content | **ADDRESSED** (via the deferral option round 1 offered) | Discovery is now a gating prerequisite: implementation cannot start without ≥1 binary-verified entry carrying cc_version + npm sha256 + matched string per the inspection playbook, and the directive names the withdrawal condition if no markers verify. The catalog is still empty *in the directive*, but round 1 explicitly accepted "restructure: make marker discovery an explicit gating task" — that is what shipped. |
| A1 | Self-contradictory "no request mutation" claim | **ADDRESSED** | With upstream emission dropped, "additive only" is now true; the directive says so explicitly. |
| A2 | Activation model didn't match the loader | **ADDRESSED** | Now correct: one `extensions.json` entry for the extension; helpers imported transitively, no config entry. Minor wording drift: "usage-log is separately enabled by the operator" — the shipped `extensions.json` already has `usage-log` `enabled: true` (lines 74-77), so in a default install the consumer is live and only the env-var gates emission. Harmless (the env-var is the load-bearing gate) but the sentence overstates the opt-in. |
| A3 | Event-log location/PII/rotation | **ADDRESSED** | `~/.claude/workflow-derivation-events.jsonl`, marker_id-not-raw-text allowlist, explicit never-log list, 5 MB rotation per the `bootstrap-defense.rotateIfNeeded` precedent (verified to exist). But see N2 for where the writer lives. |
| A4 | Marker false positives from user content | **PARTIALLY ADDRESSED** | Position-anchored matching + negative test kill the system-prompt-position spoof. Residual: a marker cataloged with `position: "first-user-message"` is still matchable by user-controlled content — in a top-level session, the first user message IS user-authored, and detection conditions 1+2 (session id present, agent-id absent) hold for *all* top-level CC traffic. Consequence remains mild (one mis-attributed row), but the directive should name the residual instead of implying position-anchoring closes the surface. |
| A5 | Missing schema-validation test | **ADDRESSED** | Both meter-validation integration tests present (emission off → validates; emission on + v0.8.0 → validates). |
| A6 | Missing canonical-overrides-derived priority test | **PARTIALLY ADDRESSED** | The Task-subagent test asserts "canonical id used by usage-log" — but the spec provides no mechanism for usage-log to ever see the canonical id (see N1). The test as written cannot pass against the directive as written. |
| A7 | Sessionless behavior unspecified | **ADDRESSED** | Explicit integration test: sessionless → no derivation. |
| A8 | Catalog maintenance ownership | **ADDRESSED** | Named honestly as a manual cc-watch watch surface; automated detection explicitly out of scope; `workflow-derivation-drift` canary added as the stale-catalog early signal. But see N2 — the canary's home undermines it. |

AITL's self-assessment ("claimed mechanics the pipeline architecturally cannot deliver (B1) and a meter contract that does not exist (B2)") is accurate, and both fixes are the simplifications round 1 recommended rather than workarounds.

## New Issues

**N1 (most substantive — must be resolved in the implementation PR): `agent_id_source: "cc-header"` is unreachable as specified.** The meter enum is `"cc-header" | "cache-fix-derived"`, and the Goal/priority language says canonical wins on every read path. But usage-log emits at `onStreamEvent`, where the ctx is `{ event, meta, telemetry, responseHeaders }` (`stream.mjs:63`) — request headers are not available. The only stash the directive specifies is `ctx.meta._workflowDerivedAgentId`, populated *only when derivation fires*, and detection condition 2 guarantees derivation does NOT fire when the canonical header is present. So no component ever delivers the canonical `x-claude-code-agent-id` to usage-log: the `"cc-header"` enum value can never be emitted, and the A6 test ("canonical id used by usage-log") cannot pass. Fix is one line of spec: the synthesis extension's `onRequest` stashes the canonical id pass-through (e.g., `ctx.meta._workflowAgentId = { id, source: "cc-header" }`) when present, and the derived pair otherwise — same pattern as `cache-telemetry.onRequest`'s `_sessionId` stash (`cache-telemetry.mjs:170-179`).

**N2: The drift canary and derivation event log are homed in `request-log.mjs`, which is dead by default.** `request-log` is `enabled: false` in `extensions.json` (lines 70-73) and additionally no-ops without `CACHE_FIX_REQUEST_LOG` set (`request-log.mjs:3,21`). The canary is supposed to be the early-warning that the marker catalog went stale — homing it in a default-off, env-gated extension means default installs get zero drift signal, defeating its purpose (and quietly re-creating round-1 A8). The event-log writer belongs in the synthesis extension itself, which is default-on.

**N3: Order 360 collides with `thinking-display`.** `extensions.json` already has `thinking-display` at 360; the directive proposes 360 while simultaneously saying the new extension runs "after … thinking-display at 360." The tie only resolves via stable sort + alphabetical file order — an accident, not a contract. The directive hedges ("exact position verified during implementation"), but it should not document a collision; pick a free slot (e.g., 365).

**N4: Catalog format omits `marker_id`.** The derivation hashes `marker_id` and the catalog unit test requires it on every entry, but the `WORKFLOW_MARKERS` format example has no `marker_id` field. Add it to the format.

**N5: "AND meter floor present" is not mechanically checkable.** The proxy cannot detect the operator's meter version; in the `request_id` precedent the env-var *is* the operator's attestation of the floor. Rephrase the emission condition so the implementation doesn't go looking for a version probe that can't exist.

**N6 (observation): `test/extensions/` is a new subdirectory.** The test tree on main is flat (`test/*.test.mjs`, fixtures aside). One subdir for extension tests is defensible but is the same shape of question B4 was about — name it as a deliberate choice in the implementation PR rather than letting it land silently.

**LOC budget:** the restated 250-350 honestly counted (code + helper + tests) is plausible and resolves the round-1 fiction; no flag.

**Sim/real-traffic validation:** the derivation itself is read-only in-band (body read + meta stash) — low risk, unit/integration coverage suffices. The meter-row emission is the part that warrants real-traffic proof: before the default-on flip lands (the "one minor release later" step), rows produced under `CACHE_FIX_USAGE_LOG_AGENT_ID=on` should be validated against a live meter v0.8.0 install on real Workflow fan-out traffic — same caution that gated the `request_id` flip. Recommend making that an explicit precondition of the flip release.

## Recommendations

1. Fold N1 into the implementation: synthesis extension stashes `{ id, source }` on `ctx.meta` for BOTH the canonical-present and derived cases; usage-log reads one meta key and never needs headers. Add it to the reviewer checklist line that already covers canonical priority.
2. Move the event log + drift canary writer into the synthesis extension (N2); drop the `request-log.mjs` modification from Files-modified.
3. Pick a non-colliding order (N3), add `marker_id` to the catalog format (N4), and rephrase the emission gate as env-var-as-attestation (N5).
4. Gate the v4.3.0 default-on flip on real-traffic validation of emitted rows against meter v0.8.0.

## Bottom Line

Round 2 fixes all five blockers the way round 1 recommended — and in B1's case the fix genuinely simplifies the design (in-proxy `ctx.meta` attribution, zero pipeline changes, no upstream claims to defend). The meter release-ordering now mirrors the proven `request_id` template, the derivation is honestly gated on binary-inspection findings with named withdrawal conditions instead of asserted mechanics, and the layout matches the settled convention. What remains is spec-tightening, not architecture: the `"cc-header"` source path needs an owner (N1), and the drift canary needs a home that's actually on by default (N2). Both are one-line spec fixes the implementation PR must carry, and the reviewer checklist is the right enforcement point since this was round 2 of 2. Approving with nits.

— Fable 5 Review Agent
