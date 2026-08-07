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

All `gh` writes from this repo run under the `vsits-proxy-builder[bot]` App identity, never under the operator's personal PAT. This keeps the audit trail clean. The `gh-bot-guard.sh` PreToolUse hook (in `~/.claude/hooks/`) provides best-effort enforcement — when its activation marker is present, it blocks `gh` write subcommands that aren't preceded by a non-empty `GH_TOKEN=<value>` environment-variable assignment.

- **Writes** — required pattern:
  ```bash
  TOKEN=$(~/.claude/github-apps/generate-token.sh proxy-builder) && \
    GH_TOKEN=$TOKEN gh <command> <args...>
  ```
- **Currently enforced subcommands** (the hook blocks these without a real `GH_TOKEN=<value>` prefix): `gh issue|pr` (`comment|create|edit|review|close|reopen|merge|ready|lock|unlock|delete|transfer|pin|unpin`), `gh release` (`create|edit|delete|upload`), `gh api -X (POST|PATCH|PUT|DELETE)`, `gh secret|variable` (`set|delete|remove`), `gh workflow` (`run|enable|disable|delete`), `gh repo` (`create|delete|edit|fork|rename|archive|unarchive|set-default`), `gh label|project|gist|ruleset` (`create|edit|delete|clone`), `gh run` (`rerun|cancel|delete`).
- **Reads** (`gh pr view`, `gh issue view`, `gh api ... GET`, `gh ... list`, etc.) pass through unchanged.
- **Activation marker**: the hook keys off `.claude/github-app` in the project tree. That file is tracked in this repo (content: `proxy-builder`) so a fresh clone gets the marker automatically; the hook walks up from `cwd` to find it.
- **What the hook does NOT guarantee**: it cannot tell a real bot token from a syntactically-valid placeholder, and it does not catch `gh` subcommands outside the list above. Treat it as a tripwire that catches accidental plain-`gh` writes, not a security control.

## Review Workflow

- For PR review work: findings first, approval only if there are no blocking issues.
- Review mindset: optimize for finding what could break, regress, mislead, or remain untested. Do not approve because a change sounds reasonable.
- Before any re-review, fetch the current PR head/ref first. Do not assume the previously viewed diff is still current.
- Every PR review must leave a PR comment summarizing the review result.
- Before taking any PR action, read the full existing PR comment thread so you do not act on stale or partial context.
- **All PR and issue comments must be postfixed with the agent name** as a sign-off (e.g. `— AI Team Lead`, `— Proxy Builder`, `— Codex review`). Do not prefix comments with the agent name. This is required for audit trail and cross-agent coordination.
- PR review must explicitly check whether tests cover the changed execution path.
- If there are blocking issues, post the findings in the PR comment and do not add an approval label.
- If the work under review is a directive/spec only, post the plan review result and add `plan-approved` only when the directive is approved.
- Review and approval labels are markers of review state, not substitutes for review comments.

## PR Labels

Review labels (directive/spec stage):
- `reviewed-by-code-agent` — Implementation agent has reviewed, no blocking findings
- `reviewed-by-codex-agent` — Codex has reviewed, no blocking findings
- `reviewed-by-lead` — Project lead has reviewed

Approval labels (LLM-agent sign-off — record that the reviewer completed a
review, not that the PR is cleared for merge):
- `approved-by-code-agent` — Implementation agent completed review with no blockers
- `approved-by-codex-agent` — Codex completed review with no blockers
- `approved-by-lead` — Project lead completed review with no blockers

Workflow state labels:
- `plan-approved` — directive/spec approved; implementation may begin
- `directive-stage` — PR is in directive/spec review; remove when implementation begins
- `implementation-stage` — PR is in implementation
- `changes-requested` — blocking findings remain
- `ready-for-merge` — Chris's merge gate. Applied by Chris only, after his formal `gh` review. No agent applies it, including the lead.
- `needs-sim-validation` — requires integration testing with live CC traffic
- `schema-change` — changes affect extension pipeline interface, telemetry format, or config schema

Policy:
- `reviewed-by-*` labels are for the directive/spec stage.
- `approved-by-*` labels record that an LLM agent has reviewed with no blockers. They are necessary preconditions for merge, not merge authorization. Must be paired with a review comment.
- `plan-approved` allows implementation to begin but does not mean the PR is merge-ready.
- `ready-for-merge` is **Chris's alone.** He applies it after his formal `gh` review. All required `approved-by-*` labels + no `changes-requested` are its preconditions but not sufficient — his `gh` review is an additional requirement. Its absence alongside `approved-by-lead` and `approved-by-codex-agent` is the normal waiting-on-human state, not an oversight to be corrected.
- Each agent owns only their own review and approval labels. No agent may add or remove another agent's labels. `ready-for-merge` is not any agent's own label; it is Chris's, per above.
- Codex should communicate desired shared-label changes in the review comment unless the user explicitly asks Codex to apply them.
- **Approval labels are bound to the commit at which the approval was granted.** If new commits land on a PR after an approval label was applied, the label becomes stale relative to the new HEAD and re-approval is required. This applies to `approved-by-codex-agent`, `approved-by-code-agent`, `approved-by-lead`, and `ready-for-merge` (since the latter depends on the underlying approvals being current). Before treating any approval label as authoritative for the current HEAD, pull its timestamp via `gh api repos/<o>/<r>/issues/<n>/timeline --jq '.[] | select(.event=="labeled") | "\(.created_at)  \(.label.name)"'` and compare against the timestamps of commits since.
- **When refreshing approval after new commits, remove and reapply the label** rather than leaving the original in place. The reapply updates the timestamp on the GitHub timeline so the label's freshness can be verified at a glance. A label whose timestamp predates the current HEAD's most recent material commit is, by definition, stale — even if the labeler intended their approval to cover the newer commits, the timeline doesn't reflect that.

## Agent Roles

- **Project Lead** (AI Team Lead session) — strategic decisions, requirements, community coordination. Does not write implementation code.
- **Proxy Builder** (CC teammate) — implements on feature branches. Commits directive to branch, opens PR, submits for review before implementing.
- **Codex Review Agent** (external, OpenAI Codex) — independent code reviewer. Reviews on PRs, writes reports to `docs/code-reviews/` in the codex workspace.
- **Proxy Test Agent** — dedicated integration testing agent. Validates proxy with live CC traffic.

## Cross-LLM Review

Significant implementation plans and code go to the Codex Review Agent before merging. Skip for hotfixes; always for infrastructure and new features. Different model catches different blind spots.

## Non-Functional Requirements & Anti-Bloat

LLM-written code reliably satisfies functional requirements and neglects non-functional ones — security, maintainability, and especially size/complexity. These rules add the missing lens. (Canonical cross-repo standard maintained by the Project Lead; the reviewer-side anti-bloat lens lives in this repo's `AGENTS.md`.)

**Every directive must address these non-functional topics in a `## Non-Functional Requirements` section** (after Goal/Background, before scope). It is a short fixed checklist, not a rigid template — answer each in a line or two. `n/a` is valid for any topic except **Load-bearing?**, which is a required yes/no.

- **Size/complexity budget** — a qualitative trigger: state the rough expected size (LOC and/or module count) so review can flag an implementation that lands materially larger (≈2×) than the directive anticipated.
- **Threat model** — inputs, trust boundaries, what must never leak or execute. The proxy handles API keys and full request/response bodies — be specific here.
- **Maintainability constraints** — new abstractions require explicit justification (repeated use, ≈3+ call sites, or a concrete near-term reuse case); otherwise default to inlining. No dead code; no defensive handling for impossible cases; no back-compat shims unless required.
- **Performance/reliability** — only where it applies.
- **Load-bearing?** (required yes/no) — yes if it touches a shared abstraction, a wire/schema contract, or anything security-relevant.

**Load-bearing changes require human (Chris) review before merge**, not just Lead + Codex — the independent reviewer and the Lead are both LLMs with correlated blind spots, and an LLM reviewer can even confabulate findings. Routine leaf code rides on Lead + Codex.

## Public Communication

Never post publicly without Chris's approval. Draft and wait for go-ahead.

## Public-Repo Information Hygiene

This repository is public. Anything committed becomes part of public git history immediately and cannot be retracted by editing or deleting the file later. Before any commit, scan for origin-server-identifying information and replace it with placeholders + a pointer to internal deployment notes.

**Never put in tracked files:**

- **Origin IPs** — literal IPv4/IPv6 addresses pointing at production hosts (droplets, load balancers, VPS, etc.)
- **SSH targets** — `ssh root@<ip>` lines, hostname-port pairs that reach origin
- **Internal service ports** that aren't surfaced through the public reverse-proxy / CDN
- **Stack fingerprinting** — server hostnames combined with "what's running" details (e.g. `host-01, Node 20 + Caddy + systemd, port 3847`). Fingerprinting narrows the attack surface even after an IP rotation.

**Why this is non-negotiable:** Cloudflare's WAF / DDoS protection only protects traffic that actually flows through Cloudflare. If the origin IP is in a public repo, an attacker can bypass Cloudflare entirely and hit the origin directly. The remediation path for an IP that has already been leaked to git history is rotating the IP itself (snapshot + recreate, or floating-IP reassignment) — there is no in-place "scrub" because git history is immutable.

**Acceptable patterns in public docs and runbooks:**

- `<droplet>` or `<DROPLET_IP>` placeholder in place of literal IPs
- `ssh root@<droplet>` rather than `ssh root@<literal-ip>`
- One-line pointer: "(host details in internal deployment notes)" or similar. Keeps the runbook useful for someone with proper access without leaking the value.
- Generic deployment shape descriptions are fine: "single DigitalOcean droplet behind Cloudflare-proxied DNS" gives readers the shape without enabling bypass.

**Scope:** This applies to ALL tracked files: source code, comments, `README.md`, `CHANGELOG.md`, `SESSION_STATE.md`, handoff docs under `docs/`, commit messages, PR descriptions, issue comments. Scan for literal IPs (v4/v6), SSH lines, and hostname-port-stack tuples before any `git commit`, `git push`, or `gh` write operation. Precedent: `cnighswonger/claude-code-meter#19` (2026-05-20) — an origin IP had leaked into `SESSION_STATE.md` via a prior rebrand commit; remediation required destroying and recreating the droplet because git history could not be scrubbed.

## Release Safety Rules

Production systems depend on this package. These rules are non-negotiable.

1. **Contributors rebase against current main before requesting review.** No manual cherry-picks or conflict resolution in the fix pipeline. Clean fast-forward merges only. If a PR has conflicts, ask the contributor to rebase — do not resolve conflicts yourself.

2. **Never tag or publish without running the full test suite on the exact commit being released.** No shortcuts under time pressure. Tests must pass at the tagged commit, not "they passed a few commits ago."

3. **Review what ships to npm.** Run `npm pack --dry-run` before `npm publish` and verify the tarball contents. Tests passing is necessary but not sufficient — confirm the packaged artifact is what you expect.

4. **Merge one PR at a time, sequentially.** Merge, test, push. Then the next PR rebases on that. No batching multiple merges before testing. Slower but dramatically safer when the core artifact is a single 2000+ line file.
