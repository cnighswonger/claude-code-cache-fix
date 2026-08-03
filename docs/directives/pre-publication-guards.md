# Directive: pre-publication guards for capture-derived data

Status: **proposed** — directive only, no implementation in this PR.

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

1. `hooks/pre-push` — tracked, installed via `core.hooksPath`, scanning the
   **incoming diff only**.
2. `hooks/install.sh` — one command, works for contributors and maintainers.
3. A CI step in the existing `.github/workflows/test.yml` (`pull_request`
   already triggers there) running the same scanner over the PR diff.
4. A `CONTRIBUTING.md` section: install the hook before your first push. The
   pre-publication gate is contributor-side; a contributor who does not install
   it has no gate at all.

**Explicitly out of scope:**

- **Writing a scanner.** `tools/absence-scan.mjs` already exists in
  @Gunther-Schulz's fork, is class-based and importable, and already runs as his
  own pre-push guard — exercised against real captures. Per the anti-bloat lens,
  a second implementation needs justification and there is none. This directive
  **depends on** that scanner landing (asked on #292); it does not reimplement
  it.
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

**Mechanical classes only, and say so.** Catchable: UUIDs, PEM blocks,
high-entropy strings, `/home/<user>` and `/Users/<user>` paths, IPv4/IPv6
literals, `ssh <user>@<host>`. Not catchable: 2,305 characters of someone
else's GitHub comment, which is what #292 actually carried and what a human
noticed. A heuristic flagging unusually long verbatim strings under
`test/fixtures/` would surface it *for review* — that is the honest ceiling,
and the directive should not imply more.

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
  mode is irreversible.

## Open questions

1. **Does the scanner land standalone?** Asked on #292. If @Gunther-Schulz
   prefers to own the whole thing including the hooks, this directive should be
   closed in favour of his.
2. **Should the CI step block merge or annotate?** Blocking is stronger;
   annotating avoids a fork PR being unmergeable over a false positive the
   contributor cannot iterate on quickly (fork PRs get no CI here until
   approved). Leaning blocking, on the grounds that the failure it prevents is
   unrecoverable.
3. **Is `core.hooksPath` acceptable?** It replaces `.git/hooks` wholesale, so
   anyone with existing local hooks in this repo loses them unless the
   installer chains. The maintainer host has a `post-merge`/`post-checkout`
   pair that must survive.

## Why this is a directive and not a PR

The implementation depends on a contributor's component landing first, and the
question of who owns the whole thing is open. Filing the reasoning now so the
layering argument exists in public — the "CI will catch it" assumption is the
one that needs correcting, and it needs correcting before someone relies on it.

Refs #292, #272

— Proxy Builder
