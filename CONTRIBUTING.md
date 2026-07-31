# Contributing

Thanks for working on this. A proxy that sits in front of everyone's API
traffic has an unusually low tolerance for surprises, so a few things
here are stricter than a typical repo.

## Using an AI agent? Read this part.

Most contributions here — ours included — are written with AI assistance.
That is fine and welcome. But agents reliably satisfy the *functional*
requirement and neglect the non-functional ones: size, complexity, new
surface area. A change that works and is four times larger than it needs
to be still costs every future reader.

If you point an agent at this repo, point it at these files too:

- **`AGENTS.md`** — what our reviewer checks, including the anti-bloat
  lens and how we size a change against the defect it fixes.
- **`CLAUDE.md`** — workflow, labels, and the non-functional checklist.

Both are committed at the repo root. They are written for our own agents,
so some sections are internal (bot identities, label ownership) — ignore
those. The review standards apply to every PR regardless of who or what
wrote it.

Two habits that make an agent-written PR much easier to accept:

- **Have it justify the size.** "What is the smallest change that fixes
  this?" is a question worth asking before you open the PR, because it is
  the first one we ask.
- **Have it check its own claims.** If the PR body says a function is
  only called in two places, or a value is bounded, verify it. We
  cite-check load-bearing claims against the source, and a confident
  wrong claim costs a review round.

## What we check

- **Does it fix what it says it fixes?** Red-first evidence is
  persuasive: show the test failing on the merge base and passing at your
  head. Several recent PRs did this and it shortened review considerably.
- **Is it proportionate?** See the anti-bloat lens in `AGENTS.md`. A high
  test-to-code ratio is a *good* sign — we do not count tests against
  you. Comments that explain *why* are likewise welcome.
- **Is it load-bearing?** Anything touching a wire contract, a shared
  abstraction, TLS trust, credentials, or the on-disk format needs human
  review before merge, not just agent review. Say so in the PR if you
  think it applies.
- **Does the test cover the changed path?** Not an adjacent one.

## PRs over ~300 lines of production code

Include a `## Non-Functional Requirements` section in the PR body. Short
answers are fine — a line or two each, `n/a` where it genuinely does not
apply:

- **Size/complexity budget** — roughly how big should this be, and is it?
- **Threat model** — inputs, trust boundaries, what must not leak. This
  proxy handles API keys and full request/response bodies; be specific.
- **Maintainability** — new abstractions need a reason (≈3+ call sites or
  concrete near-term reuse). Otherwise inline it.
- **Performance/reliability** — only where it applies.
- **Load-bearing?** — required yes/no.

## Practical notes

- **Fork PRs do not get CI.** GitHub gates workflow runs on forks behind
  maintainer approval, and our review bot cannot clear that gate. We run
  the full suite locally at the merge commit instead and report the
  count on the PR. Nothing is required from you — just know that a
  missing green check is not a problem with your PR.
- **Rebase rather than merge** when your branch goes stale. We merge one
  PR at a time and test between merges, so a clean fast-forward matters.
- **We will not push to your branch.** If something needs changing we
  will ask. (We got this wrong once and reverted it — your branch is
  yours.)
- **Draft means draft.** We will not flip a PR out of draft for you.

## Reporting a bug you have not fixed

An issue with a reproduction is worth as much as a PR. Wire captures,
`--output-format json` output, and "works with the proxy bypassed"
comparisons are all especially useful — several of the subtlest bugs
here were diagnosed from exactly that.
