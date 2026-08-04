# Review: PR #300

Date: 2026-08-04
Reviewed: `AGENTS.md` at `7053366daa60180f6267744fed68a63281a5cf46`
Round: 2
Label applied: changes-requested

## What Is Correct
- Measured: the revised CI table in `AGENTS.md:140-154` is materially better than round 1 and its cells match the GitHub artifacts I checked. `gh api repos/cnighswonger/claude-code-cache-fix/commits/<sha>/check-runs` shows `82c9f27e` had `test (18)` / `test (20)` cancelled at `11:06Z`, `4a32d142` had `test (18)` / `test (20)` still `in_progress` at the two approval times `16:39Z` and `17:18Z`, and `5e6a2e04` had all three test jobs completed successfully by `17:56Z` before the two approvals at `19:13Z` and `19:18Z`.
- Measured: the narrower CI prose at `AGENTS.md:149-154` now tracks that table instead of repeating the false “every approval” claim from round 1. I confirmed six approval events on PR #296 via `gh api repos/cnighswonger/claude-code-cache-fix/pulls/296/reviews --paginate`.
- Read: the third row does not undercut the rule. Keeping one compliant head in the example helps because it shows the contrast the rule is trying to enforce rather than leaving the section as a pile of failures with no positive comparator.
- Measured: PR #300 itself is reviewable on this head. `gh pr checks 300 --repo cnighswonger/claude-code-cache-fix` is green on `7053366d`, and `gh api graphql` for review threads returned no open threads to resolve.

## Blockers
- Read + Measured: `AGENTS.md:275-287` still makes two artifact claims that the written review record does not support. First, “**no round's written findings mention the Bun switch**” is false as written against the review bodies you are invoking: the approved PR #296 review at `5e6a2e04` says the head “adds the missing Bun/BoringSSL veto.” Second, “**No round's findings quote or answer it**” is not safe: PR #283 round 1 explicitly says the new tests “verify the guard against real TLS authorization outcomes,” which is at least an attempted answer to the comment’s “Only a handshake shows that” limitation, even if it later proved to be the wrong oracle. `quote` is grep-able; `answer` is both semantic and, on this record, substantively false. Because this section is itself a rule about falsifiable claims, it needs another wording pass that stays inside what the review texts demonstrably say.

## What Needs Attention
- Read: if you want to preserve the point, I would split the current sentence into claims with different evidence standards. “No #283 review body mentions the Bun switch” is cheaply checkable. “No round quoted the launcher comment” is also checkable. The broader “or answer it” formulation is where the evidence slips.

## Bloat / Non-Functional
- None. The delta is a tight wording correction in one document, and the retained table is proportionate because it replaces an earlier incorrect universal claim with inspectable evidence.

## Recommendations
- Replace `AGENTS.md:275-287` with phrasing limited to the artifacts you can actually cite, for example by separating “did not mention the Bun switch” from the weaker claim that the reviews reasoned from the guard/tests rather than from the project-history context.
- Keep the third CI row. It strengthens the section by showing the compliant case on the same PR timeline.

## Bottom Line
Revise once more. The round-1 blockers about the CI example and reviewer mental-state assertions are mostly fixed, and the CI table now stands up to direct verification. But one replacement paragraph still overstates what the historical review bodies did not say, in exactly the document that tells reviewers not to do that. I would merge this after one more tightening pass on `AGENTS.md:275-287`, not before.

— Codex review
