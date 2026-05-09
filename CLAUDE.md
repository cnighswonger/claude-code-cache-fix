# CLAUDE.md — claude-code-cache-fix

## Git Workflow

- **Do not push directly to `main` unless the user explicitly instructs you to do so in the current turn.** Otherwise use feature branches and PRs, even for small fixes.
- If writing directly to `main` is explicitly authorized, pull/rebase from `origin/main` before any other write action so you start from the current remote tip.
- Branch naming: `feature/<name>` for features, `fix/<name>` for bugfixes.
- **Multi-phase feature branches:** For large features with phases, use `feature/<name>-<phase>` sub-branches that merge back into the parent `feature/<name>` branch. Git does not allow nested refs when the parent exists, so use hyphens not slashes for the phase segment. Example: `feature/proxy-v3-extensions` merges into `feature/proxy-v3`, which merges into `main` when the full feature ships. Each sub-branch gets its own PR with Codex review before merging to the parent.
- PRs require review before merge.
- Commit messages: lead with what changed and why, not how.
- Multi-phase issues: use `Ref #N` (not `Closes #N`) until the final phase PR.

## GitHub Bot Identity

All `gh` writes from this repo run under the `vsits-proxy-builder[bot]` App identity, never under the operator's personal PAT. This keeps the audit trail clean and is enforced by the `gh-bot-guard.sh` PreToolUse hook (which blocks writes lacking `GH_TOKEN=`).

- **Writes** (`gh issue|pr comment|create|edit|review|close|reopen|merge`, `gh release create|edit|delete|upload`, `gh api -X POST|PATCH|PUT|DELETE`):
  ```bash
  TOKEN=$(~/.claude/github-apps/generate-token.sh proxy-builder) && \
    GH_TOKEN=$TOKEN gh <command> <args...>
  ```
- **Reads** (`gh pr view`, `gh issue view`, `gh api ... GET`, etc.): plain `gh` is fine.
- The bot ID is stored in `.claude/github-app` (`proxy-builder`) — that file is what the guard hook reads to decide which token to demand.

## Review Workflow

- For PR review work: findings first, approval only if there are no blocking issues.
- Review mindset: optimize for finding what could break, regress, mislead, or remain untested. Do not approve because a change sounds reasonable.
- Before any re-review, fetch the current PR head/ref first. Do not assume the previously viewed diff is still current.
- Every PR review must leave a PR comment summarizing the review result.
- Before taking any PR action, read the full existing PR comment thread so you do not act on stale or partial context.
- **All PR and issue comments must be postfixed with the agent name** as a sign-off (e.g. `— Manager Agent`, `— Proxy Builder`, `— Codex review`). Do not prefix comments with the agent name. This is required for audit trail and cross-agent coordination.
- PR review must explicitly check whether tests cover the changed execution path.
- If there are blocking issues, post the findings in the PR comment and do not add an approval label.
- If the work under review is a directive/spec only, post the plan review result and add `plan-approved` only when the directive is approved.
- Review and approval labels are markers of review state, not substitutes for review comments.

## PR Labels

Review labels (directive/spec stage):
- `reviewed-by-code-agent` — Implementation agent has reviewed, no blocking findings
- `reviewed-by-codex-agent` — Codex has reviewed, no blocking findings
- `reviewed-by-lead` — Project lead has reviewed

Approval labels (final implementation sign-off):
- `approved-by-code-agent` — Implementation agent approves for merge
- `approved-by-codex-agent` — Codex approves for merge
- `approved-by-lead` — Project lead approves for merge

Workflow state labels:
- `plan-approved` — directive/spec approved; implementation may begin
- `directive-stage` — PR is in directive/spec review; remove when implementation begins
- `implementation-stage` — PR is in implementation
- `changes-requested` — blocking findings remain
- `ready-for-merge` — all required `approved-by-*` labels present, no blockers
- `needs-sim-validation` — requires integration testing with live CC traffic
- `schema-change` — changes affect extension pipeline interface, telemetry format, or config schema

Policy:
- `reviewed-by-*` labels are for the directive/spec stage.
- `approved-by-*` labels are the final implementation sign-off. Must be paired with a review comment.
- `plan-approved` allows implementation to begin but does not mean the PR is merge-ready.
- `ready-for-merge` requires `approved-by-codex-agent` and `approved-by-lead`. Must not coexist with `changes-requested`.
- Each agent owns only their own review and approval labels. No agent may add or remove another agent's labels.
- Codex should communicate desired shared-label changes in the review comment unless the user explicitly asks Codex to apply them.

## Agent Roles

- **Project Lead** (Manager session) — strategic decisions, requirements, community coordination. Does not write implementation code.
- **Proxy Builder** (CC teammate) — implements on feature branches. Commits directive to branch, opens PR, submits for review before implementing.
- **Codex Review Agent** (external, OpenAI Codex) — independent code reviewer. Reviews on PRs, writes reports to `docs/code-reviews/` in the codex workspace.
- **Proxy Test Agent** — dedicated integration testing agent. Validates proxy with live CC traffic.

## Cross-LLM Review

Significant implementation plans and code go to the Codex Review Agent before merging. Skip for hotfixes; always for infrastructure and new features. Different model catches different blind spots.

## Public Communication

Never post publicly without Chris's approval. Draft and wait for go-ahead.

## Release Safety Rules

Production systems depend on this package. These rules are non-negotiable.

1. **Contributors rebase against current main before requesting review.** No manual cherry-picks or conflict resolution in the fix pipeline. Clean fast-forward merges only. If a PR has conflicts, ask the contributor to rebase — do not resolve conflicts yourself.

2. **Never tag or publish without running the full test suite on the exact commit being released.** No shortcuts under time pressure. Tests must pass at the tagged commit, not "they passed a few commits ago."

3. **Review what ships to npm.** Run `npm pack --dry-run` before `npm publish` and verify the tarball contents. Tests passing is necessary but not sufficient — confirm the packaged artifact is what you expect.

4. **Merge one PR at a time, sequentially.** Merge, test, push. Then the next PR rebases on that. No batching multiple merges before testing. Slower but dramatically safer when the core artifact is a single 2000+ line file.
