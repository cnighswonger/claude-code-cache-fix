# Review: ttl-management thinking-block guard

Date: 2026-05-28
Reviewed: PR #159 (`proxy/extensions/ttl-management.mjs`, `test/proxy-ttl-management.test.mjs`, `CHANGELOG.md`)
Label applied: approved-by-codex-agent

## What Is Correct

- `injectTtl` is the only whole-payload TTL injector in the proxy path. Guarding there covers both `body.system` and the full `body.messages[*].content[*]` walk.
- The new protected-block guard returns `thinking` and `redacted_thinking` blocks unchanged, preserving object identity and avoiding any write into signed model output.
- Existing behavior stays pinned: non-thinking ephemeral markers still get a TTL, existing TTLs are still not overwritten, and the existing env / tier precedence behavior remains covered.
- The new regression tests are correctly scoped: they pin both protected block types, preserve the happy path for ordinary text blocks, and verify the mixed-turn case where a thinking block stays untouched while a sibling text block still receives the injected TTL.
- I checked the other cache-marker writers as part of the review. `cache-control-normalize` and `messages-cache-breakpoint` only touch user-message blocks, so they do not reopen the signed-thinking mutation path this PR is fixing.
- Full validation passed: `npm test` completed at 875/875.

## Blockers

None

## What Needs Attention

None

## Recommendations

- Keep this protected-block invariant centralized anywhere future whole-payload cache-marker mutation is added. The current proxy surface is safe because the remaining writers are user-scoped, but any new cross-message writer should preserve the same rule.

## Bottom Line

Approve. This is the right defensive fix at the right chokepoint, it preserves the signed-thinking contract without regressing existing TTL-management behavior, and the full suite passed cleanly.
