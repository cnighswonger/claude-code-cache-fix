# Review: Per-session quota-status directive

Date: 2026-05-05
Reviewed: docs/directives/proxy-quota-status-per-session.md
Label applied: changes-requested

## What Is Correct

- The directive correctly identifies the current proxy-global write path as the root of the cross-session contamination problem. The current implementation does unconditionally overwrite `~/.claude/quota-status.json` from `proxy/extensions/cache-telemetry.mjs:5,108`.
- The proposed `account.json` plus per-session file split is the right shape. It removes the residual "stale global fields in an idle session file" problem that option (a) would keep.
- The `microcompact-stability` bonus fix is well-scoped and technically justified. `proxy/extensions/microcompact-stability.mjs:234-242` currently checks `meta.session_id`, `x-session-id`, and `x-anthropic-session-id`, but not `x-claude-code-session-id`.
- The atomic-write requirement, one-shot legacy cleanup, and throttled stale-file sweep are all proportionate to the problem. They address real operational footguns without introducing unnecessary machinery.
- The migration table covers the functional in-repo consumers I could confirm with `rg`: `tools/quota-statusline.sh`, `tools/cache-test.sh`, `tools/cross-version-cache-test.sh`, and the intentional preload carveout.

## Blockers

- `docs/directives/proxy-quota-status-per-session.md:45-49,78-79,114-125,180` defines the per-session file path as `~/.claude/quota-status/<session-id>.json` but never defines how `<session-id>` is normalized into a safe filename. That is a directive-level gap, not an implementation detail:
  - The same directive explicitly falls back to `x-session-id` and `x-anthropic-session-id`, which are not constrained here to canonical CC UUIDs.
  - Using raw header values as path segments permits malformed values to create nested paths (`/`), dot-segments, invalid filenames, or `ENAMETOOLONG` failures.
  - The current tests only cover UUID-like happy paths, legacy-header happy paths, and `unknown`; they do not lock in behavior for malformed or oversized IDs.
  - Because readers must derive the same path from stdin `session_id`, implementation cannot safely "just sanitize something" ad hoc without also defining the reader contract and collision behavior.

## What Needs Attention

- I could not independently source-verify the llm-relay citations in `docs/directives/proxy-quota-status-per-session.md:23` because that repository was not accessible to the review token. The claim is consistent with the local evidence I could verify, but this review cannot confirm the external citation directly.
- The directive's migration table is complete for runtime consumers, but the repo still has multiple README and docs references to `~/.claude/quota-status.json`. Those are documentation updates rather than design blockers, but the eventual implementation PR should sweep them to avoid stale guidance after a breaking path change.
- `tools/quota-statusline.sh` is a shipped utility and the directive currently leaves it at manual verification only. That is probably acceptable for this stage, but a lightweight smoke test would reduce regression risk on the consumer most exposed to the new filename contract.

## Recommendations

- Revise the directive to define a deterministic filename mapping for session IDs and require both writers and readers to use it. The rule should explicitly handle path separators, empty strings, and overlong inputs, and it should define collision behavior.
- Keep the original session ID in the JSON payload if desired, but treat the on-disk filename as a derived storage key rather than raw header text.
- Add tests for malformed session IDs, path-separator characters, and very long values so the file contract is fixed in the directive before implementation begins.
- If the llm-relay source cannot be linked in the PR, soften the wording around that external verification or add a local corroborating note so the claim is easier for future reviewers to audit.

## Bottom Line

The directive is close: the problem statement is correct, the account/session split is the right design, and the microcompact/header work is sound. I am not approving it yet because the per-session filename contract is underspecified in a way that affects safety, interoperability, and tests. Define the session-ID-to-filename mapping explicitly, then this should be ready to approve.
