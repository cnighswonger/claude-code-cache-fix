# Directive: statusline served-model divergence indicator

**Issue:** [#223](https://github.com/cnighswonger/claude-code-cache-fix/issues/223)
**Upstream:**
- [anthropics/claude-code#66728](https://github.com/anthropics/claude-code/issues/66728) — *Classifier-driven served-model swap is invisible to operators (six reported occurrences)*

**Priority:** P1
**Branch:** `feature/statusline-served-model-divergence`
**Stage:** directive — round 1
**Labels:** `directive-stage`, `P1`, `schema-change` (new persisted per-session fields + new statusline contract)
**Milestone:** v4.3.0

## Goal

Surface, in real time, the moment the served model on a CC session diverges from the requested model — the classifier-driven swap pattern documented in CC#66728. Today this is invisible until someone inspects a transcript or grep'd usage row hours after the fact. The proxy already sees both ends (request body `model` and response stream `event.message.model` on `message_start`); the statusline already reads from per-session JSON. The directive extends `cache-telemetry` to capture + persist divergence state with a sticky latch, and extends `tools/quota-statusline.sh` to render an indicator when divergence is recent or sticky.

This is the first real-time operator surface for a class of bugs (classifier-triggered downgrades) that has been a recurring upstream issue without a UX path to observe it.

## Why

Today, when CC's safety classifier swaps the served model mid-session (Fable → Opus 4.8, Sonnet → Haiku, etc.), there is no operator-visible signal that the swap occurred. The user has to either notice the in-TUI banner in real time, or inspect the session JSONL after the fact, or read the `model` field of a usage.jsonl row. None of those is a live surface. The result is sessions like gowy222's six occurrences on CC#66728, where the downgrade is detected hours into a downgraded run instead of when it lands.

The proxy already sees `requested_model` (request body) and served `model` (response). Two fields, one comparison per turn. The statusline already reads from `~/.claude/quota-status/sessions/<id>.json` and renders whatever `cache-telemetry` writes there. Total work is two small additions (writer + reader) on already-load-bearing components.

Falk-flagged adjacent: this also pairs with the May 9 [5] item (latched-headers observability) and the in-flight extended-cache-ttl-header local test in the sense that both expand the proxy's observability surface to cover server-driven session state CC doesn't expose.

## Non-Functional Requirements

- **Size/complexity budget:** ~250–350 LOC total — writer-side detector + module-scope per-session state + schema additions (~150 LOC in `proxy/extensions/cache-telemetry.mjs`), statusline rendering block + label-and-color logic (~50 LOC of bash + embedded Python in `tools/quota-statusline.sh`), plus tests (~150 LOC). Reviewers should flag implementations materially larger than ~2× this.
- **Threat model:** the new persisted fields are short string scalars (model names, ISO timestamps, booleans). No user-provided content goes anywhere new; comparison is local string equality on already-flowing fields. Statusline renders only the model names, which are non-secret. No new external surfaces, no new headers, no new env vars beyond what cache-telemetry already uses.
- **Maintainability constraints:** the divergence detector is a small pure function plus a per-session counter map. No new abstractions; reuses existing `meta` plumbing, `sessionFilename` resolution, and the per-session JSON spread pattern. No CI/config changes. Statusline render-block extends the existing TTL/hit-rate block — no new tool, no new shell file.
- **Performance/reliability:** trivial. Two extra field reads from `ctx.body` / `event.message` per response, one map lookup, one map write. Statusline reader gains four field reads + a conditional render branch. Failure isolation: the detector lives inside cache-telemetry's existing try/catch around the writer (`cache-telemetry.mjs:263-270`), so a malformed value cannot break the pipeline. Statusline already tolerates absent fields (existing `sess.get('cache', {})` precedent) — additive schema reads safely default to None / `[]`.
- **Load-bearing? Yes.** Adds a new persisted contract on the per-session JSON (`requested_model`, `served_model`, `model_divergence_recent`, `model_divergence_sticky`, `model_divergence_first_seen`) and a new statusline rendering contract. By CLAUDE.md's rubric (wire/schema contract + shared abstraction touching the operator observability surface), this qualifies as load-bearing. Per CLAUDE.md, load-bearing changes require Chris human review before merge in addition to Lead + Codex review.

## Functional requirements (carried from #223)

1. **Show only on divergence.** Normal-operation default: no extra field in the statusline. When `requested_model ≠ served_model` on the most recent turn, render a divergence indicator. When neither recent-divergent nor sticky, render nothing.

2. **Sticky state on session-permanent downgrade.** A single divergent turn followed by a return-to-requested could be a transient. A divergence that persists past the sticky threshold (see §Heuristic below) latches sticky for the remainder of the session — the bar keeps warning even if subsequent turns happen to align by coincidence. Sticky state is observable in the session JSON (`model_divergence_sticky: true`) so other consumers can read it without re-deriving from the request stream.

3. **Short labels with [1m] indicator.**
   - Family-derived short labels per the table below.
   - When `[1m]` context is in use, append `[1m]` (e.g., `Opus 4.7[1m]`). Source: `auto_1m_detected` field already on the per-session JSON via `_auto1mGuard` spread (`cache-telemetry.mjs:255`, set by `auto-1m-guard.mjs:105`).
   - Divergence renders as `requested → served`, e.g., `Fable → Opus 4.8`.

4. **Attention-grabbing color.** Recent-divergent renders red (`\033[31m`) matching the existing `TTL:5m` warning at `quota-statusline.sh:192`. Sticky state renders with yellow background (`\033[43m`) — distinct enough to signal "this is now persistent" without conflicting with the red used for transient signals. Reviewers can propose alternative color choices; the only constraint is that the two states be visually distinct from each other and from the existing red.

5. **Cost-pool axis (deferred to post-2026-06-15).** Once the SDK pool split lands, the bar should also expose which billing pool the recent turn drew from. Out of scope for this directive's initial PR; flagged for follow-up. Field-naming should leave room: a future `cost_pool` field on the per-session JSON is the obvious continuation, but no shape is committed here.

## Sticky-detection heuristic (Step 3 — narrow the issue's open question)

The issue proposes "3 consecutive divergent turns OR a span of ≥5 minutes, whichever lands first" but invites better proposals. The directive recommends a **family-aware split**:

- **Cross-family divergence → immediate sticky** on the first divergent turn. Examples: Fable → Opus, Sonnet → Haiku, Opus → Sonnet. Cross-family swaps are very rarely innocent; they almost always indicate a classifier action worth surfacing immediately. Letting the user wait 3 turns to see this when CC#66728 is the existence proof is the wrong UX trade-off.
- **Same-family divergence → 3-consecutive-turn counter** before latching. Example: Opus 4.7 → Opus 4.8 is far more often a legitimate version routing event (rollout, A/B). Three consecutive turns matched at the same target eliminates transients without an unnecessary stickiness on cross-version routing.
- **Sticky never auto-unlatches within a session.** Per the issue's framing ("session locked downgrade — no recovery without `/model` restore"), sticky is one-way. A `/model` invocation that produces a matched turn does not clear sticky; the session restart is the recovery path. Operator can manually delete the per-session JSON if they need to clear it.
- **The 5-minute span suggestion from the issue is dropped.** Turn-count is the only signal that doesn't require persisting timestamps across stream events on the writer side; introducing a wall-clock branch increases complexity without materially better detection.

The family map is hard-coded in `cache-telemetry.mjs` (or a small adjacent helper):

```
fable        → fable
mythos       → mythos
opus-4-7     → opus
opus-4-8     → opus
opus-4-7[1m] → opus  (1m suffix is orthogonal to family)
sonnet-4-6   → sonnet
sonnet-4-7   → sonnet
haiku-4-5    → haiku
```

Unknown model strings fall through to "unknown" family and are treated as same-family for purposes of the counter (conservative — avoids latching sticky on a yet-unseen model). The family map is the only piece of business logic that needs to update when Anthropic ships new models; documented as such in CHANGELOG and in the code site.

## Short label table

| Model id (substring match) | Short label |
|---|---|
| `fable` | `Fable` |
| `mythos` | `Mythos` |
| `claude-opus-4-7` | `Opus 4.7` |
| `claude-opus-4-8` | `Opus 4.8` |
| `claude-sonnet-4-6` | `Sonnet 4.6` |
| `claude-sonnet-4-7` | `Sonnet 4.7` |
| `claude-haiku-4-5` | `Haiku 4.5` |
| anything else | the raw `model` id (operator fallback so unknown models are still legible) |

`[1m]` suffix appends to either side of the `→` when `auto_1m_detected` is true on the current per-session JSON.

## Implementation surface (file-anchored)

### Writer side — `proxy/extensions/cache-telemetry.mjs`

1. **Request-side capture.** `proxy/server.mjs:127` already parses `requestedModel = parsed?.model || null` but only retains it as a local. Add `meta._requestedModel = requestedModel` after that line so `cache-telemetry.onStreamEvent` can read it. (`meta` is already plumbed through `onRequest → onResponseStart → onStreamEvent`; precedent at `server.mjs:148`, `:250`, `:260`.)

2. **Response-side capture.** Inside the existing `message_start` handler at `cache-telemetry.mjs:194`, read `event.message?.model` (already accessible — `usage-log.mjs:88` uses the same field). Compare against `ctx.meta._requestedModel`. If different, evaluate the family-aware sticky heuristic against the module-scope per-session state map and stash a result object on `ctx.meta._modelDivergence` for the `message_delta` writer to consume.

3. **Module-scope state.** `cache-telemetry.mjs` already holds module-scope state (`legacyCleanupDone`, `lastSweepMs`). Add a `Map<sessionFilename, { divergentTurnCounter, sticky, firstSeenIso }>`. LRU-bounded (reuse the existing `sweepStaleSessions` cadence at `cache-telemetry.mjs:132-156` to evict stale entries — same retention semantics already in use for the sessions directory). `__resetForTests` (`cache-telemetry.mjs:275`) clears the map for unit tests.

4. **Schema additions in the per-session JSON object** built at `cache-telemetry.mjs:225-261`. The new fields piggyback on the same spread idiom used by `_thinkingSanitize`, `_thinkingSanitizeV2`, `_auto1mGuard`, `_sessionHealth`:

```js
...(ctx.meta._modelDivergence || {}),
```

where `_modelDivergence` is the object produced by the writer side and shaped as:

```
{
  requested_model: string,
  served_model: string,
  model_divergence_recent: boolean,
  model_divergence_sticky: boolean,
  model_divergence_first_seen: string | null,   // ISO timestamp set when sticky latches; null otherwise
}
```

When `requested_model === served_model` AND no prior sticky state, `_modelDivergence` is left undefined and the spread is a no-op. When a matched turn occurs but sticky was previously latched, `_modelDivergence` carries the sticky flag + first-seen + matched (`recent: false, sticky: true`) so the statusline keeps warning. The two booleans are the load-bearing signal; the timestamps and strings are display payload.

5. **Failure isolation.** All new logic runs inside the existing `try {}` block at `cache-telemetry.mjs:263-270`. A bad model string, a missing field, or a map exception drops the divergence record on the floor; the pipeline continues. No `unhandledRejection`. No client-visible behavior change.

### Reader side — `tools/quota-statusline.sh`

After the existing TTL/hit-rate render at `quota-statusline.sh:188-196`, add a conditional render block. The script's structure is bash + heredoc'd Python (`<<'PYEOF'` to disable bash interpolation per the v3.5.2 security note at `quota-statusline.sh:12-22`). New code lives in the heredoc, NOT in bash — the security boundary stays intact.

Render rules:

- `recent = sess.get('model_divergence_recent', False)`
- `sticky = sess.get('model_divergence_sticky', False)`
- If neither, render nothing.
- If `recent` and not `sticky`: render `' | ' + red(short(requested) + ' → ' + short(served))`.
- If `sticky` (regardless of `recent`): render `' | ' + yellow_bg(short(requested) + ' → ' + short(served))`.
- `[1m]` suffix from `auto_1m_detected` on both sides of the `→` (cross-family swaps almost certainly drop 1m on the served side, but the field is consulted per-model from the same per-session JSON snapshot, so the rule applies uniformly).

Short-label function follows the table above. Unknown models pass through verbatim — the operator still gets information.

### What does NOT change

- `proxy/server.mjs` — single one-line addition at :127 to stash `meta._requestedModel`. No structural change.
- `proxy/pipeline.mjs` — no change.
- `proxy/extensions.json` — no new extension (this is a feature inside cache-telemetry).
- `proxy/extensions/usage-log.mjs` — no change. The `extractMessageStartFields` helper already exposes `model` for any later consumer.
- `proxy/extensions/auto-1m-guard.mjs` — no change. The `auto_1m_detected` field already flows correctly.
- Pre-existing `cache` block schema (`ttl_tier`, `hit_rate`, etc.) — unchanged.

## Test plan

- **Detector unit tests** (`test/proxy-cache-telemetry-model-divergence.test.mjs`, new file):
  - Matched turn (no divergence) — no `_modelDivergence` field; per-session map unchanged.
  - Cross-family swap (Fable → Opus 4.8) — immediate sticky; `recent: true, sticky: true, first_seen: <iso>`.
  - Same-family swap × 1 (Opus 4.7 → Opus 4.8) — `recent: true, sticky: false`; counter = 1.
  - Same-family swap × 2 — `recent: true, sticky: false`; counter = 2.
  - Same-family swap × 3 — `recent: true, sticky: true, first_seen: <iso>`.
  - Sticky persists across subsequent matched turn — `recent: false, sticky: true, first_seen` unchanged.
  - Same-family swap × 2 then matched turn — counter resets to 0 (transient handled), no sticky.
  - Unknown-family model — treated as same-family (counter-based latching); no immediate sticky.
- **Integration** (extend `test/proxy-cache-telemetry.test.mjs`): synthesize a request with body `model: "claude-opus-4-7"` and a `message_start` with `event.message.model: "claude-opus-4-8"`; assert the spread fields appear on the written per-session JSON.
- **Statusline rendering** (`test/quota-statusline-divergence.test.sh` or extend the existing statusline test if one is present — confirmed during impl): no divergence → no extra field; recent divergence → red `requested → served`; sticky → yellow-background treatment; `[1m]` suffix appears when `auto_1m_detected: true`. Tests invoke the script with synthetic per-session JSON files and assert on the rendered string.
- **Failure-isolation**: feed a malformed `event.message` (missing `.model`, non-string `.model`) — assert no exception escapes, no `_modelDivergence` field written, per-session JSON write succeeds for the other fields.

## Verification

- `node --test test/proxy-cache-telemetry-model-divergence.test.mjs` — all green.
- `node --test test/proxy-cache-telemetry.test.mjs` — still green; no regression.
- Statusline test green on both default-rendering case (no divergence) and the new cases.
- Manual smoke: with the proxy running on a dev host (see internal deployment notes), drive a session through `/model fable` then watch for the safety-classifier swap event. The statusline should show the divergence within one turn. Cross-family swap should immediately render the sticky treatment.
- `gh pr view <impl-pr>` shows `needs-sim-validation` capture if any envelope-shape parity is in scope (no new envelope here; sim is unlikely required, but reviewers can call it).

## Files modified / created (impl PR — out of scope for the directive PR)

Created:
- `test/proxy-cache-telemetry-model-divergence.test.mjs` — new unit tests for the detector.
- `test/quota-statusline-divergence.test.sh` (or extend existing statusline test) — render tests.

Modified:
- `proxy/server.mjs` — one-line `meta._requestedModel = requestedModel` at :127.
- `proxy/extensions/cache-telemetry.mjs` — divergence detector + module-scope state map + schema spread.
- `tools/quota-statusline.sh` — render block after the existing TTL/hit-rate section.
- `test/proxy-cache-telemetry.test.mjs` — new integration test covering the spread.
- `CHANGELOG.md` — v4.3.0 entry citing CC#66728 + #223; calls out the family-map maintenance burden.
- `README.md` — statusline feature callout listing the divergence indicator (one-line addition).
- `docs/quota-statusline.md` (if present) — render-rule table.

Out of scope (no changes):
- `proxy/pipeline.mjs`, `proxy/stream.mjs` — no pipeline hook changes.
- Cost-pool field — deferred to post-2026-06-15.
- Preload-mode shim — preload writes the flat `quota-status.json`, not the split layout. The preload parity update would need a parallel change once the proxy-mode version lands; tracked as a follow-up.

## Reviewer checklist (cache-fix side)

- [ ] `meta._requestedModel` plumbed through `server.mjs:127` and read at `cache-telemetry.mjs` `message_start` handler.
- [ ] Family map is one named constant, updated only when Anthropic ships a new family.
- [ ] Cross-family swap latches sticky on turn 1; same-family swap requires 3 consecutive divergent turns.
- [ ] Counter resets to 0 on a matched turn before sticky latches (transient handling proven by unit test).
- [ ] Per-session state map LRU-bounded and swept by the existing `sweepStaleSessions` cadence; `__resetForTests` clears it.
- [ ] Schema spread idiom matches `_thinkingSanitize`, `_auto1mGuard`, `_sessionHealth` — additive, optional, no breaking field deletions.
- [ ] When `requested_model === served_model` and no prior sticky, `_modelDivergence` is undefined; spread is a no-op.
- [ ] Statusline render only fires on `recent` or `sticky`; default render path unchanged.
- [ ] Statusline reads the new fields from per-session JSON only; no new account.json fields.
- [ ] Bash heredoc `<<'PYEOF'` boundary preserved per `quota-statusline.sh:37-41` security note.
- [ ] `[1m]` suffix consumes `auto_1m_detected` from the per-session JSON; no separate plumbing.
- [ ] Short-label table matches the directive's table; unknown models pass through verbatim.
- [ ] CHANGELOG entry cites CC#66728 + #223 and calls out the family-map maintenance burden.
- [ ] Failure isolation: writer-side detector cannot throw out of cache-telemetry's existing try/catch.

## Out of scope (explicit)

- **Cost-pool indicator.** Deferred to post-2026-06-15 SDK pool split.
- **Notification path** (PushNotification or equivalent) when sticky first latches — visible-color indicator is sufficient for v1; notification is a possible v2 once we have real-world data on how often it would fire.
- **Auto-restore** — issuing `/model` to recover from a sticky downgrade is observability, not remediation. Out of scope.
- **Anything specific to CC#66728's classifier internals.** We observe the divergence as a black-box pattern; we do not try to predict it.
- **Preload-mode parity** for the indicator. The preload writes the flat `quota-status.json`, not the split layout (filed as cache-fix #219). Preload parity is a separate change that can land once the proxy version is validated; tracking as follow-up.
- **Sticky-clear UI.** No clear-sticky mechanism inside the statusline. Operator removes the per-session JSON file or starts a new session.

## Review chain

Per project workflow:
1. Qwen first-pass scan
2. Fable primary review (design-judgment-heavy — heuristic choice, label conventions, color, sticky-state rules all need a second opinion)
3. Codex cross-LLM verification
4. AITL plan-approval
5. Owner merges (load-bearing: also requires Chris human review)

Fable and Codex both have useful angles to add — divergence-detection heuristics, the family map (additions / corrections), label conventions, color choices, and the eventual cost-pool extension are all design surfaces where second opinions matter.
