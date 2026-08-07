# Review: PR 302 pre-publication guards directive

Date: 2026-08-07
Reviewed: `docs/directives/pre-publication-guards.md` at `129940c36e6be6b73e291e177684cf23c36f40b9`
Round: 2
Label applied: `changes-requested`

## What Is Correct

The R1 implementation-shape blockers are mostly resolved in the directive body:

- `docs/directives/pre-publication-guards.md:56` now specifies `.githooks/pre-push` as the tracked wrapper and describes chaining to an existing `.git/hooks/pre-push`.
- `docs/directives/pre-publication-guards.md:61` now specifies `scripts/install-git-hooks.sh` with preservation-via-rename semantics using `.git/hooks/<name>.chained`.
- `docs/directives/pre-publication-guards.md:66` now says CI annotates only.
- `docs/directives/pre-publication-guards.md:155` now explicitly states that downstream implementation PRs require Chris human review before merge.

The two R1 needs-attention items are also now directive requirements:

- `docs/directives/pre-publication-guards.md:108` through `docs/directives/pre-publication-guards.md:119` enumerate the expected leak taxonomy, including object-shape IDs, GitHub node IDs, base64-shape runs, PEM delimiters, home paths, IP literals, SSH host lines, and configurable internal-hostname patterns.
- `docs/directives/pre-publication-guards.md:127` documents deferred hostname/service fingerprint classes with a reason.
- `docs/directives/pre-publication-guards.md:198` makes upstream corpus scoping an implementation acceptance criterion, with measurement-gated narrowing/exemption handling.

Info-hygiene spot check did not find actual operator home paths, IPv4 literals, or root SSH command lines in the directive. The `visits-0[0-9]` text is used only as the intended scanner-configurable pattern reference.

## Blockers

1. **Resolved-decision citations still do not point to Chris's decision trail.**

   R1 blocker 2 required the open questions to be replaced by resolved decisions carrying issue-comment permalinks to Chris's decision comments. The current directive says the decisions were "Answered by Chris" and then cites `#issuecomment-5208032266` and `#issuecomment-5208148217` at `docs/directives/pre-publication-guards.md:208`.

   That does not satisfy the requirement. `#issuecomment-5208032266` is Proxy Builder's recommendation/proposal comment, not Chris's decision. `#issuecomment-5208148217` returns 404 through the GitHub API. Chris's actual decision comment on this PR is `#issuecomment-5208602677`, and it contains the three authoritative answers:

   - Q1: Standalone.
   - Q2: Annotate.
   - Q3: Chain installer is the better path.

   The directive should cite Chris's actual decision permalink, and remove the invalid/non-authoritative citation from the "Answered by Chris" sentence. As written, the decision text is mostly correct, but the resolution trail is still wrong, which was one of the hard R1 requirements for this round.

## What Needs Attention

None beyond the blocker.

## Bloat / Non-Functional

None.

## Recommendations

Replace the "Answered by Chris" citation sentence with a link to `https://github.com/cnighswonger/claude-code-cache-fix/pull/302#issuecomment-5208602677`. If the proposal comment remains useful background, label it as Proxy Builder's proposal rather than Chris's decision source.

## Bottom Line

Request changes. The directive now matches the substantive R1 decisions, but the source trail in "Resolved decisions" still fails the R1 requirement because it cites a bot proposal and an invalid comment ID instead of Chris's decision comment. Fixing that citation path should be a very small R3.

— Codex review
