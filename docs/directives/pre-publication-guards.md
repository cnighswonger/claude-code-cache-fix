# Directive: pre-publication guards for capture-derived data

Status: **approved** (all open questions resolved on this PR's thread; see "Resolved decisions" below). Directive only, no implementation in this PR.

## Goal

Stop capture-derived identifiers reaching public git history. Testing this
proxy well requires real Claude Code traffic; the fixtures that make the tests
meaningful are the same artifacts that carry session UUIDs, thinking
signatures, filesystem paths, and other people's words. That tension is
permanent — we will keep testing against real data — so the guard has to be
structural rather than a habit.

Three known instances:

| case | arrival path | reached public? |
|---|---|---|
| `test/fixtures/cc-transcript-shape-snapshot.json` (#292) | our own commit, `16ad235` (#221) | yes — on `main` since 2026-06-12 |
| conversation-derived fixture (#272) | fork PR | yes — in `refs/pull/272/head` |
| origin IP in `SESSION_STATE.md` (`claude-code-meter#19`) | our own push | yes — remediated by rotating the host |

## The layering, stated precisely

This is the part that has been getting confused, including by me. **CI cannot
prevent exposure.**

| layer | prevents publication? | sees fork PRs? | bypassable |
|---|---|---|---|
| contributor pre-push | **yes** | yes — the only layer that does | yes (`--no-verify`) |
| maintainer pre-push | our own commits only | no | yes |
| CI on `pull_request` | **no** | yes | no |

A fork PR's diff is public the instant it opens; CI starts afterward. The
objects also land in **this** repo as `refs/pull/N/head` and persist there even
if the PR is closed or the fork is deleted (verified: `#294` and `#296` are
resolvable on `origin`).

So each layer earns something different, and none substitutes for another:

- **Pre-push hooks** are the only pre-publication gate that exists. They are
  bypassable by design, which is correct for a hook and disqualifying for a
  gate.
- **CI** is detection and containment: it keeps data off `main`, off tags, and
  off npm, and it bounds the exposure window so remediation knows what to treat
  as burned.

Public git history cannot be scrubbed. Remediation is always forward-looking —
rotate the resource, synthesize the fixture, treat the identifiers as burned.
That is why the guard's value is measured in what it prevents, not what it
finds.

## Scope

**In scope:**

1. `.githooks/pre-push` — tracked shell wrapper. **Chains** to any existing
   `.git/hooks/pre-push` first (calling it with stdin passed through and
   respecting its exit code), then calls the standalone scanner in
   `--git-range <old>..<new>` mode over the incoming diff. See "Resolved
   decisions" for why this is a chain wrapper and not `core.hooksPath`.
2. `scripts/install-git-hooks.sh` — one command. Copies (or symlinks) each
   `.githooks/<name>` to `.git/hooks/<name>`, preserving any prior content by
   moving it to `.git/hooks/<name>.chained` first; the wrapper reads
   `.chained` and exec's it before running the guard. Works for contributors
   and maintainers.
3. A CI step in `.github/workflows/test.yml` (`pull_request` already triggers
   there) running the same scanner over the PR diff. **Annotates only** — see
   "Resolved decisions" for why this doesn't block merge.
4. A `CONTRIBUTING.md` section: install the hook before your first push. The
   pre-publication gate is contributor-side; a contributor who does not install
   it has no gate at all.

**Explicitly out of scope:**

- **Writing a scanner.** `tools/absence-scan.mjs` already exists in
  @Gunther-Schulz's fork (visible in #276), is class-based and importable, and
  already runs as his own pre-push guard — exercised against real captures. Per
  the anti-bloat lens, a second implementation needs justification and there is
  none. This directive **depends on** that scanner landing (asked on #292); it
  does not reimplement it.
- **Adding capability to that scanner.** Measured 2026-08-03 against the #292
  file: it already has the shebang, the `import.meta.url` main-module guard,
  `0`/`2`/`1` exit codes, and a **`--git-range <old>..<new>`** mode built for a
  pre-push caller. It reported class, JSON path, and length for all 10 findings
  and never echoed a value. Every design constraint below was already satisfied
  by it before this directive was written; nothing here asks for new features.
- History rewriting. Not available on a public repo.
- Secret scanning generally. GitHub's own scanning covers credentials; this is
  about capture-derived identifiers, which are not secrets and which no
  off-the-shelf scanner recognizes.

## Design constraints

**Scan the diff, not history.** The untracked `pre-push` currently on the
maintainer host scans all reachable history and produced **77** false positives
on a single rebase (0 when pushing by remote name). A noisy guard gets
`--no-verify`'d and then protects nothing. The hook must scan only what the
push adds.

**Classes, not values.** Findings must report class and count — "6 UUIDs, 1
signature, 1 absolute home path" — never the matched strings. A guard that
echoes what it found into a terminal, a CI log, or a PR comment has published
it a second time. #292 was reported this way and it is the right pattern.

**Mechanical classes only, and say so.** Catchable, in the required
implementation scope:

- Session/message UUIDs (8-4-4-4-12 lowercase hex)
- Anthropic/CC object-shape IDs: `msg_[A-Za-z0-9]{22,}`, `req_[A-Za-z0-9]{22,}`,
  `toolu_[A-Za-z0-9]{22,}`
- GitHub node IDs: `IC_kw[A-Za-z0-9_+/=]{20,}`, `PR_kw...`, `MDU...`-shape
  legacy IDs
- Base64-shape runs >200 chars (thinking signatures, JWTs, PEM bodies)
- PEM block delimiters
- `/home/<user>` and `/Users/<user>` filesystem paths
- IPv4/IPv6 literals
- `ssh <user>@<host>` lines
- Internal hostnames matching the operator's configured list (default:
  `visits-0[0-9]`, extensible via `git-push-guard/patterns`)

Not catchable mechanically: 2,305 characters of someone else's GitHub comment,
which is what #292 actually carried and what a human noticed. A heuristic
flagging unusually long verbatim strings under `test/fixtures/` would surface
it *for review* — that is the honest ceiling, and the directive should not
imply more.

**Deferred (documented, not implemented):** hostname-port-stack fingerprints
(e.g. `hostname:port + node/nginx/systemd`), because we do not yet have a
non-brittle regex; and origin-service-name fingerprints (e.g. Cloudflare
worker IDs), because the enumeration is open-ended. These are review-time
checks per CLAUDE.md § Public-Repo Information Hygiene, not scanner classes,
until we have a concrete false-fire rate to argue from.

**Fail closed with an override that is visible.** Exit non-zero on a finding.
`--no-verify` remains available because git provides it; the CI backstop is
what makes bypassing it survivable.

## Non-Functional Requirements

- **Size/complexity budget** — small: a `pre-push` wrapper, an installer, one
  CI step, one docs section. Roughly 150-250 LOC total *excluding* the scanner,
  which is a dependency. If an implementation lands materially larger, the
  scanner boundary has probably been violated.
- **Threat model** — the guard reads diffs that may contain the very data it is
  looking for. It must never write matched values to stdout, stderr, a log, or
  a CI annotation. Counts and class names only. It runs on contributor machines
  and must not phone home, read outside the repo, or write anywhere but its own
  exit code.
- **Maintainability constraints** — one scanner implementation, three call
  sites (contributor hook, maintainer hook, CI). No second copy. No vendored
  fork of the scanner.
- **Performance/reliability** — pre-push runs on every push; diff-scoped
  scanning keeps it sub-second on normal changes. A scanner failure must fail
  the push, not silently pass.
- **Load-bearing?** — **yes.** It gates what becomes public, and its failure
  mode is irreversible. Per CLAUDE.md § Non-Functional Requirements &
  Anti-Bloat, all downstream implementation PRs (scanner integration, chain
  installer, `.githooks/pre-push` wrapper, CI annotate workflow, CONTRIBUTING
  section) require **Chris human review** before merge, not just Lead + Codex.
  This is called out explicitly here so no downstream PR under this directive
  can slip merge on two LLM approvals alone.

## Fork-vs-upstream boundary conditions

Two settings in the scanner are correct for the fork it was written in and
wrong here. Both are recorded because they would otherwise survive the move by
inertia.

**1. The `#292` file is allowlisted.** `tools/absence-scan.mjs:50-55` exempts
`test/fixtures/cc-transcript-shape-snapshot.json` by name. Measured — running
the range that introduced it returns clean:

```
$ node tools/absence-scan.mjs --git-range edf3ed7..16ad235
allowlisted: test/fixtures/cc-transcript-shape-snapshot.json
absence-scan: clean                                             exit 0
```

The rationale is documented and sound for a fork: the file is upstream's, was
public before the scan existed, and a new-branch push scans `EMPTY..tip`, so it
would go red forever on content the fork cannot change. Upstream it inverts —
once the fixture is synthesized (#292), **that entry must be removed** or the
guard is permanently blind to the one file known to have leaked.

**2. Corpus scoping has no upstream equivalent.**
`CORPUS_SCOPE = /(^|\/)test\/fixtures\/harvested\//` limits three of the five
classes to the fork's harvest tree; elsewhere only `b64-run` and `capture-uuid`
fire. The rationale is the strongest measurement in the file: **219 findings
unscoped, ~205 of them synthetic hand-authored test data**, and a guard that
fires on non-defects trains the `--no-verify` reflex that kills it. False-fire
rate on the two byte-level classes was zero.

This repo has no `test/fixtures/harvested/`. So upstream must either scope the
semantic classes to an equivalent or accept byte-level-only coverage. Note
byte-level-only would still have caught #292 — 9 of its 10 findings are
byte-level.

**Resolved (acceptance criterion for the impl):** the upstream integration
runs the semantic classes over `test/fixtures/**` (the whole fixtures tree),
not just a harvested subdirectory. Byte-level classes remain repo-wide. If
the semantic-class false-fire rate against the current fixture tree exceeds
the fork's measured zero on byte-level, the impl PR must either narrow the
scope with justification or add per-class exemptions (documented, not
inferred). The measurement gate must be on the impl PR body, not deferred.

## Resolved decisions

Answered by Chris on this PR's thread — the authoritative
[decision comment](https://github.com/cnighswonger/claude-code-cache-fix/pull/302#issuecomment-5208602677)
carries Q1/Q2/Q3 verbatim. Reproduced in the directive so implementers build
against the file, not the thread.

1. **Scanner ownership: standalone (not bundled with #276).** Landed as
   [#306](https://github.com/cnighswonger/claude-code-cache-fix/pull/306).
   This directive **depends on** #306 (or its split-out equivalent) reaching
   `main` before any impl PR under this directive can land. The scanner's
   `--git-range` mode is the required surface.
2. **CI: annotate, not block.** *"Once a thing is public, it is public. The
   one pushing owns it."* The scanner's two-exit-code shape (0 clean, 2
   findings) makes annotate cheap: CI reads exit code and posts a PR check
   annotation without gating merge. Fork PRs (which get no CI here until
   approved) are not made unmergeable over a false positive. Prevention is
   pre-push's job; CI is detection and containment, and its value survives
   annotating.
3. **Chain installer, not `core.hooksPath`.** `core.hooksPath` replaces
   `.git/hooks` wholesale for the repo, which would blow away the maintainer
   host's `post-merge`/`post-checkout` hooks (and any contributor's local
   hooks). A small `scripts/install-git-hooks.sh` + per-hook shell wrapper
   (`.githooks/<name>`) that first exec's any `.git/hooks/<name>.chained`
   preserves existing content per-hook, without owning the whole hooks
   directory.

## Why this is a directive and not a PR

The implementation depends on a contributor's component landing first, and the
question of who owns the whole thing is open. Filing the reasoning now so the
layering argument exists in public — the "CI will catch it" assumption is the
one that needs correcting, and it needs correcting before someone relies on it.

Refs #292, #272

— Proxy Builder
