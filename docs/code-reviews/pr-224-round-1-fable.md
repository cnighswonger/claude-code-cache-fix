# PR #224 — Fable review, round 1

**Directive:** `proxy-statusline-served-model-divergence.md` (statusline served-model divergence indicator)
**Branch:** `feature/directive-statusline-served-model-divergence`
**Reviewer:** Fable 5 Review Agent
**Date:** 2026-06-13

Verdict: REQUEST_CHANGES

All file:line citations were verified against `origin/main` HEAD. The overall design — proxy-side comparison, additive per-session JSON spread, heredoc-confined statusline render — is sound and matches the established `_thinkingSanitize` / `_auto1mGuard` / `_sessionHealth` pattern. Two findings go to the core sticky-detection contract and need directive text changes before the impl PR; the rest are attention items and nits.

---

## Blockers

### B1 — Sticky-state authority is contradictory: the stated recovery path doesn't work, and the stated invariant doesn't hold

The directive defines sticky state in two places — the module-scope `Map<sessionFilename, {…}>` and the persisted per-session JSON — without saying which is authoritative. The writer rebuilds the entire per-session JSON from scratch and atomically replaces the file on every `message_delta` (`cache-telemetry.mjs:226-268`). Two stated claims break against that mechanic:

1. **"Operator can manually delete the per-session JSON if they need to clear it" (§Heuristic) is false.** The map is the real source: on the next turn, the writer regenerates the file with `model_divergence_sticky: true` from the map. Deleting the file clears nothing for an active session — and an inactive session's statusline reads nothing anyway.
2. **"Sticky never auto-unlatches within a session" is violated by a proxy restart.** Restart empties the map; the on-disk JSON still says sticky, so the statusline warns — until the next matched turn, when the writer (map-miss, no divergence) rebuilds the file without the divergence fields and the spread is a no-op. The sticky warning silently vanishes mid-session, which is exactly the failure mode CC#66728 describes (downgrade invisible to the operator).

**Fix suggestion:** declare the map authoritative and **rehydrate on map-miss from the on-disk JSON** before evaluating the heuristic. The read precedent already exists — `sessionFilePath` is exported specifically so siblings "can READ the prior state this writer wrote" (`cache-telemetry.mjs:52-57`). That makes the invariant hold across restarts. Then correct the recovery-path text: clearing sticky requires a new session (or delete-file *plus* proxy restart); say so explicitly. Add a restart/rehydration case to the test plan.

### B2 — Same-family counter is keyed by session only; interleaved different-model traffic resets or pollutes it, and the state shape can't express the heuristic's own "same target" rule

Two related problems in §Heuristic:

1. The text requires "three consecutive turns matched **at the same target**", but the proposed state shape `{ divergentTurnCounter, sticky, firstSeenIso }` doesn't store the target (or the requested model). As specified, `opus-4-8 → opus-4-8-preview → opus-4-8` consecutive divergences are indistinguishable from three at the same target. The rule is unimplementable from the proposed state.
2. The counter is per-session, but a CC session is not single-model: background utility calls (title generation etc.) and other interleaved requests can carry a different requested model under the same `x-claude-code-session-id`. A matched haiku utility call between two divergent main-model turns resets the counter — in a session with regular background calls, the same-family counter may **never reach 3** despite a persistent main-model divergence. The inverse pollution is also possible. `/model` mid-session changes the requested model and should reset the pair, which session-only keying also doesn't express.

**Fix suggestion:** key the counter state by `(sessionFilename, requestedModel)` — or store `{ requestedModel, servedTarget }` in the entry — and define reset semantics explicitly: a matched turn resets the counter **only for the same requestedModel**; a requested-model change starts fresh state. Add two unit tests: (a) divergent → matched-on-different-requested-model → divergent does NOT reset the counter; (b) same-family divergence at alternating targets does not latch (or define that it does — but pick one and encode it).

---

## Attention

### A1 — Failure-isolation claim is miscited: the detector as designed runs *outside* the `cache-telemetry.mjs:263-270` try/catch

The directive states (§Implementation 5, NFRs, reviewer checklist) that "all new logic runs inside the existing try {} block at `cache-telemetry.mjs:263-270`". That try block lives in the **`message_delta`** branch and wraps only the filesystem writes. The directive places detection — `event.message?.model` read, family lookup, map mutation — in the **`message_start`** handler (`:194`), which that try cannot cover. The per-session payload build (`:226-261`) is also outside it. The actual backstop is the pipeline's per-hook catch (`pipeline.mjs:115-127`), which prevents a crash but logs a `[pipeline] cache-telemetry.onStreamEvent error` line and is not what the directive claims.

**Fix suggestion:** at `message_start`, only stash the served model (`ctx.meta._servedModel = event.message?.model` — cannot meaningfully throw); run the comparison, family heuristic, and map update at `message_delta` time inside the existing try. This makes the failure-isolation claim true as written, co-locates the heuristic with the writer, and the malformed-input test in the plan then actually exercises the claimed isolation boundary. Update checklist item 14 accordingly.

### A2 — The `server.mjs:127` change is unnecessary: `requestedModel` already reaches `onStreamEvent` via `ctx.telemetry`

The directive claims server.mjs "only retains it as a local". Not so: `server.mjs:193` stashes it — `telemetry.requestedModel = requestedModel` — and the telemetry record is passed into the stream-event context. `cache-telemetry.onStreamEvent` already destructures and requires `telemetry` (`cache-telemetry.mjs:191-192`), and `usage-log.mjs:295` reads `ctx.telemetry?.requestedModel` from exactly this path today. The proposed `meta._requestedModel` plumbing duplicates an existing channel.

**Fix suggestion:** read `ctx.telemetry?.requestedModel`, drop the `server.mjs` modification entirely, and remove `proxy/server.mjs` from the files-modified list and checklist item 1. Smaller change surface, zero new plumbing, established precedent.

---

## Nits

1. **`[1m]` suffix on both sides of the `→` is misleading.** `auto_1m_detected` reflects the *outbound request* header; the directive itself concedes the served side "almost certainly drop[s] 1m" on cross-family swaps. Rendering `Fable[1m] → Opus 4.8[1m]` asserts something the proxy doesn't know. Suggest: requested side only.
2. **Dead family-map row.** `opus-4-7[1m] → opus` can never match: per `auto-1m-guard.mjs:9-12`, CC strips `[(1|2)m]` from `body.model` before the wire — neither `requestedModel` (request body) nor `event.message.model` (response) ever carries the suffix. Remove the row (or keep it with a comment saying it's defensive-only).
3. **`message_start` guard couples divergence to usage presence.** The existing handler gates on `event.message?.usage` (`cache-telemetry.mjs:194`). If served-model capture lands inside that same guard, a usage-less `message_start` silently skips detection. With the A1 restructure, stash `_servedModel` outside the usage guard.
4. **"unknown" session bucket shares one divergence state.** Sessionless requests all key to `unknown` (`sessionFilename`), so their counters/sticky interleave across genuinely distinct clients. Precedented (the cache block already behaves this way) — just document it in the directive.
5. **Yellow-background render needs an explicit reset and ideally an explicit foreground.** `\033[43m` with default fg can be near-illegible on light-yellow-ish themes; `\033[30;43m…\033[0m` is the safe form. The red-vs-yellow-bg split itself is good — clearly distinct from each other and from the existing red `TTL:5m` at `quota-statusline.sh:192`.
6. **Size budget arithmetic:** the components (~150 + ~50 + ~150) sum to the budget's top end exactly; with the B1/B2 fixes (rehydration + pair-keyed state + extra tests) expect to land above 350. Restate as ~300–400 so the "flag at 2×" rule keeps meaning.

---

## Verified claims (no action needed)

- `server.mjs:127` is the `requestedModel` parse site; `meta` stash precedents at `:148/:250/:260` check out (though see A2 — the stash is unnecessary).
- `event.message.model` is the right response-side source; `usage-log.mjs:88` precedent confirmed.
- Per-session JSON build site (`cache-telemetry.mjs:225-261`) and spread idiom confirmed; new field names collide with nothing, and the post-spread `timestamp`/`session_id` keys can't be clobbered.
- `auto_1m_detected` writer confirmed at `auto-1m-guard.mjs:104-108`, spread at `cache-telemetry.mjs:255`.
- Statusline render insertion point (`quota-statusline.sh:188-196`) and the `<<'PYEOF'` security boundary (`:37-41`, v3.5.2/#108) confirmed; new logic confined to the heredoc keeps the boundary intact. Reader's safe-default pattern (`sess.get(..., False)`) matches the existing `sess.get('cache', {})` precedent.
- `sweepStaleSessions` (`:132-156`) and `__resetForTests` (`:274-278`) exist as cited; reusing the sweep cadence for map eviction is reasonable (note the sweep must gain map-eviction logic — it currently only unlinks files).
- Load-bearing classification is correctly applied: new persisted schema fields + new statusline contract → Chris human review required. Matches the `template-proxy-jsonl-session-mirror.md` precedent.
- Threat model holds: short non-secret scalars, local string comparison, no new external surface, no bash-side interpolation.
- Dropping the issue's 5-minute wall-clock branch is the right call — turn-count-only keeps the writer stateless across stream events.
- Out-of-scope list is correctly drawn (cost-pool, notification, auto-restore, preload parity, sticky-clear UI). Nothing that belongs in v1 is being deferred.

## Bottom line

The feature is well-motivated, correctly scoped, and sits on proven plumbing — but the directive's sticky-state story contradicts its own mechanics (B1), and the same-family counter as specified cannot implement its own "same target" rule and is fragile against real CC traffic patterns (B2). Both are directive-text fixes, not design rewrites: declare map authority + rehydrate from disk, and key counter state by requested model. A1/A2 corrections shrink the change surface and make the failure-isolation claim true. With those addressed, round 2 should be a fast APPROVE.

— Fable 5 Review Agent
