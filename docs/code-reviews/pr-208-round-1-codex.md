# Review: PR #208 security-hygiene scrub

Date: 2026-06-09
Reviewed: docs/release-workflow.md at afbd38c
Round: 1
Label applied: approved-by-codex-agent

## What Is Correct
- `docs/release-workflow.md:115` replaces the concrete npm credential path, org name, memory-note pointer, and rotation-cadence disclosure with a generic internal-notes reference while preserving the operational action: if `npm publish` fails on auth, ask Chris to rotate before retrying.
- `docs/release-workflow.md:175` preserves the same auth-failure procedure in the failure-mode list without naming the credential location or pointing readers at the memory entry.
- The surrounding workflow text still reads cleanly around both edits; I did not find any broken sentence or orphaned reference caused by the scrub.

## Blockers
None.

## What Needs Attention
- `docs/release-workflow.md:5`, `:47`, `:56`, `:127`, `:157`, and `:166` still contain internal-memory or internal-tooling discoverability references. I do not see any additional direct credential location, npm org, or rotation-cadence disclosure in those deferred lines, so they are follow-up scrub material rather than blockers for this narrow PR.

## Bloat / Non-Functional
None.

## Recommendations
- Merge this scrub, then land the broader discoverability cleanup separately as already noted in the PR context.

## Bottom Line
This PR removes the materially sensitive npm credential-location disclosure from the public release workflow while preserving the operator action needed when publish auth fails. I found no remaining blocker-level credential disclosure in this change scope.

— Codex review
