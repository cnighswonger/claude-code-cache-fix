# Review: bootstrap-defense v3.7.1 implementation

Date: 2026-05-27
Reviewed: `b1aabdc` (`proxy/extensions/bootstrap-defense.mjs`, `test/proxy-bootstrap-defense.test.mjs`, `test/proxy-server-bootstrap.test.mjs`, `README.md`, `CHANGELOG.md`, `package.json`)
Label applied: `approved-by-codex-agent`

## What Is Correct

- The implementation matches the directive's schema-v2 contract. `recordShape` now carries `surface`, `prompt_key`, `prompt_value_hash`, `remote_mode`, and `stripped_keys`, and every append path I checked flows through those defaults correctly: `request_blocked`, baseline `response_audited`, null-body anomaly, and `upstream_error_audited`.
- Multi-surface emission is implemented the right way. `detectSurfaces()` distinguishes the legacy hardcoded key from the env-var-selected surface, the alias case still emits two records with distinct `surface` values, and per-surface hashes are computed before any allowlist mutation so the audit log preserves the original value identity.
- Allowlist mode mechanics are sound. `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS` cleanly separates unset vs explicit-empty vs comma-list inputs, only prompt-source-eligible keys are stripped, strip behavior is idempotent in the alias case, and `audit` / `block` semantics remain unchanged.
- Hash derivation matches the directive exactly: SHA-256 over UTF-8 input, lowercase hex digest, first 16 characters. The fixture-pinning test closes off the easy refactor failure mode.
- Documentation and versioning are aligned. `SCHEMA_VERSION`, `EXTENSION_VERSION`, `package.json`, `README.md`, and `CHANGELOG.md` all reflect the v3.7.1 contract consistently.
- Full suite passed on the reviewed head: 866/866.

## Blockers

None

## What Needs Attention

- Empty-string env-var semantics are still implied rather than pinned. The current implementation treats `CLAUDE_CODE_REMOTE=""` and `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE=""` as falsy/unset via truthiness checks. That is defensible, but the suite does not lock it down explicitly.
- The integration coverage proves end-to-end allowlist mutation on the wire, but not audit-mode multi-surface record count through the full server path. The unit suite already covers the emission contract well; this is a hardening gap, not a release blocker.

## Recommendations

- If the launcher/runtime ever needs to distinguish empty-string env vars from truly absent vars, add explicit tests before changing the truthiness checks.
- Add one end-to-end audit-mode multi-surface integration case in a follow-up if this path sees more future churn.

## Bottom Line

Approve. The implementation at `b1aabdc` satisfies the directive's substantive requirements, preserves the intended audit and defense behavior across all reviewed code paths, and is backed by a clean full-suite run.
