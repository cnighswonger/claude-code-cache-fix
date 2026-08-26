# Review: `manual-compact.sh --thrash-recovery` directive and plan

Date: 2026-08-26
Reviewed: `docs/directives/manual-compact-thrash-recovery.md` at `3fc06cb`, plus Proxy Builder plan comment `IC_kwDOR7E3Jc8AAAABQ3CeLw`
Round: 1
Label applied: `changes-requested`

## What Is Correct

- Read: the directive has the right high-level failure model. It identifies that r169's active-work-heavy extraction and "DO NOT understate progress" prompt are actively wrong for a thrashing tail, and it keeps the new behavior opt-in (`docs/directives/manual-compact-thrash-recovery.md:47-62`).
- Read: the five detection signals are mostly falsifiable as written. Signals 1, 2, and 5 have explicit counts/windows; signal 3 gives a measurable tool-count spike plus absence of state-advance markers; signal 4 is the weakest in the directive text, but the plan makes it testable by counting a confidence phrase list against a same-window tool-result error-rate delta.
- Read: Proxy Builder's proposed extraction into `tools/lib/manual_compact_extract.py` and `tools/lib/thrash_detect.py` is a reasonable implementation shape. The directive does not require that structure, but for this change it is a testability improvement rather than premature framework work: the bash heredoc already owns parsing/extraction, while the detector needs synthetic unit coverage per signal.
- Read: deferring Levenshtein for signal 5 is acceptable for a first cut. The directive explicitly allows "Levenshtein distance below a threshold, or exact param match" (`docs/directives/manual-compact-thrash-recovery.md:90-92`), and the plan's exact `tool_use.input` match is easy to verify and unlikely to create broad false positives.
- Measured: PR diff is one documentation file, `183` added lines and `0` production LOC (`git diff --numstat origin/main...origin/feature/manual-compact-thrash-recovery`). CI is green on the PR head: GitHub reports success for `test (18)`, `test (20)`, `test (22)`, GitGuardian, and Snyk on `3fc06cb`. No local tests were run because this round changes no code.

## Blockers

1. Read: the directive file is missing the required `## Non-Functional Requirements` section. The plan comment includes an NFR block, but the mergeable artifact does not; it has Testing, Rollout, Reasoning, and then a one-paragraph `Load-bearing: no` classification (`docs/directives/manual-compact-thrash-recovery.md:146-183`). Directive-stage specs in this repo need the NFR section in the directive itself so future implementation and review are pinned to durable requirements, not to a PR-thread comment. Add the section to the directive and include the size/complexity budget, fixture redaction/privacy requirements, maintainability boundary, performance expectation, default-path no-regression contract, and load-bearing classification there.

2. Read: the directive gives contradictory requirements for the output file path. The out-of-scope section says "Any change to summarizer model, retry logic, or output file path - all identical to r169" (`docs/directives/manual-compact-thrash-recovery.md:64-69`), but the behavior section requires a new `/tmp/<sid>-compact-summary-thrash.txt` suffix when thrash treatment is applied (`docs/directives/manual-compact-thrash-recovery.md:123-124`), and the plan follows the suffix. This must be resolved before implementation. If the intended contract is "default output path unchanged; thrash-mode output gains a suffix," say that exactly.

## What Needs Attention

- Read: the truncation-inversion contract is directionally right, but the directive should state what happens when the detected loop start does not align with the fixed 60% active-work boundary. As written, it says the active-work segment is replaced wholesale (`docs/directives/manual-compact-thrash-recovery.md:107-115`) while also computing a detected-loop-start / last-known-good turn (`docs/directives/manual-compact-thrash-recovery.md:73-95`). If the loop starts before 60%, polluted turns remain in the richer working segment; if a genuine breakthrough appears near the tail, wholesale active compression can drop it. This is not a blocker for an opt-in recovery tool, but the implementation tests should include at least one boundary case around loop start vs segment split, and dry-run output should make the dropped-tail evidence inspectable.
- Read: the threshold/weights tuning path should not be calibrated only against the single AITL thrashing JSONL. The directive already asks for a healthy fixture (`docs/directives/manual-compact-thrash-recovery.md:154-158`), which is good, but the NFR should make the acceptance criterion explicit: defaults must trip on the redacted thrash sample and not trip on the healthy planned-clear sample. Otherwise the env vars become a paper escape hatch rather than a calibrated default.
- Read: the regression guard must be a golden output comparison for default mode, not just "same general extract shape." The directive's byte-identical promise appears at `docs/directives/manual-compact-thrash-recovery.md:47-48` and `docs/directives/manual-compact-thrash-recovery.md:157-158`; Proxy Builder's plan says byte-identical to r169. That should be implemented as a fixture-based exact compare against r169 output for default extraction/prompt behavior.
- Read: I agree with `Load-bearing: no` under the repo's criteria. This is an operator-invoked local tool, not a shared request-path abstraction, wire/schema contract, or security-relevant proxy path (`docs/directives/manual-compact-thrash-recovery.md:178-183`). The footgun is real if an operator skips dry-run and restores a misclassified summary, but that is a manual quality/safety risk rather than a load-bearing classification change. The NFR should still call out "dry-run first on real thrash sample" as the operational guard.

## Bloat / Non-Functional

- Read + Measured: the directive is compact at 183 added documentation lines and zero production LOC, but it omits the formal NFR section required for directive-stage review. The plan's projected implementation budget, roughly 200 LOC detector + 150 LOC extraction module + 50 LOC bash + 150 LOC tests, is proportionate if the default path remains golden-file identical and the two Python modules stay as pure testable units.

## Recommendations

- Move Proxy Builder's NFR content into the directive file, then tighten it around concrete acceptance checks: fixture provenance/redaction, default-mode golden comparison, positive/negative detection fixtures, env override tests, and boundary cases for loop start vs fixed segment split.
- Resolve the output-path wording by explicitly separating default behavior from thrash-treatment behavior.
- Keep Levenshtein deferred unless the first real thrash fixture shows exact `tool_use.input` matching misses the recurring loop. Exact matching is the better initial oracle because it is falsifiable and cheap.

## Bottom Line

Revise before approval. The design intent and implementation plan are sound enough for a small opt-in recovery tool, and the detector is mostly falsifiable once the plan's concrete definitions are included. But the directive artifact itself is missing the required NFR section and contains a direct output-path contradiction, so it is not ready to be the implementation contract yet.

— Codex, cross-LLM review, round 1
