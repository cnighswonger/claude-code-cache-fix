# Review: PR #320 usage-log extended fields

Date: 2026-08-07
Reviewed: PR #320 at HEAD `0ea369983576b84512c85b64ccbd832e20674ae9`
Round: 1
Label applied: approved-by-codex-agent

## What Is Correct

The PR adds `ttl_tier` and `duration_ms` in the established staged-rollout pattern used by prior usage-log schema additions. Emission is default-off behind `CACHE_FIX_USAGE_LOG_EXTENDED=on`, and the comment in `proxy/extensions/usage-log.mjs` correctly names `claude-code-meter v0.9.1+` as the compatible consumer version without implying any runtime version probe.

The implementation keeps the timing source local to `usage-log` via `onRequest` and `onResponseStart`, computes a non-negative time-to-response-start only when both timestamps exist and are ordered, and omits the field otherwise. `assembleRecord` independently re-validates the schema boundary: `ttl_tier` is limited to `"5m"` or `"1h"`, and `duration_ms` must be an integer `>= 0`.

I independently verified the actual published npm tarball, not the meter repository: `npm pack claude-code-meter@0.9.1` contains `src/log/schema.mjs` with `ttl_tier: z.enum(["5m", "1h"]).optional()` and `duration_ms: z.number().int().min(0).optional()` on `MeterRowSchema`.

Coverage is proportionate to the change. The new block covers gate-off, gate-on, both enum values, missing optional sources, invalid enum, negative duration, non-integer duration, non-number duration, zero boundary, mixed valid/invalid emission, end-to-end gate-on, end-to-end gate-off, and missing timing hooks.

The synthetic cross-repo contract check imported `assembleRecord` from this PR and `MeterRowSchema` from the extracted published `claude-code-meter@0.9.1` tarball. Rows with both fields present, both fields absent, and `duration_ms: 0` were accepted. Rows carrying `null` for either optional field were rejected.

Info-hygiene check on the PR diff found no IPv4 literals, `visits-0[0-9]`, or `/home/manager`.

## Blockers

None.

## What Needs Attention

Human review is still required before merge because this is a load-bearing cross-repo wire-schema addition. That is process gating, not a code finding.

## Bloat / Non-Functional

None. The production change is small and follows the already-shipped `agent_id` pattern; the larger test addition is appropriate for a gated wire-schema change.

## Recommendations

Merge after Chris's required human review. Do not apply `ready-for-merge` solely from this LLM approval.

## Bottom Line

Approve. The implementation, tests, published meter schema, and comment wording all line up with the v0.9.1+ attestation contract.

Verification:

- `node --test test/proxy-usage-log.test.mjs` passed: 63/63.
- Published tarball check: `claude-code-meter@0.9.1` has both fields optional on `MeterRowSchema`.
- Synthetic tarball-schema validation: present / absent / zero rows accepted; null rows rejected.
- `node --test` passed after installing dependencies in the temporary review worktree: 1765 passed, 0 failed, 1 skipped.

— Codex review
