# Review: Implementation: microcompact cache stability

Date: 2026-04-30
Reviewed: `ac0eab9` (`proxy/extensions/microcompact-stability.mjs`, `test/proxy-microcompact-stability.test.mjs`, docs updates)
Label applied: `reviewed-by-codex-agent`, `approved-by-codex-agent`

## What Is Correct

- The blocker is closed in the implementation. Custom Mode B prefixes are now first-class input via `CACHE_FIX_MICROCOMPACT_SENTINEL_PREFIX_<N>`, collected by `getCustomPrefixes()`, threaded through `runMicrocompactStability()`, and consulted by `isPartialMatch()` after the built-in sentinel prefix check ([proxy/extensions/microcompact-stability.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/microcompact-stability.mjs:67), [proxy/extensions/microcompact-stability.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/microcompact-stability.mjs:131), [proxy/extensions/microcompact-stability.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/microcompact-stability.mjs:154), [proxy/extensions/microcompact-stability.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/microcompact-stability.mjs:350)).
- Test `5b` now exercises a real custom-family Mode A exact match that does not share the built-in prefix, so the custom exact-match path is directly covered ([test/proxy-microcompact-stability.test.mjs](/home/manager/git_repos/claude-code-cache-fix/test/proxy-microcompact-stability.test.mjs:239)).
- Test `5c` covers the missing custom-family Mode B path: the variant body is left byte-identical even with normalization enabled, `partial_matches.length === 1`, `exact_matches.length === 0`, `sentinel_text` is not persisted, and the redacted prefix starts with the custom family prefix ([test/proxy-microcompact-stability.test.mjs](/home/manager/git_repos/claude-code-cache-fix/test/proxy-microcompact-stability.test.mjs:267)).
- The docs now describe the additional env-var family and the explicit pair-with-pattern rationale consistently across the user-facing surfaces ([README.md](/home/manager/git_repos/claude-code-cache-fix/README.md:438), [docs/extension-impact-guide.md](/home/manager/git_repos/claude-code-cache-fix/docs/extension-impact-guide.md:186), [docs/monitoring.md](/home/manager/git_repos/claude-code-cache-fix/docs/monitoring.md:125)).
- The full local suite passes at the new expected count: `628` tests, `0` failures.

## Blockers

None

## What Needs Attention

- The implementation intentionally collects custom patterns and custom prefixes independently rather than pairing by numeric suffix. That matches the PR’s documented design rationale and is acceptable here, but it should stay explicit in future docs and tests because the env-var family names can otherwise imply index-based pairing.

## Recommendations

- Keep test `5c` as the regression guard for this contract. It is the test that proves the approved custom-family Mode B behavior, not just the presence of the new env var.

## Bottom Line

Approve for implementation stage. The re-review target at `ac0eab9` fixes the only blocking defect from `6caf05b`: custom sentinel families now have a real Mode B redacted-capture path, the new regression tests prove both the custom exact-match and custom prefix-only variants, the docs describe the contract accurately, and the full suite passes locally at `628/628`.
