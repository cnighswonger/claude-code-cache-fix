# Directive: session-health early-warning (thinking-desync risk)

**Status:** DRAFT — authored by Proxy Builder 2026-05-28, pending AI Team Lead scope approval. New feature → minor release; per `docs/release-workflow.md` the maintenance-mode gate is at this directive stage.
**Author:** Proxy Builder
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

## Proposed design

### Phase 1 — measure (no thresholds yet)

Add per-session telemetry so we can calibrate thresholds against real data rather than guessing:

- Extend the per-session quota-status JSON with: `context_tokens` (latest), `thinking_block_count` (latest request), `thinking_block_max` (session high-water), `first_seen`, `request_count`.
- Emit these on each request via the existing per-session writer.
- No warning behavior yet — this phase exists to gather the distribution of `thinking_block_count` and `context_tokens` at which real sessions start failing, since the incident data only gives session-*total* thinking blocks (~6,850), not the in-context count at the trip.

### Phase 2 — warn (thresholds calibrated from Phase 1 data)

- Compute a `thinking_desync_risk` field per session: `"ok" | "warn" | "high"`, derived from `context_tokens` and `thinking_block_count` crossing configurable thresholds.
- Surface in three places:
  1. **Per-session JSON** — `thinking_desync_risk` + the raw counts (for any consumer).
  2. **Statusline** — a segment that appears only at `warn`/`high` (e.g. `⚠ ctx 310K / 220 think-blocks — consider retiring`), consumed by `tools/quota-statusline.sh`.
  3. **One-time stderr log** — when a session first crosses into `high`, so headless/non-statusline surfaces still get the signal once.
- Config (env vars, with defaults anchored to the observed failure scale):
  - `CACHE_FIX_THINKING_RISK_WARN_TOKENS` (default ~250000)
  - `CACHE_FIX_THINKING_RISK_HIGH_TOKENS` (default ~340000)
  - `CACHE_FIX_THINKING_RISK_WARN_BLOCKS` / `_HIGH_BLOCKS` (defaults TBD from Phase 1)
  - `CACHE_FIX_THINKING_RISK=off` to disable entirely

### Risk model (starting point, to refine in Phase 2)

`high` when EITHER context_tokens ≥ high-tokens OR thinking_block_count ≥ high-blocks; `warn` at the lower thresholds; `ok` otherwise. Token-OR-block (not AND) because either dimension alone can carry the risk, and the cheap conservative bias is to warn early — a false "retire soon" is far cheaper than a dead session.

## Open questions (for AI Team Lead)

1. **Phasing** — ship measure + warn together (one minor), or land Phase 1 telemetry first to calibrate, then Phase 2 in a follow-up? Lean: separate, so thresholds are evidence-based. But that's two releases.
2. **Statusline ownership** — `quota-statusline.sh` is community-contributed (@schuay). A new risk segment touches it; coordinate or keep the signal in the per-session JSON only and let the statusline opt in later?
3. **Default thresholds** — anchor on the single observed incident (~382K / ~6,850 total), or hold defaults conservative and let Phase 1 data set them? The in-context block count at failure is the number we actually lack.
4. **Scope of "thinking_block_count"** — count only the latest request's blocks, or track session high-water? (Directive proposes both fields.)

## Out of scope

- **Fixing or working around the desync** — that's #63172, CC-side. cache-fix must not attempt to mutate/strip thinking blocks to "repair" a session (that path is exactly what #157 guards against). Warning only.
- **Auto-retiring / auto-clearing a session** — too aggressive; the operator decides. We warn, they act.
- **Cross-host aggregation** — single-host per-session state, consistent with the existing model.

## Version target

Minor — **v3.8.0** (new extension + new env vars + new statusline behavior). Per `docs/release-workflow.md`, AI Team Lead approves this directive's scope before implementation begins. If split into measure/warn phases, Phase 1 telemetry could ship as a smaller minor and Phase 2 as the next.
