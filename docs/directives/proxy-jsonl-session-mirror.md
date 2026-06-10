# Directive: JSONL session-content mirror

**Issue:** TBD (will be filed alongside this directive, referencing CC#66734 and CC#66486)
**Upstream:**
- [anthropics/claude-code#66734](https://github.com/anthropics/claude-code/issues/66734) — *Session JSONL rewritten in-place to metadata-only stub — user/assistant records lost (2.1.168–2.1.170, since native installer migration)*
- [anthropics/claude-code#66486](https://github.com/anthropics/claude-code/issues/66486) — *2.1.169: interactive sessions write no JSONL transcript (only ai-title stub)*
**Priority:** P1
**Branch:** `feature/jsonl-session-mirror`
**Stage:** directive
**Milestone:** v4.2.0

## Goal

The proxy mirrors every assistant message and tool result it observes in the response stream into a per-session JSONL file the user controls — independent of CC's own transcript-write path. If CC's in-place stub-rewrite regression (CC#66734) destroys the canonical transcript, or the transcript-write path is silently disabled (CC#66486), the user retains a complete content record from the proxy side. The mirror is read-only with respect to upstream traffic; no requests are modified.

This is a **belt-and-suspenders backup**, not a transcript replacement. CC's own JSONL remains canonical when it survives. The mirror is the user's recovery path when CC's transcript is lost.

## Why

CC#66734 documents data-loss across 12 occurrences in two projects since the 2026-06-06 native installer migration; multiple CC versions affected (2.1.168, 2.1.169, 2.1.170). CC#66486 documents transcript-stub regressions in 2.1.169 specifically. Both are tagged `data-loss` by Anthropic. Users on affected versions have no recourse once the stub-rewrite fires — their conversation content is gone. Recovery tools like `restore-claude-history-linux` work only when the filesystem snapshot predates the stub-rewrite event.

The proxy is downstream of CC's own transcript writer. It sees every assistant message and tool result in the response stream as the bytes flow through. If we tee that stream to a side-write JSONL keyed by session, the user retains a complete content record regardless of what happens to CC's canonical file. The mirror is not affected by CC's stub-rewrite logic because it is a separate file path under user-controlled cache-fix-proxy storage.

The framing is **defensive**, not promotional. We do not claim the mirror solves CC's bug; CC's bug is upstream and Anthropic's to fix. We claim the mirror reduces the cost of CC's bug from "conversation gone" to "conversation recoverable from mirror" while CC's fix is in flight.

## Non-Functional Requirements

- **Size/complexity budget:** new extension `jsonl-session-mirror.mjs` (~200–300 LOC including stream tee + write batching + per-session file rotation). The streaming nature is the only non-trivial part; mirror writes must not block the response stream returning to the client.
- **Threat model:** the mirror writes plaintext conversation content to disk under user-controlled paths. This is the same threat surface as CC's own transcript; no incremental risk. Mirror files inherit the user's umask and live at `~/.cache-fix-proxy/session-mirrors/<session-id>/<timestamp>.jsonl` by default (configurable via env var).
- **Activation model:** `enabled: true` in `extensions.json` (always loaded) with internal env-var gate `CACHE_FIX_SESSION_MIRROR` (`on` / `off`). Default-off in v4.2.0 first ship; default-on after one minor-version validation cycle. Opt-in by design — users with sensitive workloads (compliance, regulated industries) should make an explicit choice about local content persistence.
- **Disk-cost discipline:** per-session mirrors are bounded by an env-var `CACHE_FIX_SESSION_MIRROR_MAX_BYTES` (default 100 MB per session file). On overflow, rotate to `<session-id>/<timestamp>.<rotation>.jsonl` and emit a structured log event. Document the disk footprint clearly.

## Detection logic

For each response observed in `onResponseEnd`:

1. Extract `x-claude-code-session-id` from the request headers (fallback to proxy `sid`).
2. Parse the assistant message envelope from the response body.
3. For each content block (`text`, `tool_use`, `thinking`, `image` — image as reference, not content), construct a mirror JSONL record matching CC's per-session-transcript record shape as closely as practical.
4. Append the record to the mirror JSONL for this session, opening the file on first write and keeping a file-handle cache keyed by session-id with LRU eviction.

The mirror record shape:

```
{
  "type": "assistant",
  "session_id": "<from-header>",
  "request_id": "<from-response-header>",
  "timestamp": "<ISO8601>",
  "model": "<echoed-from-response>",
  "content": [...],        // shaped to match CC's transcript content array
  "stop_reason": "<from-response>",
  "usage": {...},          // from response usage block
  "source": "cache-fix-proxy-mirror"
}
```

Tool results from request bodies are also mirrored (request type `tool_result`) so the user-side message history is reconstructable. User text prompts are mirrored from request `messages[*]` with `role: "user"`.

The `source: "cache-fix-proxy-mirror"` field is the load-bearing distinguisher: recovery tools and the user can tell at a glance that the file came from the proxy mirror, not from CC's transcript. The format is intentionally CC-transcript-compatible so that existing transcript readers (e.g., `restore-claude-history-linux`) can parse mirror files without modification.

## Scope (v4.2.0)

In scope:
- New extension `proxy/extensions/jsonl-session-mirror.mjs` at order 720 (after usage-log at 700, before any future late-pipeline extensions).
- Per-session JSONL writer with file-handle cache + LRU eviction (default 32 open handles).
- Mirror records for: user messages (from request body), assistant messages (from response body), tool calls, tool results.
- Stream tee that buffers SSE chunks per-message-id and emits a complete record on `message_stop`.
- Env-var configuration: `CACHE_FIX_SESSION_MIRROR` (gate), `CACHE_FIX_SESSION_MIRROR_DIR` (override base path), `CACHE_FIX_SESSION_MIRROR_MAX_BYTES` (rotation threshold), `CACHE_FIX_SESSION_MIRROR_MAX_HANDLES` (LRU cap).
- Structured rotation/event log at `~/.cache-fix-proxy/session-mirror-events.jsonl` (open, rotate, error).
- README section + extension docs entry referencing CC#66734 / CC#66486 as the motivating cases.

Out of scope (deferred):
- Recovery / restore tooling. The mirror is the data surface; restoration is a separate concern. Recommend `restore-claude-history-linux` (already supports CC's JSONL shape) and document that the mirror format is compatible.
- GUI / dashboard for browsing mirrored sessions. The JSONL is the format; consumers wire it.
- Image-content mirroring. v4.2.0 mirrors image-content blocks as references only (the `source.media_type` and a SHA-256 reference, not the bytes themselves). Storing the bytes inflates the mirror by orders of magnitude; the reference is sufficient for transcript reconstruction.
- Mirroring of `thinking` content blocks. Thinking is a privacy-sensitive surface; the v4.2.0 default mirrors `thinking` blocks but the env-var `CACHE_FIX_SESSION_MIRROR_INCLUDE_THINKING=false` excludes them. Document.

## Implementation choice

Two design alternatives considered:

1. **Stream-tee at `onResponseChunk`** — intercept every SSE chunk, accumulate per-message-id, emit on `message_stop`. Lowest latency, most complete fidelity, more code.
2. **Buffer-then-write at `onResponseEnd`** — wait for response to complete, parse the final envelope, write one record. Simpler, but loses streaming fidelity (no partial-message recovery if the response is interrupted mid-stream).

**Decision:** start with option 2 for v4.2.0. CC's own transcript is end-of-stream-written too, so feature-parity with the canonical format is preserved. Option 1 is a follow-up if interrupted-stream recovery becomes a real user concern.

This mirrors the existing `request-log.mjs` pattern but writes content rather than just headers.

## Test plan

- Unit: record-shape construction — `text`, `tool_use`, `tool_result`, `thinking` content blocks all produce valid JSONL.
- Unit: file-handle LRU — opening more than the cap evicts the oldest, file handles close cleanly on eviction.
- Unit: rotation threshold — exceeding `MAX_BYTES` triggers rotation to next file in sequence.
- Integration: replay a multi-turn fixture (user message → assistant message → tool call → tool result → assistant message); assert all four records land in the mirror in order.
- Integration: simulate CC stub-rewrite by truncating CC's canonical transcript to ai-title-only after the proxy mirror writes; assert the mirror is intact and the content is reconstructable.
- Integration: env-var off → no mirror writes occur.
- Integration: thinking exclusion → mirror records contain everything except `thinking` content blocks when the env-var is set.
- Smoke: disk-cost discipline — a session producing 10K records with default `MAX_BYTES` triggers rotation correctly; no file grows unbounded.

## Files modified / created

Created:
- `proxy/extensions/jsonl-session-mirror.mjs`
- `proxy/lib/session-mirror-writer.mjs` (file-handle cache + rotation)
- `test/extensions/jsonl-session-mirror.test.mjs`
- `test/lib/session-mirror-writer.test.mjs`
- `test/fixtures/multi-turn-session-replay.json`

Modified:
- `proxy/extensions.json` — register at order 720, default-disabled-internally.
- `CHANGELOG.md` — v4.2.0 entry citing CC#66734 + CC#66486.
- `README.md` — extension list addition + "session backup" feature callout.
- `docs/extensions.md` — extension reference.
- `docs/disk-usage.md` (new) — document the mirror's disk footprint, configuration, and rotation behavior.

## Reviewer checklist (cache-fix side)

- [ ] Mirror format is CC-transcript-compatible — `restore-claude-history-linux` can parse mirror files without modification.
- [ ] File-handle LRU does not leak handles under high session churn.
- [ ] Rotation happens at `MAX_BYTES`, not lazily — no file grows unbounded.
- [ ] Thinking-block exclusion respects the env-var explicitly.
- [ ] `source: "cache-fix-proxy-mirror"` field present on every record.
- [ ] Mirror writes do not block the response stream returning to the client (writes are async).
- [ ] Disk footprint is documented with explicit byte budget per session.
- [ ] CHANGELOG cites CC#66734 + CC#66486 explicitly.

## Out of scope (explicit)

- Replacing CC's canonical transcript. The mirror is a backup; CC's transcript remains primary when it survives.
- Mirroring server-side classifier verdicts, model-routing decisions, or any non-content surface. Content only.
- Compression of mirror files. JSONL is the format; users can post-compress if they wish.
- Encryption at rest. The mirror inherits the user's filesystem permissions; encryption is a separate concern outside this directive's scope.
- Cross-session indexing. Each session has its own file; no index database in v4.2.0.

— AI Team Lead
