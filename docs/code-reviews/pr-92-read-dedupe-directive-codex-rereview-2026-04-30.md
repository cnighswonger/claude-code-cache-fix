# Review: read-dedupe directive rereview

Date: 2026-04-30
Reviewed: `docs/directives/proxy-read-dedupe.md`
Label applied: `reviewed-by-codex-agent`, `plan-approved`

## What Is Correct

- The prior byte-stability blocker is resolved. The directive now preserves the first occurrence and rewrites later duplicates to point at that fixed keeper, which makes prior pointer bytes stable as new duplicates arrive ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:21), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:23), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:124)).
- The cache-impact section now matches that FIRST-keeper contract. It correctly narrows the cost to one cache miss per newly added duplicate, with no cascading churn across older pointer positions ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:146)).
- The mixed-array keying blocker is resolved conservatively and correctly. Eligible content is now restricted to raw strings and single-element text-only arrays; multi-element arrays, non-text items, and missing content are skipped at detection instead of being keyed from partial text ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:75), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:89), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:136)).
- Telemetry now exposes the new skipped-shape counter `read_tool_results_skipped_mixed_array`, which is the right way to keep the v1 contract conservative while still measuring whether the restriction costs meaningful coverage ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:104), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:177)).
- The test plan covers the newly important stability and eligibility cases: Tests 3a, 3b, and 20a prove pointer stability as duplicates accumulate, while Tests 16, 16a, and 16b lock in the skip behavior for ineligible array shapes ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:281), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:298), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:306)).
- The reviewer checklist was updated to reflect the actual gate conditions for implementation review: FIRST-keeper stability and the narrowed eligibility contract are both called out explicitly. The previously correct items also remain intact: `enabled: true` plus runtime gate, order `380`, and the null-byte-separated key formula are unchanged ([docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:52), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:79), [docs/directives/proxy-read-dedupe.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-read-dedupe.md:329)).

## Blockers

None.

## What Needs Attention

None.

## Recommendations

- Carry the FIRST-keeper rule and the eligibility restriction through implementation exactly as written. Those are the correctness boundaries that make the cache and byte-stability claims defensible.
- Keep the new skip counter visible in implementation review and sim validation. If real traffic ever shows meaningful skipped mixed-array volume, revisit with a canonical full-payload key rather than relaxing back to text-only keying.

## Bottom Line

Approve for directive stage. The two earlier blockers are fixed in the directive, the cache-impact reasoning now matches the replacement contract, mixed-array false positives are eliminated by restricting eligibility, and the test/checklist surface is updated to enforce those decisions during implementation.
