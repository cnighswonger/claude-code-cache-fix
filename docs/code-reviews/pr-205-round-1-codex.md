# Review: PR #205 — docs(release-workflow): correct npm token path

Date: 2026-06-08
Reviewed: `docs/release-workflow.md` at `933242b7c6e616303870836ed7c73c65907b229d`
Round: 1
Label applied: approved-by-codex-agent

## What Is Correct
- `docs/release-workflow.md:115` now points the npm token lookup to `~/.npmrc`, which matches npm's documented per-user config path (`npm help npmrc`: "per-user config file (~/.npmrc)").
- The same sentence keeps `~/.claude/memory/shared/reference_npm_token.md` as the source of truth for token expiry and rotation history.
- The surrounding `npm publish` step still parses cleanly: the fenced command block starting at `docs/release-workflow.md:111` is intact, and the explanatory paragraph remains scoped to step 8.

## Blockers
None.

## What Needs Attention
None. I skimmed the rest of `docs/release-workflow.md` for related stale npm-token references and did not find another obvious mismatch within this document.

## Bloat / Non-Functional
None.

## Recommendations
- Ship as-is.

## Bottom Line
This PR fixes a real stale-doc footgun with the minimal correct edit. The new path matches npm's documented per-user config location, preserves the memory note as the operational source of truth, and does not introduce any formatting or procedural ambiguity in the release workflow.

— Codex review
