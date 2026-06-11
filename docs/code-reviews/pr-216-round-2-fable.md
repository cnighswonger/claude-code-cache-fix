# PR #216 — Round 2 Architectural Review (Fable)

**Verdict: REQUEST_CHANGES** — all three round-1 blockers are genuinely cleared by the greenfield rewrite, but the fresh-eyes sweep finds one load-bearing design flaw: the shim's 10-second internal timeout sits *inside* CC Desktop's 5-second spawn timeout, so for the dominant feeder path (slow `gh` > 5s) CC kills the shim before classification ever runs and the false toast fires anyway. The directive's own prototype-validation experiment (6s induced sleep) would fail as specified and expose exactly this. The fix is small — invert the budget — but it is the core mechanism, so it must be corrected in the directive before implementation.

Reviewed: `docs/directives/tool-gh-auth-status-shim.md` @ `faadec1`, against round-1 artifact (`pr-216-round-1-fable.md`), the actual internal `~/.claude/hooks/gh-bot-guard.sh` (staged + verified live), current `tools/` and `hooks/examples/` layouts, and the live CC#67055 issue body (verified open; the `app.asar` `spawnGh` excerpt with `timeoutMs: 5e3` and the four-feeder-path consolidation are really there — the bundle-inspection citations are no longer hand-waved).

---

## Round-1 → Round-2 Status

### B1 (misattribution) — CLEARED

- Explicit "Round-1 misattribution acknowledgement" section; correctly characterizes `gh-bot-guard.sh` as a `GH_TOKEN=` write-prefix guard with "no relationship to CC#67055." Matches the staged script exactly.
- All "polished version of internal script" framing is gone; the directive states "There is no internal burn-in to invoke" and the reviewer checklist enforces it.
- New name `gh-auth-status-shim` used consistently in title, branch field, layout, file names, and checklist. No collision with `gh-bot-guard.sh` (verified against `hooks/examples/`, the live `~/.claude/hooks/`, and `tools/` — no `gh-*` entries in `tools/` at all).
- The round-1 "fiction" classification table is now correctly presented as design ("This is design, not description"), and the meaningless visits-01 "no behavior change" test is replaced with a real validating experiment.
- Residual metadata nit: the PR branch (`directive/tool-gh-auth-bot-guard`) and PR title still carry the old name. Cosmetic; rename the PR title at minimum so the merge record doesn't preserve the misattributed identity.

### B2 (interception mechanism) — SUBSTANTIALLY CLEARED, one residual gap

- Mechanism is now explicitly a PATH shim; the word "hook" appears only in the acknowledgement section; install target moved out of `~/.claude/hooks/` to `$HOME/.local/bin/`; placement moved to `tools/` accordingly.
- Bundle-inspection findings are cited specifically and check out against the live issue body (5s `timeoutMs`, `ignoreExitCode`, `.code === 0` classifier, four feeder paths).
- The prototype-validation step is honest and has a kill criterion ("If step 3 fails, the mechanism is dead, withdraw directive"). That is exactly the load-bearing experiment round 1 asked for.
- **Residual gap: single-platform validation.** The plan validates on visits-01 only. CC#67055's confirmed reproductions are macOS + Windows, and macOS is precisely where PATH interception is most doubtful: GUI apps launched from Finder/Dock inherit launchd's PATH (`/usr/bin:/bin:...`), not the user's shell PATH, so a shim in `~/.local/bin` may be invisible to CC Desktop on the primary repro platform even if visits-01 (Linux) passes. The directive should either (a) add a macOS validation step or recruit one from the issue thread before claiming macOS support, or (b) scope the claim to "validated on Linux; macOS PATH resolution unverified" in the README. Related: `install.sh`'s PATH-ordering check inspects the *shell* PATH, which can give macOS users false confidence — the README limitations section should say so.

### B3 (stock-macOS `timeout`) — CLEARED, two nits

- Portable timeout (bash-native watchdog or detected `gtimeout`/`timeout`) specified; bash 3.2 floor stated with a forbidden-features list; macOS CI runner added. This is what round 1 asked for.
- Nit 1: the pseudo-code matches exit `124`, which is GNU `timeout`'s convention — the bash-native watchdog yields 128+SIGTERM (143). The directive parenthetically acknowledges this ("whatever exit code our portable timeout uses"), but the implementation must normalize the timeout signal across both strategies or the classification table forks by platform.
- Nit 2: "`shellcheck -s sh`" does not verify bash 3.2 compatibility — it enforces POSIX sh, which would reject constructs that are perfectly legal in bash 3.2 (and the directive simultaneously permits version-guarded bashisms, which `-s sh` would flag). Drop `-s sh` from the bash-3.2 claim; the macOS `/bin/bash` CI run is the real verifier (see new issue N4 on making that run actually use bash 3.2).

### Round-1 attention items

| Item | Status |
|---|---|
| bats new test dependency / CI surface | **Addressed.** Separate `test-shim.yml`, install steps per OS, macOS runner, explicitly does not gate the Node-proxy pipeline. Honest LOC re-budget (400 → ~880) is appreciated. |
| `hooks/examples/` convention conflict | **Addressed.** Mechanism resolved to PATH shim → `tools/` placement is correct; hooks docs untouched. |
| shellcheck-in-install.sh hidden dependency | **Addressed.** CI-only, stated twice plus checklist item. |
| String-match classifier drift | **Partially addressed.** Conservative default (ambiguous → propagate) is adopted and the table is exit-code-aware, but the transient/expiry branches still anchor on output regexes, and the round-1 ask — document the `gh` version range the table was validated against in the README troubleshooting section — is absent from the README outline. Add it. |
| CC#67055 missing from TRACKED_ISSUES.md / sunset | **Addressed.** Table entry drafted, README sunset section, 6-month deprecation path post-fix. |

Also fixed from round-1 bloat notes: README budget honestly raised to ~300 LOC; `jq` dependency dropped. "Issue: TBD" remains TBD with a "filed alongside this directive" promise — hold that to the implementation PR as round 1 said.

---

## New Issues (greenfield sweep)

### N1 (blocker): Timeout-budget inversion — the shim cannot suppress the timeout feeder path as designed

The directive sets the shim's internal timeout to ~10s, reasoning it is "longer than CC's 5s so we can DIFFERENTIATE timeout from real expiry, not collide with CC's same 5s window." This is exactly backwards for the CC path:

- CC Desktop spawns the shim itself with `timeoutMs: 5e3`. If the real `gh` is slow (the dominant feeder: Keychain slow-read, event-loop stalls atop gh's ~1.2–2s baseline), the shim is still waiting at t=5s, CC kills/abandons it, `.code === 0` is false → **toast fires with the shim installed**. The shim's exit-0-on-timeout path at t=10s runs after CC has stopped listening.
- Worse, the shim adds its own spawn/exec overhead *inside* CC's 5s budget, making the timeout feeder marginally **more** likely.
- The directive's own validation plan proves the point: step 4 induces a 6s sleep in the shim and step 5 expects "the false toast does NOT fire" — with the specified design, the toast **will** fire at CC's 5s mark. The mandatory merge-gate experiment fails as written.

**Required fix:** the shim must render its verdict within CC's window — internal timeout ~3.5–4s, and on internal timeout exit 0 (transient) immediately. The "differentiate from CC's 5s" rationale should be deleted; differentiation beyond 5s only benefits non-CC callers, who are explicitly not the audience. Note honestly in the README which feeder paths the shim covers: it fully covers fast-failing transients (anonymous-401/Keychain hiccup) and slow-`gh` timeouts *only if* it answers inside 5s; it cannot help feeder #4 (deleted-`cwd` spawn failure — that fails before any `gh`, real or shim, executes).

### N2: `uninstall.sh` restore step reinstalls the old shim

Uninstall step 3 — "Restores from `.bak` of the prior install if one exists" — is a logic bug in the spec. `install.sh` refuses to overwrite non-shim files, so every `.bak` is by construction an *older shim version*. Uninstall would therefore remove the current shim and silently put an outdated shim back on PATH — the opposite of uninstalling, and worse than either alternative because the user believes the shim is gone. Required: uninstall removes the shim and any `.bak.*` shim backups (or leaves them inert with a non-`gh` name); restore-from-backup is only meaningful if install ever backed up a non-shim file, which it never does.

### N3: Windows coverage claim is inaccurate

Out-of-scope says Windows users are "covered ... on WSL/Git-Bash today." For the CC#67055 toast they are not: CC Desktop on native Windows spawns `gh.exe` through Windows PATH resolution; a bash shim on a WSL or Git-Bash PATH is invisible to that spawn. Deferring the PowerShell port is fine — the deferral just shouldn't claim present coverage it doesn't have. One sentence fix.

### N4: macOS CI bash-version pinning is asserted, not enforced

The workflow's `/bin/bash --version` step confirms what `/bin/bash` is but not what bats executes — bats test files and the shim run via `#!/usr/bin/env bash` shebangs, which on GitHub macOS runners can resolve to a newer Homebrew bash ahead of `/bin/bash`. The "bash 3.2 floor verified in CI" claim needs the workflow to force the interpreter (e.g., invoke the suite under `/bin/bash` explicitly, or assert `BASH_VERSION` starts with `3.2` *inside* a test). Without this, the floor is unverified and the comment line is theater.

### N5 (minor): success-path stream merging changes `gh auth status` output semantics

The pseudo-code captures `2>&1` and re-emits everything on stdout (success) or stderr (timeout). `gh` has historically moved `auth status` output between streams; the shim re-merging them is a second, self-inflicted layer of the same drift problem for any caller that parses output by stream. Capture stdout and stderr separately and replay each to its original stream. (Also prefer `command -v` over `which` in install.sh's PATH check.)

### Cleared by the sweep (no issue)

- **Namespace collision:** none — `gh-auth-status-shim` collides with nothing in `tools/`, `hooks/examples/`, or the live `~/.claude/hooks/`. The installed artifact is literally named `gh`, which is inherent to a PATH shim and is disclosed.
- **Blast radius:** the all-callers behavioral change is now explicitly disclosed in the NFRs and required in the README limitations — this resolves round-1 attention #5 and is the right posture. With N1's fix (shorter internal timeout), the blast radius statement should also note that *all* callers now get a ≤4s-budgeted `auth status` that may report success during transient failures.
- **Sunset:** real plan, tracked-issue anchored, with a deprecation timeline. Good.

## Recommendations

1. Invert the timeout budget: shim internal timeout ~3.5–4s, exit 0 on internal timeout, delete the "longer than CC's 5s" rationale, and document per-feeder-path coverage honestly. Re-derive the validation experiment from the corrected design. (N1)
2. Fix uninstall semantics: remove, don't restore, prior shim backups. (N2)
3. Correct the Windows deferral sentence. (N3)
4. Pin the CI interpreter for the bash-3.2 claim and drop `shellcheck -s sh` as a 3.2 verifier. (N4, B3 nit)
5. Preserve `gh`'s stdout/stderr separation through the shim. (N5)
6. Add a macOS validation step (or an honest "Linux-validated only" scope) and note that install.sh's PATH check cannot vouch for CC Desktop's launchd PATH on macOS. (B2 residual)
7. Document the validated `gh` version range in the README troubleshooting section. (round-1 attention #6 remainder)
8. Retitle the PR to the new tool name so the merge record matches the directive. (B1 nit)

## Bottom Line

The rewrite did what round 2 needed to do on honesty: the misattribution is acknowledged head-on, the tool is presented as greenfield, the mechanism is named, the bundle citations are real and verifiable, and every round-1 attention item is either fixed or visibly tracked. What stops approval is one new, load-bearing arithmetic problem: a shim that takes up to 10 seconds to answer a caller that gives up at 5 cannot suppress the toast it exists to suppress — and the directive's own merge-gate experiment would prove it. That fix is a few lines of directive text plus a corrected rationale, and N2–N5 are similarly small. Since this is round 2 of 2: N1 and N2 are the items I'd hold the implementation PR on; N3–N5 and the macOS-validation scoping are fix-in-flight. The design is otherwise sound and worth building.

— Fable 5 Review Agent
