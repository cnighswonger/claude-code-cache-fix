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

## Anti-Bloat Lens (no-directive PRs)

The global baseline's bloat bar is *"larger than the directive's
requirements justify."* **Community PRs have no directive**, so that bar
has nothing to anchor to and the finding defaults to "None" — including
on a PR adding thousands of lines. Measured 2026-07-31 across eight open
community PRs: every review reported `Bloat: None`, one of them on 6,630
lines of new production code.

For a PR with no directive, anchor to **the defect it claims to fix**
instead. Ask: *what is the smallest change that fixes the stated
problem, and how much larger is this?*

Report these numbers in the review, always, even when the verdict is
"proportionate" — a stated number is checkable, "None" is not:

- **production LOC** (excluding `test/`), and **test:production ratio**
- **new files, new exports, new env vars, new on-disk paths**
- **comment:code ratio** on the production diff

Calibration from merged work in this repo. These are all *proportionate*
— use them as the reference for what normal looks like:

| PR | prod LOC | test:prod | shape |
|---|---|---|---|
| #274 header propagation | 7 code + 19 comment | 23x | a wire-path defect fix |
| #277 supervised stop | 9 code + 10 comment | 9.0x | one branch + a watchdog |
| #261 absolute-form | 23 code + 31 comment | 8.4x | one parser + 3 call sites |

Two things that table shows, both deliberate:

- **A high test:prod ratio is a good sign, not bloat.** Do not flag it.
- **Comment lines exceeding code lines is normal here** and is not
  bloat when the comment explains *why* — every one of the above
  records a defect's mechanism or a non-obvious constraint. Flag
  comments that restate the code, not comments that carry history.

Raise a **blocking** finding when any of these hold:

- Production LOC is **an order of magnitude** beyond what the stated
  defect requires, and the excess is not itself explained in the PR.
- New **abstraction** with fewer than ~3 call sites and no concrete
  near-term reuse case — default is to inline.
- **Dead code**: an export, branch, or option with no call site. Verify
  by grepping `origin/main` *after* the merge base, not a local branch —
  a stale checkout produces false "unused" findings.
- **Defensive handling for cases that cannot occur** given the
  surrounding code's invariants.
- New **env var / on-disk path / config key** that is not required by
  the fix. Each one is permanent surface area.

Do **not** flag: test volume, fixtures, comment density explaining
mechanism, or complexity you cannot show is safe to remove. Per the
global rule, never assert a simplification is behavior-preserving when
you have not verified it — say you could not verify instead.

### Missing Non-Functional Requirements

A community PR over roughly **300 production LOC** should carry a
`## Non-Functional Requirements` section (same checklist as a
directive), including the required **Load-bearing?** yes/no. If it is
absent, say so as an attention item and ask for it — do not block on it
alone, and do not treat its absence as licence to skip the size
question. Independently assess load-bearing status yourself: an author's
"no" on something touching a wire contract, shared abstraction, or
security-relevant path is a blocking finding, because that
classification decides whether a human reviews before merge.

## Repo-Specific Labels

In addition to the global review-outcome labels (`reviewed-by-codex-agent`,
`approved-by-codex-agent`, `changes-requested`), apply:

- `schema-change` — Changes affect extension pipeline interface,
  telemetry format, or config schema.
- `needs-sim-validation` — Requires integration testing with live CC
  traffic.
