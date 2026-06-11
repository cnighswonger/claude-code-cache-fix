# Directive: JSONL session-content mirror

**Issue:** TBD (will be filed alongside this directive, referencing CC#66734 and CC#66486)
**Upstream:**
- [anthropics/claude-code#66734](https://github.com/anthropics/claude-code/issues/66734) — *Session JSONL rewritten in-place to metadata-only stub — user/assistant records lost (2.1.168–2.1.170, since native installer migration)*
- [anthropics/claude-code#66486](https://github.com/anthropics/claude-code/issues/66486) — *2.1.169: interactive sessions write no JSONL transcript (only ai-title stub)*
**Priority:** P1
**Branch:** `feature/jsonl-session-mirror`
**Stage:** directive — round 4 / `approved-by-codex-agent` (Codex round-2 APPROVE at `8dc14b0` cleared the round-1 blockers; this commit also fixes the non-blocking metadata nit Codex flagged. Prior rounds addressed Fable round-1, Fable round-2, then Codex round-1 REQUEST_CHANGES.)
**Labels:** `directive-stage`, `schema-change` (mirror file is a new contract for CC-transcript-reader interoperability), `needs-sim-validation` (mandatory merge gate on envelope-shape parity)
**Milestone:** v4.2.0

## Goal

The proxy mirrors every assistant message and the tool results / user inputs it observes into a per-session JSONL file under user control — independent of CC's own transcript-write path. If CC's in-place stub-rewrite (CC#66734) destroys the canonical transcript, or the transcript-write path is silently disabled (CC#66486), the user retains a complete content record from the proxy side. The mirror is read-only with respect to upstream traffic; no requests or responses are modified.

This is a **belt-and-suspenders backup**, not a transcript replacement. CC's own JSONL remains canonical when it survives.

## Why

CC#66734 documents data-loss across 12 occurrences in two projects since the 2026-06-06 native installer migration; multiple CC versions affected. CC#66486 documents transcript-stub regressions in 2.1.169 specifically. Both are tagged `data-loss` by Anthropic. Users on affected versions have no recourse once the stub-rewrite fires.

The proxy is downstream of CC's transcript writer. It sees every assistant message and tool result in the response stream as the bytes flow through. If we tee that stream to a side-write JSONL keyed by session, the user retains a complete content record regardless of what happens to CC's canonical file. The mirror is not affected by CC's stub-rewrite because it is a separate file under proxy-controlled storage.

We do not claim the mirror solves CC's bug; CC's bug is upstream and Anthropic's to fix. We claim the mirror reduces the cost of CC's bug from "conversation gone" to "conversation recoverable from mirror" while CC's fix is in flight.

## Non-Functional Requirements

- **Size/complexity budget:** ~450–550 LOC including stream-event accumulator + envelope shaping + dedup state + retention sweep. Per Fable round 1, the round-1 budget of 200–300 LOC was not credible. Restated honestly.
- **Threat model:** the mirror writes plaintext conversation content to disk under user-controlled paths. This is the same threat surface as CC's own transcript; no incremental risk. Mirror files inherit the user's umask.
- **Activation model:** `enabled: true` in `extensions.json` (always loaded) with internal env-var gate `CACHE_FIX_SESSION_MIRROR` (`on` / `off`). **Default-off in v4.2.0 and v4.3.0.** Per Fable round 1, flipping plaintext-conversation-persistence to on-by-default is a privacy-posture change that belongs to its own future directive after a real validation cycle, not as a "matured-out" milestone here.
- **Disk-cost discipline:** per-session active-file rotation at `CACHE_FIX_SESSION_MIRROR_MAX_BYTES` (default 100 MB) AND a retention sweep at `CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS` (default 30) — rotated files past the retention window are unlinked by a throttled sweep modeled on `cache-telemetry.mjs`'s `sweepStaleSessions`. Worst-case bytes documented as: active sessions × MAX_BYTES × (rotations within retention window).
- **PII discipline:** the `session-mirror-events.jsonl` writer log carries only session id, timestamps, action (open / rotate / sweep / error), rotation count, and byte counts — never image bytes, never prompt content, never auth headers. Rotation at 5 MB single-tier per `bootstrap-defense.rotateIfNeeded` precedent.
- **Failure isolation:** the pipeline try/catches every hook (`pipeline.mjs:91-96` and equivalent), so a thrown mirror writer cannot break the response. The directive states this explicitly and the test plan proves it (B5 follow-through). Async writes inside the writer are `.catch`-handled internally — un-awaited rejected promises must not escape into `unhandledRejection`.
- **Memory tradeoff:** the per-message accumulator on `ctx.meta._mirrorAccumulator` is request-scoped, so memory usage is one full in-flight assistant message buffered per concurrent request. At observed CC concurrency this is acceptable; documented for honest accounting (closes Codex round-1 attention).
- **Load-bearing? Yes.** This directive introduces a new persisted file contract intended for CC-transcript-reader interoperability AND defines new env-var / config surfaces that affect plaintext-on-disk privacy posture. By CLAUDE.md's rubric (shared abstraction + wire/schema contract + security-relevant), this qualifies as load-bearing. Per CLAUDE.md, load-bearing changes require Chris human review before merge in addition to the routine Lead + Codex review path.

## Pipeline-hook surface (closes Fable B1)

The pipeline exposes exactly four hooks: `onRequest`, `onResponseStart`, `onStreamEvent`, `onResponse` (`pipeline.mjs:85-141`). For streaming traffic — essentially all `/v1/messages` traffic — `runOnResponse` does NOT fire (`server.mjs:160-188`); `streamResponse` runs `onStreamEvent` per event and then ends the client response. The previously-named `onResponseEnd` does not exist.

The mirror runs as a **stream-event accumulator** with one buffered file write at `message_stop` — the staged user/tool-result records and the assistant record are concatenated into a single `appendFile` call (NDJSON, one record per line), so a write-time crash either persists all of them or none. This is the batching boundary; "buffered write" and "flush user records first, then the assistant record" refer to the same one file write, not two:

- **`onRequest`** — extracts the resolved session id via `resolveSessionId(ctx.headers)` (`cache-telemetry.mjs:64-72`); stashes it on `ctx.meta._mirrorSessionId`. Examines `ctx.body.messages` for new user/tool-result content not already mirrored for this session (per the dedup state machine; closes B3); stages those as pending records on `ctx.meta._mirrorPendingUserRecords` for emission alongside the response record. The dedup map is module-scope per session.
- **`onStreamEvent`** — accumulates per-message state across `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`. On `message_stop`, builds the complete assistant record in CC's transcript envelope (B2 fix below), writes it + any staged user/tool-result records, and clears the per-message accumulator. The accumulator handles `text_delta`, `input_json_delta` (for `tool_use` blocks), and `thinking_delta` (with optional exclusion per env var).
- **`onResponse`** — fires only on the non-streaming branch (rare for `/v1/messages` but possible for some routes). The same envelope shaper handles the already-complete envelope and writes one record.

No pipeline.mjs / stream.mjs / server.mjs modifications. The accumulator pattern is option-1-mechanics + option-2-cadence per Fable round 1's recommendation. The previously-listed "stream tee that buffers SSE chunks per-message-id" claim in the round-1 Scope section was a different framing for the same accumulator; the round-2 directive collapses them.

## Mirror record envelope (closes Fable B2 — verified against real CC 2.1.148 transcripts)

CC's transcript record shape, verified against `~/.claude/projects/<project>/<session-uuid>.jsonl`:

**Assistant record top-level keys:** `cwd`, `entrypoint`, `gitBranch`, `isSidechain`, `message`, `parentUuid`, `requestId`, `sessionId`, `timestamp`, `type`, `userType`, `uuid`, `version`.

**`message` nested keys:** `content`, `id`, `model`, `role`, `stop_details`, `stop_reason`, `stop_sequence`, `type`, `usage`.

**User record top-level keys** (verified against 9,410 real user records on 2.1.148): same as assistant, plus `isMeta`, `promptId`, `permissionMode`, `slug`. User records do NOT carry `requestId`. `isMeta` appears only on ~13% of records (meta records, e.g. command output); non-meta user records may omit it. **Tool-result user records additionally carry** top-level `toolUseResult` and `sourceToolAssistantUUID` — these are CC-internal enriched-result objects that the proxy cannot reconstruct from request body alone; the mirror omits both and the CHANGELOG must call this out as a known limitation. **`message` nested keys:** `content`, `role`.

The mirror record adopts this envelope with proxy-derived substitutions:

```json
{
  "type": "assistant",
  "uuid": "<sha256(sessionId+timestamp+messageId).slice(0,32) formatted as 8-4-4-4-12 dashed string (e.g. abcd1234-5678-90ab-cdef-1234567890ab) — same 32 hex chars, UUID-shape so shape-validating parsers accept; version/variant bits won't be RFC-valid which is honest about the synthetic origin>",
  "parentUuid": "<previous mirror record uuid in this session, or null for first>",
  "isSidechain": false,
  "sessionId": "<resolved session id>",
  "requestId": "<from response request-id header>",
  "timestamp": "<ISO8601>",
  "cwd": null,
  "version": "<proxy version, e.g. \"cache-fix-proxy/4.2.0\">",
  "userType": "external",
  "entrypoint": "cache-fix-proxy-mirror",
  "message": {
    "type": "message",
    "role": "assistant",
    "id": "<from message_start>",
    "model": "<from message_start>",
    "content": [...],
    "stop_reason": "<from message_delta>",
    "stop_sequence": null,
    "stop_details": "<from message_delta>",
    "usage": "<from message_start + message_delta merge>"
  },
  "source": "cache-fix-proxy-mirror"
}
```

Three load-bearing properties:

1. **Envelope shape matches CC's exactly** — existing transcript readers (including `restore-claude-history-linux`) dereferencing `record.message.content` find the expected content. The round-1 directive's top-level-fields shape would have returned `undefined` on every dereference.
2. **`source: "cache-fix-proxy-mirror"`** is the additive provenance marker — the one field that distinguishes mirror records from canonical CC records.
3. **Synthetic linear `uuid` / `parentUuid` chain** — each mirror record's `uuid` is deterministic from `(sessionId, timestamp, messageId)`; its `parentUuid` is the previous mirror record's `uuid` for the same session. This produces a linear chain reconstructable in file order. CC's true UUID tree is not reconstructible from the proxy view (no parentUuid signal from the stream), so the linear approximation is an honest best-effort.

Image content blocks are mirrored as references (`type: "image"` with `source.type: "base64"` replaced by `source: { type: "reference", sha256: "<64-hex>", media_type: "<from-block>" }`). The byte content itself is not stored.

The CHANGELOG must call out three known limitations: the mirror's `cwd` is `null` (proxy does not know caller cwd), the `uuid` chain is synthetic (dash-formatted but not RFC-valid version/variant bits), and tool-result user records omit `toolUseResult`/`sourceToolAssistantUUID` (CC-internal enriched objects the proxy cannot reconstruct). Consumers depending on those for recovery should verify their behavior against mirror files specifically.

**Per-message accumulator residence** (closes Fable round-2 nit #5): the accumulator state for the in-flight assistant message lives on `ctx.meta._mirrorAccumulator` (request-scoped), NOT in module-scope state. This means an aborted stream cleans up for free when `ctx` is garbage-collected — no cross-request leak, no eviction story needed for interrupted streams. On stream abort (`server.mjs:113-115`, client close), the proxy may optionally flush a partial assistant record with `stop_reason: "interrupted"` and any content blocks accumulated so far, which is itself a recovery win for the CC#66734 scenario (the user gets the assistant content that was streamed before the abort, not nothing). Partial-flush is in scope as an env-var-gated option `CACHE_FIX_SESSION_MIRROR_FLUSH_INTERRUPTED` (default `true`).

## Dedup state (closes Fable B3 round-1 + round-2 NB1 + NB2)

CC re-sends the full conversation history in every request. Without dedup, the mirror would write `O(n²)` records over an `n`-turn session. The fix uses **user-ordinal position tracking** (not content-hash matching), with state advancement deferred until **write time** (not stage time) so failed requests do not silently lose user records.

Module-scope state: `mirrorState.sessions = Map<sessionId, { mirroredUserMessageCount: number, mirroredToolResultIds: Set<string> }>`.

`mirroredUserMessageCount` is the count of user-role messages already written to the mirror file for this session. **This is a count in user-role-message coordinates, not in raw `ctx.body.messages` indices** — the round-2 directive conflated the two coordinate systems, which produced incorrect dedup once assistant turns were interleaved (Codex round-1 blocker on PR #214).

`onRequest` logic (staging only — does NOT advance state):

1. Resolve session id; load (or create) the session entry.
2. **Filter `ctx.body.messages` to user-role entries**, preserving original-array order. Call this filtered list `userMessages` and its length `userMessagesLen`.
3. For each `userMessages[k]` where `k >= mirroredUserMessageCount`, stage it as a pending user record. (The corresponding raw-array index is recorded only for the synthetic `parentUuid` chain — it is NOT used as a dedup key.)
4. For each `tool_result` content block inside those staged user messages, check its `tool_use_id` against `mirroredToolResultIds`. If already present, omit that block from the staged record (the surrounding user message may still stage if it has other un-mirrored blocks). Otherwise add the id to a `pendingToolResultIds` set carried on `ctx.meta`, NOT yet to the session map.
5. Stage everything on `ctx.meta._mirrorPendingUserRecords` (the records) + `ctx.meta._mirrorPendingUserMessageCount` (the value `userMessagesLen` — the new high-water if these records write successfully) + `ctx.meta._mirrorPendingToolResultIds` (the new ids).

`onStreamEvent` (at `message_stop`, after the assistant record is successfully written):

6. Flush the staged user records first, then the assistant record (the linear `parentUuid` chain orders correctly).
7. **Only after all writes have succeeded:** advance `mirroredUserMessageCount` to `_mirrorPendingUserMessageCount` and union `mirroredToolResultIds` with `_mirrorPendingToolResultIds`.

If the request never reaches `message_stop` (upstream 529, mid-stream abort, 4xx, client close) the staged records on `ctx.meta` are discarded with the request and the session-map state is unchanged. CC's natural retry re-sends the same `messages` array; the same un-mirrored user-ordinal positions stage again, and the mirror records appear exactly once when the retry succeeds.

**Walk-through verifying the coordinate fix** (Codex round-1 blocker):

- Request 1 `[u1]` → `userMessages = [u1]`, `userMessagesLen = 1`. `mirroredUserMessageCount` was 0; stages u1 (k=0). On write success: count → 1. ✓
- Request 2 `[u1, a1, u2]` → `userMessages = [u1, u2]`, `userMessagesLen = 2`. count is 1; stages userMessages[1] = u2 only. On write success: count → 2. ✓
- Request 3 `[u1, a1, u2, a2, u3]` → `userMessages = [u1, u2, u3]`, `userMessagesLen = 3`. count is 2; stages userMessages[2] = u3 only. On write success: count → 3. **3 user records after 3 turns, not 4.** ✓

The round-2 algorithm produced 4 records on request 3 (because raw array index 2 is u2 and index 4 is u3, both ≥ a count-of-2). The round-3 fix uses the same coordinate system end-to-end and yields the acceptance number.

The session map is bounded by `CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS` (default 1024) with LRU eviction and a periodic 60s throttled sweep removing entries inactive past the retention window.

**Why position-based, not hash-based** (closes round-2 NB1): a single-value `lastMirroredUserMessageHash` re-iterating each request's full history will re-stage the entire history starting on turn 3 (`u1`'s hash no longer matches the stored `h(u2)`, so `u1` re-stages, then `u2` re-stages, etc.) — exactly the O(n²) failure mode this section exists to close. A Set of hashes would dedup more aggressively but wrongly collapse legitimately-repeated user texts (e.g. the literal `"yes"` sent at turn 2 and again at turn 9 — distinct records in CC's transcripts). Position-based tracking is correct on both axes: distinct positions always mirror, and CC's full-history replay naturally pads the prefix without re-mirroring it.

**Why commit at write time, not stage time** (closes round-2 NB2): committing state in `onRequest` while the actual write happens in `onStreamEvent` creates a silent data-loss path on failed requests — the session-map says "mirrored" while the user record never made it to disk. CC's retry, sending the same history, would then skip the lost message forever. Mirror is a data-loss-defense feature; introducing a data-loss path is incompatible with its mission.

Test fixtures (acceptance):

- **3-turn replay** with single-message-per-turn growth: produces exactly 3 user records + 3 assistant records, no duplicates. (Fails with the round-1 algorithm at 5 user records by turn 3.)
- **200-turn replay**: produces exactly 200 user + 200 assistant records, not ~20,000.
- **Failed-request re-stage**: request 3 reaches stage but the upstream fails before `message_stop` → session-map state unchanged. Request 4 (CC's retry) sends the same history → records stage again and the mirror contains them exactly once. Asserts no record loss AND no duplicates.
- **Legitimately-repeated user text**: `"yes"` at turns 2 and 9 produces two distinct mirror records (position-based dedup preserves them; hash-set dedup would have collapsed them — this fixture verifies the position-based design choice).

## Session id and path sanitization (closes Fable B4)

Session id resolution and filesystem encoding both reuse `cache-telemetry.mjs`:

- Session id resolved at `onRequest` time via `resolveSessionId(ctx.headers)` (checks three session-id header variants).
- Filesystem directory name is `sessionFilename(sessionId)` (safe-charset passthrough, `inv-<sha256[:16]>` otherwise, `unknown` on null). This is the established convention for the same threat surface (path traversal, invalid-filename injection).
- Sessionless requests bucket to `"unknown"` and share a directory; this is best-effort and documented as such.

Mirror storage root: `~/.claude/session-mirrors/` (NOT `~/.cache-fix-proxy/`; per Fable round 1, every proxy artifact lives under `~/.claude/` — established convention). Sub-directory is `sessionFilename(sessionId)`; per-rotation file `<timestamp>.jsonl`.

## Retention sweep (closes Fable B5)

`MAX_BYTES` rotation bounds the active file but accumulated files would grow without bound. The retention sweep closes this:

- `CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS` (default 30) — **any mirror file** (active or rotated) whose mtime is older than the threshold is unlinked. For an inactive session whose active file has not rotated for >`RETENTION_DAYS`, the active file itself is unlinked — sweep is not "rotated-files-only" (closes Codex round-1 attention).
- Sweep runs at a 60s throttled cadence inside the mirror extension's `onResponse`/`onStreamEvent` hooks (lazy, not a separate timer) — modeled on `sweepStaleSessions` in `cache-telemetry.mjs:132-156`.
- Empty directories are pruned after sweep.
- A throttled `sweep` event is logged to `session-mirror-events.jsonl` with the count of files unlinked.

Worst-case disk footprint (documented in `docs/disk-usage.md`):

```
active_sessions × MAX_BYTES × (1 + rotations_within_retention_days)
```

For default config (100 MB cap × 30-day retention × 32 sessions × typical 2 rotations/session/month): ~9.6 GB worst case, more typically <500 MB.

`session-mirror-events.jsonl` itself rotates at 5 MB single-tier per `bootstrap-defense.rotateIfNeeded` precedent — the round-1 directive omitted this and event-log growth was unbounded.

## Thinking content (in scope, with opt-out)

CC's own canonical transcript includes full `thinking` content blocks (verified against 2.1.148 transcripts). Default-include is fidelity-parity with the thing being backed up. This was previously framed in round 1 as "out of scope (deferred)" while describing a shipped default — the round-2 directive moves it into Scope explicitly with the parity argument named.

Opt-out: `CACHE_FIX_SESSION_MIRROR_INCLUDE_THINKING=false` excludes `thinking` content blocks from mirror records.

## Scope (v4.2.0)

In scope:
- New extension `proxy/extensions/jsonl-session-mirror.mjs` at order 720 (after `usage-log` 650 and `request-log` 700; the round-1 directive's order claim was correct but its citation said "after usage-log at 700" — usage-log is 650, request-log is 700).
- Session-mirror writer module flat at `proxy/session-mirror-writer.mjs` (per the flat `proxy/` convention reaffirmed in PR #213 round 2; **NOT** `proxy/lib/`).
- Reusable envelope shaper at `proxy/session-mirror-envelope.mjs` (flat).
- Per-session dedup state with LRU + throttled sweep.
- Per-message accumulator handling text / input_json / thinking deltas.
- Retention sweep with rotation-count discipline.
- Mirror records in CC's verified envelope shape with synthetic uuid chain.
- Env-vars: `CACHE_FIX_SESSION_MIRROR` (on/off), `CACHE_FIX_SESSION_MIRROR_DIR` (override base path), `CACHE_FIX_SESSION_MIRROR_MAX_BYTES` (default 100 MB), `CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS` (default 30), `CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS` (default 1024), `CACHE_FIX_SESSION_MIRROR_INCLUDE_THINKING` (default `true`).
- Failure-isolation test: writer throws (sync and async-rejected) mid-stream; assert client still receives complete SSE response.
- Format-round-trip test: feed a mirror file to `restore-claude-history-linux` (or vendored fixture parser); assert successful reconstruction.
- `needs-sim-validation` label (mandatory merge gate): compare mirror records to CC's own transcript records for the same captured traffic; assert envelope-shape parity.

Out of scope (deferred):
- LRU file-handle cache (per Fable round 1, plain `appendFile` per write is adequate at chat-traffic rates; the LRU earns its keep only under per-chunk writes, which are not the chosen design).
- Recovery / restore tooling.
- GUI / dashboard.
- Cross-session indexing.
- Default-on flip — split into its own future directive once production validation data exists.

## Implementation choice

Stream-event accumulator with one buffered write at `message_stop`. Zero pipeline modifications. The `restore-claude-history-linux` round-trip test confirms format parity before merge. The `needs-sim-validation` capture confirms envelope-shape parity against real CC traffic before merge.

## Test plan

- Unit: envelope shaper — produces records matching CC's verified key set for assistant + user records; image-content blocks become references; synthetic uuid chain is deterministic.
- Unit: dedup state — user-ordinal high-water advancement is correct (the round-2 hash-based wording is gone; replaced with position-based); different tool-result ids mirror separately; session entry LRU eviction.
- Unit: retention sweep — files past `RETENTION_DAYS` unlinked; empty directories pruned.
- Unit: `sessionFilename` reuse — verify integration with the established helper (no re-implementation).
- Integration: 3-turn replay — exactly 3 user + 3 assistant records, no duplicates. (Position-based dedup; round-1 hash algorithm produced 5 user records by turn 3.)
- Integration: 200-turn replay — total records = 400, not 20,400.
- Integration: failed-request re-stage — turn 3 stages then upstream fails before `message_stop` → `mirroredUserMessageCount` unchanged. Turn 4 (CC's retry, same history) re-stages and the records appear exactly once. Asserts no record loss AND no duplicates.
- Integration: legitimately-repeated user text — same `"yes"` user text at turns 2 and 9 produces TWO distinct mirror records (position-based dedup; verifies the design choice over hash-set dedup which would collapse them).
- Integration: stream-abort partial flush — `CACHE_FIX_SESSION_MIRROR_FLUSH_INTERRUPTED=true` (default) and stream aborts mid-message → mirror contains a partial assistant record with `stop_reason: "interrupted"`. With env var false, no partial record written.
- Integration: writer throws synchronously mid-stream → client still receives complete SSE response.
- Integration: writer rejects asynchronously mid-stream → no `unhandledRejection`; client still receives complete SSE response; error logged to `session-mirror-events.jsonl`.
- Integration: env-var off → no mirror writes occur.
- Integration: thinking exclusion → mirror records contain everything except `thinking` blocks when set.
- Integration: rotation at `MAX_BYTES` → next record opens new file; rotation event logged.
- Integration: rotation count under retention → old rotated files unlinked when past `RETENTION_DAYS`.
- Integration: path-traversal session id (`../../etc/passwd`) → mirror writes under `inv-<hash>` directory, not anywhere up the tree.
- **Format-round-trip:** feed a mirror file to `restore-claude-history-linux` (or vendored fixture parser); assert successful reconstruction of conversation order and content.
- **Sim validation:** capture real CC traffic on a test session; compare mirror records to CC's canonical transcript records for the same session; assert envelope-shape parity (all expected top-level keys present, `message` nesting correct, content blocks structurally identical).

## Files modified / created

Created:
- `proxy/extensions/jsonl-session-mirror.mjs`
- `proxy/session-mirror-writer.mjs` (flat `proxy/`)
- `proxy/session-mirror-envelope.mjs` (flat `proxy/`; reusable shaper)
- `test/extensions/jsonl-session-mirror.test.mjs`
- `test/session-mirror-writer.test.mjs`
- `test/session-mirror-envelope.test.mjs`
- `test/fixtures/multi-turn-session-replay.json`
- `test/fixtures/cc-transcript-shape-snapshot.json` (captured from a real CC 2.1.148 transcript for envelope-parity tests)
- `docs/disk-usage.md` (mirror disk footprint, configuration, rotation, retention)

Modified:
- `proxy/extensions.json` — register at order 720, default-internal-disabled.
- `CHANGELOG.md` — v4.2.0 entry citing CC#66734 + CC#66486.
- `README.md` — extension list addition + "session backup" feature callout.
- `docs/extensions.md` — extension reference.

Out of scope (no changes):
- `proxy/pipeline.mjs`, `proxy/stream.mjs`, `proxy/server.mjs` — no pipeline modifications.
- No `proxy/lib/` directory introduced.

## Reviewer checklist (cache-fix side)

- [ ] Hook surface uses `onRequest` + `onStreamEvent` + `onResponse` only; no `onResponseEnd` referenced.
- [ ] Envelope shape matches CC's verified key set for assistant + user records (verified by fixture-snapshot test).
- [ ] `restore-claude-history-linux` round-trip test passes against a generated mirror file.
- [ ] Synthetic uuid chain is deterministic from `(sessionId, timestamp, messageId)`.
- [ ] Image content blocks mirrored as references; bytes never persisted.
- [ ] Dedup uses position-based `mirroredUserMessageCount` (user-role-message ordinal coordinates, NOT raw `messages[]` indices); advances ONLY at `message_stop` write success; failed-request re-stage test passes.
- [ ] Synthetic `uuid` is dash-formatted (`8-4-4-4-12`) so shape-validating parsers accept it.
- [ ] Per-message accumulator lives on `ctx.meta._mirrorAccumulator` (request-scoped); aborted streams free state via ctx GC; `CACHE_FIX_SESSION_MIRROR_FLUSH_INTERRUPTED` partial-flush behavior tested both directions.
- [ ] User record key list matches verified 2.1.148 transcript shape: `isMeta` optional, `permissionMode` + `slug` included, `requestId` absent on user records, tool-result records omit `toolUseResult` / `sourceToolAssistantUUID` (CHANGELOG caveat).
- [ ] `sessionFilename` from `cache-telemetry.mjs` reused for directory name; sessionless requests bucket to `"unknown"`.
- [ ] Retention sweep unlinks files past `RETENTION_DAYS`; empty directories pruned.
- [ ] `session-mirror-events.jsonl` rotates at 5 MB.
- [ ] Failure-isolation: writer throws sync AND async-reject tests both pass without breaking client response.
- [ ] Storage root is `~/.claude/session-mirrors/`, NOT `~/.cache-fix-proxy/`.
- [ ] No `proxy/lib/` directory introduced.
- [ ] Default-off in v4.2.0 AND v4.3.0 (per the privacy-posture argument).
- [ ] `needs-sim-validation` label present; sim results attached as PR comment before merge.
- [ ] CHANGELOG cites CC#66734 + CC#66486 explicitly; documents three caveats: dash-formatted-but-not-RFC-valid uuid, null cwd, omitted toolUseResult on tool-result records.

## Out of scope (explicit)

- Replacing CC's canonical transcript. The mirror is a backup; CC's transcript remains primary when it survives.
- Mirroring server-side classifier verdicts, model-routing decisions, or any non-content surface.
- Compression of mirror files.
- Encryption at rest.
- Cross-session indexing.
- Default-on flip — separate future directive.
- LRU file-handle cache.

— AI Team Lead
