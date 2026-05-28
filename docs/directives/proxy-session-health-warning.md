# Directive: session-health early-warning (thinking-desync risk)

**Status:** Scope APPROVED by AI Team Lead 2026-05-28 (issue #158). Ready for directive-stage PR + Codex review. New feature → minor release (v3.8.0); per `docs/release-workflow.md` the maintenance-mode gate is at this directive stage and has been cleared.
**Author:** Proxy Builder (directive), AI Team Lead (scope approval + refinements)
**References:**
- `anthropics/claude-code#63147` — canonical upstream root-cause bug (interleaved-thinking signature desync; our report #63172 was consolidated into it). `anthropics/claude-code#63143` is the `AskUserQuestion`-cancel trigger variant.
- cache-fix `#157` — defensive thinking-block guards (related but separate)
- `playbook_manual_compact_procedure.md` (shared memory) — the manual retirement procedure this warning feeds into

**Warning half vs recovery half:** this directive is the **pre-wedge early-warning** — it flags a session approaching the desync-trip scale so the operator can retire it deliberately. The complementary **post-wedge recovery** — healing a wedged session in place by stripping standalone thinking rows from the `.jsonl` and re-linking `parentUuid` (see `playbook_heal_thinking_wedged_session.md`) — is being tracked as a repair-tool in the `restore-claude-history-linux` project. Warn before; heal after.

## Problem statement

Long-running Opus 4.7 (`claude-opus-4-7[1m]`) sessions accumulate interleaved thinking blocks and grow their context window until Claude Code's own history management (compaction / context-editing / parallel-tool-cancellation reconstruction) desyncs a thinking-block signature. The result is a hard `400 messages.<N>.content.<M>: thinking blocks ... cannot be modified` on essentially every subsequent turn — the session becomes unusable and the only recovery is retiring it (see #63172 for the full mechanism).

Observed failure scale on the incident that motivated this (2026-05-28): ~382K-token live context, ~6,850 accumulated thinking blocks, ~7 weeks of continuous session age, 99% cache-read right up until the trip. **There was no proactive signal.** The session ran healthy for weeks and then died abruptly. The existing `manual-compact.sh` retirement procedure relies entirely on a human noticing context-% creep — which nobody did until it was too late.

cache-fix is uniquely positioned to provide the missing early warning: it proxies every request, already reads response `usage` for telemetry, already maintains per-session state files, and already feeds the statusline. It can measure the exact conditions that correlate with the desync risk and warn before the session reaches the danger zone.

**Scope boundary:** cache-fix CANNOT fix the desync — that's CC-side (#63172). This feature only *warns* so the operator can retire the session deliberately (write SESSION_STATE, `/clear`) instead of being surprised by a dead session. It is an early-warning, not a mitigation of the bug itself.

## What the proxy can measure (all already in hand)

- **Live context size** — from response `usage`: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. The `cache-telemetry` extension already reads these.
- **Interleaved thinking-block count in the request** — count `thinking` / `redacted_thinking` blocks across `body.messages[*].content[*]` in `onRequest`. The proxy has the full request body.
- **Session age / first-seen** — the per-session quota-status file already exists (cache-fix v3.5.0+); first-seen timestamp gives age.
- **Per-session keying** — session id is already resolved in `onRequest` (the v3.5.4 fix moved session-id resolution to request headers).

## Design (v3.8.0 — single release, split by dimension)

Per AI Team Lead's scope decision: ship one useful release now rather than a warn-nothing telemetry release followed by a warn release. The **token dimension is already anchored** (we directly observed the trip at ~382K live context), so it gates an active warning immediately. The **block dimension is recorded in telemetry but does not yet gate a warning** — we lack the in-context block distribution at failure (the incident only gives session-*total* ~6,850), so its threshold stays evidence-driven and activates in a calibrated fast-follow.

### Telemetry (all fields, this release)

Extend the per-session quota-status JSON, written on each request via the existing per-session writer:

- `context_tokens` — latest request's live context (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`)
- `thinking_block_count` — count of `thinking`/`redacted_thinking` blocks in the latest request (the live risk driver)
- `thinking_block_max` — session high-water mark of the above (this is exactly the calibration data we're missing for the block threshold; free to record)
- `first_seen`, `request_count`
- `thinking_desync_risk` — `"ok" | "warn" | "high"` (computed; see below)

### Active warning (token-gated, this release)

- Compute `thinking_desync_risk` from `context_tokens` only, in this release: `high` when `context_tokens ≥ high-tokens`, `warn` at `≥ warn-tokens`, else `ok`. (Block-count is recorded but does NOT contribute to the risk level yet.)
- Surface in **two** places (NOT the statusline this release — see Resolved decisions #2):
  1. **Per-session JSON** — `thinking_desync_risk` + the raw counts, for any consumer.
  2. **One-time stderr log** — when a session first crosses into `high`, so headless/non-statusline surfaces get the signal once (not on every request).

### Config (env vars)

- `CACHE_FIX_THINKING_RISK_WARN_TOKENS` (default **250000**)
- `CACHE_FIX_THINKING_RISK_HIGH_TOKENS` (default **340000** — just under the observed ~382K trip, with margin)
- `CACHE_FIX_THINKING_RISK=off` disables the warning signal — both the stderr warn line AND the computed `thinking_desync_risk` field — while raw count telemetry (`context_tokens`, `thinking_block_count`, `thinking_block_max`) keeps recording (always useful, and it feeds the block-threshold calibration)
- Block-threshold env vars (`..._WARN_BLOCKS` / `..._HIGH_BLOCKS`) are **deferred to the fast-follow**, set once `thinking_block_max` telemetry gives the failure distribution. Not introduced this release.

Conservative early-warn bias is intentional: a premature "retire soon" is far cheaper than a dead session.

### Fast-follow (separate, after data)

Once production `thinking_block_max` telemetry shows the in-context block count at/near failure, add the block dimension to the risk computation (`high`/`warn` on EITHER tokens OR blocks) with calibrated `..._BLOCKS` defaults. Tracked as a follow-up, not part of v3.8.0.

## Resolved scope decisions (AI Team Lead, 2026-05-28, #158)

1. **Phasing → split by dimension, one release.** v3.8.0 ships full telemetry + the active token-gated warn now (token trip is anchored); the block dimension is telemetry-only and activates in a calibrated fast-follow. Avoids shipping a warn-nothing release while the failure keeps recurring.
2. **Statusline → leave `quota-statusline.sh` untouched this release.** Signal via per-session JSON + one-time stderr log only. A separate coordination issue/PR will propose the optional risk segment for @schuay to opt into or own — keeping community-code edits out of this release and the contributor boundary clean.
3. **Defaults → anchor tokens, hold blocks.** Token `high` ~340K / `warn` ~250K; no blind block defaults (telemetry-only until data sets them). Conservative early-warn bias retained.
4. **`thinking_block_count` → track both.** Latest-request count (live driver) and `thinking_block_max` high-water (the missing calibration data).

## Non-Functional Requirements

- **Size/complexity budget:** small–moderate — telemetry fields on the existing per-session writer + a token-threshold risk computation + a one-time stderr warn. Reuses `cache-telemetry`'s `usage` read, the per-session quota-status writer, and `onRequest` body access. No new subsystem. ~100–200 LOC + tests; flag at review if it grows materially past that.
- **Threat model:** counts/tokens only. MUST NOT log, persist, or emit thinking text, signatures, or any request/response content — telemetry is numeric (`context_tokens`, `thinking_block_count`, `thinking_block_max`, risk level) plus a content-free warn line. **Read-only on request/response bodies** — this extension observes and records; it never mutates the body. No new inbound surface.
- **Maintainability constraints:** reuse the existing per-session quota-status writer and `cache-telemetry`'s usage extraction; do not introduce a new abstraction for the count/threshold logic. New JSON fields are additive. No dead code, no back-compat shims.
- **Performance/reliability:** O(content-blocks) per request to count thinking blocks; cheap. Because the transform is read-only on the body, it does not churn the prompt-cache prefix.
- **Load-bearing? yes — schema-contract dimension only.** It does **not** modify request/response bodies (unlike the sibling #162 sanitize), so it carries none of the request-path correctness/cache-mutation risk. BUT it extends the per-session quota-status JSON — a wire/schema contract that downstream consumers (statusline, dashboards) read — so it qualifies as load-bearing on the schema dimension. The additions are backward-compatible (new optional fields; existing consumers unaffected). Per CLAUDE.md's load-bearing rule, wire/schema-contract changes **require** human (Chris) review before merge — here specifically to confirm the additive fields don't break existing per-session consumers — and the `schema-change` label applies. (It does not carry #162's request-mutation review burden, but the schema-contract change is a Chris-review gate, not a recommendation.)

## Out of scope

- **Fixing or working around the desync** — that's #63172, CC-side. cache-fix must not attempt to mutate/strip thinking blocks to "repair" a session (that path is exactly what #157 guards against). Warning only.
- **Auto-retiring / auto-clearing a session** — too aggressive; the operator decides. We warn, they act.
- **Cross-host aggregation** — single-host per-session state, consistent with the existing model.

## Version target

Minor — **v3.8.0** (new extension + new env vars). No statusline change this release (decision #2), so no community-code edit. Scope approved by AI Team Lead (#158); ready for the directive-stage PR + Codex review loop. The block-dimension fast-follow is a later patch/minor once telemetry calibrates it.
