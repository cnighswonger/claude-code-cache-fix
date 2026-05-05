# Review: Per-session quota-status directive

Date: 2026-05-05
Reviewed: docs/directives/proxy-quota-status-per-session.md
Label applied: changes-requested

## What Is Correct

- The original blocker is resolved. The directive now defines a canonical `sessionFilename(rawId)` contract, moves per-session files under `~/.claude/quota-status/sessions/`, and backs the rule with targeted tests `#11a-#11j`.
- The llm-relay citation is improved. The directive now attributes the cross-repo verification to Lead and includes a locally verifiable corroboration path. I also confirmed this review token can read `cnighswonger/llm-relay`, and the current canonical file `src/llm_relay/proxy/proxy.py` does reference `x-claude-code-session-id`.
- The migration sweep is now broad enough at the directive level. README, translated copies, and `TRACKED_ISSUES.md` are explicitly called out, rather than only the runtime shell tools.
- The `tools/quota-statusline.sh` smoke coverage is now present and materially better. `T1-T5` cover the happy path, missing `session_id`, missing per-session file, both files missing, and malformed `session_id`.
- The internal contradiction from the previous re-review is resolved. The CHANGELOG text, tests `#1-#5`, sweep test `#8`, pipeline test `#11j`, and acceptance criteria now consistently use `~/.claude/quota-status/account.json` plus `~/.claude/quota-status/sessions/<filename>.json`.

## Blockers

- `docs/directives/proxy-quota-status-per-session.md` currently embeds a literal NUL byte in test `11d` inside the sample string for the malformed-session case (`with\\0nul` was written as an actual NUL, not a textual representation). This is not just cosmetic:
  - `rg` now treats the directive as a binary file instead of normal markdown.
  - Text-oriented review and implementation sweeps become less reliable because standard repo tooling no longer sees the file as plain text.
  - The user instruction for this re-review explicitly called out avoiding a literal NUL in the review artifact, which is the right constraint for the directive too.

## What Needs Attention

- The llm-relay path in the directive text appears stale. The repository is readable now, but the file lives at `src/llm_relay/proxy/proxy.py`, not `proxy/proxy.py`. That does not invalidate the substance of the claim, but the citation should match the actual tree.
- The acceptance bullet says shipped readers `tools/quota-statusline.sh`, `tools/cache-test.sh`, and `tools/cross-version-cache-test.sh` must all implement the canonical filename rule identically. Only `tools/quota-statusline.sh` actually needs that rule; the other two read `account.json` only. Tightening that wording would avoid overstating the shared contract surface.

## Recommendations

- Replace the literal NUL byte in test `11d` with a textual representation such as `\"with\\\\0nul\"` or `\"with<NUL>nul\"` so the directive remains a normal markdown text file.
- Update the llm-relay citation path to `src/llm_relay/proxy/proxy.py` so future reviewers can verify it directly.
- Narrow the filename-rule acceptance bullet to the writer plus readers that actually derive per-session filenames, chiefly `tools/quota-statusline.sh`.

## Bottom Line

The substantive design issues from the prior reviews are resolved, and the directive is close to approval. I am still requesting changes because the current markdown file contains a literal NUL byte, which degrades normal repo text tooling and should not ship as part of the directive.
