# PR #216 — Round 1 Architectural Review (Fable)

**Verdict: REQUEST_CHANGES** — the directive misattributes the internal script it claims to be polishing; the tool it describes does not exist internally, and the proposed interception mechanism is architecturally unspecified.

Reviewed: `docs/directives/tool-gh-auth-bot-guard.md` @ `5f74f33`, against the actual internal script at `~/.claude/hooks/gh-bot-guard.sh`, the current `tools/` and `hooks/` layout, the test/CI surface, and upstream CC#67055 (verified open, title matches).

---

## What Is Correct

- **The problem is real and well-framed.** CC#67055 is open, multi-platform-confirmed, and the "complementary, not promotional" framing is right: suppress the false toast, don't claim to fix Anthropic's classifier.
- **The failure-mode analysis is sound.** "Misclassify real expiry as transient → next genuine `gh` call fails at the API layer" is the correct worst-case reasoning, and conservative-default ("anything else → let CC see the failure") is the right classification posture.
- **Out-of-scope fences are good.** No telemetry, no PowerShell port, no bundling `gh`, one classifier class only. The scope discipline itself is fine.
- **Bash is the right implementation language** for a process-launch-path interceptor, and the no-Node/no-Python latency argument is valid.
- **Opt-in activation** (nothing wired without the user running the installer) matches the repo's existing hook philosophy (`hooks/README.md`: "cache-fix does not register them automatically").

## Blockers

### B1. The directive describes a tool that does not exist. The internal script is a different tool solving a different problem.

The directive's central claim — *"Ship a polished, documented version of the `gh-auth-bot-guard.sh` hook script we have been using internally (`~/.claude/hooks/gh-bot-guard.sh`)"* and *"The fix we landed (`~/.claude/hooks/gh-bot-guard.sh`) is a small bash hook that catches `gh auth status` exit codes and timeouts"* — is false.

The actual script at that path (staged for this review; verified) is a **PreToolUse Bash-tool guard that blocks `gh` *write* commands lacking a `GH_TOKEN=` prefix**, enforcing bot-identity discipline on GitHub writes. It:

- never invokes `gh auth status`;
- contains no timeout wrapper, no exit-code classification, no stdout/stderr string matching for auth failures;
- has nothing to do with CC#67055's false-toast problem;
- reads CC's PreToolUse JSON from stdin and exits 2 to block tool calls — a completely different contract from "intercept the `gh auth status` invocation that CC's classifier consumes."

Consequences:

1. **There is no internal burn-in.** The directive's strongest selling point — months of internal use validating the design — does not apply to the tool being shipped. This is a greenfield tool, and the directive must be honest about that.
2. **The "Detection logic (from current internal script)" section is fiction.** The 10s-timeout / "You are not logged in" / transient-string classification table exists nowhere; it is a design proposal, not a description. Likewise *"The classification table is in `lib/classify-auth-failure.sh`"* (present tense) — no such file exists.
3. **The test plan's only regression anchor evaporates.** *"Manual: run on visits-01 … assert no behavior change from current state (we're the canonical user)"* is meaningless: there is no current auth-status-guarding state to compare against. visits-01 runs a write-prefix guard, not an auth classifier.
4. **Name collision compounds the confusion.** `gh-bot-guard.sh` (real, write-guard) vs `gh-auth-bot-guard.sh` (proposed, auth classifier) in the same `~/.claude/hooks/` directory. The directive's own author conflated them; users and future operators will too. Pick a name that doesn't shadow the existing internal tool — e.g. `gh-auth-status-shim`.

**Required fix:** rewrite the Goal/Why sections to present this as a *new* tool inspired by the internal failure experience, drop all "polished version of what we run" claims, rename to avoid collision with the real internal guard, and replace the visits-01 "no behavior change" test with a real validation plan (see B2/Recommendations).

### B2. The interception mechanism is architecturally unspecified — a CC hook cannot do what the directive claims.

The directive says the tool *"intercepts the `gh auth status` invocation that CC's classifier consumes"* and is activated by copying to `~/.claude/hooks/` with the user wiring it *"via their existing hook config per CC documentation."*

CC hooks (PreToolUse/PostToolUse/SessionStart/etc.) fire around **Claude's tool calls**. The CC#67055 toast comes from **CC Desktop's own internal credential check** — there is no hook event on that path. A script in `~/.claude/hooks/`, wired through `settings.json`, will never see CC Desktop's internal `gh auth status` invocation. As specified, the tool cannot suppress the toast.

The only plausible mechanism is a **PATH shim**: a `gh` wrapper earlier in `$PATH` (or a `GH_PATH`-style redirect) that intercepts `auth status` subcommands, applies the classification, and execs the real `gh` for everything else. The directive's *"prints the env-var setup the user should add to their shell"* gestures at this, but everything else (the word "hook" throughout, `~/.claude/hooks/` as install target, "per CC documentation" wiring) says CC-hook — which doesn't work. Note also that a PATH shim only affects processes that inherit the modified PATH; whether CC Desktop's internal `gh` invocation resolves through the user's shell PATH at all (vs. an absolute path or its own resolution) is exactly the kind of question the directive must answer before claiming the mechanism works.

**Required fix:** specify the actual interception mechanism, verify CC Desktop's `gh` resolution actually flows through it (this is the real visits-01 test), and align the install target / activation docs with that mechanism. If it's a PATH shim, it is not a "hook" and arguably belongs under `tools/` with shim docs — but the README must stop referencing CC hook configuration.

### B3. The specified detection logic does not run on stock macOS, contradicting the directive's own macOS claim.

Detection step 1 wraps `gh auth status` in `timeout 10s`. `timeout` is GNU coreutils — absent on stock macOS (only available as `gtimeout` via Homebrew coreutils). The reviewer checklist simultaneously requires *"Bats test suite passes on linux + macOS CI."* As written, the design's first line fails on the platform the directive claims to support, and the upstream issue's confirmed reproductions are macOS + Windows — macOS is the *primary* audience.

**Required fix:** either implement a portable timeout (bash-native `wait -n` pattern, or detect `timeout`/`gtimeout` and degrade gracefully) or scope macOS support honestly. Also mandate bash-3.2 compatibility explicitly (macOS default bash) or add a version guard — the current design doesn't state a floor.

## What Needs Attention

1. **bats is a brand-new test dependency, and the CI claim is unbacked.** The repo has zero bats usage — the entire suite is Node `.mjs` under `npm test`, and `.github/workflows/test.yml` runs **ubuntu-latest only** (Node 18/20/22 matrix). "Bats test suite passes on linux + macOS CI" requires: installing bats-core in CI, adding a macOS runner (or a new workflow), and deciding whether bash-tool tests gate the Node-proxy PR pipeline. That is real CI surface the directive doesn't acknowledge; the scope budget should include it.

2. **`lib/classify-auth-failure.sh` split is new design, not a refactor** — fine in itself (it's a reasonable extension point), but since there is no monolithic predecessor (B1), the directive should present it as design, and the "contributors can extend without touching the main script" claim needs a defined sourcing contract (function name, input/output convention) in the README.

3. **Repo-placement convention conflict.** The repo already has a home for CC hook scripts: `hooks/examples/` + a docs page under `docs/hooks/` + a settings.json snippet, explicitly *without* an installer ("you install them by pointing at them from your own settings.json"). The directive puts this under `tools/` with an `install.sh` that copies into `~/.claude/hooks/`. If the mechanism resolves to a PATH shim (B2), `tools/` is defensible; if it stays a CC hook, it belongs in `hooks/examples/` following the existing convention. Either way, the current split-the-difference placement contradicts one convention or the other.

4. **`install.sh` adds a hidden dependency and skips known footguns.** The directive says deps are "`gh` + `jq`" but `install.sh` "runs `shellcheck` on the hook as a pre-install sanity check" — that makes shellcheck a user-machine install dependency (wrong place for it; shellcheck belongs in CI, not on the user's box — degrade to a warning if absent). The scope also doesn't address: existing file at target path (backup-then-overwrite), partial-failure state, or what "idempotent" (checklist item) concretely means. Three sentences in the directive would settle all of it.

5. **Threat model is slightly overstated.** "Read-only with respect to gh-auth state" is true of state, but the tool **rewrites the exit-code semantics of `gh auth status` for every caller in scope** — if installed as a PATH shim, that includes other scripts and tools that rely on `gh auth status`'s exit code for security-relevant decisions. They will see exit 0 during a transient network failure. That's the documented intent for CC, but it's a behavioral change for all callers; the README must say so and the threat-model line should be amended.

6. **String-matching on `gh` output is a drift-prone classifier.** `gh` has historically moved `auth status` output between stdout/stderr and reworded messages across versions; "stdout contains `You are not logged in`" is the most fragile possible anchor. Prefer structural signals first (exit code distinctions, `gh auth status --hostname github.com 2>&1` combined-stream matching as fallback) and consider `gh api /user --silent`'s exit code or `gh auth token >/dev/null` as a more durable expiry probe. At minimum the README's troubleshooting section should document the `gh` version range the table was validated against.

7. **No sunset plan.** The tool's value evaporates when Anthropic fixes the classifier. Cheap mitigations: add CC#67055 to `TRACKED_ISSUES.md` (it's absent today, and that file is exactly the repo's mechanism for upstream-fix tracking), and a README "when to uninstall" section pointing at the issue. Not ship-blocking, but the absence is conspicuous in a directive whose whole framing is "until the upstream fix lands."

## Bloat / Non-Functional

- **README 200 LOC is tight** for: problem statement + CC#67055 context + mechanism explanation (now necessarily including PATH-shim caveats per B2) + classification table + install/uninstall + troubleshooting + sunset note. Expect ~300; not a problem, just budget honestly.
- **Branch-name discrepancy:** directive header says `feature/tool-gh-auth-bot-guard`, PR branch is `directive/tool-gh-auth-bot-guard`. If that's the directive-stage convention, fine — but the header field should name the eventual implementation branch consistently with other directives.
- **"Issue: TBD"** — file it before the implementation PR; the changelog entry can't cite a TBD.

## Recommendations

1. Rewrite Goal/Why as a **new tool** motivated by (not extracted from) internal experience; rename to avoid colliding with the real `gh-bot-guard.sh` (suggest `gh-auth-status-shim` or similar). (B1)
2. Specify the interception mechanism precisely, and make the visits-01 manual test answer the real question: *does CC Desktop's internal `gh auth status` invocation actually resolve through the shim, and does the toast stop firing during induced transient failures?* That — not "no behavior change" — is the validating experiment. (B2)
3. Replace `timeout 10s` with a portable timeout strategy; state a bash-3.2 floor or add a version guard. (B3)
4. Add a CI subsection to the directive: bats-core install step, macOS runner decision, and whether bash tests join the existing `test.yml` or get their own workflow. (Attention #1)
5. Move shellcheck to CI-only; specify install.sh's overwrite/backup/idempotency behavior in one short paragraph. (Attention #4)
6. Add CC#67055 to `TRACKED_ISSUES.md` and a README sunset section. (Attention #7)

## Bottom Line

The problem is real, the framing is honest, and the scope fences are good — but the directive's foundation is a misattribution. The script at `~/.claude/hooks/gh-bot-guard.sh` is a GH_TOKEN write-prefix guard, not an auth-status classifier; the tool this directive proposes has never run anywhere, and its claimed activation mechanism (a CC hook intercepting CC Desktop's internal credential check) cannot work as described. None of this kills the idea — a `gh auth status` shim for CC#67055 is worth shipping — but the directive must describe the tool it's actually going to build, prove the interception path works on the operator's own setup, and fix the stock-macOS `timeout` gap before implementation starts. All three blockers are rewrite-level fixes to the directive, not design dead-ends; round 2 should be quick if they're addressed head-on.

— Fable 5 Review Agent
