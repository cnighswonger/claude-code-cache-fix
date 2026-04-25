# Directive: Overage cost warning extension

**Issue:** #47
**Branch:** `feature/overage-cost-warning`
**Stage:** directive
**Milestone:** v3.2.0

## Goal

When Anthropic's response headers indicate the user is approaching or has crossed the overage threshold, surface a user-friendly warning that quantifies the cost trajectory and the alternatives. The proxy is the right place to do this because Anthropic's headers suggest the action (`upgrade-paths: upgrade_plan,overage`) but provide no cost context for that decision.

## Why

At today's multi-agent burn rates, a Max 5x user can cross the Q5h ceiling well before the 5-hour window resets. Once the overage state is `allowed`, every subsequent token bills at API rates — typically 2.4x the cost ratio of plan tokens once adaptive thinking is in play. Most users discover this only when they get the overage invoice. The proxy already sees every response header; it can see the `surpassed-threshold` headline before the user does, and it can carry burn-rate state across calls to project hours-to-overage.

This is **advisory only**. No request mutation. The user's actions are theirs to choose.

## Scope (v3.2.0)

In scope:
- New extension `overage-warning.mjs` (or extend `cache-telemetry.mjs` — see "Implementation choice" below).
- Detect `allowed_warning` status + `surpassed-threshold` header presence on `onResponseStart` (latches eligibility).
- Accumulate per-call usage tokens + per-call utilization snapshots in proxy memory across the stream lifecycle.
- Compute a rolling burn rate (tokens/min, utilization-pct/hour) over a sliding window.
- Project minutes-until-100% based on current burn rate.
- Emit a one-time warning per threshold crossing per Q5h window:
  - `[overage-warning] Q5h at X% (projected 100% in ~Y min). Estimated continued burn at API rates ≈ $Z/hr (coarse). Plan upgrade path: <upgrade_plan options>.`
- Write the warning to stderr (visible in proxy journal/logs) AND to a structured JSON record at `~/.claude/overage-warnings.jsonl` for downstream consumption (status line, dashboards, claude-meter, etc.).

Out of scope (deferred):
- Status line integration — that's a CC-side change and lives in the user's wrapper or status-line script. We expose the JSONL; consumers wire it.
- Plan-upgrade calculator UI — text only for v3.2.0.
- Persistence of accumulated state across proxy restarts. In-memory only; restart resets the window. Document this clearly.

## Implementation choice

Two options:

1. **Extend `cache-telemetry.mjs`** — already parses every response header and persists `~/.claude/quota-status.json`. Adding a sibling `overage-warnings.jsonl` writer is a small delta and reuses the parsing.
2. **New `overage-warning.mjs` extension** — keeps cache-telemetry focused on its current job (quota snapshot persistence), and isolates the burn-rate state machine in its own module.

**Decision:** new extension. `cache-telemetry` is a single-responsibility persister of the latest snapshot; the overage warning is a stateful watcher (rolling window, one-time-per-threshold emit, projection math). Mixing them would make `cache-telemetry`'s state model harder to reason about. The new extension can read the same headers — the parsing is cheap.

Order: 610 (immediately after cache-telemetry at 600, so cache-telemetry's persistence happens first; overage-warning then runs against the same response with both header data and cache stats already on `ctx.meta`).

## Activation model

This directive uses the **`prefix-diff` pattern**: `enabled: true` in `extensions.json` (so the module is always loaded) plus an internal env-var gate that no-ops the extension when the user hasn't opted in. Codex review of the previous draft caught that the alternative — `enabled: false` plus an env var — cannot work because a disabled extension is never loaded by `proxy/pipeline.mjs`.

Concretely:
- `extensions.json` ships with `overage-warning: { enabled: true }`.
- The extension's hook bodies short-circuit on the very first line if `process.env.CACHE_FIX_OVERAGE_WARNING !== "1"`.
- No file is created, no state is allocated, no warning is emitted unless the env var is set.

This is identical to how `prefix-diff` is wired (`enabled: true` in config, gated on `CACHE_FIX_PREFIXDIFF=1`). It keeps the user-facing toggle a one-line shell export instead of a JSON edit.

## Hook lifecycle

Detection eligibility is captured early; emission happens once we have enough sample data. The flow:

| Hook | Action |
|---|---|
| `onResponseStart(ctx)` | If env-gate off → return. Read response headers (already parsed by `cache-telemetry` into `ctx.meta._quotaData` at order 600). Compute trigger eligibility (status + `surpassed-threshold` + dedup check). If eligible → set `ctx.meta._overageWarning = { eligible: true, trigger, snapshot }`. If not eligible → no-op. |
| `onStreamEvent(ctx)` for `event.type === "message_start"` | If env-gate off → return. Push input/cache token sample into the module-scope rolling window using `event.message.usage`. |
| `onStreamEvent(ctx)` for `event.type === "message_delta"` | If env-gate off → return. Push output token sample into the rolling window using `event.usage`. Then: if `ctx.meta._overageWarning?.eligible && !ctx.meta._overageWarning?.emitted` → compute projection from the window, emit the warning (stderr + JSONL), set `ctx.meta._overageWarning.emitted = true`, and record the dedup-key in module-scope state so the same threshold doesn't fire again in this Q5h window. |

**Single emission per response.** The `emitted` flag on `ctx.meta._overageWarning` prevents multiple `message_delta` events in the same response from causing duplicate writes. The module-scope dedup state (keyed by `(threshold, q5h_resets_at)`) prevents the same threshold from firing again across responses within the same Q5h window.

**Warm-up.** If the rolling window has fewer than 3 samples when `message_delta` fires, the projection fields are emitted as `null` and the stderr line falls back to the reduced format (no `~Y min`, no `≈ $Z/hr`). The warning still fires — the trigger crossed; the operator deserves to know — just without forward-looking math.

## Detection rules

Trigger candidates from the response headers (already extracted by `cache-telemetry.parseHeaders`):

| Field | Meaning | Use |
|---|---|---|
| `anthropic-ratelimit-unified-status` | overall throttle state — values include `allowed`, `allowed_warning`, `throttled` | Trigger gate: emit only when `allowed_warning` or `throttled` |
| `anthropic-ratelimit-unified-7d-surpassed-threshold` | numeric (e.g., `0.75`) — the threshold the 7d quota has crossed | Confirms we're in the warning regime |
| `anthropic-ratelimit-unified-overage-status` | `allowed`, `not_allowed`, `unknown` — whether overage spend is enabled | Affects message wording (`upgrade vs cap`) |
| `anthropic-ratelimit-unified-upgrade-paths` | comma-separated (`upgrade_plan,overage`) | Direct quote in warning text |
| `anthropic-ratelimit-unified-5h-utilization` | 0.0–1.0 | Current Q5h burn for projection |
| `anthropic-ratelimit-unified-5h-reset` | unix timestamp | Time-to-reset for projection window |

A warning event is generated when ALL of:
1. Status is `allowed_warning` OR `throttled`
2. `surpassed-threshold` header is present and non-empty
3. We have not yet emitted a warning for this threshold in this Q5h window (one-time-per-threshold-per-window dedup)

## Burn-rate calculation

Maintain in proxy memory a sliding window of `(timestamp, q5h_utilization, total_input_tokens, total_output_tokens)` samples. Window size: last 15 minutes, capped at 60 samples (whichever is smaller).

Per call on `onStreamEvent` for `message_delta`:
- Push the latest `(now, q5h_util, inputTokens, outputTokens)` from `ctx.meta.cacheStats`.
- Drop samples older than 15 min.

On warning trigger:
- `delta_util = newest_util - oldest_util`
- `delta_min = (newest_t - oldest_t) / 60_000`
- `util_per_min = delta_util / delta_min` (bounded at 0 if negative — utilization can decrease as old usage rolls off)
- `min_to_100 = (1.0 - newest_util) / util_per_min` (or `null` if `util_per_min <= 0`)

For cost projection at API rates (v3.2.0 — coarse estimate, explicitly labeled):

The directive does NOT ship a precise per-token pricing engine in v3.2.0. Anthropic's published per-token rates vary by model, by cache tier (read vs write vs ephemeral_1h vs ephemeral_5m), and by overage classification. Encoding all of that correctly is its own subproject.

Instead, v3.2.0 ships a **coarse burn estimate**:

```
weighted_token_cost_usd = $0.000005     # heuristic blend covering input + cache_read + output at typical Opus mix
tokens_per_min          = (input_total + cache_creation_total + output_total) / window_minutes
cost_per_hr_usd_coarse  = tokens_per_min * 60 * weighted_token_cost_usd
```

The constant `weighted_token_cost_usd` lives in a new `proxy/rates.mjs` module with an explanatory comment block ("This is a deliberate over-simplification for v3.2.0; refine in v3.3.0"). The stderr line and JSONL record both label this number with the word `coarse` so users don't take it as a precise quote.

A precise per-tier cost engine is filed as a follow-up for v3.3.0.

The warm-up rule (described in **Hook lifecycle** above) governs when the projection is suppressed: fewer than 3 samples → emit `null` for both `min_to_100` and `cost_per_hr_usd_coarse`; the threshold-crossed warning still fires.

## Output format

### Stderr line (single warning)
```
[overage-warning] 2026-04-25T18:42:11Z Q5h=78% Q7d=82% (surpassed 0.75) — projected 100% in ~22 min, estimated continued burn ≈ $4.10/hr at API rates (coarse). Upgrade paths: upgrade_plan, overage.
```

### Stderr line (warm-up — fewer than 3 samples)
```
[overage-warning] 2026-04-25T18:42:11Z Q5h=78% Q7d=82% (surpassed 0.75) — projection unavailable (warming up). Upgrade paths: upgrade_plan, overage.
```

### `~/.claude/overage-warnings.jsonl` (one JSON object per line)
```json
{
  "ts": "<ISO>",
  "trigger": {
    "status": "allowed_warning",
    "surpassed_threshold": 0.75,
    "overage_status": "allowed",
    "upgrade_paths": ["upgrade_plan", "overage"]
  },
  "snapshot": {
    "q5h_pct": 78,
    "q7d_pct": 82,
    "q5h_resets_at": 1712345678
  },
  "projection": {
    "min_to_100": 22,
    "tokens_per_min": 14500,
    "cost_per_hr_usd_coarse": 4.10,
    "window_samples": 47,
    "window_minutes": 14
  }
}
```

If projection fields are unavailable (warm-up), emit them as `null` rather than omitting — keeps the schema stable for consumers.

## Dedup / once-per-threshold semantics

In-memory state per Q5h window (keyed by `q5h_resets_at`):
- Set of thresholds we've already warned at: `{0.75, 0.90, 0.95, 1.00}` etc.
- When a warning fires, record the threshold value in the set.
- Window expires when `q5h_resets_at` changes (new window = new dedup state).

Don't try to be clever about partial overlap (e.g., 0.78 vs 0.80) — Anthropic emits discrete `surpassed-threshold` values, so use what they emit verbatim as the dedup key.

## Env vars

- `CACHE_FIX_OVERAGE_WARNING=1` — runtime activation gate (matches `prefix-diff` pattern). When unset, the extension is loaded but every hook returns immediately on the first line. No file is created, no state is allocated.
- `CACHE_FIX_OVERAGE_WARNING_DIR` — override path for `overage-warnings.jsonl` (defaults to `~/.claude/`). Runtime override only.
- `CACHE_FIX_OVERAGE_WARNING_QUIET=1` — suppress stderr emission, keep JSONL. For users who want programmatic-only consumption.

No env var for window size or threshold tuning in v3.2.0 — keep the surface small. If users complain, add them in v3.2.1.

## Test seam

Per the established pattern (image-strip, prefix-diff, deferred-tools-restore):
- Export pure functions alongside `default`:
  - `parseTriggerFromHeaders(headers)` → `{ shouldWarn: bool, threshold, status, ... }`
  - `computeProjection(samples, now)` → `{ min_to_100, tokens_per_min, ... }`
  - `dedupKey(threshold, q5h_resets_at)` → string
  - `formatStderrLine(record)` → string
  - `formatJsonlRecord(trigger, snapshot, projection)` → object
- Tests call pure functions with their own contexts. Use `CACHE_FIX_OVERAGE_WARNING_DIR` env var **only as a runtime override**, not as a test isolation mechanism — tests pass a `dir` option to the writer function directly.

## Test plan

Minimum coverage:

1. **Trigger detection**: `allowed_warning` + `surpassed=0.75` → trigger fires
2. **No trigger**: `status=allowed`, no `surpassed-threshold` → no fire
3. **Throttled**: `status=throttled` → fires (treats throttled same as warning)
4. **Dedup within window**: same threshold twice in same Q5h window → fires once
5. **New window**: threshold fires in window A, then again in window B → fires twice
6. **Higher threshold in same window**: 0.75 fires, then 0.90 fires (different threshold) → both fire
7. **Projection math**: synthesized samples → assert `min_to_100` matches expected
8. **Projection warm-up**: <3 samples → projection fields null, line still emits
9. **Decreasing utilization**: util_per_min ≤ 0 → projection null, line still emits
10. **JSONL append**: file is append-only, multiple events readable as JSONL
11. **Quiet mode**: `CACHE_FIX_OVERAGE_WARNING_QUIET=1` → no stderr, JSONL still written
12. **Disabled**: `CACHE_FIX_OVERAGE_WARNING` unset → extension is no-op, no file created
13. **Header absence**: missing `surpassed-threshold` even with `allowed_warning` → no fire (one of the trigger gates)
14. **Concurrency**: parallel calls to the writer don't corrupt JSONL. The writer must use the same single-syscall append pattern that `usage-log` uses (`fs.promises.appendFile` writing the full record + trailing newline as one buffer). The kernel's `O_APPEND` semantics guarantee record-level atomicity for writes under `PIPE_BUF` (4096 bytes on Linux); each emitted record is well under that bound. Test by spawning 50 parallel writes and asserting the resulting file has exactly 50 well-formed JSON lines with no truncation or interleaving.

## Files modified / created

| File | Change |
|---|---|
| `proxy/extensions/overage-warning.mjs` | NEW — extension module |
| `proxy/rates.mjs` | NEW — shared rate constants for input/cache_read/cache_creation/output (extract from usage-log if rates already live there) |
| `proxy/extensions/usage-log.mjs` | MINOR — import rates from `proxy/rates.mjs` instead of inline constants (only if existing constants need to move) |
| `test/overage-warning.test.mjs` | NEW — covers all test-plan items |
| `extensions.json` | Add `overage-warning` entry, `enabled: true` (extension is always loaded; runtime gated by `CACHE_FIX_OVERAGE_WARNING=1`) |
| `README.md` | Document new extension + env vars in the extensions table |

## Reviewer checklist

- [ ] Pure functions exported for testing; default export remains the extension contract.
- [ ] No request mutation — `onResponseStart`/`onStreamEvent` only read from `ctx`.
- [ ] In-memory state cleanly bounded (window cap, dedup set per window).
- [ ] One-time-per-threshold-per-window dedup verified.
- [ ] Stderr emission has consistent prefix (`[overage-warning]`) for grep-ability.
- [ ] JSONL writes are atomic-append, never partial-write a record.
- [ ] All env vars follow the `CACHE_FIX_OVERAGE_WARNING*` naming pattern.
- [ ] No new top-level dependencies.
- [ ] Tests pass on Node 18, 20, 22 (CI matrix).
- [ ] `extensions.json` entry has `enabled: true`; runtime gated by `CACHE_FIX_OVERAGE_WARNING=1` (matches `prefix-diff` pattern).
- [ ] When `CACHE_FIX_OVERAGE_WARNING` is unset, the extension hooks return on the first line — no file created, no state allocated.
- [ ] Tests live under `test/`, not `tests/`.
- [ ] Cost-per-hour number is labeled `coarse` in stderr line, JSONL field, and source comments.
- [ ] README documents the new extension and links the issue.

## Out of scope (explicit)

- Plan-upgrade decision UI (calculate-and-show "upgrade vs overage" trade-off table) — needs design pass.
- Cross-window projection (e.g., "you'll hit Q7d in 3 days") — Q5h is the actionable signal; Q7d projection over days is noisy.
- Persisting warning state across proxy restarts — file-backed dedup is more code than it's worth at v3.2.0; restart resets state, document it.
- Status line integration — separate concern; consumer reads the JSONL.

— AI Team Lead
