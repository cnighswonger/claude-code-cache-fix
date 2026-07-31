# AGENTS.md — claude-code-cache-fix (Codex)

**Read first:** `~/.codex/AGENTS.md` — global Codex agent baseline
including the Code & Directive Review Agent discipline (bot identity,
posting rules, artifact persistence, label ownership, output format,
citation rules, how-you-review checklist). This file adds only
cache-fix-specific context.

## Repo

- Owner: `cnighswonger` (public, MIT)
- URL: https://github.com/cnighswonger/claude-code-cache-fix
- Bot identity: `vsits-codex-review-agent[bot]` (slug `codex-reviewer`)
- Default branch: `main`
- Workflow: branch-per-work-unit, PRs required for `main`

## Artifact Path

This repo uses **`docs/code-reviews/`** (not `docs/reviews/` — older
convention retained for continuity). Commit review documents there:

- **PR review, PR branch owned by this org** → on the PR branch as
  `docs/code-reviews/pr-<N>-round-<R>-codex.md`
- **PR review, PR from a contributor's fork** → **do not push anything to
  the fork.** See below.
- **Issue / directive review** → on a review branch (or the directive's
  branch if one exists) as
  `docs/code-reviews/issue-<N>-round-<R>-codex.md`

### Never write to a contributor's fork

When the PR head is a fork you do not own, the review artifact does **not**
get committed anywhere. Post the review body in the formal `gh pr review`
and stop there — that is the artifact.

`maintainerCanModify: true` makes pushing mechanically possible on most
community PRs. It is not permission. A contributor's branch is theirs; a
push you make to it rewrites history they may have local work on, and it
puts our internal review notes into their PR's file diff where they do not
belong.

There is also a mechanical cost: this repo dismisses stale reviews on push,
so a review-doc commit **dismisses the very approval it documents**, and
any `approved-by-*` label instantly goes stale against the new head.

Check before writing: if `gh pr view <N> --json headRepositoryOwner` is not
this org, no commit.

## What cache-fix Is

The proxy that replaces the Node.js `--import` preload interceptor
killed by CC v2.1.113's Bun binary switch. Detection + observability +
transform pipeline sitting in front of `api.anthropic.com`.

- `ANTHROPIC_BASE_URL` is the interception point — SDK contract, durable.
- 16 existing extensions ported from preload (`body → body'` transforms).
- Detection / monitoring is the core value going forward, not just fixes.
- Design spec: https://github.com/cnighswonger/claude-code-cache-fix/issues/40

## Key Files

- `proxy/server.mjs` — Bun-compatible HTTPS proxy server
- `proxy/extensions/*.mjs` — body transforms (chain ordered by config)
- `preload.mjs` — legacy preload interceptor (~2800 lines, 162 tests);
  reference for ported logic
- `docs/directives/` — directive-stage specs awaiting / under review
- `docs/code-reviews/` — Codex review artifacts (commit here, not `docs/reviews/`)
- `tests/` — extension-level + proxy-level integration tests

## What You Review

- **Directives in `docs/directives/`** — design specs for new extensions
  or infrastructure changes. Per the global discipline, validate the
  `## Non-Functional Requirements` section and the `Load-bearing?`
  declaration against its criteria.
- **Implementation PRs** — Node.js proxy code, launch wrapper, detection
  module.
- **Test coverage** — adequacy, edge cases, missing scenarios. 162
  existing preload tests are the behavioral baseline for any
  extension port — behavioral drift from preload semantics is a
  blocking finding unless the directive explicitly authorizes it.
- **Security** — the proxy handles API keys and request / response
  bodies. Treat any change that touches header passthrough, body
  mutation, or upstream URL construction as security-relevant.
- **Schema changes** — extension-pipeline interface, telemetry format,
  config schema. Apply `schema-change` label (see below).

## What You Do NOT Review

- The cache-fix Discussions tab — AITL owns community engagement.
- Public-engagement content (blog drafts, issue replies) — AITL owns.

## Repo-Specific Considerations

- **Public MIT repo with active community contributors.** Treat
  first-time-contributor PRs with extra care: examine the full design,
  not just the diff. If you'd reject the approach, say so in the
  review rather than letting the PR linger.
- **`needs-sim-validation` label** applies to changes that require live
  CC-traffic integration testing through the proxy. Apply it when
  unit / integration tests alone can't prove behavior under real
  traffic.

## Repo-Specific Labels

In addition to the global review-outcome labels (`reviewed-by-codex-agent`,
`approved-by-codex-agent`, `changes-requested`), apply:

- `schema-change` — Changes affect extension pipeline interface,
  telemetry format, or config schema.
- `needs-sim-validation` — Requires integration testing with live CC
  traffic.
