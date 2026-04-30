# Review: Tier upgrade/downgrade recommendation directive

Date: 2026-04-30
Reviewed: `docs/directives/proxy-tier-advisor.md`
Label applied: `changes-requested`

## What Is Correct

The directive makes the right high-level product call by keeping this as a CLI tool plus cached statusline token instead of a per-request proxy extension. Tier advice is a slow-moving weekly decision, and the rejected extension path would add runtime noise for little value.

The recommendation asymmetry is directionally correct. A single projected overage week is enough to justify an upgrade recommendation, while downgrades should require sustained under-use. That matches the stated cost asymmetry and avoids flapping on temporary dips.

The out-of-scope decisions are also sensible for v1. Excluding auto-execution is the right boundary because there is no durable public API surface for plan changes, and excluding per-request warnings keeps proxy overhead at zero.

The proposed `--quiet` mapping itself is reasonable for shell integration. `0/1/2/3` is clear and conflict-free as long as the directive consistently defines when `3` is used.

## Blockers

1. The burn-rate source-of-truth is internally inconsistent, and one branch is materially wrong for recommendation quality. Lines 86-90 say to compute burn from the "lower of" header-derived Q7d rate and usage-log-derived rate, then immediately say to use the header rate when available because it is the source of truth. Those are not equivalent behaviors. Using the lower of the two will systematically under-project when `usage.jsonl` is incomplete or only captures a subset of the user's activity, which suppresses upgrade recommendations. This needs one explicit rule, not two conflicting ones. Reference: [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:86).

2. The consecutive-weeks downgrade gate is modeled as a run counter, but the directive also recommends refreshing the cached result hourly. The state schema stores `weeks_under_downgrade_threshold`, the text says that counter enforces the 2-week rule, and the tests increment it "after under-threshold week" / "after upgrade-recommendation" by run. With hourly execution, a single low-usage week would hit the downgrade threshold after two executions, not two weeks. The state design needs to be keyed to unique weekly windows, with idempotent updates per `week_ending`, or the downgrade logic is wrong. References: [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:118), [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:131), [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:202), [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:272).

3. The directive contradicts itself on exit behavior and unknown-plan handling. Scope says the tool "Exits 0 always," `--quiet` later defines non-zero recommendation/error codes, the plan-detection section says undetectable plan should output `tier:unknown`, and the edge-case section instead says unknown plan returns `tier:ok`. `--quiet` also treats "plan undetectable" as exit code 3. These are incompatible contracts, and they matter for both shell integration and user-facing behavior. The directive needs one canonical behavior for normal mode, `--json`, and `--quiet` when the plan cannot be detected. References: [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:46), [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:141), [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:188), [proxy-tier-advisor.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-tier-advisor.md:294).

## What Needs Attention

The plan-detection heuristic is acceptable only as a fallback, but the directive should specify a conservative tolerance band and minimum sample quality before classifying a user as 5x or 20x. The current "~204M" vs "~892M" wording is directionally grounded by the 4.4x analysis, but it does not yet define what "consistent with" means.

The state section should explicitly define week-boundary semantics in UTC using the reset timestamp already present in `quota-status.json`. Without that, "week ending" can drift if the implementation derives weeks from wall-clock calendar boundaries instead of Anthropic's actual Q7d reset boundary.

Tests 13-17 cover only the pure decision function, not the idempotence/noise-rejection behavior that matters operationally. Once the state model is fixed, the plan should add tests proving that repeated runs within the same weekly window do not change the consecutive-week count and that a reset boundary creates exactly one new history slot.

## Recommendations

Replace the burn-rate rule with an explicit precedence order: use header-derived Q7d rate when `quota-status.json` is fresh enough, otherwise use the usage-log reconstruction, and only use both for validation/debug output if desired.

Redesign the downgrade memory around weekly observations, not run counters. Persist one normalized record per completed or current Q7d window keyed by reset boundary, then derive "N consecutive weeks under threshold" from those records.

Unify the result contract. A clean option is: normal human mode may print `unknown` guidance without treating it as a process error, `--json` emits `recommendation: "unknown"` plus reason metadata, and `--quiet` reserves exit code `3` for true operational failures only. If unknown-plan should be treated as an error instead, that same rule needs to be reflected everywhere in the directive.

Document the heuristic classification threshold explicitly, including tolerance and fallback-to-unknown behavior when the inferred budget is ambiguous.

## Bottom Line

Revise before implementation. The product shape is good and the upgrade/downgrade asymmetry is sound, but the current directive has three contract-level problems: inconsistent burn-rate selection, a downgrade counter that counts runs instead of weeks, and contradictory exit/unknown-plan semantics. Those need to be resolved in the directive before this is safe to hand to the implementation agent.
