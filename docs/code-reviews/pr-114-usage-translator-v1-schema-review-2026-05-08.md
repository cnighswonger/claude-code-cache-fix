# Review: usage-to-dashboard translator v:1 schema fallback

Date: 2026-05-08
Reviewed: PR #114 (`fix: usage-to-dashboard translator handles both preload + v:1 schemas (#112, v3.5.3)`)
Label applied: reviewed-by-codex-agent

## What Is Correct

- `translateRecord()` now accepts either `entry.timestamp` or `entry.ts`, which directly fixes the `if (!entry.timestamp) return null` regression that dropped every proxy `usage-log` row.
- Timestamp precedence is correct and internally consistent. The translator uses `entry.timestamp || entry.ts` once, then reuses that value for `ts_start`, `ts_end`, and `req_id`, so preload-era rows keep their legacy semantics while hybrid rows stay deterministic.
- Quota-header reconstruction is correct for both schemas. Legacy `q5h_pct` / `q7d_pct` values are divided by 100, v:1 `q5h` / `q7d` values are passed through verbatim, and the legacy fields take precedence when both are present.
- `req_id` remains stable across schemas for the same logical request because both code paths now normalize onto the same timestamp source and still use the same model-suffix rule. The new parity test proves preload and v:1 rows dedup to the same id.
- The new module-entry guard works on Linux for the intended invocation path. Importing `translateRecord` from tests no longer auto-runs the CLI, and a direct repo-root run of `node tools/usage-to-dashboard-ndjson.mjs --input <tmp> --stdout` executed batch mode successfully.
- The v:1 fixture is aligned with `proxy/extensions/usage-log.mjs:assembleRecord` for every field the translator reads: `ts`, `model`, token counts, `ephemeral_*`, `q5h`, and `q7d` all match the writer's names and types. The fixture also includes the surrounding writer-emitted fields (`v`, `sid`, `speed`, `service_tier`, resets, status fields, deltas, `cache_hit_rate`) so the test data reflects a real writer row rather than an invented minimal shape.
- Test coverage is adequate for this fix. The 16 new tests cover the original entry-guard failure, timestamp mapping, header reconstruction for both schemas, hybrid-row precedence, deterministic `req_id`, and full translated-record parity across schemas.
- Release metadata is accurate. `package.json` bumps to `3.5.3`, the changelog description matches the actual regression and fix, credits the reporter, and the suite count math is correct: `772 -> 788 (+16)`.

## Blockers

None

## What Needs Attention

None

## Recommendations

- Keep the translator fixture keyed to `assembleRecord()` whenever the usage-log schema evolves. This test file is now the regression tripwire for the documented dashboard bridge, so drift between writer and fixture would weaken the protection it just added.

## Bottom Line

Ship it. The patch is small, directly addresses the actual schema mismatch in #112, preserves back-compat for preload-era rows, keeps dedup behavior stable across upgrades, and adds focused regression coverage that meaningfully protects the documented dashboard integration path.
