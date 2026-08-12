# Review: release-preflight PR #332

Date: 2026-08-12
Reviewed: PR #332 at `47c6b094473b42b6e24dcfd87a7c5df3f5b381b3`
Round: 2
Label applied: changes-requested

## What Is Correct

- [Measured] `bash -n bin/release-preflight.sh` exits 0 on GNU bash 5.2.21.
- [Measured] `bash bin/release-preflight.sh --self-test` exits 0 in 0.03s on GNU bash 5.2.21. With exported shell wrappers that would fail on any `git`, `gh`, or `curl` call, the same command still exits 0 in 0.03s, so the self-test path is standalone for those external calls. Code read also shows the self-test branch exits before the prerequisite checks and release-history logic at `bin/release-preflight.sh:89`.
- [Measured] The self-test exits non-zero on fixture failure: piping a copy with the `@1Password` expected value removed exits 1 and prints the failing fixture.
- [Read + Measured] R1 blocker 1 is resolved for the named cases. `fetch_coauthored_handles` now matches `<([0-9]+\+)?...@users.noreply.github.com>` at `bin/release-preflight.sh:333`, which covers both `NNN+handle` and legacy handle-only noreply shapes; the real-email path at `bin/release-preflight.sh:341` surfaces `Chris Nighswonger <chris.nighswonger@veritassuperaitsolutions.com>` as UNKNOWN in the full retro run.
- [Read + Measured] R1 blocker 3 is resolved. The Check 5 query at `bin/release-preflight.sh:547` selects `enhancement` label OR `title | startswith("feat(")`. Running that query for `v4.3.0..HEAD` enumerates `#244`, `#262`, `#272`, `#273`, `#275`, `#278`, `#280`, and `#320`, and the CHANGELOG diff contains references for all eight.
- [Read + Measured] R1 blocker 4's narrow extraction issue is resolved. The commit-body parser first character is `[A-Za-z0-9]` at `bin/release-preflight.sh:310`, and the self-test fixture proves `@1Password` is extracted.

## Blockers

1. [Measured] Check 3 still does not satisfy the R2 acceptance condition: the full retro run reports four Check 3 findings, not at most two, because the fix commit's own explanatory prose now creates two new false positives.

   Command:

   ```text
   /usr/bin/time -f 'elapsed=%e exit=%x' bash bin/release-preflight.sh v4.3.0 --skip-running-version
   ```

   Relevant output:

   ```text
   == Check 3: @handle mentions in commit bodies covered in README Contributors ==
     MISSING @-handles mentioned in commit bodies:
       - @1Password
       - @handle
       - @TheAuditorTool
       - @Victor-Sun
   ```

   `@users` is gone, but the R2 contract said this run should produce at most `@TheAuditorTool` and `@Victor-Sun` for Check 3. The two extra candidates come from commit `47c6b09`'s body:

   ```text
   Check 3 (@handle mentions) ...
   verified via gh api users/1password returning @1Password
   ```

   Those are parser/meta-discussion strings, not contributor credits. The current filter at `bin/release-preflight.sh:307-313` has no way to suppress them, and the `--self-test` fixture at `bin/release-preflight.sh:133-150` actually expects `@1Password`, so it validates extraction but misses the release-preflight false-positive behavior. This is the same class as R1 blocker 2: explanatory prose in commit bodies can become a spurious contributor finding.

## What Needs Attention

- [Measured] Full retro output at `47c6b09` is now 14 findings across 7 checks, not the claimed 12 findings / 11 real plus prior false-positive delta. The extra two findings are the Check 3 `@1Password` and `@handle` rows above.
- [Read] `COMMIT_BODY_HANDLE_EXCLUDES` at `bin/release-preflight.sh:292` is explicitly scoped to observed reserved URL-path segments, not a complete reserved-name set. That is acceptable as a follow-on maintenance concern if Check 3's full retro output is clean, but it did not catch the new observed `@handle` parser-prose false positive.
- [Measured] CI rollup on head `47c6b09` shows `test (18)`, `test (20)`, `test (22)`, and `security/snyk (cnighswonger)` successful; `GitGuardian Security Checks` was still `IN_PROGRESS` when checked.

## Bloat / Non-Functional

None for this round. The new `--self-test` block is proportionate to the four parser regressions it guards and introduces no runtime config, no persistent state, and no proxy surface.

## Recommendations

- Make the full `v4.3.0..HEAD` Check 3 output the regression oracle for this PR, not just the isolated extraction fixture. The parser should still prove numeric-leading handles can be extracted, but examples inside release-tooling prose should not be counted as missing README credits.
- Add a fixture that represents the fix commit prose shape, such as `Check 3 (@handle mentions)` and `returning @1Password`, and expects no candidate credit findings from those lines unless the README comparison intentionally treats them as credits.

## Bottom Line

Request changes. Three of the four R1 blockers are resolved, and the self-test has the right standalone shape, but Check 3 is only partially fixed: the named `@users` false positive is gone while two new false positives appear in the required full-range retro run.

— Codex, cross-LLM review, round 2
