# Directive: `gh-auth-status-shim` — new PATH-resolved shim addressing CC#67055

**Issue:** TBD (will be filed alongside this directive, referencing CC#67055)
**Upstream:** [anthropics/claude-code#67055](https://github.com/anthropics/claude-code/issues/67055) — *Desktop: false "GitHub CLI authentication expired" toast — any `gh auth status` failure (incl. its 5s timeout) is classified as expired credentials, frequent during multi-agent workloads* (state: open; multi-platform repro confirmed; 4+ feeder paths into the same classifier)
**Priority:** P2
**Branch:** `feature/tool-gh-auth-status-shim`
**Stage:** directive — round 4 (addresses Codex round-1 REQUEST_CHANGES at PR #216; prior rounds addressed Fable round-1 REQUEST_CHANGES then Fable round-2 REQUEST_CHANGES)
**Labels:** `directive-stage`, `tools-contribution`, `needs-prototype-validation` (mandatory Linux experiment described below)
**Milestone:** v4.2.0

## Round-1 misattribution acknowledgement

The round-1 directive claimed to be "polishing the internal `~/.claude/hooks/gh-bot-guard.sh`" — that script exists and is real, but it is a `GH_TOKEN=` write-prefix guard for bot-identity discipline. It has no `timeout` wrapper, no `gh auth status` classification, no relationship to CC#67055. The round-1 directive described a tool that does not exist.

The round-2 directive presents this as **a new tool**, designed from the CC#67055 issue body's verified bundle-inspection findings (5-second spawn timeout misclassified as "auth", four feeder paths into the same `"auth"` toast category). There is no internal burn-in to invoke; the design must stand on its own merits and prototype validation before shipping. The name is changed to `gh-auth-status-shim` to eliminate collision with the real `gh-bot-guard.sh`.

## Goal

Ship a PATH-resolved `gh` wrapper script that, when active on a user's PATH ahead of the real `gh` binary:

1. Intercepts `gh auth status` invocations from CC Desktop's PR poller.
2. Classifies the outcome conservatively:
   - Real authentication failure (stderr signals "not logged in" or an explicit auth-error line) — exit non-zero so CC's toast fires (real failure surfaced).
   - Transient failure (spawn timeout, network/Keychain hiccup, ambiguous error) — return success exit code to suppress the false toast; the next CC poll will retry naturally.
3. Execs the real `gh` for every other subcommand without modification.

The shim suppresses CC#67055's false toast for the user while letting genuinely-expired tokens still surface through normal `gh` error paths. It is not a fix for CC's classifier — it is a user-installable workaround for the documented bundle-inspection findings.

## Why

CC#67055 documents (with verified `app.asar` bundle excerpts) that CC Desktop's PR poller runs `gh auth status --hostname github.com` with a 5-second `timeoutMs`, and **any** non-zero return — including the 5s spawn timeout itself — maps to the `"auth"` toast category. The 2026-06-11 issue update consolidates the cross-platform picture: at least four independent feeder paths (Keychain slow-read, CLI's silent anonymous fallback under cli/cli#13317, spawn-time CPU contention, classifier overstrictness itself) all land at the same false-toast surface.

CC Desktop's internal `gh` spawn cannot be intercepted by a CC hook — CC hooks fire around Claude's tool calls, not around the Desktop process's own subprocess spawns. The only effective interception is at the OS level: a `gh` wrapper earlier on PATH than the real binary. The wrapper must validate against CC Desktop's actual PATH resolution before claiming to fix anything; that's the load-bearing prototype-validation step.

The framing is **workaround, not fix**. The README explicitly frames the tool as "use this until Anthropic ships their classifier fix." The sunset plan (uninstall when CC#67055 closes) is documented.

## Non-Functional Requirements

- **Size/complexity budget:** shim script ~150 LOC bash; classification helper ~80 LOC; install/uninstall ~100 LOC each; bats tests ~250 LOC; README ~300 LOC. Honest total: ~880 LOC. The round-1 budget of 400 LOC was not credible once bats CI infrastructure is included.
- **bash 3.2 floor** — macOS ships bash 3.2 by default; the script must run on it. Modern features (`mapfile`, `[[ -v ]]`, `;;&` case fall-through, `${var,,}`) are forbidden unless guarded by version detection. Verification (closes round-2 N4): CI explicitly invokes the bats suite under `/bin/bash` on the macOS runner AND every test file asserts `BASH_VERSION` starts with `3.2` inside its setup. `shellcheck` runs as a CI lint pass but in default mode (NOT `-s sh`, which enforces POSIX sh and would reject perfectly legal bash 3.2 constructs); the macOS bash-3.2 run is the actual floor verifier.
- **Portable timeout** — `timeout` is GNU coreutils, absent on macOS. The shim uses a bash-native timeout pattern (`gh ... &` background, `sleep N &&  kill ...` watchdog, `wait` for outcome) or detects and uses `gtimeout` (Homebrew) / `timeout` whichever is present. Verified across linux + macOS in CI.
- **No external runtime dependencies beyond `gh` itself.** `jq` is NOT required (round-1 listed it; not needed for shim use case). Verified.
- **Threat model:** the shim sees gh stderr/stdout for classification purposes but never logs them, never persists credentials, never modifies gh state. Read-only with respect to the auth backend.
- **Behavioral-change disclosure:** the shim rewrites the exit-code semantics of `gh auth status` for every caller in the user's shell session — including non-CC callers. This is documented in the README's "limitations" section. Other tools that depend on `gh auth status` exit code for security-relevant decisions will see exit 0 during the transient-failure window. Per Fable round 1 attention #5, this is a real behavioral change, not just an internal CC adjustment.
- **Activation model:** opt-in install via `tools/gh-auth-status-shim/install.sh` which:
  - Copies the shim to a user-selected directory (default `$HOME/.local/bin/`).
  - Verifies the directory is on the user's PATH AHEAD of the real `gh` binary (compares `which gh` before and after).
  - Refuses to install if PATH ordering can't be guaranteed; prints instructions for fixing.
  - Does NOT modify the user's shell rc files automatically — prints the export line the user should add.
- **Load-bearing? Yes.** This tool installs a PATH-intercepting `gh` wrapper that intentionally rewrites `gh auth status` exit-code semantics for every caller in the shim's PATH scope — including non-CC tools that depend on the standard `gh` exit-code contract for security-relevant decisions. Per CLAUDE.md's security-relevant criterion, this qualifies as load-bearing. Per CLAUDE.md, load-bearing changes require Chris human review before merge in addition to the routine Lead + Codex review path.

## Interception mechanism (closes Fable B2)

The shim is a bash script named `gh` placed earlier on PATH than the real `gh` binary. It MUST resolve the real `gh` binary at startup via `command -v` or absolute path detection (excluding itself); failure to find a real `gh` aborts with a clear error.

Subcommand dispatch:

```bash
# Pseudo-code
REAL_GH=$(detect_real_gh)
case "$1" in
  auth)
    case "$2" in
      status)
        # The intercept path — classify outcome
        classify_and_dispatch_auth_status "$@"
        ;;
      *)
        exec "$REAL_GH" "$@"
        ;;
    esac
    ;;
  *)
    exec "$REAL_GH" "$@"
    ;;
esac
```

For `auth status` specifically:

```bash
# Run real gh with portable timeout INSIDE CC's 5s window. CC Desktop
# spawns the shim with timeoutMs: 5e3 and abandons it at t=5s — any
# verdict the shim renders after that point is invisible to CC. The
# shim's internal budget must therefore be ~3.5-4s so it can both run
# the real gh AND classify within CC's window.
#
# Capture stdout and stderr SEPARATELY so output stream semantics are
# preserved (gh has historically moved auth-status output between
# streams; re-merging would compound that drift).
STDOUT_FILE=$(mktemp)
STDERR_FILE=$(mktemp)
portable_timeout 4 "$REAL_GH" auth status --hostname github.com \
    > "$STDOUT_FILE" 2> "$STDERR_FILE"
EXIT=$?
STDOUT=$(cat "$STDOUT_FILE")
STDERR=$(cat "$STDERR_FILE")
rm -f "$STDOUT_FILE" "$STDERR_FILE"

# Normalize timeout exit code. GNU timeout uses 124; bash-native
# watchdog (kill -TERM) yields 128+SIGTERM = 143. Map both to 124
# internally so the classifier is platform-agnostic.
if [ "$EXIT" = "143" ]; then EXIT=124; fi

case "$EXIT" in
  0)  # Real success — pass stdout and stderr through their original streams
      printf '%s\n' "$STDOUT"
      printf '%s\n' "$STDERR" >&2
      exit 0 ;;
  124) # Timeout (whether GNU timeout or bash-native watchdog)
      # Transient — return success to suppress false toast. Emit a
      # diagnostic to stderr so direct-shell callers see what happened;
      # CC Desktop has already abandoned the shim at t=5s and will
      # never read this, which is fine.
      printf '%s\n' "$STDERR" >&2
      printf '[gh-auth-status-shim] auth status timed out within %ss; treating as transient.\n' "$INTERNAL_TIMEOUT" >&2
      exit 0 ;;
  *)  # Non-zero — inspect outputs separately and classify
      classify_real_failure "$STDOUT" "$STDERR" "$EXIT"
      ;;
esac
```

Where `classify_real_failure` returns 0 (suppress) for transient signals and the original exit code (propagate) for genuine "not logged in" signals.

**Per-feeder-path coverage** (honest disclosure for the README):

| CC#67055 feeder path | Shim coverage |
|---|---|
| Slow `gh` exceeding CC's 5s (Keychain slow-read, event-loop stalls) | **Covered** — shim's 4s internal timeout returns exit 0 before CC's 5s abandonment. |
| Anonymous-401 from gh's silent Keychain fallback (cli/cli#13317) | **Covered** — fast-failing exit; classifier matches HTTP 401 in stderr and returns 0. |
| Network transient (timeout, connection refused, resolve failure) | **Covered** — classifier matches stderr signals and returns 0. |
| Deleted-`cwd` spawn failure (CC#67055 issue update feeder #4) | **NOT covered** — spawn fails before any `gh` (real or shim) executes. Documented limitation. |
| Genuinely expired token | **Correctly propagates** — classifier matches "not logged in" in stdout and returns the original exit code, letting CC's toast fire as intended. |

The previous round-2 directive's "longer than CC's 5s so we can DIFFERENTIATE" rationale was backwards: differentiating timeout-vs-expiry past 5s benefits only non-CC callers, who are not the audience. CC Desktop is the audience, and CC's 5s window is the load-bearing constraint.

**Critical prototype-validation step:** before merge, the implementation PR must demonstrate (a) that CC Desktop's PR poller actually resolves `gh` through the user's PATH on the target platform, AND (b) that the shim renders its verdict within CC's 5-second window.

**Linux (visits-01) validation:**

1. Install the shim.
2. Run a CC Desktop session that triggers PR polling.
3. Confirm via shim-side logging that the shim received the `auth status` invocation.
4. Mock the real `gh` to sleep 8 seconds (longer than CC's 5s window). The shim's 4s internal timeout must fire AND return exit 0 in time for CC to read it. **Verify the false toast does NOT fire.** Baseline without the shim: the false toast DOES fire when the real `gh` is slow.
5. Measure the shim's actual wall-clock time-to-exit; must be < 5s on the slow-real-gh path.

If step 3 fails (CC Desktop bypasses PATH on Linux), the mechanism is dead on Linux and the directive must be withdrawn or rescoped. If step 4 or 5 fails (shim cannot answer within CC's 5s window), the timeout budget is wrong and must be tightened further.

**macOS validation (separate experiment; closes round-2 B2 residual):**

macOS GUI apps launched from Finder/Dock inherit `launchd`'s PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), NOT the user's shell PATH. A shim installed in `~/.local/bin` may be invisible to CC Desktop even if Linux validation passes. The implementation PR must either:

- **(a) Recruit a macOS validator** from the CC#67055 issue thread, run steps 1-5 above on macOS Desktop, and attach the results to the PR; OR
- **(b) Scope the support claim** to "Linux validated; macOS PATH resolution unverified" in the README, install instructions, and the CHANGELOG. The shim still ships, but the README is honest that macOS coverage is experimental.

The `install.sh` PATH-ordering check inspects the *shell* PATH, which can give macOS users false confidence (shell PATH is correct, but `launchd`'s PATH is what matters for CC Desktop). The README limitations section MUST say so explicitly.

**Windows validation:** out of scope. Native Windows is NOT covered by a bash shim (see "Coverage scope" below).

If both (a) and (b) are unviable for macOS — no validator available AND we don't want to scope-restrict — the directive is reduced to Linux-only and the macOS-validation prerequisite becomes a follow-up directive.

## Classification table (closes Fable B1 fiction)

This is design, not description. The classification logic the shim implements:

| Signal | Action |
|---|---|
| Exit 0 + stdout contains "Logged in to github.com" | Pass through with exit 0 (genuine success). |
| Exit non-zero + stdout/stderr matches `/(not logged in|no.*credentials.*configured|HTTP 401)/i` | Return original exit code (genuine expiry; let CC toast fire). |
| Exit non-zero + timed out (portable timeout fired) | Return 0 with stderr message logged to optional debug log (transient). |
| Exit non-zero + stderr matches `/(timeout|connection refused|could not resolve host|temporary failure|network unreachable)/i` | Return 0 (transient network). |
| Exit non-zero, no clear signal, output empty or ambiguous | **Conservative default: return the original exit code.** Let CC see the failure. This matches Fable round 1's recommended posture — the worst case for the user is a slightly delayed surfacing of a real failure, not a silent loss. |

The table lives in `lib/classify-auth-status.sh` as a sourceable helper with documented function names (`classify_auth_status_exit_code`, `classify_auth_status_output_text`). Contributors extending the table follow the documented sourcing contract per Fable round 1 attention #2.

**Why string matching, not `gh auth status --json hosts`** (closes Codex round-1 attention): the JSON output flag is available on modern `gh` (verified locally), and structural classification would be more durable to upstream wording changes. We chose text-matching for v1 because (a) the `--json hosts` output is intended for `--hostname github.com` queries and its `state` field semantics for the failure cases we care about (timeout, transient network, Keychain anonymous-fallback HTTP 401) are not documented and may not be present on the stderr-stream-only failure paths the shim has to classify — those failures happen before `gh` produces structured output. (b) `gh`'s output format has been stable across recent versions on the specific strings we anchor on ("Logged in to github.com", "not logged in"); the README documents the validated version range. (c) the conservative-default posture (ambiguous → propagate original exit code) means classifier drift produces "slightly delayed surfacing of a real failure," not a security regression. Revisit in v2 if Codex round-2 or sim validation surfaces a structural-output failure path the regex misses.

## bats CI integration (closes Fable round-1 attention #1)

The repo's existing CI (`.github/workflows/test.yml`) runs `npm test` on Node 18/20/22 on `ubuntu-latest` only. The shim needs:

- bats-core install step (`apt-get install bats` on ubuntu, `brew install bats-core` on macOS).
- macOS runner for the macOS-specific portability tests (bash 3.2, `timeout` absence, `gtimeout` fallback path).
- A separate workflow file `.github/workflows/test-shim.yml` (NOT joined to the main proxy test workflow — different language, different test framework, should not gate Node-proxy PRs).

Workflow shape (in scope):

```yaml
name: Test shim
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  test-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get install -y bats
      - run: bats tools/gh-auth-status-shim/tests/
  test-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - run: brew install bats-core
      - run: /bin/bash --version  # informational only — does NOT pin bats interpreter
      # Force the suite to run under /bin/bash (3.2) explicitly; without this,
      # bats's `#!/usr/bin/env bash` shebang may resolve to Homebrew bash and
      # the floor claim becomes theater (round-2 N4).
      - run: /bin/bash $(which bats) tools/gh-auth-status-shim/tests/
```

shellcheck runs in CI only (not in `install.sh`) per Fable round 1 attention #4.

## Install / uninstall behavior (closes Fable round-1 attention #4)

`install.sh`:

1. Resolves install target (default `$HOME/.local/bin/`; overridable via flag).
2. If target file already exists:
   - If it's the same shim version (checksum match): no-op, print "already installed."
   - If it's a different version: backup to `<target>.bak.<timestamp>` and overwrite. Print backup path.
   - If it's not a shim file (sanity check `grep -q '^# gh-auth-status-shim'` in head): refuse to overwrite; print error.
3. Verifies `which gh` resolves to the shim after install (with the user's current PATH); if not, print the export line the user needs to add to their shell rc.
4. Prints the sunset notice + CC#67055 link.
5. Exits 0 only if all steps succeeded.

`uninstall.sh` (closes round-2 N2 — the round-2 restore-from-backup step was inverted logic; install refuses to overwrite non-shim files, so every `.bak` is by construction an older shim version, and "restoring" would silently put an outdated shim back on PATH):

1. Verifies the file at target is a shim (`grep -q '^# gh-auth-status-shim'`); refuses to remove if not.
2. Removes the file.
3. Removes any `<target>.bak.<timestamp>` shim backups created by prior installs (verifies each is a shim before removing, same predicate as step 1).
4. Prints confirmation + the export line the user can remove from shell rc.

No restore-from-backup. Installs that fail their own integrity check leave nothing to restore; installs that succeeded created shim backups, which uninstall should clean up, not reinstate.

Idempotent: install twice → no-op the second time; uninstall twice → benign error on the second.

## Repo placement (closes Fable round-1 attention #3)

The shim is a PATH-resolved binary wrapper, not a CC hook. Belongs in `tools/`, not `hooks/examples/`.

Layout:

```
tools/gh-auth-status-shim/
  gh-auth-status-shim.sh        # the actual shim (executable, named `gh` when installed)
  lib/classify-auth-status.sh   # sourceable classification helper
  install.sh
  uninstall.sh
  README.md                     # ~300 LOC: problem, mechanism, install, classification table, limitations, sunset
  tests/
    classify.bats               # unit tests for classification table
    integration.bats            # end-to-end shim behavior tests
    mocks/
      gh-mock.sh                # mock real-gh binary that simulates each failure mode
```

The README in `hooks/` is unaffected — this directive does NOT add a hook.

## TRACKED_ISSUES.md update (closes Fable round-1 attention #7)

CC#67055 gets added to the Engaged Issues table in `TRACKED_ISSUES.md`:

```
| [#67055](https://github.com/anthropics/claude-code/issues/67055) | Desktop: false "GitHub CLI authentication expired" toast — gh auth status failures (incl. 5s timeout) classified as expired credentials | Open | Shipping `tools/gh-auth-status-shim/` as PATH-resolved workaround until Anthropic's classifier fix lands. Sunset on issue close. |
```

The README's sunset section points at this entry. Operators can track upstream fix progress and uninstall the shim when CC#67055 closes.

## Sunset plan

When CC#67055 closes with an Anthropic fix:

1. README updates to "no longer needed if you're on CC version ≥ X" with the version that ships the fix.
2. TRACKED_ISSUES.md status updates.
3. The tool is NOT deleted from the repo (preserves the install path for users on older CC versions).
4. A future cache-fix release deprecates the tool with a removal date 6 months out.

The sunset doc lives in `tools/gh-auth-status-shim/README.md` under a "When to uninstall" section.

## Scope (v4.2.0)

In scope:
- New directory `tools/gh-auth-status-shim/` per the layout above.
- bats test suite covering classification table cases + end-to-end shim behavior.
- Portable timeout implementation (bash-native or detected `gtimeout`/`timeout`).
- bash 3.2 compatibility (verified by forcing the bats suite under `/bin/bash` on the macOS CI runner + per-test `BASH_VERSION` assertion; NOT by `shellcheck -s sh`, which enforces POSIX sh and would reject legal bash 3.2 constructs).
- `install.sh` / `uninstall.sh` per the behavior spec above.
- README citing CC#67055, classification table, limitations (per-feeder-path coverage table from above; behavioral-change disclosure; macOS launchd-PATH caveat; native-Windows non-coverage), sunset plan, troubleshooting section documenting the **specific `gh` version range the classification table was validated against** (closes round-1 attention #6 remainder; classification anchors on `gh`'s output strings, which `gh` has historically reworded across versions — a documented version range tells users when the table may need refresh).
- New CI workflow `.github/workflows/test-shim.yml` (linux + macOS).
- TRACKED_ISSUES.md entry.
- Prototype-validation step on visits-01 documented in the PR body before merge.

Out of scope (deferred):
- Windows PowerShell port. **Native Windows CC Desktop is NOT covered by a bash shim** (closes round-2 N3): CC Desktop on Windows spawns `gh.exe` through Windows PATH resolution; a bash shim on a WSL or Git-Bash PATH is invisible to that spawn. The round-2 directive's "covered for Windows users on WSL/Git-Bash" claim was false for the CC#67055 toast specifically. Windows users running CC Desktop natively must wait for a future PowerShell port or for Anthropic's classifier fix. Windows users running CC inside WSL with CC Desktop also inside WSL would be covered by the bash shim, but that's an uncommon configuration; do not claim it as general Windows support.
- Telemetry/phone-home of any kind.
- Caching `gh` auth token to inject as `GH_TOKEN` env var (the issue's third suggested fix from CC#67055's body). Distinct tool with distinct security implications; not bundled here.
- Modifying CC's classifier directly. Not our code.
- Suppressing toasts for non-`gh auth status` failures.

## Implementation choice

bash is the right language: process-launch-path interceptor, no Node/Python startup cost, universally available. shellcheck (in CI) is the static-quality gate. bats is the test framework.

The mechanism (PATH shim) is OS-level interception. The directive does not use the word "hook" anywhere except in the round-1 acknowledgement section.

## Test plan

- bats unit (`tests/classify.bats`): each classification table case produces the expected exit + suppress/forward decision. Mock `gh-mock.sh` simulates each failure mode (exit 0 + happy stdout, exit 1 + "not logged in", exit 1 + timeout, exit 1 + network error, exit 1 + ambiguous, exit 1 + empty output).
- bats integration (`tests/integration.bats`):
  - End-to-end shim flow with mock-gh: shim is called with `auth status`, classification runs, expected exit code is produced.
  - Non-`auth status` subcommand passes through to mock-gh unchanged.
  - Real-gh detection fails when only the shim itself is on PATH → shim aborts with clear error.
  - Portable timeout fires when mock-gh sleeps longer than the shim's timeout.
- bash 3.2 compatibility: bats suite passes on macOS-latest runner using the default `/bin/bash` (3.2).
- shellcheck (CI): clean on shim script + classification helper + install/uninstall scripts. CI-only; not bundled with the user-side install.
- bash 3.2 floor verification (CI): macOS runner explicitly invokes the bats suite under `/bin/bash` (`/bin/bash $(which bats) tests/`); every test asserts `BASH_VERSION` starts with `3.2` in setup. `shellcheck -s sh` is NOT used as the floor verifier (it enforces POSIX sh and would reject legal bash 3.2 constructs).
- Install idempotence: install twice → no-op the second time.
- Uninstall behavior: install over existing different-version shim → backup created at `<target>.bak.<timestamp>`; uninstall removes the current shim AND any `<target>.bak.*` shim backups (verifying each is a shim before removing). **No restore-from-backup step** — every `.bak` is by definition an older shim (install refuses to overwrite non-shim files), so "restoring" would silently reinstate an outdated shim. This was the round-2 N2 logic inversion; round-3 corrected it; the round-2 test-plan line for "backup/restore behavior present" is removed accordingly.

**Prototype validation (mandatory merge gate)** — must happen on Linux (visits-01) before implementation PR can merge, matching the rewritten validation experiment in §"Critical prototype-validation step" above:

1. Install the shim on visits-01.
2. Run a CC Desktop session that triggers PR polling.
3. Confirm via shim-side debug-logging that the shim received the `auth status` invocation. (If no, mechanism is dead, withdraw directive.)
4. Mock the real `gh` to sleep 8 seconds (longer than CC's 5s window). Verify the shim's 4s internal timeout fires and exits 0 in time for CC to read it. **The false toast must NOT fire** (vs. baseline without shim where it does at the 5s mark).
5. Measure the shim's actual wall-clock time-to-exit; must be < 5s on the slow-real-gh path.

(Round-2 directive specified a 6-second sleep + "longer than CC's 5s" rationale that would have failed the experiment by construction. Round-3 inverted the budget; round-4 reconciles this validation block with that inversion.)

Results attached as a comment on the implementation PR before reviewer chain proceeds to merge gate.

## Files modified / created

Created:
- `tools/gh-auth-status-shim/gh-auth-status-shim.sh`
- `tools/gh-auth-status-shim/lib/classify-auth-status.sh`
- `tools/gh-auth-status-shim/install.sh`
- `tools/gh-auth-status-shim/uninstall.sh`
- `tools/gh-auth-status-shim/README.md`
- `tools/gh-auth-status-shim/tests/classify.bats`
- `tools/gh-auth-status-shim/tests/integration.bats`
- `tools/gh-auth-status-shim/tests/mocks/gh-mock.sh`
- `.github/workflows/test-shim.yml` (new workflow; does NOT join the existing Node-proxy `test.yml`)

Modified:
- `CHANGELOG.md` — v4.2.0 entry citing CC#67055 explicitly + the workaround framing + the sunset plan.
- `README.md` — `tools/` section addition pointing to the shim subdirectory; one-paragraph summary of the CC#67055 workaround.
- `TRACKED_ISSUES.md` — add CC#67055 to the Engaged Issues table.

Out of scope (no changes):
- `.github/workflows/test.yml` — proxy Node tests stay in their existing pipeline.
- `hooks/examples/` and `hooks/README.md` — this is NOT a CC hook.
- The real `~/.claude/hooks/gh-bot-guard.sh` — different tool, different problem.

## Reviewer checklist (cache-fix side)

- [ ] Directive does NOT claim internal burn-in. This is a greenfield tool.
- [ ] Mechanism is documented as PATH shim, not CC hook, throughout.
- [ ] Prototype validation step (visits-01, mechanism actually intercepts CC Desktop's invocation) ran successfully — results attached as PR comment.
- [ ] Portable timeout: bash-native, or detected `gtimeout`/`timeout`; works on stock macOS.
- [ ] bash 3.2 floor: macOS CI runner explicitly invokes `/bin/bash $(which bats) tests/`; every test asserts `BASH_VERSION` starts with `3.2` in setup. (shellcheck runs in default mode for general lint; `-s sh` is NOT the floor verifier.)
- [ ] Shim internal timeout ≤ 4s — verified against CC's 5s spawn-timeout window.
- [ ] Validation experiment passed on Linux: mocked-slow-gh sleep 8s → toast does NOT fire (with shim) but DOES fire (without).
- [ ] macOS validation: either an external validator's results attached, OR README + CHANGELOG explicitly scope macOS as "unverified" and `install.sh` PATH-check disclaims launchd-PATH.
- [ ] Windows native CC Desktop NOT claimed as supported; README sunset section says so.
- [ ] `uninstall.sh` removes shim AND `.bak` shim backups; no restore-from-backup step.
- [ ] `gh auth status` stdout and stderr preserved separately through the shim (no `2>&1` re-merge).
- [ ] Timeout exit code normalized (GNU 124 + bash-native 143 → 124).
- [ ] No `jq` dependency.
- [ ] Classification table is the conservative posture (ambiguous → return original exit code, let CC see).
- [ ] Behavioral-change disclosure (`gh auth status` rewritten for every caller in the shim's PATH scope) explicit in README limitations.
- [ ] Install verifies PATH ordering; refuses install if PATH can't be guaranteed; does NOT modify shell rc files automatically.
- [ ] Uninstall idempotent; removes current shim AND any `.bak.*` shim backups (verifying each is a shim before removing); **no restore-from-backup step** (round-3 corrected the round-2 N2 logic inversion).
- [ ] `.github/workflows/test-shim.yml` is SEPARATE from `test.yml`; failure does not block proxy Node tests.
- [ ] shellcheck runs in CI only, not in install.sh.
- [ ] TRACKED_ISSUES.md entry added.
- [ ] README sunset section names CC#67055 explicitly.
- [ ] Tool name is `gh-auth-status-shim` (NOT `gh-auth-bot-guard`, NOT `gh-bot-guard`).
- [ ] CHANGELOG cites CC#67055 explicitly.

## Out of scope (explicit)

- "Polish version of internal script" framing. The internal `gh-bot-guard.sh` is a different tool; round-2 directive is about a new tool.
- CC hook integration. CC hooks cannot intercept CC Desktop's internal subprocess spawns.
- Modifying CC's classifier. Not our code.
- Bundling `gh` itself.
- Telemetry of any kind.
- Native Windows PowerShell port.
- Token-caching `GH_TOKEN` injection (different tool, different security profile).
- Joining the proxy Node test pipeline.

— AI Team Lead
