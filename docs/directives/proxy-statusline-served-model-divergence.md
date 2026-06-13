# Directive: statusline served-model divergence indicator

**Issue:** [#223](https://github.com/cnighswonger/claude-code-cache-fix/issues/223)
**Upstream:**
- [anthropics/claude-code#66728](https://github.com/anthropics/claude-code/issues/66728) — *Classifier-driven served-model swap is invisible to operators (six reported occurrences)*

**Priority:** P1
**Branch:** `feature/statusline-served-model-divergence`
**Stage:** directive — round 3 (Codex r1 REQUEST_CHANGES at `b14d90f`; r3 narrows rehydration to guard on `requested_model` equality (closes Codex B1 — restart + `/model` correctness), removes two contradictory user-facing contracts (closes Codex B2 — `[1m]` rendering + sticky-clear path), corrects LRU→TTL terminology, names the concrete statusline test file. Prior: Fable r1 at `9e0d58a` REQUEST_CHANGES; r2 addressed Fable B1/B2/A1/A2 + 6 nits.)
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

- **Size/complexity budget:** ~300–400 LOC total — writer-side detector + module-scope pair-keyed map + rehydration-from-disk + schema additions (~180 LOC in `proxy/extensions/cache-telemetry.mjs`, up from r1's 150 to absorb rehydration + pair-key bookkeeping per Fable r1 B1/B2 fixes), statusline rendering block + label-and-color logic (~50 LOC of bash + embedded Python in `tools/quota-statusline.sh`), plus tests (~170 LOC including the new restart-rehydration and pair-keyed-counter-isolation cases). Reviewers should flag implementations materially larger than ~2× this (closes Fable r1 nit 6).
- **Threat model:** the new persisted fields are short string scalars (model names, ISO timestamps, booleans). No user-provided content goes anywhere new; comparison is local string equality on already-flowing fields. Statusline renders only the model names, which are non-secret. No new external surfaces, no new headers, no new env vars beyond what cache-telemetry already uses.
- **Maintainability constraints:** the divergence detector is a small pure function plus a per-session counter map. No new abstractions; reuses existing `meta` plumbing, `sessionFilename` resolution, and the per-session JSON spread pattern. No CI/config changes. Statusline render-block extends the existing TTL/hit-rate block — no new tool, no new shell file.
- **Performance/reliability:** trivial. Two extra field reads from `ctx.body` / `event.message` per response, one map lookup, one map write. Statusline reader gains four field reads + a conditional render branch. Failure isolation: the detector lives inside cache-telemetry's existing try/catch around the writer (`cache-telemetry.mjs:263-270`), so a malformed value cannot break the pipeline. Statusline already tolerates absent fields (existing `sess.get('cache', {})` precedent) — additive schema reads safely default to None / `[]`.
- **Load-bearing? Yes.** Adds a new persisted contract on the per-session JSON (`requested_model`, `served_model`, `model_divergence_recent`, `model_divergence_sticky`, `model_divergence_first_seen`) and a new statusline rendering contract. By CLAUDE.md's rubric (wire/schema contract + shared abstraction touching the operator observability surface), this qualifies as load-bearing. Per CLAUDE.md, load-bearing changes require Chris human review before merge in addition to Lead + Codex review.

## Functional requirements (carried from #223)

1. **Show only on divergence.** Normal-operation default: no extra field in the statusline. When `requested_model ≠ served_model` on the most recent turn, render a divergence indicator. When neither recent-divergent nor sticky, render nothing.

2. **Sticky state on session-permanent downgrade.** A single divergent turn followed by a return-to-requested could be a transient. A divergence that persists past the sticky threshold (see §Heuristic below) latches sticky for the remainder of the session — the bar keeps warning even if subsequent turns happen to align by coincidence. Sticky state is observable in the session JSON (`model_divergence_sticky: true`) so other consumers can read it without re-deriving from the request stream.

3. **Short labels with [1m] indicator.**
   - Family-derived short labels per the table below.
   - When `[1m]` context is in use, append `[1m]` **to the requested side only** (e.g., `Opus 4.7[1m] → Opus 4.8`). Source: `auto_1m_detected` field already on the per-session JSON via `_auto1mGuard` spread (`cache-telemetry.mjs:255`, set by `auto-1m-guard.mjs:104-108`). The flag reflects the **outbound request** header (`auto-1m-guard.mjs:11-12` — CC strips `[(1|2)m]` from `body.model` before the wire), so it can only assert "1m was requested." The served side's 1m status is unknown to the proxy (the response carries no 1m signal we can use), and cross-family swaps almost certainly drop 1m on the served side — rendering `[1m]` on the served label would assert something we don't know (closes Fable r1 nit 1).
   - Divergence renders as `requested → served`, e.g., `Fable → Opus 4.8`.

4. **Attention-grabbing color.** Recent-divergent renders red (`\033[31m`) matching the existing `TTL:5m` warning at `quota-statusline.sh:192`. Sticky state renders with explicit black-foreground + yellow-background (`\033[30;43m...\033[0m`) — distinct enough to signal "this is now persistent" without conflicting with the red used for transient signals, and the explicit foreground keeps the text legible on light/yellow-ish terminal themes where the default fg might collide with the yellow bg (closes Fable r1 nit 5). Reviewers can propose alternative color choices; the only constraint is that the two states be visually distinct from each other and from the existing red.

5. **Cost-pool axis (deferred to post-2026-06-15).** Once the SDK pool split lands, the bar should also expose which billing pool the recent turn drew from. Out of scope for this directive's initial PR; flagged for follow-up. Field-naming should leave room: a future `cost_pool` field on the per-session JSON is the obvious continuation, but no shape is committed here.

## Sticky-detection heuristic (Step 3 — narrow the issue's open question)

The issue proposes "3 consecutive divergent turns OR a span of ≥5 minutes, whichever lands first" but invites better proposals. The directive recommends a **family-aware split**:

- **Cross-family divergence → immediate sticky** on the first divergent turn. Examples: Fable → Opus, Sonnet → Haiku, Opus → Sonnet. Cross-family swaps are very rarely innocent; they almost always indicate a classifier action worth surfacing immediately. Letting the user wait 3 turns to see this when CC#66728 is the existence proof is the wrong UX trade-off.
- **Same-family divergence → 3-consecutive-turn counter** before latching. Example: Opus 4.7 → Opus 4.8 is far more often a legitimate version routing event (rollout, A/B). Three consecutive turns matched at the same `(requestedModel, servedModel)` pair eliminates transients without an unnecessary stickiness on cross-version routing. **Counter state is keyed by `(sessionFilename, requestedModel)` and stores `servedTarget` so "same target" is explicit and verifiable** (closes Fable r1 B2 — session-only keying was unimplementable for "same target" and would have been reset by interleaved background utility calls).
- **Counter reset semantics** (closes Fable r1 B2):
  - A matched turn at the same `(sessionFilename, requestedModel)` resets the counter for that pair only — other pair entries are untouched. This isolates main-model state from background utility calls (haiku title generation, etc.) that interleave at a different `requestedModel`.
  - A divergence at a different `servedTarget` for the same `(sessionFilename, requestedModel)` resets the counter (or, equivalently, starts a new pair entry under the new target). Cross-target flapping does not accumulate.
  - A `/model` invocation that changes the `requestedModel` for subsequent turns starts a fresh pair entry. **Prior pair entry's state lives only in the in-memory map for the lifetime of the process — it does NOT survive proxy restart.** A return to the original `requestedModel` within the same process resumes from where it left off; a return after restart starts fresh for that pair.
- **Sticky never auto-unlatches within a session — and the map is authoritative across proxy restarts for the currently-active `requestedModel` pair only** (closes Fable r1 B1; closes Codex r1 B1). The per-session JSON is the rehydration source for ONE pair: on map-miss (first turn after proxy restart, fresh process), the writer reads `sessionFilePath(rawSid).json` (precedent: `sessionFilePath` is exported at `cache-telemetry.mjs:55-57` for exactly this read pattern). **Rehydration only seeds a map entry when the persisted `requested_model` field on disk equals the current turn's `ctx.telemetry.requestedModel`** — if they differ (e.g. the session is now on a different `/model` than when sticky last latched), the writer treats it as a fresh entry for the new pair and does NOT inherit the persisted `sticky` / `served_model` / `first_seen` fields. This narrow rehydration contract avoids the cross-pair pollution Codex r1 flagged: persisted state was always single-tuple, so seeding ANY new pair from it would risk inheriting unrelated sticky into the wrong key. Dormant pair counters explicitly do NOT survive restart; that's documented as a known limitation rather than fixed by persisting per-pair state (which would expand the schema for an edge case unlikely to matter in practice — a session that goes `A → /model B → restart → /model A` is rare and the worst case is "sticky restarts at fresh for `A`," not a wrong indicator).
- **Clearing sticky requires a new session** — deleting the per-session JSON file clears it AND restarting the proxy (or waiting for the time-based stale-session sweep to drop the in-memory entry) clears the map; otherwise the map will re-emit sticky on the next turn. The directive states this explicitly so operators don't expect file-deletion alone to work.
- **The 5-minute span suggestion from the issue is dropped.** Turn-count is the only signal that doesn't require persisting timestamps across stream events on the writer side; introducing a wall-clock branch increases complexity without materially better detection.

The family map is hard-coded in `cache-telemetry.mjs` (or a small adjacent helper):

```
fable        → fable
mythos       → mythos
opus-4-7     → opus
opus-4-8     → opus
sonnet-4-6   → sonnet
sonnet-4-7   → sonnet
haiku-4-5    → haiku
```

Note: no `[1m]` suffix variants in the family map. Per `auto-1m-guard.mjs:11-12`, CC strips `[(1|2)m]` from `body.model` before the wire — neither `requestedModel` (request body) nor `event.message.model` (response) ever carries the suffix. The `[1m]` indicator is a render-side suffix driven separately from `auto_1m_detected`.

Unknown model strings fall through to "unknown" family and are treated as same-family for purposes of the counter (conservative — avoids latching sticky on a yet-unseen model). The family map is the only piece of business logic that needs to update when Anthropic ships new models; documented as such in CHANGELOG and in the code site.

**Sessionless / unknown-session bucket** (closes Fable r1 nit 4): per `cache-telemetry.mjs:64-72`, requests missing a session-id header bucket to the literal `"unknown"` sessionFilename and share a single per-session JSON file. Their pair-keyed map entries therefore also share state across genuinely distinct clients in this bucket. This is precedented by the existing `cache` block on the same file and is documented as a known limitation; impl PR call-out in CHANGELOG. Operators relying on the divergence indicator should ensure their CC is sending the session-id header (which 2.1.x does by default).

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

`[1m]` suffix appends to **the requested side only** of the `→` when `auto_1m_detected` is true on the current per-session JSON. See Functional Requirement §3 for rationale.

## Implementation surface (file-anchored)

### Writer side — `proxy/extensions/cache-telemetry.mjs` (no `server.mjs` change)

1. **Request-side source — already exists.** Fable r1 A2: `server.mjs:127` parses `requestedModel`, AND `server.mjs:193` already stashes it as `telemetry.requestedModel`. `cache-telemetry.onStreamEvent` already destructures `telemetry` at `cache-telemetry.mjs:191-192`. `usage-log.mjs:295` is the established precedent reader: `const requestedModel = ctx.telemetry?.requestedModel || undefined;`. The directive reads from this existing channel — no `server.mjs` modification, no new `meta._requestedModel` plumbing. (R1's proposed server change is dropped.)

2. **Response-side capture — `message_start`, outside the usage guard.** Inside the `message_start` handler at `cache-telemetry.mjs:194`, stash `ctx.meta._servedModel = event.message?.model` **before** the `event.message?.usage` guard at the same site — a usage-less `message_start` (cancelled response, edge cases) must not silently skip the served-model capture (closes Fable r1 nit 3). This is a pure assignment; it cannot meaningfully throw.

3. **Detection runs at `message_delta`, inside the existing try/catch.** Move the comparison, family lookup, and map mutation into the `message_delta` branch at `cache-telemetry.mjs:203` — specifically, inside the existing `try {}` block at `cache-telemetry.mjs:263-270` so the failure-isolation claim is true as written (closes Fable r1 A1). At that point, `ctx.telemetry.requestedModel` and `ctx.meta._servedModel` are both available; the result object is stashed on `ctx.meta._modelDivergence` for the per-session JSON build at `:225-261` to consume via the spread idiom.

4. **Module-scope state — pair-keyed, rehydrated from disk.** `cache-telemetry.mjs` already holds module-scope state (`legacyCleanupDone`, `lastSweepMs`). Add a `Map<string, { servedTarget, divergentTurnCounter, sticky, firstSeenIso }>` where the map key is the composite `${sessionFilename}|${requestedModel}` (closes Fable r1 B2 — the previous session-only keying was unimplementable for "same target" and would have been polluted by interleaved background utility calls).

   **Rehydration on map-miss** (closes Fable r1 B1; closes Codex r1 B1): when the writer encounters a `(sessionFilename, requestedModel)` pair with no map entry, it reads `sessionFilePath(rawSid).json` (precedent: `sessionFilePath` is exported at `cache-telemetry.mjs:55-57` precisely for sibling-reader access). **Rehydration is guarded on `requested_model` equality**: the persisted `requested_model` field MUST equal the current turn's `ctx.telemetry.requestedModel` for seeding to occur. If they match, the entry is seeded from persisted `model_divergence_sticky` + `model_divergence_first_seen` + `served_model` fields (`sticky: true` rehydrates immediately so the next emit carries the sticky spread — indicator survives proxy restart for the active pair). If they don't match, OR if the file is missing, OR if the disk read throws, the writer treats it as a fresh entry for this pair — no inherited sticky, no cross-pair pollution. Rehydration is best-effort and never throws into the pipeline.

   Time-based eviction (closes Codex r1 attention): the existing `sweepStaleSessions` at `cache-telemetry.mjs:132-156` is a TTL-based stale-session sweep, not access-order LRU. The directive extends it (or adds a sibling map-sweep at the same throttled cadence) to drop map entries whose `sessionFilename` matches an evicted-from-disk session (i.e. the file got swept). `__resetForTests` (`cache-telemetry.mjs:275`) clears the map for unit tests.

5. **Schema additions in the per-session JSON object** built at `cache-telemetry.mjs:225-261`. The new fields piggyback on the same spread idiom used by `_thinkingSanitize`, `_thinkingSanitizeV2`, `_auto1mGuard`, `_sessionHealth`:

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

When `requested_model === served_model` AND no prior sticky state for the active `(sessionFilename, requestedModel)` pair, `_modelDivergence` is left undefined and the spread is a no-op. When a matched turn occurs but sticky was previously latched for that pair, `_modelDivergence` carries the sticky flag + first-seen + matched (`recent: false, sticky: true`) so the statusline keeps warning. The two booleans are the load-bearing signal; the timestamps and strings are display payload.

6. **Failure isolation — actually true as written now.** All detection logic at `message_delta` runs inside the existing `try {}` block at `cache-telemetry.mjs:263-270`. The `message_start` `_servedModel` stash is a pure assignment outside any try/catch but cannot throw. A bad model string, a missing field, a map exception, or a rehydration disk-read failure all drop the divergence record on the floor; the pipeline continues. The pipeline's per-hook catch at `pipeline.mjs:115-127` is the secondary backstop, not the primary. No `unhandledRejection`. No client-visible behavior change.

### Reader side — `tools/quota-statusline.sh`

After the existing TTL/hit-rate render at `quota-statusline.sh:188-196`, add a conditional render block. The script's structure is bash + heredoc'd Python (`<<'PYEOF'` to disable bash interpolation per the v3.5.2 security note at `quota-statusline.sh:12-22`). New code lives in the heredoc, NOT in bash — the security boundary stays intact.

Render rules:

- `recent = sess.get('model_divergence_recent', False)`
- `sticky = sess.get('model_divergence_sticky', False)`
- If neither, render nothing.
- If `recent` and not `sticky`: render `' | ' + red(short(requested) + ' → ' + short(served))`.
- If `sticky` (regardless of `recent`): render `' | ' + yellow_bg(short(requested) + ' → ' + short(served))`.
- `[1m]` suffix from `auto_1m_detected` on the **requested side only** (per Functional Requirement §3, the table, and the reviewer checklist — the proxy has no signal for served-side 1m, and cross-family swaps almost certainly drop 1m on the served side).

Short-label function follows the table above. Unknown models pass through verbatim — the operator still gets information.

### What does NOT change

- `proxy/server.mjs` — **no change.** R1 proposed a one-line stash; r2 confirms `telemetry.requestedModel` already flows via the established `usage-log.mjs:295` precedent. No new plumbing.
- `proxy/pipeline.mjs` — no change.
- `proxy/extensions.json` — no new extension (this is a feature inside cache-telemetry).
- `proxy/extensions/usage-log.mjs` — no change. The `extractMessageStartFields` helper already exposes `model` for any later consumer.
- `proxy/extensions/auto-1m-guard.mjs` — no change. The `auto_1m_detected` field already flows correctly.
- Pre-existing `cache` block schema (`ttl_tier`, `hit_rate`, etc.) — unchanged.

## Test plan

- **Detector unit tests** (`test/proxy-cache-telemetry-model-divergence.test.mjs`, new file):
  - Matched turn (no divergence) — no `_modelDivergence` field; pair-keyed map unchanged.
  - Cross-family swap (Fable → Opus 4.8) — immediate sticky; `recent: true, sticky: true, first_seen: <iso>`; map entry under `(session, "fable...")` with `servedTarget: "claude-opus-4-8"`.
  - Same-family swap × 1 (Opus 4.7 → Opus 4.8) — `recent: true, sticky: false`; counter = 1; `servedTarget: "claude-opus-4-8"`.
  - Same-family swap × 2 — `recent: true, sticky: false`; counter = 2.
  - Same-family swap × 3 (at the same `servedTarget`) — `recent: true, sticky: true, first_seen: <iso>`.
  - Same-family swap × 2 at one target then × 1 at a different target — counter resets / new pair entry; no sticky (cross-target flapping does not accumulate, per the heuristic's reset semantics).
  - Sticky persists across subsequent matched turn — `recent: false, sticky: true, first_seen` unchanged.
  - Same-family swap × 2 then matched turn at the **same** `requestedModel` — counter resets to 0, no sticky.
  - **Pair isolation (Fable r1 B2):** divergent turn at `requestedModel = "claude-opus-4-7"` → matched turn at `requestedModel = "claude-haiku-4-5"` (simulates interleaved background utility call) → divergent turn at `claude-opus-4-7` again. Opus pair counter advances 1 → 1 → 2 (the haiku matched-turn does NOT reset the opus counter; pair isolation verified).
  - **Restart rehydration (Fable r1 B1):** persist a per-session JSON with `model_divergence_sticky: true` and `requested_model: "claude-opus-4-7"`; reset the module-scope map (`__resetForTests`); next turn at the same `requestedModel = "claude-opus-4-7"` produces a map-miss, the writer rehydrates from disk, and the next emit carries `sticky: true` even though no new divergence happened. Sticky survives restart for the active pair.
  - **Restart + `/model` change rehydration guard (Codex r1 B1):** persist a per-session JSON with `model_divergence_sticky: true` and `requested_model: "claude-opus-4-7"`; reset the module-scope map; next turn arrives at `requestedModel = "claude-sonnet-4-6"` (operator did `/model` post-persist, pre-restart). Writer reads the file, sees the `requested_model` mismatch, treats this as a fresh pair entry — NO sticky inherited into the sonnet pair. The persisted opus state is left on disk but does NOT contaminate the new pair. Documents that dormant pair counters do not survive restart.
  - **Rehydration disk-read failure is non-fatal:** ENOENT on the per-session JSON during rehydration → fresh entry, no exception, pipeline continues.
  - Unknown-family model — treated as same-family (counter-based latching); no immediate sticky.
  - `/model` mid-session (different `requestedModel` for subsequent turns) — fresh pair entry under the new requested model; prior pair entry retained but inactive; return to original `requestedModel` resumes from prior state.
- **Integration** (extend `test/proxy-cache-telemetry.test.mjs`): synthesize a request with body `model: "claude-opus-4-7"` (which `server.mjs:127`/`:193` puts on `telemetry.requestedModel`) and a `message_start` with `event.message.model: "claude-opus-4-8"`; assert the spread fields appear on the written per-session JSON.
- **Statusline rendering** (extend `test/quota-statusline-smoke.test.mjs` — the existing harness on `origin/main`): no divergence → no extra field; recent divergence → red `requested → served`; sticky → black-on-yellow-background treatment; `[1m]` suffix appears on the requested side only when `auto_1m_detected: true`; served-side `[1m]` is never rendered. Tests invoke the script with synthetic per-session JSON files and assert on the rendered string.
- **Failure-isolation**: feed a malformed `event.message` (missing `.model`, non-string `.model`) — assert no exception escapes the `message_delta` try/catch, no `_modelDivergence` field written, per-session JSON write succeeds for the other fields. Also: `message_start` with no `.usage` (cancelled response) still stashes `_servedModel` correctly (nit 3 regression test).

## Verification

- `node --test test/proxy-cache-telemetry-model-divergence.test.mjs` — all green.
- `node --test test/proxy-cache-telemetry.test.mjs` — still green; no regression.
- Statusline test green on both default-rendering case (no divergence) and the new cases.
- Manual smoke: with the proxy running on a dev host (see internal deployment notes), drive a session through `/model fable` then watch for the safety-classifier swap event. The statusline should show the divergence within one turn. Cross-family swap should immediately render the sticky treatment.
- `gh pr view <impl-pr>` shows `needs-sim-validation` capture if any envelope-shape parity is in scope (no new envelope here; sim is unlikely required, but reviewers can call it).

## Files modified / created (impl PR — out of scope for the directive PR)

Created:
- `test/proxy-cache-telemetry-model-divergence.test.mjs` — new unit tests for the detector.
- Render tests added by extending `test/quota-statusline-smoke.test.mjs`.

Modified:
- `proxy/extensions/cache-telemetry.mjs` — divergence detector (at `message_delta` inside try/catch) + pair-keyed module-scope state map + rehydration-from-disk + schema spread + `_servedModel` stash at `message_start` (outside usage guard).
- `tools/quota-statusline.sh` — render block after the existing TTL/hit-rate section; reads new fields, renders red recent / black-on-yellow sticky, `[1m]` suffix on requested side only.
- `test/proxy-cache-telemetry.test.mjs` — new integration test covering the spread.
- `CHANGELOG.md` — v4.3.0 entry citing CC#66728 + #223; calls out the family-map maintenance burden.
- `README.md` — statusline feature callout listing the divergence indicator (one-line addition).
- `docs/quota-statusline.md` (if present) — render-rule table.

Out of scope (no changes):
- `proxy/pipeline.mjs`, `proxy/stream.mjs` — no pipeline hook changes.
- Cost-pool field — deferred to post-2026-06-15.
- Preload-mode shim — preload writes the flat `quota-status.json`, not the split layout. The preload parity update would need a parallel change once the proxy-mode version lands; tracked as a follow-up.

## Reviewer checklist (cache-fix side)

- [ ] `requestedModel` is read from `ctx.telemetry?.requestedModel` at the `message_delta` site — no `server.mjs` modification, no new `meta._requestedModel` plumbing. (Fable r1 A2.)
- [ ] `_servedModel` stash at `message_start` is **outside** the `event.message?.usage` guard so cancelled / usage-less responses still capture the served model. (Fable r1 nit 3.)
- [ ] Detection (comparison + family lookup + map mutation) runs at `message_delta` **inside** the existing try/catch at `cache-telemetry.mjs:263-270`, so the failure-isolation claim is true as written. (Fable r1 A1.)
- [ ] Family map is one named constant, updated only when Anthropic ships a new family. No `opus-4-7[1m]` row (CC strips `[(1|2)m]` from `body.model` before the wire per `auto-1m-guard.mjs:11-12`). (Fable r1 nit 2.)
- [ ] Cross-family swap latches sticky on turn 1; same-family swap requires 3 consecutive divergent turns **at the same `(requestedModel, servedTarget)` pair**. (Fable r1 B2.)
- [ ] Counter state map keyed by `(sessionFilename, requestedModel)` and stores `servedTarget`; matched-turn reset applies to that pair only; cross-target flapping does not accumulate. (Fable r1 B2.)
- [ ] **Map authoritative + rehydrates from on-disk JSON on map-miss, guarded on `requested_model` equality.** Persisted `model_divergence_sticky` survives proxy restart for the active pair only. If persisted `requested_model` ≠ current `ctx.telemetry.requestedModel`, the writer treats it as a fresh entry — no cross-pair pollution. Rehydration disk-read failure is non-fatal (best-effort). Dormant pair counters do NOT survive restart (documented as a known limitation). (Fable r1 B1, Codex r1 B1.)
- [ ] Per-session state map bounded by the existing TTL-based `sweepStaleSessions` cadence (or a sibling map-sweep at the same cadence) — NOT access-order LRU; `__resetForTests` clears it.
- [ ] Schema spread idiom matches `_thinkingSanitize`, `_auto1mGuard`, `_sessionHealth` — additive, optional, no breaking field deletions.
- [ ] When `requested_model === served_model` and no prior sticky for this `(session, requestedModel)` pair, `_modelDivergence` is undefined; spread is a no-op.
- [ ] Statusline render only fires on `recent` or `sticky`; default render path unchanged.
- [ ] Statusline reads the new fields from per-session JSON only; no new account.json fields.
- [ ] Bash heredoc `<<'PYEOF'` boundary preserved per `quota-statusline.sh:37-41` security note.
- [ ] `[1m]` suffix consumes `auto_1m_detected` from the per-session JSON and renders **on requested side only**. (Fable r1 nit 1.)
- [ ] Sticky color escape is `\033[30;43m...\033[0m` (explicit black foreground + yellow background + full reset) for light-theme legibility. (Fable r1 nit 5.)
- [ ] Short-label table matches the directive's table; unknown models pass through verbatim.
- [ ] CHANGELOG entry cites CC#66728 + #223 and calls out the family-map maintenance burden.
- [ ] Failure isolation: writer-side detector at `message_delta` cannot throw out of cache-telemetry's existing try/catch; `message_start` `_servedModel` stash is a pure assignment that cannot throw.
- [ ] Restart-rehydration unit test and pair-isolation unit test both present and green.
- [ ] Documents that clearing sticky requires a new session — file deletion alone does not work because the map will re-emit on the next turn. (Fable r1 B1 follow-through.)

## Out of scope (explicit)

- **Cost-pool indicator.** Deferred to post-2026-06-15 SDK pool split.
- **Notification path** (PushNotification or equivalent) when sticky first latches — visible-color indicator is sufficient for v1; notification is a possible v2 once we have real-world data on how often it would fire.
- **Auto-restore** — issuing `/model` to recover from a sticky downgrade is observability, not remediation. Out of scope.
- **Anything specific to CC#66728's classifier internals.** We observe the divergence as a black-box pattern; we do not try to predict it.
- **Preload-mode parity** for the indicator. The preload writes the flat `quota-status.json`, not the split layout (filed as cache-fix #219). Preload parity is a separate change that can land once the proxy version is validated; tracking as follow-up.
- **Sticky-clear UI.** No clear-sticky mechanism inside the statusline. Clearing requires a new session — see §Heuristic for the authoritative recovery contract; file deletion alone does NOT clear sticky because the in-memory map will re-emit on the next turn for that session.

## Review chain

Per project workflow:
1. Qwen first-pass scan
2. Fable primary review (design-judgment-heavy — heuristic choice, label conventions, color, sticky-state rules all need a second opinion)
3. Codex cross-LLM verification
4. AITL plan-approval
5. Owner merges (load-bearing: also requires Chris human review)

Fable and Codex both have useful angles to add — divergence-detection heuristics, the family map (additions / corrections), label conventions, color choices, and the eventual cost-pool extension are all design surfaces where second opinions matter.
