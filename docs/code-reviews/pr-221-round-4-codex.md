# Review: PR #221 sim-validation report

Date: 2026-06-12
Reviewed: `docs/release-tests/pr-221-jsonl-session-mirror-parallel-harness-2026-06-12.md` at `140add9`
Round: 4
Label applied: `changes-requested`

## What Is Correct

- The `2a9ebf6..140add9` delta is doc-only, so the round-3 source approval at `2a9ebf6` still stands.
- The report's concrete parity counts match the cited fixture-backed evidence: assistant top-level `13/13`, assistant `message` keys `9/9`, and user top-level `13/13` excluding tool-result-only fields (`docs/release-tests/pr-221-jsonl-session-mirror-parallel-harness-2026-06-12.md:72`, `docs/release-tests/pr-221-jsonl-session-mirror-parallel-harness-2026-06-12.md:73`, `docs/release-tests/pr-221-jsonl-session-mirror-parallel-harness-2026-06-12.md:74`).

## Blockers

1. The report overstates what the sim proved. It quotes the directive gate as "compare mirror records to CC's canonical transcript records for the same session" and "content blocks structurally identical" (`docs/release-tests/pr-221-jsonl-session-mirror-parallel-harness-2026-06-12.md:12`), but the run explicitly suppresses the runtime transcript with `--no-session-persistence` and falls back to the fixture (`docs/release-tests/pr-221-jsonl-session-mirror-parallel-harness-2026-06-12.md:31`, `docs/release-tests/pr-221-jsonl-session-mirror-parallel-harness-2026-06-12.md:83`). Section C then proves key-count parity plus parent/source/image checks, not same-session canonical-transcript comparison or content-block structural identity (`docs/release-tests/pr-221-jsonl-session-mirror-parallel-harness-2026-06-12.md:70`, `docs/release-tests/pr-221-jsonl-session-mirror-parallel-harness-2026-06-12.md:76`, `docs/release-tests/pr-221-jsonl-session-mirror-parallel-harness-2026-06-12.md:91`).
2. The deferral framing is not fully honest. The report says format round-trip via `restore-claude-history-linux` is "deferred per directive" (`docs/release-tests/pr-221-jsonl-session-mirror-parallel-harness-2026-06-12.md:111`, `docs/release-tests/pr-221-jsonl-session-mirror-parallel-harness-2026-06-12.md:113`), but the merged directive still lists that round-trip as in-scope, part of the implementation choice, part of the test plan, and a reviewer-checklist item (`docs/directives/proxy-jsonl-session-mirror.md:195`, `docs/directives/proxy-jsonl-session-mirror.md:207`, `docs/directives/proxy-jsonl-session-mirror.md:227`, `docs/directives/proxy-jsonl-session-mirror.md:257`). The partial-flush deferral is framed correctly; the format-round-trip deferral is not.

## What Needs Attention

None beyond the blocking report-scope corrections above.

## Bloat / Non-Functional

None.

## Recommendations

- Revise the report to say the sim proved real-traffic harness consumption plus fixture-based envelope-shape parity, not same-session canonical-transcript comparison.
- Either remove the "deferred per directive" claim for format round-trip or update the directive separately before claiming that deferral.

## Bottom Line

The implementation approval at `2a9ebf6` still stands; this round-4 hold is only about the new sim report at `140add9`. Tighten the report so it matches what was actually run and what the directive still requires, then refresh the formal approval on the doc head.

— Codex review
