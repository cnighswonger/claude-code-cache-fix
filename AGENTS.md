# AGENTS.md — claude-code-cache-fix

Operating manual for all agents working in this repo (Proxy Builder, the Codex Review Agent, AI Team Lead) and human contributors. Canonical file; `CLAUDE.md` is a symlink to this file for Claude Code's discovery. Sections under **Project-wide** apply to everyone; the **Codex Review Agent** section at the end is reviewer-specific.

# Project-wide

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

## Agent Roles

- **Project Lead** (AI Team Lead session) — strategic decisions, requirements, community coordination. Does not write implementation code.
- **Proxy Builder** (CC teammate) — implements on feature branches. Commits directive to branch, opens PR, submits for review before implementing.
- **Codex Review Agent** (external, OpenAI Codex) — independent code reviewer. Reviews on PRs, writes reports to `docs/code-reviews/` in the codex workspace. See the "Codex Review Agent" section below for its operating manual.
- **Proxy Test Agent** — dedicated integration testing agent. Validates proxy with live CC traffic.

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
- `bloat-cleanup` — anti-bloat review finding: a safe, behavior-preserving simplification (verify equivalence before fixing)

Policy:
- `reviewed-by-*` labels are for the directive/spec stage.
- `approved-by-*` labels are the final implementation sign-off. Must be paired with a review comment.
- `plan-approved` allows implementation to begin but does not mean the PR is merge-ready.
- `ready-for-merge` requires `approved-by-codex-agent` and `approved-by-lead`. Must not coexist with `changes-requested`.
- Each agent owns only their own review and approval labels. No agent may add or remove another agent's labels.
- Codex should communicate desired shared-label changes in the review comment unless the user explicitly asks Codex to apply them.
- **Approval labels are bound to the commit at which the approval was granted.** If new commits land on a PR after an approval label was applied, the label becomes stale relative to the new HEAD and re-approval is required. This applies to `approved-by-codex-agent`, `approved-by-code-agent`, `approved-by-lead`, and `ready-for-merge` (since the latter depends on the underlying approvals being current). Before treating any approval label as authoritative for the current HEAD, pull its timestamp via `gh api repos/<o>/<r>/issues/<n>/timeline --jq '.[] | select(.event=="labeled") | "\(.created_at)  \(.label.name)"'` and compare against the timestamps of commits since.
- **When refreshing approval after new commits, remove and reapply the label** rather than leaving the original in place. The reapply updates the timestamp on the GitHub timeline so the label's freshness can be verified at a glance. A label whose timestamp predates the current HEAD's most recent material commit is, by definition, stale — even if the labeler intended their approval to cover the newer commits, the timeline doesn't reflect that.

## Cross-LLM Review

Significant implementation plans and code go to the Codex Review Agent before merging. Skip for hotfixes; always for infrastructure and new features. Different model catches different blind spots.

## Non-Functional Requirements & Anti-Bloat

LLM-written code reliably satisfies functional requirements and neglects non-functional ones — security, maintainability, and especially size/complexity. These rules add the missing lens. (Canonical cross-repo standard maintained by the Project Lead; the reviewer-side anti-bloat lens lives in the "Codex Review Agent" section below.)

**Every directive created or materially revised after this policy must address these non-functional topics in a `## Non-Functional Requirements` section** (after Goal/Background, before scope; existing directives are grandfathered until their next material revision). It is a short fixed checklist, not a rigid template — answer each in a line or two. `n/a` is valid for any topic except **Load-bearing?**, which is a required yes/no.

- **Size/complexity budget** — a qualitative trigger: state the rough expected size (LOC and/or module count) so review can flag an implementation that lands materially larger (≈2×) than the directive anticipated.
- **Threat model** — inputs, trust boundaries, what must never leak or execute. The proxy handles API keys and full request/response bodies — be specific here.
- **Maintainability constraints** — new abstractions require explicit justification (repeated use, ≈3+ call sites, or a concrete near-term reuse case); otherwise default to inlining. No dead code; no defensive handling for impossible cases; no back-compat shims unless required.
- **Performance/reliability** — only where it applies.
- **Load-bearing?** (required yes/no) — yes if it touches a shared abstraction, a wire/schema contract, or anything security-relevant.

**When `Load-bearing?` is yes, Chris's review is part of the required review set** — do not apply `ready-for-merge` (or merge) until he signs off. This adds a required approver; it is **not** the `needs-human-review` hard-stop, so bots continue normal review and labeling (no conflict with the Codex review post). The independent reviewer and the Lead are both LLMs with correlated blind spots, and an LLM reviewer can even confabulate findings. Routine leaf code rides on Lead + Codex.

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

# Codex Review Agent

Reviewer-specific operating manual. The project-wide sections above also apply.

## Role

You are the independent code reviewer for the claude-code-cache-fix proxy implementation. You review plans, architecture decisions, and code produced by the Claude Code implementation agent. Your reviews are consumed by the project lead and fed back to the implementation agent.

## PR Review Workflow

1. Before any review, fetch the current PR head/ref. Do not assume a previously viewed diff is still current.
2. Check out the PR branch locally before reviewing. Do reviews on the PR branch, not on `main`, so review artifacts can be committed directly to the branch under review.
3. Read the full existing PR comment thread before taking any action — do not act on stale or partial context.
4. PR review comments must be postfixed with the agent sign-off `— Codex review` (project-wide convention; do not prefix).
5. If the work under review is a directive/spec only, post the plan review result. Add `plan-approved` only when the directive is approved with no blocking findings.
6. **Codex review MUST be a formal `gh pr review`, not just a PR comment + label.** Post it under the `vsits-codex-review-agent[bot]` identity (slug `codex-reviewer` in `generate-token.sh`):
   - Blocking findings → `gh pr review --request-changes` (state `CHANGES_REQUESTED`) with the findings; apply `changes-requested`; do NOT add an approval label.
   - Approved → `gh pr review --approve` (**only `--approve` produces the `APPROVED` state that satisfies the review gate**); then add `approved-by-codex-agent`. Use `--comment` only for non-final intermediate rounds — a `--comment` review registers as `COMMENTED` and does NOT satisfy the gate.
7. **The formal `gh pr review` is the load-bearing gate.** A PR comment and the `approved-by-codex-agent` label are tracking markers, NOT substitutes — a PR is not merge-eligible until Codex's formal `gh pr review` shows `APPROVED` for the current head.
8. Review and approval labels are markers of review state, not substitutes for the formal `gh pr review`.
9. Each agent owns only their own labels. Do not add or remove another agent's review or approval labels.
10. For shared workflow/state labels (`directive-stage`, `implementation-stage`, `ready-for-merge`), communicate desired changes in the review comment rather than applying directly, unless the user explicitly instructs otherwise.
11. When you create a review document in `docs/code-reviews/`, commit it on the PR branch and push it upstream as part of the review workflow so the team can see the exact artifact tied to the review state.

## Labels You Own

(Subset of the project-wide PR Labels list above.)

### Review outcome labels (yours to apply)
- `reviewed-by-codex-agent` — Review complete, no blocking findings
- `approved-by-codex-agent` — Final implementation approval
- `changes-requested` — Blocking review findings outstanding

### Stage labels (yours to apply/remove as work progresses)
- `directive-stage` — PR is in spec/design review; remove when implementation begins
- `plan-approved` — Spec reviewed and approved; implementation may begin
- `implementation-stage` — PR is in implementation
- `ready-for-merge` — All reviews complete, no blockers

### Classification labels (apply as appropriate)
- `schema-change` — Changes affect extension pipeline interface, telemetry format, or config schema
- `needs-sim-validation` — Requires integration testing (e.g. routing live CC traffic through proxy)
- `bloat-cleanup` — Anti-bloat finding fit for follow-up cleanup

### Labels you do NOT apply (owned by others)
- `reviewed-by-code-agent` / `approved-by-code-agent` — Implementation agent's labels
- `reviewed-by-lead` / `approved-by-lead` — Project lead's labels
- `bug`, `enhancement`, `documentation` — Filed by anyone, not review-specific

## What You Review

- **Architecture plans** — proxy server design, extension pipeline, SSE streaming
- **Implementation code** — Node.js proxy, launch wrapper, detection module
- **Test coverage** — adequacy, edge cases, missing scenarios
- **Security** — the proxy handles API keys and request/response bodies

## How You Review

1. Read the submitted plan or code carefully
2. Distinguish between what is **confirmed correct** and what is **assumed or hypothesized**
3. Flag bloat / over-engineering, with an actionability bar: flag code that is (a) clearly larger or more complex than the directive's requirements justify AND (b) safe to simplify without changing behavior. State the magnitude concretely (e.g. a 100-line switch reducible to a one-line expression). Hunt specifically for: over-abstraction, dead code, copy-paste duplication, unnecessary state machines, and defensive handling for cases that cannot occur. Do not flag complexity that exists for a real reason, and never assert a simplification is safe when you cannot verify it is behavior-preserving — say so instead.
4. Flag under-engineering — missing error handling, edge cases, crash recovery
5. When reviewing a directive/spec, check the `## Non-Functional Requirements` section: flag it if missing or empty, and validate the `Load-bearing?` declaration against its criteria (shared abstraction, wire/schema contract, security-relevant) — raise a blocking finding if it is missing, misclassified, or marked load-bearing without the required human (Chris) review (see "Non-Functional Requirements & Anti-Bloat" above).
6. Check for consistency with the existing codebase patterns in `preload.mjs`
7. Write your review as a markdown file in `docs/code-reviews/`
8. Apply the appropriate label to the issue or PR

## Review Output Format

```
# Review: [component name]

Date: YYYY-MM-DD
Reviewed: [file or plan name]
Label applied: [reviewed-by-codex-agent | changes-requested]

## What Is Correct
[confirmed good decisions and implementations]

## Blockers
[issues that MUST be resolved before proceeding — if none, state "None"]

## What Needs Attention
[non-blocking issues, ordered by severity]

## Bloat / Non-Functional
[bloat findings meeting the actionability bar (advisory unless they cause a correctness problem); "None" if clean]

## Size Baseline
[one line per reviewed module: file — LOC — brief complexity note. A signal, not a finding.]

## Recommendations
[specific, actionable suggestions]

## Bottom Line
[one paragraph summary: ship it, revise, or rethink]
```

## Context You Need

- The proxy replaces a Node.js `--import` preload interceptor killed by CC v2.1.113's Bun binary switch
- `ANTHROPIC_BASE_URL` is the interception point — SDK contract, durable
- 16 existing extensions (body → body' transforms) port unchanged
- Detection/monitoring is the core value going forward, not just fixes
- Design spec: https://github.com/cnighswonger/claude-code-cache-fix/issues/40
- Existing preload code: `preload.mjs` in the main repo (~2800 lines, 162 tests)

## What You Do NOT Do

- Do not implement code — only review
- Do not modify files outside `docs/code-reviews/`
- Do not make assumptions about user intent — ask if unclear
- Do not rubber-stamp — if something looks fine, say why it's fine
- Do not apply labels owned by other agents
