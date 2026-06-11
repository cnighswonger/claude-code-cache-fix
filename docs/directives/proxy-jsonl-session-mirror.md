# Directive: JSONL session-content mirror

**Issue:** TBD (will be filed alongside this directive, referencing CC#66734 and CC#66486)
**Upstream:**
- [anthropics/claude-code#66734](https://github.com/anthropics/claude-code/issues/66734) — *Session JSONL rewritten in-place to metadata-only stub — user/assistant records lost (2.1.168–2.1.170, since native installer migration)*
- [anthropics/claude-code#66486](https://github.com/anthropics/claude-code/issues/66486) — *2.1.169: interactive sessions write no JSONL transcript (only ai-title stub)*
**Priority:** P1
**Branch:** `feature/jsonl-session-mirror`
**Stage:** directive — round 2 (addresses Fable round-1 REQUEST_CHANGES at PR #214)
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

## Pipeline-hook surface (closes Fable B1)

The pipeline exposes exactly four hooks: `onRequest`, `onResponseStart`, `onStreamEvent`, `onResponse` (`pipeline.mjs:85-141`). For streaming traffic — essentially all `/v1/messages` traffic — `runOnResponse` does NOT fire (`server.mjs:160-188`); `streamResponse` runs `onStreamEvent` per event and then ends the client response. The previously-named `onResponseEnd` does not exist.

The mirror runs as a **stream-event accumulator** with one buffered write at `message_stop`:

- **`onRequest`** — extracts the resolved session id via `resolveSessionId(ctx.headers)` (`cache-telemetry.mjs:64-72`); stashes it on `ctx.meta._mirrorSessionId`. Examines `ctx.body.messages` for new user/tool-result content not already mirrored for this session (per the dedup state machine; closes B3); stages those as pending records on `ctx.meta._mirrorPendingUserRecords` for emission alongside the response record. The dedup map is module-scope per session.
- **`onStreamEvent`** — accumulates per-message state across `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`. On `message_stop`, builds the complete assistant record in CC's transcript envelope (B2 fix below), writes it + any staged user/tool-result records, and clears the per-message accumulator. The accumulator handles `text_delta`, `input_json_delta` (for `tool_use` blocks), and `thinking_delta` (with optional exclusion per env var).
- **`onResponse`** — fires only on the non-streaming branch (rare for `/v1/messages` but possible for some routes). The same envelope shaper handles the already-complete envelope and writes one record.

No pipeline.mjs / stream.mjs / server.mjs modifications. The accumulator pattern is option-1-mechanics + option-2-cadence per Fable round 1's recommendation. The previously-listed "stream tee that buffers SSE chunks per-message-id" claim in the round-1 Scope section was a different framing for the same accumulator; the round-2 directive collapses them.

## Mirror record envelope (closes Fable B2 — verified against real CC 2.1.148 transcripts)

CC's transcript record shape, verified against `~/.claude/projects/<project>/<session-uuid>.jsonl`:

**Assistant record top-level keys:** `cwd`, `entrypoint`, `gitBranch`, `isSidechain`, `message`, `parentUuid`, `requestId`, `sessionId`, `timestamp`, `type`, `userType`, `uuid`, `version`.

**`message` nested keys:** `content`, `id`, `model`, `role`, `stop_details`, `stop_reason`, `stop_sequence`, `type`, `usage`.

**User record top-level keys:** as assistant, plus `isMeta`, `promptId`. **`message` nested keys:** `content`, `role`.

The mirror record adopts this envelope with proxy-derived substitutions:

```json
{
  "type": "assistant",
  "uuid": "<sha256(sessionId+timestamp+messageId).slice(0,32)>",
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

The CHANGELOG must call out that the mirror's `cwd` is null and the `uuid` chain is synthetic; consumers depending on those for recovery should verify their behavior.

## Dedup state (closes Fable B3)

CC re-sends the full conversation history in every request. Without dedup, the mirror would write `O(n²)` records over an `n`-turn session. The fix:

Module-scope state: `mirrorState.sessions = Map<sessionId, { lastMirroredUserMessageHash, lastMirroredToolResultIds: Set<string> }>`.

`onRequest` logic:

1. Resolve session id; load (or create) the session entry.
2. For each user-role message in `ctx.body.messages`:
   - Hash the text content (`sha256(JSON.stringify(content)).slice(0,32)`).
   - If the hash matches `lastMirroredUserMessageHash`, skip — already mirrored.
   - Otherwise, stage the record for emission and update `lastMirroredUserMessageHash`.
3. For each tool-result block in user messages:
   - Look up its `tool_use_id`. If in `lastMirroredToolResultIds`, skip.
   - Otherwise, stage and add to the set.
4. Pending records are stashed on `ctx.meta._mirrorPendingUserRecords` for the response-side accumulator to flush before its assistant record.

The session map is bounded by `CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS` (default 1024) with LRU eviction and a periodic 60s throttled sweep removing entries inactive past the retention window.

Test fixture: a 3-turn replay must produce exactly 3 user records + 3 assistant records + (any tool result records) — no duplicates.

## Session id and path sanitization (closes Fable B4)

Session id resolution and filesystem encoding both reuse `cache-telemetry.mjs`:

- Session id resolved at `onRequest` time via `resolveSessionId(ctx.headers)` (checks three session-id header variants).
- Filesystem directory name is `sessionFilename(sessionId)` (safe-charset passthrough, `inv-<sha256[:16]>` otherwise, `unknown` on null). This is the established convention for the same threat surface (path traversal, invalid-filename injection).
- Sessionless requests bucket to `"unknown"` and share a directory; this is best-effort and documented as such.

Mirror storage root: `~/.claude/session-mirrors/` (NOT `~/.cache-fix-proxy/`; per Fable round 1, every proxy artifact lives under `~/.claude/` — established convention). Sub-directory is `sessionFilename(sessionId)`; per-rotation file `<timestamp>.jsonl`.

## Retention sweep (closes Fable B5)

`MAX_BYTES` rotation bounds the active file but rotated files would accumulate without bound. The retention sweep closes this:

- `CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS` (default 30) — rotated files older than the threshold are unlinked.
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
- Unit: dedup state — same user message hashed twice mirrors once; different tool-result ids mirror separately; session entry LRU eviction.
- Unit: retention sweep — files past `RETENTION_DAYS` unlinked; empty directories pruned.
- Unit: `sessionFilename` reuse — verify integration with the established helper (no re-implementation).
- Integration: 3-turn replay — exactly 3 user + 3 assistant records, no duplicates.
- Integration: 200-turn replay — total records = 400, not 20,400 (the round-1-shape would have produced).
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
- [ ] Dedup state prevents O(n²) record growth on long sessions.
- [ ] `sessionFilename` from `cache-telemetry.mjs` reused for directory name; sessionless requests bucket to `"unknown"`.
- [ ] Retention sweep unlinks files past `RETENTION_DAYS`; empty directories pruned.
- [ ] `session-mirror-events.jsonl` rotates at 5 MB.
- [ ] Failure-isolation: writer throws sync AND async-reject tests both pass without breaking client response.
- [ ] Storage root is `~/.claude/session-mirrors/`, NOT `~/.cache-fix-proxy/`.
- [ ] No `proxy/lib/` directory introduced.
- [ ] Default-off in v4.2.0 AND v4.3.0 (per the privacy-posture argument).
- [ ] `needs-sim-validation` label present; sim results attached as PR comment before merge.
- [ ] CHANGELOG cites CC#66734 + CC#66486 explicitly; documents synthetic uuid + null cwd caveats.

## Out of scope (explicit)

- Replacing CC's canonical transcript. The mirror is a backup; CC's transcript remains primary when it survives.
- Mirroring server-side classifier verdicts, model-routing decisions, or any non-content surface.
- Compression of mirror files.
- Encryption at rest.
- Cross-session indexing.
- Default-on flip — separate future directive.
- LRU file-handle cache.

— AI Team Lead
