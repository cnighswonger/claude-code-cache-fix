# Review: PR #216 `gh-auth-status-shim` directive

Verdict: APPROVE

Date: 2026-06-11
Reviewed: `docs/directives/tool-gh-auth-status-shim.md` at `74f05f5`, `CLAUDE.md`, and the current PR body/thread
Round: 2
Label applied: `approved-by-codex-agent`

## Status Table

| Item | Status | Notes |
|---|---|---|
| B1 — `Load-bearing? Yes.` declaration | PASS | `docs/directives/tool-gh-auth-status-shim.md:37-50` now includes `Load-bearing? Yes.`, the security-relevant rationale, and the Chris human-review requirement. |
| B2 — internal contradictions resolved | PASS | The later validation/checklist sections now match the round-3 design: no restore-from-backup language (`docs/directives/tool-gh-auth-status-shim.md:228-235`, `docs/directives/tool-gh-auth-status-shim.md:320`, `docs/directives/tool-gh-auth-status-shim.md:368`, `docs/directives/tool-gh-auth-status-shim.md:375`); no `shellcheck -s sh` bash-floor claim (`docs/directives/tool-gh-auth-status-shim.md:40`, `docs/directives/tool-gh-auth-status-shim.md:288`, `docs/directives/tool-gh-auth-status-shim.md:318`, `docs/directives/tool-gh-auth-status-shim.md:363`); timeout validation is consistently 8s slow-`gh` plus `< 5s` wall-clock (`docs/directives/tool-gh-auth-status-shim.md:140-148`, `docs/directives/tool-gh-auth-status-shim.md:322-330`, `docs/directives/tool-gh-auth-status-shim.md:365`). |
| A1 — JSON-mode classifier consideration | PASS | The directive now explains why v1 keeps string matching despite `gh auth status --json hosts`, and it keeps the validated `gh` version-range requirement in README scope (`docs/directives/tool-gh-auth-status-shim.md:177`, `docs/directives/tool-gh-auth-status-shim.md:290`). |
| A2 — front-matter round metadata | PASS | Front matter now correctly says `directive — round 4` (`docs/directives/tool-gh-auth-status-shim.md:7`). |
| A3 — PR body stale framing | PASS | The current PR body is updated to the greenfield `gh-auth-status-shim` framing and includes the load-bearing note; the old `gh-auth-bot-guard` / "internal hook we landed months ago" story is gone. |
| Spot-check — new contradictions / budget honesty | PASS | No new contract drift surfaced in the round-4 sweep, and the ~880 LOC budget remains internally consistent with the described script/test/README/CI scope (`docs/directives/tool-gh-auth-status-shim.md:39`, `docs/directives/tool-gh-auth-status-shim.md:181-185`, `docs/directives/tool-gh-auth-status-shim.md:284-291`). |

## What Is Correct

- Round 4 closes the repo-process blocker cleanly: the directive now names the load-bearing nature of the PATH shim and states the required Chris review gate in the NFR section (`docs/directives/tool-gh-auth-status-shim.md:50`).
- The test plan, duplicated validation block, and reviewer checklist now agree with the main design contract on uninstall semantics, bash-3.2 verification, and the 8-second slow-`gh` experiment inside CC's 5-second window (`docs/directives/tool-gh-auth-status-shim.md:140-148`, `docs/directives/tool-gh-auth-status-shim.md:228-235`, `docs/directives/tool-gh-auth-status-shim.md:316-320`, `docs/directives/tool-gh-auth-status-shim.md:322-330`, `docs/directives/tool-gh-auth-status-shim.md:363-375`).
- Codex round-1 attention items were handled rather than papered over: the JSON-vs-regex choice is justified, round metadata is current, and the PR body now matches the directive's actual scope and mechanism.

## Blockers

None.

## What Needs Attention

- The implementation PR still needs to satisfy the directive's mandatory prototype-validation gate before merge, especially the Linux PATH-interception proof and the macOS validation/scoping decision (`docs/directives/tool-gh-auth-status-shim.md:138-161`, `docs/directives/tool-gh-auth-status-shim.md:322-332`). That is an implementation-stage check, not a remaining directive-stage blocker.

## Bloat / Non-Functional

None. The round-4 changes are corrective, not expansive, and the directive still keeps the scope/budget honest.

## Recommendations

1. Carry the prototype-validation evidence directly in the eventual implementation PR thread so the load-bearing PATH-interception claim is verified where merge decisions are made.
2. Keep the README's validated `gh` version range current if the implementation lands after upstream CLI wording changes.

## Bottom Line

Round 4 resolves both Codex round-1 blockers and leaves the directive internally consistent end-to-end. The load-bearing declaration and Chris-review gate are now explicit, the later test/checklist sections no longer contradict the corrected round-3 design, and the remaining risks are already framed as implementation-stage validation gates rather than directive defects. This directive is approvable at `74f05f5`.

— Codex review
