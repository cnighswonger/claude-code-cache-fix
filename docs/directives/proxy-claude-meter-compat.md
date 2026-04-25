# Directive: claude-meter compatibility with proxy mode

**Issue:** #70
**Branch:** `feature/claude-meter-compat`
**Stage:** directive
**Milestone:** v3.2.0

## Goal

Restore `claude-code-meter` functionality for users on CC v2.1.113+ (Bun binary) by repointing it from the broken NODE_OPTIONS preload at the existing `usage-log` JSONL stream the proxy already writes. Keep claude-meter's privacy and validation guarantees intact; eliminate the duplicate collection logic that no longer fires.

## Why

`claude-code-meter` was wired into the legacy CC wrapper via `NODE_OPTIONS="--import .../claude-meter/preload.mjs"`. CC v2.1.113+ ships as a Bun binary that ignores NODE_OPTIONS. Result: every modern CC install silently drops claude-meter rows. We've already pulled the broken README references in v3.1.0 (PR #71) so we stop promising a path that doesn't work; this directive does the actual fix.

The proxy already produces `~/.claude/usage.jsonl` via the `usage-log` extension (currently `enabled: false`). It captures most of what claude-meter needs from the same response stream. Refactoring claude-meter to consume from this file:

- Works for both Bun and Node CC installs
- Decouples claude-meter from CC's binary lifecycle entirely
- Eliminates duplicate fetch-patching logic
- Keeps the proxy as the single point of telemetry collection

## Scope (v3.2.0)

This directive spans **two repositories**:

### Repo 1: `claude-code-cache-fix` (this repo)

In scope:
- Extend `proxy/extensions/usage-log.mjs` to emit a superset record that includes every field claude-meter currently captures (model, requested_model, speed, service_tier, ephemeral_1h/5m split, qstatus, qoverage, qclaim, qfallback_pct, qoverage_util, qrepresentative_claim, hashed org_id, overage_disabled_reason, derived totals, q5h/q7d deltas, sid for session grouping).
- Update `usage-log` schema to match the same shape claude-meter validates with `MeterRowSchema` — the file becomes a canonical wire format both projects agree on.
- Document the new schema explicitly in `usage-log.mjs` as a comment block with the field list.
- Add an opt-in env var `CACHE_FIX_USAGE_LOG_PATH` to override the file path (already partly there as `CACHE_FIX_USAGE_LOG`; rename for clarity OR keep existing name with alias). Decision: **keep existing name**, no churn.
- Keep `enabled: false` default for v3.2.0. Document that enabling it is the gate for claude-meter ingestion.
- Update README to point claude-meter users at `CACHE_FIX_USAGE_LOG=1` as the integration path (or via `extensions.json` toggle).

Out of scope (this repo, this milestone):
- Making `usage-log` default-on. That's a v3.3.0 decision after we see real adoption and any disk-usage concerns surface.
- Removing the existing simpler 9-field record format. We change the record shape in-place; downstream consumers either upgrade to the new schema or pin an older version.

### Repo 2: `claude-code-meter` (separate repo)

In scope:
- New ingestion mode: read from `~/.claude/usage.jsonl` (path configurable) instead of via fetch-patch.
- Refactor `bin/claude-meter.mjs` to add a subcommand (e.g., `claude-meter ingest` or default behavior) that tails the proxy's JSONL.
- Validate every row through `MeterRowSchema` (existing) — proxy-emitted rows must pass the same validation. Fields the proxy doesn't yet emit (e.g., `web_search_requests`) become optional in `MeterRowSchema` or are emitted by the proxy as `0`.
- Track ingestion offset (e.g., `~/.claude/.claude-meter-ingest-offset`) so we don't re-process already-uploaded rows on restart.
- Deprecate `src/interceptor/preload.mjs` — keep the file with a notice for now (people may have it pinned in NODE_OPTIONS and deserve a friendly error), remove in next major.
- Update `package.json` exports — drop `./preload`.
- Update README — describe the new flow: install cache-fix proxy → enable usage-log → run `claude-meter` to ingest/share.

Out of scope (claude-meter, this milestone):
- Changes to the share/upload protocol. Same wire format, same validation, same endpoints. Only the ingestion source changes.
- New analytics features. Keep the change purely structural.

### Repo 3: wrapper script (`~/bin/claude` on each user host)

In scope (documented in cache-fix README, not committed code):
- Remove the legacy `NODE_OPTIONS="--import .../claude-meter/preload.mjs"` line for v2.1.113+ users.
- The cache-fix proxy is the only production wiring needed for usage capture going forward.

Not in this PR (this is local-host setup, not a versioned artifact).

## Schema reconciliation

Current proxy `usage-log` record (9 fields):
```
timestamp, model, input_tokens, output_tokens, cache_read_input_tokens,
cache_creation_input_tokens, q5h_pct, q7d_pct, peak_hour
```

claude-meter `MeterRowSchema` (24+ fields, see `src/log/schema.mjs`):
```
v, ts, sid, model, requested_model, model_mismatch, speed, service_tier,
input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
ephemeral_1h_input_tokens, ephemeral_5m_input_tokens, web_search_requests,
q5h, q7d, q5h_reset, q7d_reset, qstatus, qoverage, qclaim, qfallback_pct,
qoverage_util, qrepresentative_claim, org_id, overage_disabled_reason,
+ derived: q5h_delta, q7d_delta, total_input, cache_hit_rate
```

Target proxy `usage-log` record (canonical superset, schema-version 2):
```
v: 2,
ts: <ISO>,
sid: <8-char-hex>,                       // proxy session, regenerated on restart
model, requested_model, model_mismatch, speed, service_tier,
input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
ephemeral_1h_input_tokens, ephemeral_5m_input_tokens, web_search_requests,
q5h, q7d, q5h_reset, q7d_reset, qstatus, qoverage, qclaim, qfallback_pct,
qoverage_util?, qrepresentative_claim?, org_id?, overage_disabled_reason?,
q5h_delta, q7d_delta, total_input, cache_hit_rate,
peak_hour                                 // keep — useful proxy-side derived field
```

Optional fields (`?`) are present only when the source headers/data are present. Schema-validated by zod on the claude-meter side; proxy emits without validation but follows the contract documented in the source comment block.

**Schema versioning:** `v: 2` distinguishes the new superset record from anyone still reading old `v: 1` (preload-era) rows. claude-meter's reader handles both during a transition window.

## Implementation choice

For `usage-log.mjs`:
- Keep the existing extension contract (`order: 650`, `onStreamEvent`).
- Move record building to a pure exported function `buildRecord(meta, telemetry, responseHeaders)` that produces the v: 2 schema. Already half-extracted; finish the job.
- Add session ID generation at module scope (PID + load-time hash), sticky across the proxy run.
- Track previous q5h/q7d in module-scope vars to compute deltas. (Reset on proxy restart — same tradeoff as claude-meter's preload.)
- Atomic-append per write (existing `appendFile` is fine — small records, single-line, kernel guarantees atomicity for small writes).

For claude-meter:
- New module `src/ingest/jsonl-tailer.mjs` — reads usage.jsonl forward from a saved offset.
- Reuses existing `src/log/schema.mjs` validation.
- Reuses existing `src/share/` upload logic unchanged — feeds it validated rows.
- Bin entry adds `claude-meter ingest [--source <path>] [--once] [--watch]`.

## Test seam (cache-fix side)

Pure exports from `usage-log.mjs`:
- `buildRecord(meta, telemetry, responseHeaders, sessionId, prevQ5h, prevQ7d)` → record object
- `generateSessionId()` → string
- `parseAllHeaders(headers)` → all the qstatus/qoverage/etc. fields

Tests pass synthetic ctx/telemetry/headers. `CACHE_FIX_USAGE_LOG` env var is for runtime override only; tests pass `path` directly to a write helper.

## Test plan (cache-fix side)

1. **Schema correctness**: synthesized stream-event → record matches v:2 shape exactly
2. **Optional fields omitted when absent**: missing `org_id` header → `org_id` not in record
3. **Required fields zero when absent**: missing `web_search_requests` → field present as `0`
4. **Delta computation**: two consecutive calls → `q5h_delta` / `q7d_delta` reflect difference
5. **First-call deltas**: first call after restart → deltas are `0` (no prior)
6. **Session ID stability**: multiple calls → same `sid` within a process
7. **Session ID format**: matches `/^[0-9a-f]{8}$/` (claude-meter's regex)
8. **Cache hit rate**: `cache_read / total_input` computed correctly; `0` when total is `0`
9. **org_id hashing**: input `acct-abc123` → output is sha256 prefix, not the original
10. **Schema version**: every record has `v: 2`
11. **Backwards-compat note**: tests verify old consumers reading new records get extra fields they can ignore (forward-compat smoke test)
12. **Disabled**: env var off, extension config off → no file writes
13. **Concurrency**: parallel calls don't corrupt JSONL

## Test plan (claude-meter side — for the separate PR)

Will be detailed in the claude-meter repo's own directive. Outline:
1. Tailer reads valid usage.jsonl rows
2. Tailer rejects (and logs) invalid rows without crashing
3. Offset persists across restarts; no double-ingestion
4. Backward-compat with v:1 records (transition window)
5. Watch mode picks up appended rows in <1s
6. Once mode reads to current EOF and exits

## Files modified / created

### `claude-code-cache-fix` (this PR)

| File | Change |
|---|---|
| `proxy/extensions/usage-log.mjs` | EXPAND record to v:2 superset schema; extract pure functions; add sessionId + delta tracking |
| `tests/usage-log.test.mjs` | NEW (or expand existing) — 13 cases per test plan |
| `extensions.json` | Confirm `enabled: false` default; add comment pointing at claude-meter integration |
| `README.md` | Document v:2 schema; add claude-meter integration instructions |
| `docs/directives/proxy-claude-meter-compat.md` | THIS file |

### `claude-code-meter` (separate PR in that repo)

| File | Change |
|---|---|
| `src/ingest/jsonl-tailer.mjs` | NEW |
| `src/log/schema.mjs` | Mark `web_search_requests` and other proxy-not-yet-emitting fields optional; add v:2 acceptance |
| `bin/claude-meter.mjs` | Add `ingest` subcommand |
| `src/interceptor/preload.mjs` | Add deprecation notice |
| `package.json` | Drop `./preload` export |
| `README.md` | Rewrite integration section |

## Reviewer checklist (cache-fix side)

- [ ] v:2 schema documented as a source-comment block in `usage-log.mjs`
- [ ] All claude-meter fields covered by the proxy where data is available
- [ ] Optional vs required fields match `MeterRowSchema` constraints
- [ ] Pure functions exported for testing; default export remains the extension contract
- [ ] No request mutation
- [ ] sessionId regex matches `/^[0-9a-f]{8}$/`
- [ ] org_id is hashed (sha256 prefix), never raw
- [ ] Tests pass on Node 18, 20, 22 (CI matrix)
- [ ] `extensions.json` default remains `enabled: false`
- [ ] README documents the schema change AND the claude-meter integration path
- [ ] Existing 9-field consumers handled with a CHANGELOG note (v:1 → v:2 is a breaking change for anyone parsing the old shape)

## Out of scope (explicit)

- **Default-enabling `usage-log`** — defer to v3.3.0 once adoption pattern is clear.
- **claude-meter share-protocol changes** — wire format and endpoints unchanged.
- **Real-time ingestion** beyond watch-mode polling. JSONL append is the boundary; if we need true streaming later, that's a different design.
- **Backfill of historical preload-written `~/.claude/claude-meter.jsonl` data** — already collected data is what it is; this directive doesn't migrate it.
- **The dangerous-command filter** from the security doc — separate proposal.

— AI Team Lead
