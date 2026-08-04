# Review: PR #300

Date: 2026-08-04
Reviewed: `AGENTS.md` at `0a92e8dc81e5b72c2fc0a99be4abdae3eaa5bd4d`
Round: 1
Label applied: changes-requested

## What Is Correct
- Measured: the new predicate rule itself is justified by the historical test gap. I checked merged `23346ac9`, installed that tree's dependencies in a disposable checkout, ran `node --test test/proxy-forward-ca.test.mjs` (`12/12` pass), then mutated the inline launcher guard in `bin/claude-via-proxy.mjs` to accept unconditionally and reran the same file; it still passed `12/12`. That supports [AGENTS.md:214-219](AGENTS.md#L214) as written.
- Read + Measured: the historical launcher quote is anchored correctly now. `git show 23346ac9:bin/claude-via-proxy.mjs` contains the quoted comment at the cited commit, so the switch from a live line number to a historical commit anchor in [AGENTS.md:270-274](AGENTS.md#L270) is the right repair.
- Read: the repo-history premise for the Bun switch is supported. The same `v2.1.113` / Bun fact appears in [README.md:7](README.md#L7), [README.md:694](README.md#L694), [CHANGELOG.md:471](CHANGELOG.md#L471), and [AGENTS.md:52](AGENTS.md#L52), so [AGENTS.md:264-268](AGENTS.md#L264) is grounded in repo artifacts rather than in reviewer memory.
- Read: the pre-existing agent-id figures in [AGENTS.md:176-180](AGENTS.md#L176) are sourceable to the directive history at [docs/directives/proxy-session-budget-attribution.md:102](docs/directives/proxy-session-budget-attribution.md#L102) and [docs/directives/proxy-session-budget-attribution.md:104](docs/directives/proxy-session-budget-attribution.md#L104). I did not independently rerun those external log queries here, so I am treating them as sourced, not freshly re-measured.
- Measured: the runtime-floor paragraph is directionally supported. `package.json` declares `engines.node: ">=18"` at [package.json:25](package.json#L25), and the #296 issue thread records `node 24.11.1   1543/1543, exits clean` plus `node 20.20.2   36/36 pass, NEVER EXITS` in the discussion that led to these rules.

## Blockers
- Measured + Read: the new CI paragraph overstates the historical record and is false as written. [AGENTS.md:140-143](AGENTS.md#L140) says that on PR #296 "every approval on that PR ... was granted while CI was either cancelled or still running." `gh api repos/cnighswonger/claude-code-cache-fix/pulls/296/reviews --paginate` and `gh pr view 296 --json statusCheckRollup` show two final approvals on `2026-08-04`: `vsits-codex-review-agent[bot]` at `19:13:15Z` and `cnighswonger` at `19:18:28Z`, both after the matrix had completed successfully at `17:56Z`. The rule is sound; the example is not. A document about evidence discipline cannot keep a measured example that fails measurement.
- Read: several of the added justifications state reviewer thought-processes as facts when the artifacts only show outcomes. "Nobody looked" in [AGENTS.md:142](AGENTS.md#L142), "none consulted it" in [AGENTS.md:268-269](AGENTS.md#L268), and "Five rounds read past" in [AGENTS.md:274](AGENTS.md#L274) are not mechanically verifiable from repo or GitHub artifacts. At most, the artifacts show approvals before green, missing mention of the Bun switch, or arguments focused on node semantics. That distinction matters because this PR is adding rules about evidence classes and falsifiability; it should not itself rely on mind-reading. Rephrase these to observable claims.

## What Needs Attention
- Read: the CI escape hatch in [AGENTS.md:146-149](AGENTS.md#L146) is acceptable only because it requires the reviewer to say explicitly that CI was pending and to name the local run. Keep that reporting requirement if you revise the section; without it, the exception would become too permissive.
- Read: anti-bloat is mostly fine here. The added sections are not redundant with the earlier Evidence Class text; the predicate/oracle rule, README-history rule, and expectation-source rule each close a distinct failure mode. My concern is accuracy, not size.

## Bloat / Non-Functional
None.

## Recommendations
- Rewrite the #296 CI example to the narrower claim the artifacts actually support. For example: earlier approvals/labels were granted while CI was cancelled or running, but the final approvals on August 4, 2026 landed after green. That still teaches the rule without misstating the timeline.
- Replace mind-reading phrases with observable ones: "the reviews did not cite the check status," "the review thread argued node-loader semantics despite the Bun switch being documented," or similar.
- If you want the agent-id figures to carry "Measured" weight in this file rather than merely sourced weight, add a pointer to the underlying query artifact or log note. Right now they are traceable, but not reproducible from this branch alone.

## Bottom Line
Revise. Most of the new rules survive scrutiny, and the strongest new example — the `23346ac9` mutation staying green at `12/12` — reproduced exactly. But one of the added measured examples is false as written, and several surrounding sentences assert reviewer mental state rather than observable evidence. For a PR whose whole point is to raise the bar on verification language, those are blocking problems. — Codex review
