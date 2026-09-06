# Review: release-preflight PR #332

Date: 2026-08-12
Reviewed: PR #332 at `52a2a832b0a1595e58b2a4d73d621fa0961373c7`
Round: 1
Label applied: changes-requested

## What Is Correct

- [Read] `bin/release-preflight.sh:22` deliberately uses `set -uo pipefail` without `-e`. That is the right shape for this diagnostic script: each check should finish and accumulate findings even after a command substitution or grep pipeline produces no matches.
- [Read] The empty-input `while IFS= read -r ... <<< "$VAR"` loops are guarded by `[ -z "$x" ] && continue` at `bin/release-preflight.sh:213`, `bin/release-preflight.sh:239`, `bin/release-preflight.sh:267`, and `bin/release-preflight.sh:313`. With an empty variable the here-string supplies one empty record and the guard skips it, so the body does not add a phantom finding.
- [Read] The `wc -l` counts at `bin/release-preflight.sh:222`, `bin/release-preflight.sh:248`, `bin/release-preflight.sh:286`, `bin/release-preflight.sh:339`, and `bin/release-preflight.sh:343` operate on lists after empty lines are removed and then printed with `printf '%s\n'`, so the missing trailing newline case is normalized before counting.
- [Measured] `bash -n bin/release-preflight.sh` exits 0 on the PR head under GNU bash 5.2.21. `readarray -t < <(...)` is bash-4+ only, and the header states that requirement.
- [Measured] CI on PR head `52a2a832` is green: GitHub check rollup shows `test (18)`, `test (20)`, `test (22)`, and `security/snyk (cnighswonger)` all `SUCCESS`.
- [Read] Non-functional scope is reasonable for a release-only tool: one bash file, no persistent writes, no proxy path or wire/schema contract. I agree it is not load-bearing.

## Blockers

1. [Measured] Check 2 silently drops valid Co-authored-by trailer shapes, so it does not implement directive #324's "every Co-authored-by trailer" check.

   `bin/release-preflight.sh:192-202` says non-convertible trailers are "surfaced as-is for manual verification", but the implementation only extracts `<NNN+handle@users.noreply.github.com>` and discards everything else. Running the same filter over `v4.3.0..HEAD` leaves these non-bot, non-Anthropic trailers unreported:

   ```text
   Chris Nighswonger <chris.nighswonger@veritassuperaitsolutions.com>
   anupamme <anupamme@users.noreply.github.com>
   codeslake <codeslake@users.noreply.github.com>
   ```

   Check 3 does not catch them because it explicitly skips trailer lines at `bin/release-preflight.sh:185-187`. Check 1 only catches someone who was also the PR author. A future co-author-only contributor using a real email or legacy `handle@users.noreply.github.com` address can be omitted from README without any finding.

2. [Measured] Check 3 currently emits the `@users` false positive that the PR body says was fixed.

   Running `bin/release-preflight.sh v4.3.0 --skip-running-version` on the PR head reports:

   ```text
   == Check 3: @handle mentions in commit bodies covered in README Contributors ==
     MISSING @-handles mentioned in commit bodies:
       - @TheAuditorTool
       - @users
       - @Victor-Sun
   ```

   The source is the PR commit message itself:

   ```text
   Check 3 regex was matching @users out of email domains
     users.noreply.github.com
   ```

   The line filter at `bin/release-preflight.sh:185-187` excludes lines containing `users.noreply.github.com`, but it cannot suppress a prose line that discusses `@users` separately from the domain line. The retro-run therefore exits with 12 findings, not the 11 claimed in the PR body, and a release operator gets a wrong credit finding.

3. [Read + Measured] Check 5 omits the `feat(` fallback required by directive #324.

   Directive #324 says changelog coverage should include "Every merged PR labelled `enhancement` (or with a `feat(` commit) since `<last-tag>`". The implementation at `bin/release-preflight.sh:386-390` only asks GitHub for `label:enhancement`.

   On `v4.3.0..HEAD`, the script's enhancement query returns only:

   ```text
   320
   ```

   But the git range contains feature commits tied to PRs:

   ```text
   244
   262
   272
   273
   275
   278
   280
   320
   ```

   Several of those PRs do not carry the `enhancement` label. If one of them lacked a changelog entry, this script would still pass Check 5. That is a directive-level false negative.

4. [Measured] The commit-body handle regex rejects valid GitHub usernames that start with a digit.

   `bin/release-preflight.sh:187` uses `[A-Za-z]` for the first character. GitHub's current signup page says usernames may contain alphanumeric characters or single hyphens and cannot begin or end with a hyphen; it does not require a letter first. `gh api users/1password --jq '.login'` returns `1Password`, proving a numeric-leading account shape exists.

   A prose credit such as `Thanks @1Password` would not be extracted by Check 3, and neither Check 1 nor Check 2 is guaranteed to cover prose-only credits. The same regex also allows consecutive hyphens and trailing hyphens, but those are false-positive/manual-review problems; the numeric-leading miss is the release-relevant false negative.

## What Needs Attention

- [Read] `bin/release-preflight.sh:304-305` parses `remote.origin.url` with a `.git` suffix requirement. It fails loudly in the empty-owner/name guard, so I would not block on it, but `gh repo view --json owner,name` or a suffix-optional parse would be less brittle for HTTPS remotes cloned without `.git`.
- [Measured] `grep -E "(#|/pull/)${n}\b"` works as intended on this review host with GNU grep 3.11: it matches `#332` and `/pull/332`, and does not match `#332x`. This is not portable POSIX ERE behavior, so if the script is expected to run on macOS/BSD grep, prefer an explicit delimiter class.
- [Reported] AITL R0 preferred an allowlist file for Check 4's zero-activity external credits. I agree with option (b), with a required reason per entry. I would keep zero-activity as a failing check and make the reviewed allowlist the mechanism for known legitimate external credits.
- [Read] The Check 7 `curl /health` then `git rev-parse HEAD` comparison can false-negative if the branch moves during the run, but this is acceptable for a local release preflight. The operator can rerun.
- [Read] Search API rate limiting is not a blocker at the current README size, but Check 4 is the expensive part. An allowlist follow-up would also reduce repeated `search/issues` calls for known external credits.

## Bloat / Non-Functional

None. The script is bigger than a one-off shell snippet, but the size is in per-check reporting and human-oriented diagnostics, not unused abstraction. No new env vars, no new on-disk state, no proxy runtime surface.

## Recommendations

- Fix Check 2 to report every non-bot Co-authored-by trailer. For GitHub noreply, support both `NNN+handle@users.noreply.github.com` and `handle@users.noreply.github.com`; for real emails, print the trailer as manual-verification-required rather than dropping it.
- Fix Check 3 to parse actual GitHub handle syntax conservatively enough to avoid numeric-leading false negatives, and avoid treating explanatory prose like `@users` as a contributor mention. If exact parsing gets too clever, prefer surfacing uncertain mentions as manual-review rows with context.
- Extend Check 5 to include merged PRs associated with `feat(` commits in `LAST_TAG..HEAD`, not only PRs carrying the `enhancement` label.
- Add a tiny fixture-based shell test for the three parser behaviors above. This script is now release-gating human credit; a few heredoc fixtures would catch the regressions found in this review without needing live GitHub calls.

## Bottom Line

Request changes. The script is the right kind of release tool, and the non-functional shape is fine, but the current implementation still has release-relevant false positives and false negatives in the contributor and changelog checks. Fix those before merging.

— Codex, cross-LLM review, round 1
