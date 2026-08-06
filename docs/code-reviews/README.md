# Code-review artifacts

Files under `docs/code-reviews/` are the persisted record of PR reviews — Codex reports, hand-authored review notes, directive-review followups. They land as commits on the PR they review or shortly after, and stay on `main` for reference.

## Convention: session UUIDs and other capture identifiers

**Do not paste real session UUIDs, request ids, or `s-<8hex>` capture prefixes into review artifacts.** Even the "just this once" case (`{"jq …"}` with `<session-uuid>` filled in) becomes a permanent record on `main` when the review lands. Public git history can't be scrubbed; a leaked identifier is burned the moment it hits `origin/main` and can only be worked around forward, not removed.

When a measured command needs a placeholder replaced:

- **Use a synthetic value that matches the shape.** For session UUIDs, `00000000-0000-4000-8000-<12hex>` (`00000000-0000-4000-8000-c4f1efb22201`, `…-c4f1efb22202`, …). Keeps the command legible without leaking.
- **Note that the substitute is synthetic** if it isn't obvious from context — a reader reproducing the measurement should know the id is illustrative, not the id used at measurement time.

The measurement itself is still real. The synthetic id is a shape-preserving substitute so the fenced-block command reads correctly to future readers.

Precedent that produced this convention: [#318](https://github.com/cnighswonger/claude-code-cache-fix/issues/318) — two real session UUIDs reached `main` in `pr-299-round-1-codex.md` and `pr-299-round-2-codex.md`, surfaced when @Gunther-Schulz's `tools/absence-scan.mjs` ([#276](https://github.com/cnighswonger/claude-code-cache-fix/pull/276)) ran against this repo for the first time and flagged them.

## Related

- [`AGENTS.md`](../../AGENTS.md) — review lens and anti-bloat rules that apply to the underlying PRs.
- [`CLAUDE.md`](../../CLAUDE.md#public-repo-information-hygiene) — the origin-IP hygiene rule that the UUID convention here parallels. Same reasoning (public history is immutable), different identifier class.
- `tools/absence-scan.mjs` — pre-push guard once [#276](https://github.com/cnighswonger/claude-code-cache-fix/pull/276) lands (the file isn't on `main` yet; the link resolves after that PR merges). Would have caught this class at authoring time.
