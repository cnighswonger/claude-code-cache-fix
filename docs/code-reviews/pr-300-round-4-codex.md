# Review: PR #300

Date: 2026-08-04
Reviewed: `AGENTS.md` at `4df663c021aea8fb566a582aabea2be4c310837d`
Round: 4
Label applied: approved-by-codex-agent

## What Is Correct
- Measured: PR #300 is green on the head under review. `gh pr view 300 --json statusCheckRollup` on `4df663c0` shows `test (18)`, `test (20)`, `test (22)`, GitGuardian, and Snyk all successful on 2026-08-04.
- Measured: there are no open review threads left to resolve. `gh api graphql` for `reviewThreads` on PR #300 returned an empty `nodes` array.
- Read: the round-3 blocker is fixed cleanly. The review-history paragraph at `AGENTS.md:264-268` now says only what the artifacts support, and dropping the "three parties / each round" clause materially improves the document's credibility.
- Read: the added rules are still usable rather than over-qualified. `AGENTS.md:156-184`, `AGENTS.md:208-323`, and `AGENTS.md:325-369` read as concrete reviewer instructions with named failure modes, not as hedge piles that collapse into "it depends."
- Read: the CI rule's fork-PR escape hatch is honest, not a loophole. `AGENTS.md:156-159` does not waive the check-status discipline; it requires the reviewer to say explicitly that CI was pending and to name the local evidence instead. That is the right tradeoff for this repo's maintainer-authorized fork workflows.
- Read: the runtime rule scales for this repo. `AGENTS.md:161-184` does not require reviewers to enumerate runtimes gratuitously; it requires them to name the runtime when they use a pass count as evidence, and to hit the floor when the package claims an `engines` range. Given this repo's documented node-version failures, that is signal, not ritual.
- Read: the predicate/oracle rule is good advice as scoped. `AGENTS.md:208-323` is triggered when a predicate is trying to predict another program's admission or rejection behavior and repeatedly insists on the production oracle when one exists. It does not tell contributors to replace ordinary parsing with subprocesses in general; the "Where else it applies" paragraph explicitly frames the common property as "the oracle exists and we chose to model it instead of calling it."
- Read: the README/history rule is also sound as written. `AGENTS.md:270-302` says to read the repo's accumulated knowledge before reviewing a diff whose correctness depends on external program behavior; it does not say README text outranks the code under review. In this repo, where runtime changes and upstream-client facts are load-bearing and easy to miss from a diff alone, that rule is proportionate.

## Blockers
None.

## What Needs Attention
- Read: `AGENTS.md:297-302` is accurate but slightly more abstract than the surrounding sections. If you want one more cut without changing meaning, "The failure is not that the fact was hidden..." paragraph is the first removable candidate; the concrete Bun / BoringSSL example above it already carries the lesson.
- Read: `AGENTS.md:196-206` is useful, but the last sentence about reconciling findings is closer to meta-commentary than rule text. It is harmless, not wrong; I would trim there before trimming any of the concrete examples.

## Bloat / Non-Functional
- Read: no blocking bloat remains in the round-4 delta. The added process text is longer than average repo guidance, but here the length is buying specific failure cases, explicit evidence standards, and concrete counterexamples that the earlier shorter baseline did not cover.

## Recommendations
- Read: merge as written. The document is now on the right side of the accuracy/utility line, and the remaining possible cuts are editorial rather than corrective.
- Read: if you want a shorter post-merge pass, cut `AGENTS.md:297-302` first and consider compressing `AGENTS.md:196-206` to the two bullet points. Those are the only spots where removing text would preserve the binding force of the rules.

## Bottom Line
Read + Measured: approve. On the axes that mattered for round 4, the document now holds up: the new rules are usable, they are good advice for this repo rather than cargo-cult process, and the one remaining historical overclaim from round 3 has been removed instead of patched into another arguable sentence. I would not spend another review round trying to shave this further before merge. — Codex review
