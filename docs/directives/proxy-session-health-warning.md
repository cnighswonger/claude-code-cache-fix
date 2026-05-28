# Directive: session-health early-warning (thinking-desync risk)

**Status:** Scope APPROVED by AI Team Lead 2026-05-28 (issue #158). Ready for directive-stage PR + Codex review. New feature → minor release (v3.8.0); per `docs/release-workflow.md` the maintenance-mode gate is at this directive stage and has been cleared.
**Author:** Proxy Builder (directive), AI Team Lead (scope approval + refinements)
**References:**
- `anthropics/claude-code#63172` — upstream root-cause bug (interleaved-thinking signature desync on extreme-scale sessions)
- cache-fix `#157` — defensive thinking-block guards (related but separate)
- `playbook_manual_compact_procedure.md` (shared memory) — the manual retirement procedure this warning feeds into

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
- `CACHE_FIX_THINKING_RISK=off` to disable the warning (telemetry still recorded)
- Block-threshold env vars (`..._WARN_BLOCKS` / `..._HIGH_BLOCKS`) are **deferred to the fast-follow**, set once `thinking_block_max` telemetry gives the failure distribution. Not introduced this release.

Conservative early-warn bias is intentional: a premature "retire soon" is far cheaper than a dead session.

### Fast-follow (separate, after data)

Once production `thinking_block_max` telemetry shows the in-context block count at/near failure, add the block dimension to the risk computation (`high`/`warn` on EITHER tokens OR blocks) with calibrated `..._BLOCKS` defaults. Tracked as a follow-up, not part of v3.8.0.

## Resolved scope decisions (AI Team Lead, 2026-05-28, #158)

1. **Phasing → split by dimension, one release.** v3.8.0 ships full telemetry + the active token-gated warn now (token trip is anchored); the block dimension is telemetry-only and activates in a calibrated fast-follow. Avoids shipping a warn-nothing release while the failure keeps recurring.
2. **Statusline → leave `quota-statusline.sh` untouched this release.** Signal via per-session JSON + one-time stderr log only. A separate coordination issue/PR will propose the optional risk segment for @schuay to opt into or own — keeping community-code edits out of this release and the contributor boundary clean.
3. **Defaults → anchor tokens, hold blocks.** Token `high` ~340K / `warn` ~250K; no blind block defaults (telemetry-only until data sets them). Conservative early-warn bias retained.
4. **`thinking_block_count` → track both.** Latest-request count (live driver) and `thinking_block_max` high-water (the missing calibration data).

## Out of scope

- **Fixing or working around the desync** — that's #63172, CC-side. cache-fix must not attempt to mutate/strip thinking blocks to "repair" a session (that path is exactly what #157 guards against). Warning only.
- **Auto-retiring / auto-clearing a session** — too aggressive; the operator decides. We warn, they act.
- **Cross-host aggregation** — single-host per-session state, consistent with the existing model.

## Version target

Minor — **v3.8.0** (new extension + new env vars). No statusline change this release (decision #2), so no community-code edit. Scope approved by AI Team Lead (#158); ready for the directive-stage PR + Codex review loop. The block-dimension fast-follow is a later patch/minor once telemetry calibrates it.
