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
- Detect `allowed_warning` status + `surpassed-threshold` header presence on `onResponseStart`.
- Accumulate per-call usage tokens + per-call utilization snapshots in proxy memory.
- Compute a rolling burn rate (tokens/min, utilization-pct/hour) over a sliding window.
- Project hours-until-100% based on current burn rate.
- Emit a one-time warning per threshold crossing per Q5h window:
  - `[overage-warning] Q5h at X% (projected 100% in ~Y min). Continued burn at API rates ≈ $Z/hr. Plan upgrade path: <upgrade_plan options>.`
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

For cost projection at API rates:
- Use `usage-log.mjs`-style rate constants (input, cache_read, cache_creation, output). Define them in a shared `proxy/rates.mjs` module so both `usage-log` and `overage-warning` reference the same values.
- `tokens_per_min = (input_total + cache_creation_total) / window_minutes` (roughly — adjust if cache_read becomes the dominant cost line; see seanGSISG dataset)
- `cost_per_hr ≈ tokens_per_min * 60 * weighted_avg_rate`

If the window has fewer than 3 samples (e.g., proxy just restarted), suppress the projection and emit only the threshold-crossed message without `~Y min` and `≈ $Z/hr`. Document the warm-up requirement.

## Output format

### Stderr line (single warning)
```
[overage-warning] 2026-04-25T18:42:11Z Q5h=78% Q7d=82% (surpassed 0.75) — projected 100% in ~22 min, continued burn ≈ $4.10/hr at API rates. Upgrade paths: upgrade_plan, overage.
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
    "cost_per_hr_usd": 4.10,
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

- `CACHE_FIX_OVERAGE_WARNING=1` — opt-in, default off (consistent with usage-log, prefix-diff). The warning text is informational but the JSONL is a new file users may not expect.
- `CACHE_FIX_OVERAGE_WARNING_DIR` — override path for `overage-warnings.jsonl` (defaults to `~/.claude/`). Standard test-seam pattern.
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
14. **Concurrency**: parallel calls to the writer don't corrupt JSONL (atomic-append per write, similar to existing usage-log)

## Files modified / created

| File | Change |
|---|---|
| `proxy/extensions/overage-warning.mjs` | NEW — extension module |
| `proxy/rates.mjs` | NEW — shared rate constants for input/cache_read/cache_creation/output (extract from usage-log if rates already live there) |
| `proxy/extensions/usage-log.mjs` | MINOR — import rates from `proxy/rates.mjs` instead of inline constants (only if existing constants need to move) |
| `tests/overage-warning.test.mjs` | NEW — covers all test-plan items |
| `extensions.json` | Add `overage-warning` entry, default `enabled: false` |
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
- [ ] `extensions.json` default is `enabled: false`.
- [ ] README documents the new extension and links the issue.

## Out of scope (explicit)

- Plan-upgrade decision UI (calculate-and-show "upgrade vs overage" trade-off table) — needs design pass.
- Cross-window projection (e.g., "you'll hit Q7d in 3 days") — Q5h is the actionable signal; Q7d projection over days is noisy.
- Persisting warning state across proxy restarts — file-backed dedup is more code than it's worth at v3.2.0; restart resets state, document it.
- Status line integration — separate concern; consumer reads the JSONL.

— AI Team Lead
