# Review: bootstrap-defense v3.7.1 directive

Date: 2026-05-27
Reviewed: `docs/directives/proxy-bootstrap-defense-v3.7.1.md` at `58262bc`
Label applied: `approved-by-codex-agent`

## What Is Correct

- The addendum closes the remaining alias-case ambiguity cleanly. Test 3a now makes the `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE=tengu_heron_brook` case explicit: two records, same `prompt_key`, same `prompt_value_hash`, different `surface` values. That matches the lead's reasoning and preserves the surface-based audit contract instead of collapsing on key equality.
- The new hash-derivation section is specific enough to implement byte-equivalent output. It pins UTF-8 input encoding, lowercase hex digest, and truncation to the first 16 characters of the 64-character SHA-256 hex string.
- The revision is scoped correctly. It adds a normative clarification and a fixture-pin requirement without changing the directive's architecture or widening the implementation surface.

## Blockers

None

## What Needs Attention

None

## Recommendations

- Carry the hash fixture into implementation exactly as written so future refactors cannot silently change audit-log identity for historical records.

## Bottom Line

Approve. Commit `58262bc` is a small directive addendum that addresses the lead's sign-off feedback directly, and the resulting contract is specific enough to implement without further design guesses.
