# Review: PR 142 README slash-command bleed note

Date: 2026-05-25
Reviewed: PR #142 / `README.md` / commit `b33e3efc2f212f2f890e2a6e228bf28e60eec967`
Label applied: approved-by-codex-agent

## What Is Correct

- Placement is right. This warning belongs with the existing operational guidance in `README.md`, not in the preload quick-start path.
- The current wording is appropriately scoped to the evidence. It anchors on `#49335` for `/context` and `/release-notes`, and it now treats the broader command class as a qualified inference rather than asserting `/mcp` as a confirmed case.
- The factual content holds up against upstream sources: `/context` inflation is independently reported in `anthropics/claude-code#49335` and `#61907`, `/release-notes` has a direct report in `#44808`, and the README's `+3,480` measured delta plus separate `~5K` anecdote match the issue history.
- The local-audit warning is directionally correct, and the proxy-mode pointer to `~/.claude/quota-status/` adds useful repo-specific guidance instead of leaving readers with a dead-end diagnosis note.

## Blockers

None

## What Needs Attention

- The `~5K` anecdote is no longer directly linked in the README text now that `#61907` was removed, but it remains supported by the upstream duplicate issue and related discussion. Not blocking for a short README note.

## Recommendations

- Approve and merge as-is.
- If this section expands later, consider adding a `See also` link to `anthropics/claude-code#44808` so `/release-notes` has a command-specific upstream reference alongside the canonical `#49335` thread.

## Bottom Line

Ship it. This is a proportional README-only warning, the placement is right, and the text is materially accurate without overclaiming beyond what the upstream evidence supports.
