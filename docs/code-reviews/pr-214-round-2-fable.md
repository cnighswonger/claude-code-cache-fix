Verdict: REQUEST_CHANGES

# PR #214 round-2 review — `directive/jsonl-session-mirror` (HEAD `268ae6a`)

Round 2 of max 2 (Fable). Focused re-review of the round-2 directive against the round-1 REQUEST_CHANGES (5 blockers + 8 attention items at `5cce318`). All citations re-verified against the unchanged `pipeline.mjs` / `stream.mjs` / `server.mjs` / `cache-telemetry.mjs` / `usage-log.mjs` / `bootstrap-defense.mjs` / `extensions.json`, and the envelope claims re-verified against a real CC transcript (`~/.claude/projects/.../a27d470e….jsonl`, 9,410 user records).

The round-2 rewrite is substantially honest work: 11 of 13 round-1 items are cleanly addressed, the hook surface is now real, the envelope is now CC's actual shape, and the sim-validation gate is a mandatory merge gate. But the new dedup state machine — the section written to close B3 — contains an algorithmic bug that re-introduces the exact O(n²) duplication it claims to close, and it fails the directive's own 3-turn test fixture as specified. One round-trip through the spec with pencil and paper catches it; it must be fixed in the directive because the directive is the spec the implementer will follow.

## Round-1 → round-2 status table

| # | Round-1 finding | Status | Note |
|---|---|---|---|
| B1 | `onResponseEnd` doesn't exist; no end-of-stream hook for SSE | **ADDRESSED** | Stream-event accumulator (`onRequest` → `onStreamEvent` w/ write at `message_stop` → `onResponse` for non-streaming) verified implementable against `pipeline.mjs:85-141`, `stream.mjs:63` ctx shape, and `server.mjs:160-188`; zero pipeline modifications, correctly stated. |
| B2 | Record shape didn't match CC's transcript | **ADDRESSED** | Assistant top-level + nested `message` key sets match my independent real-transcript verification exactly (camelCase ids, `message` nesting, synthetic uuid chain, `source` marker). Residual user-record inaccuracies noted under New Issues #3 — caught by the now-mandatory sim gate, so nit-grade. |
| B3 | O(n²) duplication from mirroring `messages[*]` per request | **PARTIALLY ADDRESSED** | Dedup section exists with the right intent and the right test fixture — but the specified algorithm is broken and still produces O(n²) (New Issue #1, blocker). |
| B4 | Path traversal on header-derived session id | **ADDRESSED** | `sessionFilename(resolveSessionId(ctx.headers))` reuse mandated (both verified exported from `cache-telemetry.mjs:44-72`), `unknown` bucket for sessionless, path-traversal test in plan, storage root moved under `~/.claude/`. |
| B5 | Unbounded disk growth | **ADDRESSED** | `RETENTION_DAYS` (default 30) + 60s-throttled sweep modeled on `sweepStaleSessions` (citation `cache-telemetry.mjs:132-156` verified exact), empty-dir pruning, events-log 5 MB rotation, worst-case formula documented (32 × 100 MB × 3 = 9.6 GB — arithmetic checks). |
| A1 | Session id unreachable from response-side ctx | **ADDRESSED** | `onRequest` capture → `ctx.meta._mirrorSessionId` stash; matches the documented house pattern (`cache-telemetry.mjs:170-179`). |
| A2 | Per-boot proxy-sid fallback mixes sessions | **ADDRESSED** | Fallback gone; sessionless requests bucket to `"unknown"` and are documented best-effort. |
| A3 | LRU 32-handle cache is bloat | **ADDRESSED** | Explicitly deferred out of scope with the correct rationale (plain `appendFile` adequate at chosen cadence). |
| A4 | LOC budget 200–300 not credible | **ADDRESSED** | Restated 450–550 including accumulator + envelope + dedup + sweep; my component-level estimate lands ~490, so this is honest. |
| A5 | Missing failure-isolation test | **ADDRESSED** | Sync-throw AND async-reject tests in plan; NFR mandates internal `.catch()` so rejections can't escape to `unhandledRejection`. Both halves of the round-1 trap covered. |
| A6 | Missing format round-trip test | **ADDRESSED** | `restore-claude-history-linux` round-trip test in plan and reviewer checklist; CC-transcript snapshot fixture listed in created files. |
| A7 | Thinking default-include implicit / mis-sectioned | **ADDRESSED** | Moved into Scope with the fidelity-parity argument stated; explicit `INCLUDE_THINKING` opt-out (default `true`). |
| A8 | Tool-result + multi-turn completeness | **PARTIALLY ADDRESSED** | Dedup tracks `tool_use_id`s and the multi-turn replay fixture covers interleaving — but the tool-result user-record envelope is unspecified (New Issue #3). |

Also fixed from round 1 without being asked twice: usage-log/request-log order citation (650/700 — verified against `extensions.json`), image-reference shape now defined, `session-mirror-events.jsonl` rotation added, default-on flip split into a future directive, sim-validation promoted to mandatory merge gate, flat `proxy/` placement (no `proxy/lib/`).

## New issues

### NB1 (blocker). The dedup algorithm as specified still produces O(n²) — and fails the directive's own test fixture

The spec stores a **single** `lastMirroredUserMessageHash` per session, then iterates **every** user-role message in `ctx.body.messages`, comparing each to that one stored hash and updating it on every stage. Trace it:

- Request 1, messages `[u1]`: h(u1) ≠ null → stage u1, last = h(u1). ✓
- Request 2, `[u1, a1, u2]`: h(u1) = last → skip ✓; h(u2) ≠ h(u1) → stage u2, last = h(u2). ✓
- Request 3, `[u1, a1, u2, a2, u3]`: h(u1) ≠ h(u2) → **stage u1 again**, last = h(u1); h(u2) ≠ h(u1) → **stage u2 again**, last = h(u2); stage u3.

It works for exactly two turns, then re-mirrors the entire history every turn — O(n²), the precise failure mode B3 named. The directive's own 3-turn fixture ("exactly 3 user records") yields **5** under this algorithm; the 200-turn fixture yields ~20,000 user records, not 200. The spec contradicts its own acceptance test.

The fix is small but must be in the directive, because this section *is* the B3 fix: either (a) keep a **`Set` of mirrored user-message hashes** per session (the spec already does exactly this for tool-result ids — `lastMirroredToolResultIds: Set<string>` — so the asymmetry is one word away from correct), or (b) track the index/count of already-mirrored messages and only consider messages past it (cheapest and also dedups identical user texts sent twice legitimately, which the hash-set approach would wrongly collapse — note `"yes"` sent at turn 2 and turn 9 are distinct records in CC's transcript; option (b) is therefore the more correct of the two).

### NB2 (blocker). Dedup state is committed at stage time, not write time — failed requests permanently lose user records

`onRequest` stages pending records **and updates the dedup state** in the same step; the actual write happens later, at `message_stop`. If the request never reaches `message_stop` — upstream 529, mid-stream abort (`server.mjs:113-115` aborts on client close), 4xx — the staged records on `ctx.meta._mirrorPendingUserRecords` are dropped with the request, but the dedup map already says "mirrored." When CC retries (resending the same history), the lost messages are skipped forever. For an extension whose entire reason to exist is data-loss defense, the spec's own bookkeeping creates a silent data-loss path on every failed request.

Fix in the dedup section: commit hashes/ids to the session's dedup state **only when the records are actually written** (at `message_stop` flush, alongside the assistant record), or re-stage on flush failure. Add a test: request fails before `message_stop` → next request's identical history re-stages and the records appear exactly once.

### Remaining items are nits

3. **User-record envelope claims don't fully match a real transcript.** Verified against 9,410 real user records: they carry `permissionMode` and `slug` (the directive omits both), they do **not** carry `requestId` (the directive's "as assistant, plus…" implies they do), `isMeta` appears only on ~13% of user records (meta records), and tool-result user records carry top-level `toolUseResult` + `sourceToolAssistantUUID`, which the proxy cannot reconstruct (CC-internal enriched result object). None of this breaks `record.message.content` readers, and the snapshot fixture + sim gate will surface it mechanically — but the directive should (a) correct the user-record key list, and (b) add `toolUseResult` omission to the CHANGELOG caveats next to null-`cwd` and synthetic-uuid.
4. **Synthetic uuid isn't UUID-formatted.** CC's real `uuid`/`parentUuid` are dash-formatted UUIDs (`8-4-4-4-12`); `sha256(…).slice(0,32)` is a bare 32-hex string. Any reader that validates UUID shape (common in recovery tooling) rejects every mirror record. One-line fix: format the same 32 hex chars with dashes (version/variant bits won't be RFC-valid, but shape-validating parsers pass).
5. **Accumulator residence and abort behavior are unspecified.** If the per-message accumulator lives on `ctx.meta` (request-scoped), aborted streams clean up for free and there's no cross-request leak — say so. If module-scope keyed by session, the spec needs an eviction story for interrupted streams. While specifying it, the round-1 bonus is nearly free: flush a partial record with `stop_reason: "interrupted"` on abort, which is itself a recovery win for the CC#66734 scenario.

## Net-new sweep (per the round-2 charter)

- **Stream-event accumulator surface:** the design is sound against the real ctx shapes (`{event, meta, telemetry, responseHeaders, drop}` at `stream.mjs:63`; `request-id` reachable via `responseHeaders` exactly as `usage-log.mjs:296` does). The state-machine risk concentrates in `input_json_delta` reassembly and abort cleanup — covered by nit #5 and the existing test plan.
- **Internal contradictions:** besides NB1-vs-its-own-fixture, none found; the round-2 rewrite is coherent (route scoping defaults to messages-only via `appliesToRoute`, so bootstrap traffic is correctly excluded without any directive text needed).
- **LOC budget:** 450–550 is credible for the stated surface; NB1/NB2 fixes don't move it.
- **Sim-validation gate:** the directive already declares `needs-sim-validation` as a mandatory merge gate with envelope-parity assertions — exactly what round 1 asked for. Keep it; it is the only honest check on format compatibility, and it would also catch nit #3 mechanically.

## Recommendations

1. **Rewrite the dedup state machine (closes NB1 + NB2 together):** track per-session `mirroredMessageCount` (index past last-mirrored message) instead of a single hash; stage only messages past it in `onRequest`; advance the counter and commit tool-result ids **at `message_stop` write time**, not stage time. Add the failed-request re-stage test. This is a one-section rewrite, ~15 lines of directive text.
2. Correct the user-record key list against a real transcript, document the `toolUseResult` omission in the CHANGELOG caveats, and regenerate `cc-transcript-shape-snapshot.json` from a transcript that includes tool-result and meta user records (not just plain prompts).
3. Dash-format the synthetic uuid; specify the accumulator as `ctx.meta`-scoped with optional `stop_reason: "interrupted"` partial flush on abort.

## Bottom Line

Round 2 did real work: the hook surface is now the actual pipeline, the envelope is now CC's verified shape, retention/sanitization/failure-isolation/test gaps are all closed, and the budget and scope statements are honest. Eleven of thirteen round-1 items are cleanly addressed. But the dedup section — the load-bearing fix for round-1's B3 — specifies an algorithm that re-creates the O(n²) duplication bug and fails the directive's own 3-turn acceptance fixture, and its stage-time state commit silently drops user records on any failed request, which is a data-loss path inside a data-loss-defense feature. Both have small, precisely-named fixes (one section rewrite). Per the round-cap protocol this routes onward regardless; the directive is not fundamentally wrong — it is one section away from approvable. REQUEST_CHANGES.

— Fable 5 Review Agent
