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

## Evidence Class (every finding, every reviewer)

The global baseline asks you to distinguish what is **confirmed correct**
from what is **assumed or hypothesized**. That is a disposition, and a
disposition is self-assessed: a reviewer who read a code path and found
it plausible will file it honestly under "confirmed."

So state *how* you know, not just that you know. Tag every finding —
blocking or not — with one of three classes:

- **Measured** — you ran something. Name the command and paste the
  result. `node --test test/proxy-read-dedupe.test.mjs` →
  `actual: 'insertion-normalization', expected: 'cache-control-normalize'`.
- **Read** — you read the code. Cite `file:line`, and say plainly that
  it is a code read. Reading proves a path *exists*, not what it does on
  real traffic.
- **Reported** — the author's claim, or another agent's. Name the source
  and say you did not reproduce it. Never restate it as fact.

**The hard rule:** a load-bearing claim from a PR body may not be
repeated as fact in a review without independent measurement. If you
cannot measure it, mark it *Reported* and say what would settle it.

This binds every reviewer — Codex, the implementation agent's own
maintainer comments, and any third model added later. A finding relayed
without its class is not usable by the next reader.

### Look at CI before approving

**Check the status rollup on the head you are approving. Cancelled,
pending, queued, and absent are all "not green."** Say which you saw.

This is the cheapest control available and the easiest to skip, because
a PR page shows a review box and a checks box and only one of them asks
for your attention.

Measured on #296, from the review and workflow timestamps:

```
head       CI                    approvals                  green first?
82c9f27e   cancelled   11:06Z    10:46Z, 15:18Z             no
4a32d142   never completed       16:39Z, 17:18Z             no
5e6a2e04   success     17:56Z    19:13Z, 19:18Z             yes
```

Four of the six approvals landed against a matrix that was cancelled or
still running, and no review on those two heads cited a check status.
`4a32d142` was approved twice while its run sat `in_progress` — on a
defect that made the suite hang forever on two of the three supported
runtimes, which is why that run never finished. The last head is what
the rule looks like when it is followed.

Approving ahead of CI is sometimes right; a fork PR whose workflow needs
maintainer authorisation cannot go green before someone acts. Then say
so — *"approved with CI pending, on the following local run"* — so the
next reader knows the checkmark was not part of the evidence.

### A local run is evidence only for the runtime it ran on

**State the runtime beside the count.** `1543/1543` is not a result;
`1543/1543 on node v24.11.1` is.

When the package declares an `engines` range, exercise the **floor**
before approving, not just whatever is on your PATH. A version-specific
defect is invisible to any number of runs on one version — repetition
measures flakiness, not portability.

Measured on #296, and reproducible from the PR thread: the full suite
passed `1543/1543` on node v24.11.1 — repeatedly, and for both
independent reviewers. On node v20.20.2 all 36 CA tests pass and **the
process never exits**, because a positive control the tests depend on
cannot be established below v22.15. `npx node@20 --test` took under a
minute and would have caught it. `package.json` declares
`engines: >=18`, and the CI matrix is 18/20/22 — so the runtime that
everyone measured on was the one runtime CI does not cover.

This is an Evidence Class failure of exactly the shape this section
exists for: the measurement was real, honestly reported, and certified
nothing about two thirds of the supported surface. Same family as
running a genuine TLS handshake through the API production does not
call.

### Why this rule exists

On PR #270 the reviewer **endorsed** a claim about agent-id availability
that measurement later destroyed. Measured 2026-06 during that review:
the canonical header was present on 38 of 121,685 requests (0.03%), and
0 of 176,344 usage rows were populated. Re-measured 2026-07-31 against a
now-larger log: still **0 of 184,976**. The claim was plausible, the code
path existed, and a second model family agreed with it. Cross-family
review did not catch it. One query did.

Two consequences worth internalizing:

- **A reviewer agreeing is not verification.** Correlated plausibility
  is what agreement measures.
- **Measurement is usually cheap.** The two queries that settled #270's
  design were one command each; run on day one they would have prevented
  most of five review rounds.


## Predicates That Predict Another Program

**When a change decides trust, admission, or rejection — or more
generally when any predicate's job is to predict another program's
behavior — the review must run adversarial inputs through the real
decision path and compare against the oracle production actually uses.
A code read is not sufficient evidence for a claim about which inputs
it accepts.**

Two corollaries. They are the load-bearing part; the rule above them
would not have caught the case that produced it.

- **A. The oracle must be the *same API* production calls, not merely
  a real one.** A real check through the wrong entry point is a green
  test that certifies nothing.
- **B. Before relying on a test as evidence, verify it reaches the
  shipped code — mutate the code and confirm the test fails.**

**"We have tests" is the most common form the reassurance takes, and
it is the one that failed here.** Measured on merged `23346ac9`:
mutating the launcher's CA guard to accept unconditionally left
`test/proxy-forward-ca.test.mjs` passing **12/12**, because the test
exercised a hand-copied twin of the logic rather than the shipped
function. Both reviews cited the suite's pass count; neither established
that it reached the shipped guard.

### Phrasing

Claims of the form *"conservative, never permissive"* / *"fails
closed"* / *"cannot accept X"* are universal quantifications over an
input space. State them **Measured with the input set named**, or
downgrade to a floor: *"these shapes were checked; the set is not
known to be complete."*

### Why this rule exists

PR #283's `ca-trust` guard merged with two approvals and independent
verification of every blocker. It is wrong in **both** directions, and
both reproduce on `main`:

- **False reject** — `new X509Certificate(block)` runs on every PEM
  block and the throw escapes; one CRL in a bundle voids the whole
  file. Rejection is not the safe direction: the fallback drops every
  sibling CA, which is the failure the contract exists to prevent.
- **False accept** — `X509Certificate` ignores the PEM label, so our
  CA relabelled `TRUSTED CERTIFICATE` yields byte-identical DER and
  passes, while node's loader skips any block not labelled exactly
  `CERTIFICATE`.

That review was not lazy — it measured a write→rename race at 0.88 ms
over 5,000 iterations, grepped the rendezvous path, checked file modes —
**and never fed the guard a realistic bundle.** The shape to watch for
is *verifying the checkable parts and reasoning about the deciding
part*, and it is invisible from inside because the deciding function
usually looks readable.

That predicate shipped in #283 and was still being corrected in #296 —
two PRs, and the defects above were found after both had been approved.
When a single function keeps producing new defects after review has
signed off on it, stop asking whether reviewers were diligent and ask
whether the design is a model of an oracle that already exists.

### Read the README before reviewing the code

**When a change depends on what some other program does — a runtime, a
client, an upstream API — read this repo's own README and CHANGELOG
history for that program before reviewing the diff.** The project's
accumulated knowledge of it lives there, and a reviewer who skips it
re-derives from the code alone and will re-derive wrong.

Concretely, and measured against the review bodies themselves: **no
review on #283 mentions Bun or BoringSSL** (0 of 3 — two written Codex
rounds and one empty-bodied approval), while both written rounds reason
about node's `X509Certificate` and node's CA loader. The client stopped
being node at CC v2.1.113, which is documented in this file, in
`README.md`, in `CHANGELOG.md`, and is the reason the `NODE_OPTIONS`
preload was abandoned and this proxy exists in its current form.

The guard documented its own limitation too. It carried the comment
*"Still only a pre-flight guard, not proof… never that **Node** will
verify a given leaf with it. Only a handshake shows that, and the
launcher does not perform one"* (`23346ac:bin/claude-via-proxy.mjs`,
replaced by #296). That comment was **partly answered and partly
misread**: #283 round 1 credits the new tests with verifying "the guard
against real TLS authorization outcomes," so the handshake gap was
noticed — but the handshake in question ran through `tls.connect({ca})`,
which is not the API the launcher uses. The limitation was read, and
answered with the wrong oracle.

The runtime fact stayed unexamined for three further rounds, until it
was measured directly against the shipped binary.


### The expectations are part of what gets checked

Corollary B says mutate the code to prove the test reaches it. That is
not sufficient on its own: **when a test asserts what another program
does, the expectation itself must have come from that program.**

A row in the CA guard's shape table recorded the predicate's own
behaviour as the expected value. It survived every review that reached
it, and was found only when @codeslake ran the table against the real
loader while building #296's oracle — reported on that PR. The suite was
green throughout.

### Where else it applies

The CA guard is one instance. The unifying property is that **the
oracle exists and we chose to model it instead of calling it.** Also
in this class: `git push --dry-run` as a test of a branch ruleset (it
reports success against a ruleset the server never consulted — read
`gh api repos/<o>/<r>/rulesets` instead); a schema pre-check ahead of
a strict parse; any validator predicting a downstream parser.

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
