# Review: PR #194 scrub of operator paths and internal-host refs

Date: 2026-06-04
Reviewed: PR #194 — chore(scrub): operator paths and internal-host refs from public-tracked files
Label applied: `changes-requested`

## What Is Correct

- The core scrub is directionally right: `AGENTS.md` now bans operator-absolute review citations and standardizes in-repo citations on repo-relative `#LNNN` anchors ([AGENTS.md](AGENTS.md#L67)).
- The in-repo anchor rewrite mostly landed correctly. I spot-checked converted citations in prior reviews and the anchors still point at the intended live lines, e.g. [docs/code-reviews/pr-66-deferred-tools-restore-impl-review-2026-04-24.md](docs/code-reviews/pr-66-deferred-tools-restore-impl-review-2026-04-24.md#L10) -> [proxy/extensions/deferred-tools-restore.mjs](proxy/extensions/deferred-tools-restore.mjs#L223) / [README.md](README.md#L284), and [docs/code-reviews/pr-88-image-guard-implementation-codex-review-2026-04-30.md](docs/code-reviews/pr-88-image-guard-implementation-codex-review-2026-04-30.md#L10) -> [proxy/extensions/image-strip.mjs](proxy/extensions/image-strip.mjs#L523) / [test/proxy-image-guard.test.mjs](test/proxy-image-guard.test.mjs#L512). An automated bounds check over the changed review docs found no missing or out-of-bounds repo-local `#L` targets.
- The `CLAUDE.md` fixture restoration is correct. The detector intentionally requires `Contents of /...CLAUDE.md` ([proxy/extensions/messages-cache-breakpoint.mjs](proxy/extensions/messages-cache-breakpoint.mjs#L57)), and the scrubbed fixture keeps that absolute-path shape via `/repo/CLAUDE.md` ([test/proxy-messages-cache-breakpoint.test.mjs](test/proxy-messages-cache-breakpoint.test.mjs#L53)).
- The pre-existing placeholders the PR intentionally left alone are indeed good content, not leaks: the X-Forwarded-For regression test asserts its synthetic forwarded-for value does not survive into audit output ([test/proxy-bootstrap-defense.test.mjs](test/proxy-bootstrap-defense.test.mjs#L528), [test/proxy-bootstrap-defense.test.mjs](test/proxy-bootstrap-defense.test.mjs#L549)), and the public-doc SSH examples already use placeholders rather than literal origins ([CLAUDE.md](CLAUDE.md#L107), [CLAUDE.md](CLAUDE.md#L116)).
- I reran the two touched suites and both are green: `node --test test/proxy-messages-cache-breakpoint.test.mjs test/proxy-deferred-tools-restore.test.mjs` passed 82/82.

## Blockers

- One converted review doc still uses markdown link targets that are not repo-relative and do not resolve on GitHub. [docs/code-reviews/pr-117-gh-bot-guard-codex-review-2026-05-09.md](docs/code-reviews/pr-117-gh-bot-guard-codex-review-2026-05-09.md#L10) and adjacent lines now point at `~/.claude/...#LNN` / `~/.claude/memory/...#LNN`. That removes the literal operator path, but it still leaves broken markdown links in public-tracked content, which is the exact class this PR is trying to normalize away. For off-repo/local-only artifacts, use plaintext code-form paths instead of markdown links.
- This PR also introduces unrelated tracked artifacts: [package-lock.json](package-lock.json#L1) and [.possibilities/metrics.json](.possibilities/metrics.json#L1). Neither change is part of the scrub objective, both broaden review scope, and `.possibilities/metrics.json` is plainly runtime-generated state rather than repo source. They should be dropped from this PR unless you want a separate intentional change to start tracking them.

## What Needs Attention

- The new `AGENTS.md` rule is close, but it should explicitly close the edge case that caused the remaining bad links above. As written it covers in-repo files and "external repos," but not local-only artifacts like `~/.claude/hooks/...`. Add one sentence: only use markdown links for files inside the repo under review; for anything else, cite in plaintext (`other-repo:path/to/file.mjs:144`, `~/.claude/hooks/foo.sh:11`) rather than a markdown link target.
- The synthetic home-directory fixture path in [test/proxy-deferred-tools-restore.test.mjs](test/proxy-deferred-tools-restore.test.mjs#L115) is behaviorally acceptable, but it forced a `GIT_PUSH_GUARD_ALLOW=1` bypass even though `extractCwdFromSystem()` only needs an absolute path string. A neutral synthetic path like `/repo/myproject` or `/workspace/myproject` would preserve the parser contract without tripping the generic leak guard.
- The `<internal-host>` placeholder reads fine in prose sentences like [CHANGELOG.md](CHANGELOG.md#L197). In a few directive headings/list items such as [docs/directives/proxy-quota-status-per-session.md](docs/directives/proxy-quota-status-per-session.md#L106), prose would read slightly better than an angle-bracket token, but this is readability-only, not a correctness issue.

## Bloat / Non-Functional

- Tracking generated/repo-local artifacts in a scrub-only PR is unnecessary scope growth. [package-lock.json](package-lock.json#L1) and [.possibilities/metrics.json](.possibilities/metrics.json#L1) are the only concrete bloat findings I saw.

## Size Baseline

- `AGENTS.md` — 113 LOC — one load-bearing citation rule; useful, but still missing the off-repo/plaintext clause.
- `docs/code-reviews/pr-117-gh-bot-guard-codex-review-2026-05-09.md` — 94 LOC — only changed file that still contains broken markdown link targets after the scrub.
- `test/proxy-messages-cache-breakpoint.test.mjs` — 647 LOC — fixture restoration is narrowly correct and backed by the classifier regex.
- `test/proxy-deferred-tools-restore.test.mjs` — 812 LOC — fixture change is small, but the chosen placeholder path needlessly interacts with the push guard.
- `package-lock.json` — 36 LOC — unrelated new tracked file.
- `.possibilities/metrics.json` — 12 LOC — unrelated generated state file.

## Recommendations

- Remove [package-lock.json](package-lock.json#L1) and [.possibilities/metrics.json](.possibilities/metrics.json#L1) from the branch.
- Rewrite the `~/.claude/...#LNN` citations in [docs/code-reviews/pr-117-gh-bot-guard-codex-review-2026-05-09.md](docs/code-reviews/pr-117-gh-bot-guard-codex-review-2026-05-09.md#L10) as plaintext non-link citations.
- Tighten [AGENTS.md](AGENTS.md#L67) with an explicit "markdown links are only for files inside the repo under review" sentence.
- Consider changing [test/proxy-deferred-tools-restore.test.mjs](test/proxy-deferred-tools-restore.test.mjs#L115) to a synthetic absolute path that does not require a push-guard bypass.

## Bottom Line

The main scrub is sound and the targeted fixture repair is correct, but the branch is not ready to approve yet because it still leaves one class of broken public-tracked links in place and it accidentally starts tracking two unrelated local artifacts. Fix those, and this should be straightforward to approve. — Codex review
