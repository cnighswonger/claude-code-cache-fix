# Directive: proxy-thinking-block-sanitize (prior-turn signed-but-empty thinking strip)

**Status:** DRAFT — AI Team Lead, 2026-05-28. Directive-stage; pending Codex review + Proxy Builder implementation.
**References:** anthropics/claude-code#63147 (canonical upstream bug, our #63172 consolidated into it), cache-fix #157 (defensive thinking-block guards — this realizes it), cache-fix #158 (session-health warning — complementary).

## Goal

On the request path, strip **prior-turn** extended-thinking blocks that are stored signed-but-empty, so they never reach the API as `{ "type":"thinking", "thinking":"", "signature":"<intact>" }`. This heads off the permanent-session-death `400 messages.<n>.content.<m>: thinking ... blocks cannot be modified` for the history-replay trigger paths, for the entire affected CC line (2.1.145–2.1.154+), while Anthropic fixes the root cause upstream.

## Why

CC persists extended-thinking blocks with the `thinking` text emptied to `""` but the `signature` retained. When CC rebuilds a request from the transcript (resume, `--continue`, auto-compaction on away/wake, mid-turn background-completion injection, parallel-tool-cancel), it re-sends those signed-but-empty blocks; the API validates the signature against the now-empty text and rejects the whole request. The session is then permanently wedged — every retry, no-op, and `/compact` re-sends the same blocks. Anthropic's 2.1.152 signature-stripping safety-net does not cover these paths, and no staff have engaged on #63147 as of this writing. cache-fix proxies every request and already rewrites request bodies (cache-control), so it is well-placed to neutralize the corrupted blocks before they leave the machine. An empty-text thinking block carries no reasoning content — only a signature — so removing it loses nothing semantic.

## Non-Functional Requirements

- **Size/complexity budget:** small — one focused request-transform extension plus tests (~100–200 LOC). A bounded `messages[].content[]` walk, not a new subsystem. Flag at review if it grows materially past that.
- **Threat model:** operates on request bodies that contain conversation content. MUST NOT log, persist, or emit thinking text or signature values (telemetry is counts only). MUST NOT provide any path to strip content other than the precisely-matched corrupted shape. No new inbound surface.
- **Maintainability constraints:** reuse the existing extension pipeline and any existing message/content-walk helper in `preload.mjs`; do not introduce a new abstraction for a single transform. No dead code; no back-compat shims.
- **Performance/reliability:** O(content-blocks) per request, cheap. The transform MUST be deterministic and stable — identical input → identical output — so it does not itself churn the prompt-cache prefix across turns (a non-deterministic strip would defeat cache-fix's own purpose).
- **Load-bearing? yes** — modifies request bodies in a shared proxy on the request path; correctness-, security-, and cache-relevant. Requires human (Chris) review before merge, not just Lead + Codex.

## Behavior

1. In `onRequest`, walk `body.messages`. For every assistant message **except the latest assistant message**, in its `content[]`, match blocks where `type` is `thinking` or `redacted_thinking` AND the text field is empty or whitespace-only AND a non-empty `signature` is present. Remove those matched blocks.
2. **Never touch the latest assistant message.** The API error is specifically about modifying thinking blocks in the *latest* assistant message; those are off-limits and cannot be safely altered by a proxy. (This is the inherent coverage limit — see Out of scope.)
3. **Never touch non-empty thinking blocks** — a thinking block with real text + signature is valid and load-bearing; leave it exactly as-is.
4. If removing matched blocks would leave an assistant message with an empty `content[]`, drop that message from the array (prior-turn thinking-only messages are optional history to the API). Decide vs. a placeholder text block at implementation time; prefer dropping if it keeps `parentUuid`-equivalent ordering valid for the API (note: proxy operates on the wire request, not the on-disk transcript, so there is no `parentUuid` to relink here).
5. Default-on, with a single env kill-switch (e.g. `CACHE_FIX_THINKING_SANITIZE=off`). Default-on is justified because the transform only removes blocks that would otherwise cause a hard 400, and removes nothing with semantic content.

## Telemetry

Emit a per-request count of blocks stripped (counts only — never content). A non-zero count is a strong signal the session is in the danger zone; expose it to the per-session state so it can feed the #158 session-health warning. This is the natural bridge between the two features: **#158 warns** before a session grows large enough to trip the bug; **this directive mitigates** the request when it would.

## Out of scope

- **The latest/in-flight assistant message.** The API forbids modifying its thinking blocks, so the proxy cannot fix the case where the corrupted block is in the current turn. This mitigation covers the history-replay triggers only — it is a partial fix by nature (mirrors the community band-aid's partial coverage). Document this limitation in user-facing notes.
- **Repairing the on-disk `.jsonl` transcript.** The proxy acts on requests, not disk. Transcript repair is a recovery-tool concern (restore-claude-history-linux territory), tracked separately.
- **Persisting the real thinking text.** That is CC's job; the upstream fix lives in #63147.

## Testing

- **Unit:** request bodies covering — prior-turn empty+signed thinking → stripped; prior-turn `redacted_thinking` empty+signed → stripped; non-empty signed thinking → kept; latest assistant message empty+signed → untouched; a prior assistant message that becomes empty-content after strip → handled (no empty-content message sent); determinism (same input twice → identical output).
- **Integration (Proxy Test Agent, live CC traffic):** capture a wedged extended-thinking session's outgoing request; confirm the proxy transform makes the history-replay request succeed where it previously 400'd; confirm a healthy session is byte-identical through the transform except for the targeted blocks; confirm prompt-cache prefix stability across consecutive turns.

## Open questions (for Codex / Proxy Builder)

1. Drop-the-message vs. placeholder-text-block when a prior assistant message becomes empty — which does the API accept more cleanly in the messages array?
2. Default-on vs. opt-in for the first release — lean default-on per NFR rationale; confirm against cache-fix's release-safety posture.
3. Interaction with the existing 2.1.152-era client-side signature handling — ensure no double-processing or conflict.
