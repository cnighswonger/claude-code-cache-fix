# Directive: proxy-thinking-block-sanitize (drop prior-turn omitted thinking on replay)

**Status:** DRAFT — AI Team Lead, 2026-05-28 (reframed same day per Codex + community convergence on the root cause). Directive-stage; pending Codex review + Proxy Builder implementation.
**References:** anthropics/claude-code#63147 (canonical upstream bug, our #63172 consolidated into it), cache-fix #157 (defensive thinking-block guards — this realizes it), cache-fix #158 (session-health warning — complementary).

## Goal

On the request path, drop **prior-turn** extended-thinking blocks (which CC persists in the *omitted* shape `{ "type":"thinking", "thinking":"", "signature":"<intact>" }`) before the request leaves the machine. Prior-turn thinking is optional history to the API, so dropping it is safe and API-permitted. This heads off the permanent-session-death `400 messages.<n>.content.<m>: thinking ... blocks cannot be modified` on the history-replay trigger paths, for the affected CC line (2.1.145–2.1.154+, incl. Opus 4.8), while Anthropic fixes the root cause upstream.

## Why

**The omitted shape is normal, not corruption.** CC persists *every* prior thinking block with the `thinking` text emptied to `""` and the `signature` retained — verified 6866/6866 on our wedged transcript, and confirmed by Codex and by community analysis on #63147 (healthy, working sessions show the identical shape). So "empty-text + signature" does not distinguish a broken session; it is simply how prior thinking is stored.

**What actually 400s** is the API's rule that thinking blocks in the **latest assistant message** must not be modified. When CC rebuilds a request from the transcript (resume, `--continue`, auto-compaction on away/wake, mid-turn background-completion injection, parallel-tool-cancel) and replays interleaved-thinking-with-tools turns, the latest assistant turn's omitted thinking is rejected, and because the transcript is fixed, every retry re-sends it → permanent wedge. Anthropic's 2.1.152 signature-stripping safety-net does not cover these paths, and no staff have engaged on #63147 as of this writing.

**Why dropping prior-turn thinking helps:** cache-fix proxies every request and already rewrites bodies. Removing the optional prior-turn thinking history is the API-permitted fix the issue itself lists ("drop thinking blocks entirely from reconstructed prior turns"). An omitted thinking block carries no reasoning content — only a signature — so dropping it loses nothing semantic. (See Open Questions on coverage vs. the latest-turn case.)

## Non-Functional Requirements

- **Size/complexity budget:** small — one focused request-transform extension plus tests (~100–200 LOC). A bounded `messages[].content[]` walk, not a new subsystem. Flag at review if it grows materially past that.
- **Threat model:** operates on request bodies that contain conversation content. MUST NOT log, persist, or emit thinking text or signature values (telemetry is counts only). MUST NOT remove content other than prior-turn omitted (`thinking:""`) `thinking` blocks. No new inbound surface.
- **Maintainability constraints:** reuse the existing extension pipeline and any existing message/content-walk helper in `preload.mjs`; do not introduce a new abstraction for a single transform. No dead code; no back-compat shims.
- **Performance/reliability:** O(content-blocks) per request, cheap. The transform MUST be deterministic and stable — identical input → identical output — so it does not itself churn the prompt-cache prefix across turns (a non-deterministic transform would defeat cache-fix's own purpose).
- **Load-bearing? yes** — modifies request bodies in a shared proxy on the request path; correctness-, security-, and cache-relevant. Requires human (Chris) review before merge, not just Lead + Codex.

## Behavior

1. In `onRequest`, walk `body.messages`. For every assistant message **except the latest assistant message**, remove `thinking` blocks whose text is empty/whitespace-only (the omitted shape). These are prior-turn optional history; dropping them is safe. (`redacted_thinking` is **out of scope for v1** — see Out of scope.)
2. **Do not touch non-empty thinking blocks** — a block with real thinking text + signature is intact, valid, and load-bearing; leave it exactly as-is. (In practice CC stores prior thinking empty, but guard against it anyway.)
3. **Latest-assistant-message handling is the open question (see below).** The 400 names the *latest* assistant message, so a prior-turn-only drop may not clear it in every trigger. Default behavior in v1: do not modify the latest assistant message (conservative — never break a live interleaved-thinking continuation). Whether the latest *completed* (non-continuation) turn can also be safely dropped is to be settled empirically before this ships.
4. If removing blocks would leave an assistant message with empty `content[]`, drop that message (prior-turn thinking-only messages are optional history). The proxy operates on the wire request, not the on-disk transcript, so there is no `parentUuid` to relink.
5. **Opt-in for v1** via `CACHE_FIX_THINKING_SANITIZE=on` (default **off**). Per Chris's release-safety call (2026-05-28): the transform mutates request bodies for every session and its coverage is not yet live-validated (Open Question 1), so v1 ships opt-in — we do not ship a body-mutating, not-yet-validated transform default-on. Revisit default-on once a captured wedged request confirms the predicate clears a real 400 without touching healthy sessions.

## Telemetry

Emit a per-request count of blocks dropped (counts only — never content). A non-zero count is a signal the session is in the danger zone; expose it to the per-session state so it can feed the #158 session-health warning. **#158 warns** before a session grows large enough to trip the bug; **this directive mitigates** the request when it would.

## Out of scope

- **The latest interleaved-thinking continuation.** When the latest assistant turn ended mid-tool-use and tool_results follow, the API requires that turn's thinking intact — the proxy cannot supply it (the text is gone) and must not strip it. **User-side answer for this case: `DISABLE_INTERLEAVED_THINKING=1` in settings `env`** (forces thinking to lead / avoids the failing form), reported effective on #63147. Document this; it is the part the proxy cannot cover.
- **Repairing the on-disk `.jsonl` transcript.** The proxy acts on requests, not disk. Transcript repair is a recovery-tool concern (restore-claude-history-linux `heal-thinking-wedge`, RCB#5), tracked separately.
- **Persisting the real thinking text.** That is CC's job; the upstream fix lives in #63147.
- **`redacted_thinking` blocks (deferred from v1).** `redacted_thinking` is a distinct opaque `{ "type":"redacted_thinking", "data":"..." }` block — it carries no emptied text field, so it does not exhibit the empty-text-vs-signature mismatch that drives this 400 and is therefore unlikely to be part of the failure mode. Rather than special-case a schema-aware rule for a rare block with no evidence it wedges, v1 scopes to `thinking` only. Revisit if a captured repro ever shows prior-turn `redacted_thinking` contributing to the rejection (Codex re-review, 2026-05-28).

## Open questions (for Codex / Proxy Builder)

1. **Coverage (load-bearing):** confirm empirically against a captured wedged request whether dropping *prior-turn* omitted thinking actually clears a 400 that names the *latest* assistant message. If the failing block is the latest *completed* (non-continuation) turn, the transform likely must also drop that turn's omitted thinking — while still never touching a latest turn that is an active tool-continuation. Settle the exact "which turns" rule with a real repro before implementation locks.
2. Drop-the-message vs. placeholder-text-block when an assistant message becomes empty-content — which does the API accept more cleanly in the messages array?
3. **RESOLVED (Chris, 2026-05-28): opt-in for v1** (`CACHE_FIX_THINKING_SANITIZE=on`, default off). Revisit default-on only after live coverage validation (Open Question 1). Rationale: don't ship a body-mutating, not-yet-validated transform default-on — no train wreck.

## Testing

- **Unit:** prior-turn omitted thinking → dropped; non-empty thinking → kept; latest-message handling per the resolved Open Question 1 rule; message that becomes empty-content → handled; determinism (same input twice → identical output).
- **Integration (Proxy Test Agent, live CC traffic):** replay a captured wedged extended-thinking request; confirm the transform makes the history-replay request succeed where it previously 400'd; confirm a healthy session is unchanged except for the targeted drops; confirm prompt-cache prefix stability across consecutive turns.
