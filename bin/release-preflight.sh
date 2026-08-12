#!/usr/bin/env bash
#
# bin/release-preflight.sh — validate contributor credit + changelog
# coverage before a release tag lands.
#
# Usage:
#   bin/release-preflight.sh <last-tag> [--skip-running-version]
#
# Read-only. Prints findings; exits non-zero if any check fires. Never
# edits.
#
# The tool's job is to surface a discrepancy for a human, never resolve
# one — see the directive for why. Every finding here is about a real
# person's name, and the cost of a confident wrong answer exceeds the
# cost of the manual check it replaces (see #324 rationale, and the
# @Victor-Sun vs @VictorSun92 case that drove check 4).
#
# Requires: bash 4+, git, gh (authenticated to this repo), jq.
# curl needed for check 7 (--skip-running-version to bypass on hosts
# without :9801).

set -uo pipefail

# --- args ---

SKIP_RUNNING_VERSION=0
LAST_TAG=""

while [ $# -gt 0 ]; do
    case "$1" in
        --skip-running-version) SKIP_RUNNING_VERSION=1; shift ;;
        -h|--help)
            cat <<'EOF'
Usage: bin/release-preflight.sh <last-tag> [--skip-running-version]

Read-only validation of contributor credit and changelog coverage
between <last-tag> and current HEAD. Prints findings to stdout;
exits 0 if all checks pass, 1 if any check fires, 2 on usage error.

Options:
  --skip-running-version  Skip check 7 (local :9801 /health query).
                          Use on CI or a host without the proxy running.

Checks:
  1. Every PR author merged since <last-tag> appears in README Contributors
  2. Every Co-authored-by trailer in the range appears (bots excluded)
  3. Every @handle in a commit body appears (catches prose-only credit)
  4. Every @handle in README Contributors resolves via GH API and has
     ≥1 contribution to this repo (catches same-display-name collision)
  5. Every merged PR labelled 'enhancement' since <last-tag> is
     referenced by number somewhere in CHANGELOG.md's Unreleased section
  6. Any PR merged in the range still carrying 'needs-sim-validation'
     or 'changes-requested'
  7. Running proxy version at :9801 matches the version about to be
     tagged (skip with --skip-running-version)

Exit codes:
  0  All checks passed.
  1  ≥1 check fired.
  2  Usage error, missing dependency, or unresolvable tag.
EOF
            exit 0
            ;;
        -*)
            echo "ERROR: unknown option: $1" >&2
            exit 2
            ;;
        *)
            if [ -n "$LAST_TAG" ]; then
                echo "ERROR: unexpected extra positional argument: $1" >&2
                exit 2
            fi
            LAST_TAG="$1"
            shift
            ;;
    esac
done

if [ -z "$LAST_TAG" ]; then
    echo "Usage: $0 <last-tag> [--skip-running-version]" >&2
    exit 2
fi

# --- prerequisites ---

for tool in git gh jq; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: required tool not found: $tool" >&2
        exit 2
    fi
done

if ! git rev-parse -q --verify "refs/tags/${LAST_TAG}" >/dev/null; then
    echo "ERROR: tag '${LAST_TAG}' does not exist" >&2
    exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
README="${REPO_ROOT}/README.md"
CHANGELOG="${REPO_ROOT}/CHANGELOG.md"

for f in "$README" "$CHANGELOG"; do
    if [ ! -r "$f" ]; then
        echo "ERROR: cannot read $f" >&2
        exit 2
    fi
done

# The commit range for every check that walks history since the tag.
RANGE="${LAST_TAG}..HEAD"

FAIL_COUNT=0
CHECK_NUM=0

pass() { echo "  OK"; }
fail() {
    # $1 = number of findings to add to fail count
    # remaining args = lines to print
    local n="$1"; shift
    local line
    for line in "$@"; do echo "  $line"; done
    FAIL_COUNT=$((FAIL_COUNT + n))
}

section() {
    CHECK_NUM=$((CHECK_NUM + 1))
    echo
    echo "== Check ${CHECK_NUM}: $1 =="
}

# Contributor handles listed in README Contributors section.
# Extracted from `[@handle](https://github.com/handle)` markdown links
# in the section starting `## Contributors` up to the next `## `.
extract_readme_handles() {
    awk '
        /^## Contributors$/ { in_section = 1; next }
        /^## / && in_section { in_section = 0 }
        in_section { print }
    ' "$README" \
        | grep -oE '\[@[A-Za-z0-9][A-Za-z0-9-]*\]' \
        | sed -E 's/^\[@//; s/\]$//' \
        | sort -uf
}

# lowercase for case-insensitive membership (GH handles are
# case-insensitive)
lc() { tr '[:upper:]' '[:lower:]'; }

# True if $1 (handle) is present in the newline-separated list on stdin
# (case-insensitive).
in_list_ci() {
    local needle
    needle=$(printf '%s' "$1" | lc)
    grep -qxi "$needle"
}

# All PR authors of PRs merged in range, bots excluded.
# gh pr list filters by state=merged; the range is applied via
# merged:>=<isodate> where <isodate> is the tag's committer date.
tag_iso_date() {
    git log -1 --format=%cI "$LAST_TAG"
}

fetch_pr_authors_since_tag() {
    local since
    since=$(tag_iso_date)
    gh pr list --state merged --search "merged:>=${since}" --limit 200 \
        --json author \
        --jq '.[] | .author.login' \
        | grep -vE '^app/|-bot$|\[bot\]$|^dependabot$' \
        | sort -uf
}

# All @handle mentions in commit bodies over the range. Handles must
# start with a letter (GH constraint), 1-39 chars. Filters:
#   - Skip trailer lines (Co-authored-by:, Signed-off-by:) entirely —
#     those go through fetch_coauthored_handles with proper parsing.
#   - Skip lines containing a users.noreply.github.com email — this
#     defends against emails like <279815601+vsits-proxy-builder[bot]@
#     users.noreply.github.com> matching "@users" via the loose char
#     class (this was the retro-test false positive of 2026-08-12).
#   - Require the @ to be preceded by whitespace or a
#     conversational-punctuation char, not an email/URL residue char.
fetch_commit_body_handles() {
    git log "$RANGE" --format='%b' \
        | grep -viE '^Co-authored-by:|^Signed-off-by:|users\.noreply\.github\.com' \
        | grep -oE '(^|[[:space:](\[{,;:!?—])@[A-Za-z][A-Za-z0-9-]{0,38}\b' \
        | sed -E 's/.*@//' \
        | sort -uf
}

# All Co-authored-by: emails/handles in commit trailers over the range.
# Only handles whose email is at users.noreply.github.com are convertible
# to a login without an extra lookup; others are surfaced as-is for
# manual verification. Bots and Anthropic-model identities excluded.
fetch_coauthored_handles() {
    git log "$RANGE" --format='%(trailers:key=Co-authored-by,valueonly)' \
        | grep -vE '^$' \
        | grep -viE 'noreply@anthropic\.com|-bot@|\[bot\]@' \
        | grep -oE '<[0-9]+\+([A-Za-z0-9-]+)@users\.noreply\.github\.com>' \
        | sed -E 's/.*\+([A-Za-z0-9-]+)@.*/\1/' \
        | sort -uf
}

# ---------- Check 1: PR authors covered ----------

section "PR-author coverage in README Contributors"

README_HANDLES=$(extract_readme_handles)
PR_AUTHORS=$(fetch_pr_authors_since_tag)

MISSING=""
while IFS= read -r author; do
    [ -z "$author" ] && continue
    if ! printf '%s\n' "$README_HANDLES" | in_list_ci "$author"; then
        MISSING="${MISSING}${author}"$'\n'
    fi
done <<< "$PR_AUTHORS"

if [ -n "$MISSING" ]; then
    MISSING_LIST=$(printf '%s' "$MISSING" | sed '/^$/d')
    MISSING_COUNT=$(printf '%s\n' "$MISSING_LIST" | wc -l)
    fail "$MISSING_COUNT" "MISSING PR authors (not in README Contributors):"
    while IFS= read -r m; do
        [ -z "$m" ] && continue
        echo "    - @${m}"
    done <<< "$MISSING_LIST"
else
    pass
fi

# ---------- Check 2: Co-authored-by trailers covered ----------

section "Co-authored-by trailer coverage in README Contributors"

COAUTHORED=$(fetch_coauthored_handles)

MISSING=""
while IFS= read -r author; do
    [ -z "$author" ] && continue
    if ! printf '%s\n' "$README_HANDLES" | in_list_ci "$author"; then
        MISSING="${MISSING}${author}"$'\n'
    fi
done <<< "$COAUTHORED"

if [ -n "$MISSING" ]; then
    MISSING_LIST=$(printf '%s' "$MISSING" | sed '/^$/d')
    MISSING_COUNT=$(printf '%s\n' "$MISSING_LIST" | wc -l)
    fail "$MISSING_COUNT" "MISSING Co-authored-by handles:"
    while IFS= read -r m; do
        [ -z "$m" ] && continue
        echo "    - @${m}"
    done <<< "$MISSING_LIST"
else
    pass
fi

# ---------- Check 3: @-handles in commit bodies covered ----------
# This catches prose-only credits like @thepiper18 that weren't
# author or Co-authored-by.

section "@handle mentions in commit bodies covered in README Contributors"

BODY_HANDLES=$(fetch_commit_body_handles)

MISSING=""
while IFS= read -r handle; do
    [ -z "$handle" ] && continue
    # Skip our own bot identities and Anthropic noise. Kept as an
    # explicit list (not a regex) so a new bot in the fleet has to be
    # added deliberately — a bot mentioned in a commit body that we
    # DON'T recognize IS worth surfacing as a finding to review.
    case "$handle" in
        vsits-proxy-builder|vsits-team-lead-agent|vsits-code-agent) continue ;;
        vsits-codex-review-agent|codex-reviewer-vsits) continue ;;
        code-agent-vsits|team-lead-agent-vsits) continue ;;
        anthropic|claude|noreply) continue ;;
    esac
    if ! printf '%s\n' "$README_HANDLES" | in_list_ci "$handle"; then
        MISSING="${MISSING}${handle}"$'\n'
    fi
done <<< "$BODY_HANDLES"

if [ -n "$MISSING" ]; then
    MISSING_LIST=$(printf '%s' "$MISSING" | sed '/^$/d')
    MISSING_COUNT=$(printf '%s\n' "$MISSING_LIST" | wc -l)
    fail "$MISSING_COUNT" "MISSING @-handles mentioned in commit bodies:"
    while IFS= read -r m; do
        [ -z "$m" ] && continue
        echo "    - @${m}"
    done <<< "$MISSING_LIST"
else
    pass
fi

# ---------- Check 4: README handles resolve to real accounts ----------
# The @Victor-Sun check. For each handle in README Contributors:
#   - resolve via GET /users/<h>
#   - report id + created_at
#   - check has ≥1 contribution to this repo (issue/PR author OR commit)

section "README Contributor handles resolve to accounts with repo activity"

REPO_OWNER=$(git config --get remote.origin.url | sed -E 's|.*[:/]([^/]+)/([^/]+)\.git$|\1|')
REPO_NAME=$(git config --get remote.origin.url | sed -E 's|.*[:/]([^/]+)/([^/]+)\.git$|\2|')
REPO="${REPO_OWNER}/${REPO_NAME}"

if [ -z "$REPO_OWNER" ] || [ -z "$REPO_NAME" ]; then
    fail 1 "ERROR: could not parse origin remote to owner/name for GH API queries"
else
    UNRESOLVABLE=""
    ZERO_ACTIVITY=""
    while IFS= read -r handle; do
        [ -z "$handle" ] && continue
        # Resolve the user
        user_json=$(gh api "users/${handle}" 2>&1) || {
            UNRESOLVABLE="${UNRESOLVABLE}${handle}"$'\n'
            continue
        }
        uid=$(printf '%s' "$user_json" | jq -r '.id')
        created=$(printf '%s' "$user_json" | jq -r '.created_at')
        # Check for ANY activity on this repo:
        # (a) authored PR or issue (issue/PR count as one search)
        # (b) authored a commit
        activity=$(gh api "search/issues?q=repo:${REPO}+author:${handle}&per_page=1" \
            --jq '.total_count' 2>/dev/null || echo "0")
        commits=$(gh api "repos/${REPO}/commits?author=${handle}&per_page=1" \
            --jq 'length' 2>/dev/null || echo "0")
        total=$((activity + commits))
        if [ "$total" -eq 0 ]; then
            ZERO_ACTIVITY="${ZERO_ACTIVITY}@${handle} (id=${uid}, created=${created%%T*}, 0 issue/PR/commit here)"$'\n'
        fi
    done <<< "$README_HANDLES"

    UNRES_COUNT=0
    ZERO_COUNT=0
    if [ -n "$UNRESOLVABLE" ]; then
        UNRES_LIST=$(printf '%s' "$UNRESOLVABLE" | sed '/^$/d')
        UNRES_COUNT=$(printf '%s\n' "$UNRES_LIST" | wc -l)
    fi
    if [ -n "$ZERO_ACTIVITY" ]; then
        ZERO_LIST=$(printf '%s' "$ZERO_ACTIVITY" | sed '/^$/d')
        ZERO_COUNT=$(printf '%s\n' "$ZERO_LIST" | wc -l)
    fi

    if [ "$UNRES_COUNT" -eq 0 ] && [ "$ZERO_COUNT" -eq 0 ]; then
        pass
    else
        if [ "$UNRES_COUNT" -gt 0 ]; then
            fail "$UNRES_COUNT" "UNRESOLVABLE README handles (GET /users/<h> failed):"
            while IFS= read -r m; do [ -z "$m" ] && continue; echo "    - @${m}"; done <<< "$UNRES_LIST"
        fi
        if [ "$ZERO_COUNT" -gt 0 ]; then
            fail "$ZERO_COUNT" "README handles with ZERO repo activity (possible same-display-name collision):"
            while IFS= read -r m; do [ -z "$m" ] && continue; echo "    - ${m}"; done <<< "$ZERO_LIST"
            echo
            echo "    NOTE: A handle with 0 repo activity may be a LEGITIMATE"
            echo "    external-project credit (research, tool, production usage,"
            echo "    community-mentioned issue reporter) rather than a"
            echo "    misattribution. Verify per-handle:"
            echo "      gh api users/<handle> --jq '{login, id, created_at}'"
            echo "    Compare id + creation date against the person the credit"
            echo "    is FOR. Different id + implausible creation date + zero"
            echo "    activity == the @Victor-Sun collision this check exists"
            echo "    to catch. Same id + matching activity elsewhere in their"
            echo "    profile == external credit, safe to acknowledge."
        fi
    fi
fi

# ---------- Check 5: 'enhancement' PRs referenced in CHANGELOG additions ----------

section "Every 'enhancement' PR since ${LAST_TAG} referenced in CHANGELOG additions"

# Look for PR numbers in the CHANGELOG DIFF since the last tag, not just
# the Unreleased section. This covers both workflows:
#   - Pre-tag: everything is in [Unreleased] and shows as added lines in the diff.
#   - Post-tag or retro: everything is in a named [x.y.z] section and STILL
#     shows as added lines in the diff (because that section didn't exist at
#     <last-tag>).
# Failing on missing-from-diff catches both "forgot to write it" (pre-tag)
# and "wrote it under wrong section" (retro), and doesn't false-pass a PR
# whose number happens to appear in an OLDER release's entry.
CHANGELOG_ADDS=$(git diff "${LAST_TAG}..HEAD" -- "$CHANGELOG" | grep -E '^\+' || true)

# All PR numbers with enhancement label merged since the tag
readarray -t ENHANCE_PRS < <(
    gh pr list --state merged --search "merged:>=$(tag_iso_date) label:enhancement" \
        --limit 200 --json number \
        --jq '.[] | .number'
)

MISSING_PRS=()
for n in "${ENHANCE_PRS[@]}"; do
    if ! printf '%s' "$CHANGELOG_ADDS" | grep -qE "(#|/pull/)${n}\b"; then
        MISSING_PRS+=("$n")
    fi
done

if [ ${#MISSING_PRS[@]} -gt 0 ]; then
    fail "${#MISSING_PRS[@]}" "MISSING 'enhancement' PRs from CHANGELOG additions since ${LAST_TAG}:"
    for n in "${MISSING_PRS[@]}"; do
        title=$(gh pr view "$n" --json title --jq '.title' 2>/dev/null || echo "")
        echo "    - #${n}  ${title}"
    done
else
    pass
fi

# ---------- Check 6: needs-sim-validation / changes-requested still applied ----------

section "PRs merged in range still carrying blocker labels"

readarray -t BLOCKED_PRS < <(
    gh pr list --state merged --search "merged:>=$(tag_iso_date)" \
        --limit 200 --json number,labels,title \
        --jq '.[] | select(.labels | map(.name) | any(. == "needs-sim-validation" or . == "changes-requested")) | "\(.number)\t\(.labels | map(.name) | join(","))\t\(.title)"'
)

if [ ${#BLOCKED_PRS[@]} -gt 0 ]; then
    fail "${#BLOCKED_PRS[@]}" "Merged PRs still carrying needs-sim-validation or changes-requested:"
    for row in "${BLOCKED_PRS[@]}"; do
        num=$(printf '%s' "$row" | cut -f1)
        labels=$(printf '%s' "$row" | cut -f2)
        title=$(printf '%s' "$row" | cut -f3)
        echo "    - #${num}  [${labels}]  ${title}"
    done
else
    pass
fi

# ---------- Check 7: running proxy version matches ----------

section "Running proxy at :9801 matches HEAD"

if [ "$SKIP_RUNNING_VERSION" -eq 1 ]; then
    echo "  SKIPPED (--skip-running-version)"
else
    HEALTH=$(curl -sS --max-time 3 http://127.0.0.1:9801/health 2>/dev/null || echo "")
    if [ -z "$HEALTH" ]; then
        fail 1 "ERROR: could not reach http://127.0.0.1:9801/health"
        echo "    (pass --skip-running-version to skip this check on CI or hosts without the proxy)"
    else
        running_tree=$(printf '%s' "$HEALTH" | jq -r '.proxy_tree // "unknown"')
        head_short=$(git rev-parse --short=12 HEAD)
        if [ "$running_tree" = "$head_short" ] || [ "$running_tree" = "unknown" ]; then
            # unknown = an older proxy that doesn't expose proxy_tree; can't check
            if [ "$running_tree" = "unknown" ]; then
                echo "  SKIPPED (running proxy doesn't expose proxy_tree in /health)"
            else
                pass
            fi
        else
            fail 1 "Running proxy tree '${running_tree}' != HEAD '${head_short}'"
            echo "    Restart the proxy onto HEAD before tagging, or the soak was against wrong code."
        fi
    fi
fi

# ---- summary ----

echo
if [ "$FAIL_COUNT" -eq 0 ]; then
    echo "All checks passed."
    exit 0
else
    echo "${FAIL_COUNT} finding(s) across ${CHECK_NUM} check(s). Do not tag until resolved."
    exit 1
fi
