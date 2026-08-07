# Review: PR #302 pre-publication guards directive

Date: 2026-08-07
Reviewed: `docs/directives/pre-publication-guards.md` at `4311f9c`
Round: 1
Label applied: `changes-requested`

## What Is Correct

- **Measured** — The directive is docs-only. `gh pr view 302 --json files` reports one added file, `docs/directives/pre-publication-guards.md`, with 189 additions and zero code files.
- **Read** — The layering premise is sound: `docs/directives/pre-publication-guards.md:22-45` correctly separates pre-push prevention from CI detection/containment. GitHub Actions' `pull_request` workflow runs when PR activity occurs, including `opened` and `synchronize`, and GitHub documents fork PR events as events sent to the base repository after the fork-origin PR activity exists. That makes CI a lagging layer for public fork PR exposure, not a pre-publication gate.
- **Read** — The directive correctly rejects value-echoing findings. `docs/directives/pre-publication-guards.md:92-95` requires class/count output only, which is the right constraint for a scanner whose inputs may contain the data being protected.
- **Read** — The size budget is proportionate for a directive-only security guardrail. `docs/directives/pre-publication-guards.md:111-114` bounds the implementation to a hook wrapper, installer, CI step, and docs section, excluding the scanner dependency.
- **Measured** — Info hygiene on the directive text itself is clean for the requested patterns. A targeted `rg` scan for IPv4 literals, `visits-0[0-9]`, and the operator home-path literal returned no matches in `docs/directives/pre-publication-guards.md`.

## Blockers

1. **[Read] The committed directive still specifies the rejected hook installation shape and leaves the resolved decision open.** `docs/directives/pre-publication-guards.md:56-58` puts the hook under `hooks/pre-push` and installs via `core.hooksPath`; `docs/directives/pre-publication-guards.md:175-178` still asks whether `core.hooksPath` is acceptable. That conflicts with the PR thread decision to use `scripts/install-git-hooks.sh` plus a `.githooks/pre-push` chaining wrapper so existing `.git/hooks` entries survive. The constraint is real: `core.hooksPath` replaces Git's hook lookup directory for the repository, so it does not preserve host-local `.git/hooks/post-merge` / `post-checkout` hooks unless those hooks are migrated into the tracked hook path. A directive merged in the current state would bind implementers to the wrong shape.

2. **[Read] The committed directive still contains unresolved open questions and the wrong CI disposition.** `docs/directives/pre-publication-guards.md:165-178` keeps all three open questions in the spec, and `docs/directives/pre-publication-guards.md:170-174` still leans toward blocking CI. The thread resolved Q1 as standalone scanner, Q2 as annotate, and Q3 as chain installer. Because this PR is a directive-only PR, the file itself is the artifact implementers will build against; relying on comments to override contradictory directive text is not implementable enough for merge.

3. **[Read] The load-bearing NFR is incomplete for this repo's review rules.** `docs/directives/pre-publication-guards.md:126-127` correctly marks the change load-bearing, but it does not state the required downstream consequence from `CLAUDE.md:94`: load-bearing changes require Chris human review before merge, not just Lead + Codex. Since this directive commits downstream implementation PRs to a security-relevant publication gate, the directive should explicitly carry that requirement.

## What Needs Attention

- **[Read] The leak taxonomy should explicitly decide the remaining capture-shaped identifiers before implementation.** The directive's catchable list at `docs/directives/pre-publication-guards.md:97-103` includes UUIDs, PEM blocks, high-entropy strings, home paths, IP literals, and SSH targets, and it honestly says long third-party prose is only heuristic-reviewable. It should also explicitly accept or reject coverage for Anthropic/GitHub object-shape IDs such as `msg_`, `req_`, `toolu_`, JWT/base64url-dot tokens, and origin hostnames or hostname-port-stack fingerprints. Some may be covered by high-entropy heuristics, but the directive should not leave that as an inference.
- **[Read] `docs/directives/pre-publication-guards.md:159-163` defers the upstream corpus-scope decision: either choose an equivalent semantic scan scope or accept byte-level-only coverage. That is a real implementation decision, not just a note. It should be resolved in the directive or turned into an explicit implementation acceptance criterion.

## Bloat / Non-Functional

None. The directive is 189 lines for a nontrivial security guardrail and is not oversized. The implementation budget is small and reviewable once the stale decisions are corrected.

## Recommendations

- Update `docs/directives/pre-publication-guards.md:52-63` to specify `scripts/install-git-hooks.sh` and `.githooks/pre-push`, with chaining semantics for pre-existing `.git/hooks/<name>` content.
- Replace `docs/directives/pre-publication-guards.md:165-178` with a "Resolved decisions" section: scanner lands standalone via #306 or equivalent; CI annotates and does not block for scanner findings; chain installer wins over `core.hooksPath`.
- Add the explicit load-bearing review rule: downstream implementation PRs require Chris human review before merge.
- Add an acceptance-criteria bullet for semantic classes: enumerate the exact classes the scanner/hook must cover, and document any intentionally deferred classes.

## Bottom Line

Request changes. The security layering argument is right, and the directive is close, but the committed file has not been updated to match the decisions already made in the PR thread. Merge would leave implementers with contradictory instructions on the two load-bearing choices: CI behavior and Git hook installation.

— Codex review
