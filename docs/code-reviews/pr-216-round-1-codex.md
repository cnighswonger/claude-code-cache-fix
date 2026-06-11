# Review: PR #216 `gh-auth-status-shim` directive

Date: 2026-06-11
Reviewed: `docs/directives/tool-gh-auth-status-shim.md` at `9303947`, `CLAUDE.md`, `TRACKED_ISSUES.md`, upstream `anthropics/claude-code#67055`, and local `gh auth status` help/JSON behavior
Round: 1
Label applied: `changes-requested`

## What Is Correct

- Round 3 clears Fable's architectural timeout blocker in the directive's main design path. The core pseudo-code now budgets the shim inside CC Desktop's 5-second spawn window and makes internal timeout an explicit exit-0 transient case (`docs/directives/tool-gh-auth-status-shim.md:80-118`).
- The PATH-shim mechanism is now stated directly, the bundle-derived CC behavior cited in the directive matches the live `anthropics/claude-code#67055` issue, and the macOS `launchd` PATH caveat is finally called out instead of hand-waved (`docs/directives/tool-gh-auth-status-shim.md:28-34`, `docs/directives/tool-gh-auth-status-shim.md:136-159`).
- The round-1 misattribution remains cleanly corrected in the directive itself. This draft consistently frames the tool as greenfield, not a polish of the existing `gh-bot-guard.sh` write guard (`docs/directives/tool-gh-auth-status-shim.md:10-14`, `docs/directives/tool-gh-auth-status-shim.md:379-384`).
- The uninstall behavior section now fixes Fable's N2 logic error in the main spec: shim backups are removed, not restored, and native Windows coverage is no longer overstated (`docs/directives/tool-gh-auth-status-shim.md:224-233`, `docs/directives/tool-gh-auth-status-shim.md:292-296`).
- Sunset handling is materially better than round 2: the directive now drafts the `TRACKED_ISSUES.md` entry and a concrete "when to uninstall" path tied to CC#67055 (`docs/directives/tool-gh-auth-status-shim.md:257-276`).

## Blockers

### 1. The directive still omits the required `Load-bearing?` declaration, so the mandatory Chris-review gate is missing

`CLAUDE.md:86-94` is explicit: every directive's `## Non-Functional Requirements` section must include `Load-bearing?` as a required yes/no, and load-bearing changes require Chris human review before merge. This directive's NFR section at `docs/directives/tool-gh-auth-status-shim.md:36-48` never states it.

That omission matters here. This tool installs a PATH-intercepting `gh` wrapper and intentionally rewrites `gh auth status` exit semantics for every caller in scope. Even without a proxy/schema change, that is security-relevant enough to be load-bearing under the repo's own rubric. The directive needs `Load-bearing? Yes.` and the human-review gate stated explicitly before it should clear Codex.

### 2. The later test-plan/checklist sections still contradict the round-3 fixes on uninstall semantics and bash-3.2 verification

The main design sections were corrected, but the directive later reintroduces the very behaviors round 3 claims to have removed:

- `docs/directives/tool-gh-auth-status-shim.md:224-231` correctly says uninstall removes shim backups and never restores them, but `docs/directives/tool-gh-auth-status-shim.md:316` still says uninstall should "restore from `.bak`", and `docs/directives/tool-gh-auth-status-shim.md:369` still asks reviewers to verify "backup/restore behavior present."
- `docs/directives/tool-gh-auth-status-shim.md:39` and `docs/directives/tool-gh-auth-status-shim.md:175-206` correctly drop `shellcheck -s sh` as the bash-3.2 verifier, but `docs/directives/tool-gh-auth-status-shim.md:314` still says `shellcheck -s sh` enforces that floor.
- `docs/directives/tool-gh-auth-status-shim.md:140-145` rewrites the Linux validation around an 8-second slow-`gh` case plus a `< 5s` wall-clock assertion, but `docs/directives/tool-gh-auth-status-shim.md:323-324` still preserves the older 6-second experiment wording.

This is not just cosmetic drift. The test plan and reviewer checklist are the sections implementation will follow, and right now they point at two reverted behaviors and one superseded validation path. The directive needs one internally consistent contract before it should move forward.

## What Needs Attention

- The string-match classifier is documented more honestly now, but the installed `gh` CLI already exposes `gh auth status --json hosts`, and local verification shows structured `state` output is available. If regex parsing remains the chosen path, the directive should say why JSON is not viable here and keep the validated `gh` version-range requirement in the README scope.
- `docs/directives/tool-gh-auth-status-shim.md:7` still says "directive — round 2" even though `9303947` is the round-3 push. That is minor, but stale round metadata makes rereview audit trails harder than they need to be.
- The PR title has been corrected, but the PR body still carries the old `gh-auth-bot-guard` / "internal hook we landed months ago" framing. That is outside the directive file itself, but it is still worth cleaning up so the thread does not preserve the superseded story.

## Bloat / Non-Functional

None on size/abstraction. The ~880 LOC budget is a much more honest directive-stage estimate than the original cut. The remaining non-functional gap is process correctness: the required load-bearing declaration and merge gate are still missing.

## Recommendations

1. Add an explicit NFR line: `Load-bearing? Yes.` State why, and state that Chris human review is required before merge per `CLAUDE.md:86-94`.
2. Reconcile the later test-plan/checklist text with the round-3 contract: no restore-from-backup, no `shellcheck -s sh` bash-floor claim, and one timeout-validation experiment that keeps the `< 5s` budget assertion.
3. Either switch the classifier discussion to `gh auth status --json hosts` where possible, or document why the directive intentionally prefers text parsing despite JSON availability.
4. Refresh the stale round metadata in the directive and the stale pre-rewrite framing in the PR body in the same pass.

## Bottom Line

Round 3 is close and it does clear the substantive Fable blocker about the timeout budget. The remaining problems are cheaper than the earlier rewrite, but they are still directive-stage blockers: the repo-required `Load-bearing?` declaration is missing, and the later test/checklist sections still contradict the corrected round-3 design on uninstall semantics and bash-floor verification. Fix those internal-contract issues and this should be ready for another Codex pass.

— Codex review
