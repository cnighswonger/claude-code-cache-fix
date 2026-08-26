# Directive: `manual-compact.sh --thrash-recovery` mode

Status: DRAFT r2 (directive stage — AITL scope approved; Codex R1 blockers + attention items addressed in this revision)
Author: AI Team Lead
Refs: shared memory `feedback_long_context_thrashing_unrecoverable.md`; Codex R1 review artifact `docs/code-reviews/pr-358-round-1-codex.md`; Proxy Builder implementation plan comment on PR #358

## Goal

Add a `--thrash-recovery` mode to `tools/manual-compact.sh` that, when
invoked, produces a compaction summary suitable for restarting a **thrashing**
session — one where the recent tail is a stuck-loop and the summary MUST NOT
faithfully carry that loop forward. Default behavior of the script (planned
`/clear`, planned handoff, size-driven compact) is **unchanged**.

## Why

Chris's observation (recorded in shared memory 2026-08-26):

> In long contexts, when an agent gets in a rabbit hole and begins thrashing,
> it can almost never escape. It flat spirals and will eventually pound the
> ground. Even with human intervention recovery is seldom achieved without a
> `/clear`. I think this is because the thrashing itself pollutes the context
> and since it is most recent, the thrashing survives `/compact`.

The current `manual-compact.sh` (r169) is a great primitive for the *planned*
case but does not solve the *thrashing* case unmodified:

- The active-work segment (last 40% of turns) IS the polluted tail when the
  session is thrashing. Preserving it near-full-detail (8000 chars/turn) carries
  the poison forward — same failure as in-model `/compact`, just written to
  disk.
- The summarizer prompt says `DO NOT understate progress on in-flight work`,
  which reinforces a thrashing agent's misplaced confidence — the failing
  approach gets summarized as "in-progress work" rather than "stuck in a
  wrong-direction loop."
- There is no thrash-signal detection; the summarizer faithfully compresses
  whatever's in the tail.

The result: a session that's thrashing at `/clear` time, if compacted with
today's script, will restore into a fresh session that re-enters the exact same
loop from the summary. This mode fixes that.

## Scope

**In scope:**

- New CLI flag `--thrash-recovery` (default off; when omitted, behavior is
  byte-identical to today).
- Automatic detection of thrashing signals in the last N turns of the extract.
- Manual override `--from-turn N` (works independently of `--thrash-recovery`
  or alongside it — treats turn N as the last-known-good boundary).
- `--dry-run` output that prints the detection signals + proposed treatment
  BEFORE the Opus call, so the operator can verify judgment on a real
  thrashing JSONL before wiring auto-mode.
- Truncation strategy inversion when thrashing is confirmed: keep foundational
  and working segments at richer detail; aggressively compress the poisoned
  tail into a bounded "was attempting X, stuck for N turns" block instead of
  8000 chars per turn.
- Summary-prompt override on detection: inject a header naming the failed
  approach and the last-known-good turn, and REPLACE the "DO NOT understate
  progress" line with "The tail was a stuck loop; do not carry the failed
  approach forward; treat turn N as the last verifiably-good state."

**Explicitly unchanged from r169:**

- Summarizer model (Opus, with `MANUAL_COMPACT_MODEL` override still honored).
- Retry logic.
- Default-mode output file path: `/tmp/<sid>-compact-summary.txt` — identical
  to r169. **Only** the new thrash-treatment output path gains a suffix (see
  "Behavior on detection" §3 below: `/tmp/<sid>-compact-summary-thrash.txt`),
  so the two artifacts are distinguishable at a glance and a planned-clear
  operator can't accidentally load a thrash-recovery summary.

**Out of scope (deferred to follow-ups):**

- Live in-session thrash detection (this directive is JSONL-post-hoc only).
- Automatic invocation from a proxy hook (operator triggers it by hand).

## Detection signals

The pre-summarization pass runs a Python analysis over the extracted
conversation before the Opus call. It emits a **thrash score** and a
**detected-loop-start turn**. Signals (each contributes a weighted vote; a
threshold trips detection):

1. **Repeat tool-call error strings**: same error message (normalized) ≥3× in
   the last 20% of turns.
2. **Retry-cadence language**: assistant-side occurrences of phrases like
   "let me try again", "trying a different approach", "let me try one more
   thing", "hmm, still not working" ≥3× in the last 20% of turns.
3. **Per-turn tool-count spikes with no state advance**: rolling per-turn tool
   count > 2× median over the last 10% of turns, coincident with no
   file-write / no commit / no test-pass since the spike began.
4. **Escalating confidence markers with unchanged failure state**: assistant
   language like "this should definitely work" / "I'm certain now" / "the fix
   is" while the tool-result-error rate over the same window stays flat or
   climbs.
5. **Same-fix-attempt loops**: near-duplicate tool_use content (Levenshtein
   distance below a threshold, or exact param match) within a 5-turn window,
   repeated ≥2×.

The **last-known-good turn** is the last turn PRIOR to the earliest signal
that fires. If multiple signals fire at different turns, take the minimum.

Threshold + weights are tunable via env vars (e.g.
`MANUAL_COMPACT_THRASH_THRESHOLD`, `MANUAL_COMPACT_THRASH_SIGNAL_WEIGHTS`)
with sensible defaults; unset uses builtin defaults calibrated against a
sample thrashing JSONL that AITL will provide.

## Behavior on detection

When `--thrash-recovery` is passed AND detection fires (or `--from-turn N` is
passed, forcing the boundary):

1. **Truncation inversion in the extract:**
   - Foundational segment: unchanged (300 chars/turn).
   - Working segment: bumped to 3000 chars/turn (from 1500) — this is where
     the pre-thrash reasoning lives and it's the recovery basis.
   - Active-work segment: replaced with a bounded compressed block:
     `"[thrash-loop compressed] agent attempted <inferred approach>; stuck for
     N turns (turn X → turn Y); recurring failure: <top-error-signature>;
     tool-call pattern: <summary>"`
     — capped at ~1500 chars total, not per turn.
2. **Summarizer prompt override:**
   - Remove the "DO NOT understate progress" line.
   - Add a header block: `"THRASH-RECOVERY SUMMARY. The tail was a stuck loop
     starting at turn X. Do NOT carry the failed approach forward. The last
     verifiably-good state was at turn W (before signal Y fired). Frame the
     summary around what the agent should try NEXT, from that pre-thrash
     state, not around continuing the failed approach."`
3. **Output filename** gains a suffix: `/tmp/<sid>-compact-summary-thrash.txt`
   so it's distinguishable from planned-clear summaries at a glance.

When `--thrash-recovery` is passed but detection does NOT fire, exit with an
informational message and NO output file (so the operator sees "you asked for
thrash-recovery but this session doesn't look like thrashing — did you mean
the default mode?"), unless `--force` is also passed.

## Dry-run output

`--dry-run` (works with or without `--thrash-recovery`) prints:

- Per-signal scores + which turns triggered.
- Computed last-known-good turn.
- The Opus prompt that would be sent (with the override applied).
- The truncated extract preview (first 500 + last 500 chars of each segment).
- **Does NOT call Opus.**

This is the review harness — AITL and Chris should be able to run
`manual-compact.sh --thrash-recovery --dry-run <jsonl>` against a real
thrashing session and verify the detection lands on the right turn before
committing to auto-mode.

## Testing

**Fixtures (both required, both under `tests/fixtures/manual-compact/`):**

- `thrashing-sample.jsonl` — small, redacted from a real thrashing session AITL
  will provide. Redaction requirement: strip session ids, absolute home-dir
  paths, tokens/credentials, real user names — anonymize to `session_X`,
  `<PATH>`, `<REDACTED>` placeholders. Provenance note in a companion
  `README.md` (source date, what was redacted, why the pattern qualifies as
  thrashing).
- `healthy-sample.jsonl` — small, redacted planned-clear session with no
  thrashing signals.
- `healthy-sample.expected-extract.txt` — golden output pinned from r169 on
  `healthy-sample.jsonl` (see regression guard below).

**Smoke tests on the thrashing fixture:**

- `--dry-run --thrash-recovery` detects with score above threshold. Assert
  which signals fired and the computed last-known-good turn.
- `--dry-run` alone (no `--thrash-recovery`) does NOT alter the extract
  (byte-identical extract-preview to r169 dry behavior).
- `--thrash-recovery --from-turn N` forces the boundary regardless of
  detection.
- **Boundary case:** the detected loop-start does not always align with the
  fixed 60% active-work boundary. Include at least one test where
  `--thrash-recovery --from-turn K` with K < 60%-boundary — verify the
  pre-K range gets working-segment treatment, K+ gets the compressed block,
  no crash on the crossing, and the compressed-block header names K
  correctly.

**Smoke tests on the healthy fixture:**

- `--thrash-recovery --dry-run` reports "no thrashing detected" and exits
  non-zero (unless `--force`).
- **Regression guard — golden-file exact compare.** Default mode (no flag)
  on the healthy fixture produces output byte-identical to
  `healthy-sample.expected-extract.txt`. Mechanism: `diff -u
  tests/fixtures/manual-compact/healthy-sample.expected-extract.txt
  <(manual-compact.sh --extract-only tests/fixtures/manual-compact/healthy-sample.jsonl)`
  must produce no output. The fixture is generated once from r169 output and
  pinned to the repo. Not "same general shape" — exact byte match.

## Non-Functional Requirements

**Size/complexity budget.** Implementation budget: ~200 LOC detector
(`tools/lib/thrash_detect.py`) + ~150 LOC extraction module
(`tools/lib/manual_compact_extract.py`) + ~50 LOC bash orchestrator delta on
`manual-compact.sh` + ~150 LOC tests. Total ~550 LOC. Exceeding by more than
~30% without justification is a scope-creep flag; implementer notes the reason
in the implementation PR's `## Reasoning` block if the budget grows.

**Fixture provenance and redaction.** Both `thrashing-sample.jsonl` and
`healthy-sample.jsonl` MUST ship redacted per the Testing section above and
MUST include a companion `README.md` naming (a) the source-session date, (b)
the redaction transforms applied, (c) why the pattern qualifies. Raw
un-redacted sessions do NOT enter the repo. Fixture size cap: 500 KB each so
the test suite stays fast.

**Maintainability boundary.** The two Python modules (`thrash_detect.py`,
`manual_compact_extract.py`) MUST be pure-function libraries — no filesystem
side effects, no subprocess calls, no direct `claude`-CLI invocation. The
bash orchestrator owns I/O; the Python owns logic. This is the seam that
makes signal-level unit tests possible.

**Performance expectation.** The Python pre-summarization pass on the largest
supported fixture (500 KB JSONL, ~1000 turns) MUST complete in under 2s of
wall-clock on typical developer-workstation hardware. Signal detection is O(turns) with a
small constant; if a candidate implementation is quadratic (e.g.
all-pairs Levenshtein), reject and re-scope.

**Default-path no-regression contract.** When invoked WITHOUT
`--thrash-recovery` and WITHOUT `--dry-run`, `manual-compact.sh` MUST produce
output byte-identical to r169 on the same input. Enforced by the golden-file
compare above. This is the load-bearing safety guarantee for existing
planned-clear callers.

**Threshold calibration acceptance criterion.** Default weights + threshold
MUST simultaneously (a) trip detection on `thrashing-sample.jsonl` (score
above threshold, non-empty signal list) AND (b) NOT trip on
`healthy-sample.jsonl` (score below threshold). Both assertions in the test
suite. Env-var overrides
(`MANUAL_COMPACT_THRASH_THRESHOLD`, `MANUAL_COMPACT_THRASH_SIGNAL_WEIGHTS`)
are for operator tuning on their own fixtures, not a substitute for
calibrated defaults.

**Operational guard: dry-run first on real thrash sample.** The one
non-load-bearing footgun is an operator who skips `--dry-run` on a real
suspected-thrash session, gets a misclassified detection, and restores from
the wrong summary. Mitigation is procedural: the `--thrash-recovery`
help-text and the human-facing output MUST include the sentence "Run with
`--dry-run` first to verify detection before generating the summary." Both
tests and the tool's own output enforce this pattern.

**Load-bearing classification.** `no`. Tool is opt-in, invoked by operator
out-of-band, no code path changes for existing callers. Default behavior
byte-identical on non-thrashing inputs (enforced by golden-file compare);
explicit flag required for the new behavior. The misfire risk is a manual
quality/safety concern mitigated by dry-run-first discipline, not a
shared-abstraction or wire-contract change. If detection misfires and the
operator skipped dry-run, the summary is aggressive on tail-drop but still
restorable from the working segment — degraded, not catastrophic.

## Rollout

- Follows the standard vsits gate flow: `directive-stage` on this PR →
  Proxy Builder implementation PR → Codex R1 → AITL R0 → Chris approval →
  merge.
- No runtime code path changes — the tool is invoked out-of-band by the
  operator; existing planned-clear callers are unaffected.
- Ship version bump: none required (tool-only change under `tools/`).

## Reasoning

Alternative considered: extending the summarizer prompt alone (no detection
pass, no truncation inversion) to always include a "check if the tail is
thrashing" instruction. Rejected — this offloads the pattern-recognition to
the summarizer at Opus rates every time; a small Python pre-pass is
deterministic, auditable, and cheap. It also gives us `--dry-run` visibility,
which the prompt-only path cannot.

Load-bearing classification is stated in the Non-Functional Requirements
section above.
