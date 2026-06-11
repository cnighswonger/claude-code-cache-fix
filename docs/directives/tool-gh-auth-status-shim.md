# Directive: Contribute `gh-auth-bot-guard` hook as a cache-fix tool

**Issue:** TBD (will be filed alongside this directive, referencing CC#67055)
**Upstream:** [anthropics/claude-code#67055](https://github.com/anthropics/claude-code/issues/67055) — *Desktop: false "GitHub CLI authentication expired" toast — any `gh auth status` failure (incl. its 5s timeout) is classified as expired credentials, frequent during multi-agent workloads* (state: open; multi-platform repro confirmed)
**Priority:** P2
**Branch:** `feature/tool-gh-auth-bot-guard`
**Stage:** directive
**Milestone:** v4.2.0

## Goal

Ship a polished, documented version of the `gh-auth-bot-guard.sh` hook script we have been using internally (`~/.claude/hooks/gh-bot-guard.sh`) as a cache-fix-proxy contributed tool, so users hitting CC#67055 can install it directly and gain immediate relief while the upstream classifier is fixed. The script lives at `tools/gh-auth-bot-guard/` with an `install.sh` runner that wires it into the user's CC hooks directory, and a README that documents the problem class and the install steps.

This is not a proxy change. It is a **contributed-tool** addition that solves an adjacent operational problem CC users are reporting today. Shipping it under cache-fix-proxy's umbrella surfaces the script to users already trusting our tooling without standing up a separate repo.

## Why

Per CC#67055, CC Desktop classifies any failure of `gh auth status` — including its own internal 5-second timeout — as expired credentials. The toast fires repeatedly during multi-agent workloads where `gh` is called by hooks, by Workflow agents, or by bot-token-using scripts. josephjguerra and dcarter00 confirmed cross-platform repro (macOS + Windows). zxvchaos consolidated the report with four distinct feeder paths into the false-positive.

We hit this same failure mode internally when we started routing bot-token-using GitHub writes through `gh`. The fix we landed (`~/.claude/hooks/gh-bot-guard.sh`) is a small bash hook that:

1. Catches `gh auth status` exit codes and timeouts.
2. Distinguishes "real expired token" from "transient failure / timeout / network blip" via response-payload inspection.
3. When the failure is transient, suppresses the bubble-up to CC's classifier so the false toast doesn't fire.
4. When the failure is real, lets the bubble-up proceed normally so the user does get notified about a genuinely-expired token.

The script is small (~150 LOC bash), has no external dependencies beyond `gh` + `jq`, and is the kind of thing CC users hitting CC#67055 can install in five minutes for immediate relief. Until Anthropic fixes the classifier itself, this is the cheapest, fastest workaround.

The framing is **complementary**, not promotional. We do not claim to fix CC's classifier; that is Anthropic's to fix. We claim to provide a working hook that suppresses the false toast while the canonical fix is in flight. The README explicitly links CC#67055 and frames the tool as "use this while waiting for the upstream fix."

## Non-Functional Requirements

- **Size/complexity budget:** ~150 LOC bash, plus `install.sh` (~50 LOC) and `README.md` (~200 LOC). Trivial scope.
- **Threat model:** the hook runs `gh auth status` and inspects its output. Read-only with respect to the user's gh-auth state. No writes, no token logging, no credential surface.
- **Activation model:** opt-in install. The user runs `tools/gh-auth-bot-guard/install.sh` which copies the script to `~/.claude/hooks/` and prints the env-var setup the user should add to their shell. Nothing is wired automatically without the user running the installer.
- **Failure mode:** if the hook misclassifies a real auth-failure as transient, the user will not see the toast — but their next genuine `gh` call will fail at the API layer and surface the auth error directly. Worst case is a slightly-delayed surfacing of a real failure, not a silent loss.

## Detection logic (from current internal script)

The hook intercepts the `gh auth status` invocation that CC's classifier consumes. For each call:

1. Run `gh auth status --hostname github.com` with a `timeout 10s` wrapper (longer than CC's internal 5s, so we can distinguish timeout from real expiry).
2. Capture exit code + stderr + stdout.
3. Classify the result:
   - Exit 0 → authenticated, return 0.
   - Exit non-zero + stdout contains `"You are not logged in"` → genuinely expired, return non-zero (let CC's toast fire).
   - Exit non-zero + stderr contains `"timeout"` or `"connection refused"` or `"could not resolve host"` → transient network failure, return 0 (suppress the false toast).
   - Anything else → conservative: let CC see the failure (return original exit code).

The classification table is in `lib/classify-auth-failure.sh` and is documented so contributors can extend it as new failure modes are reported.

## Scope (v4.2.0)

In scope:
- New directory `tools/gh-auth-bot-guard/` containing:
  - `gh-auth-bot-guard.sh` — the main hook script.
  - `lib/classify-auth-failure.sh` — the classification table as a sourceable helper.
  - `install.sh` — copy to `~/.claude/hooks/`, print env-var setup.
  - `uninstall.sh` — remove from `~/.claude/hooks/`, print cleanup instructions.
  - `README.md` — problem statement + CC#67055 link + install steps + classification table + troubleshooting.
  - `tests/` — bats test suite covering each classification case with mock `gh` binary.

Out of scope (deferred):
- A Windows PowerShell port. Bash via WSL / Git-Bash covers the Windows reports in CC#67055 today; native PowerShell port is a follow-up if user demand surfaces.
- Integration with CC's hook configuration files (`~/.claude/settings.json` hook entries). The install script copies to `~/.claude/hooks/`; user wires it via their existing hook config per CC documentation.
- A bug-bug-bug feedback loop where the hook reports its own classifications back to us for telemetry. Local-only; no phone-home.

## Implementation choice

Bash is the right tool. The hook runs in CC's process-launch path; adding a Node or Python dependency adds startup latency to every `gh auth status` call. Bash + `jq` is universally available, fast, and matches the existing tooling style in `cache-fix-proxy/tools/`.

`shellcheck` clean is a requirement; the `install.sh` script runs `shellcheck` on the hook as a pre-install sanity check.

## Test plan

- Bats unit: classification table — each documented failure mode produces the expected suppress/forward decision.
- Bats integration: full hook flow — mock `gh auth status` returning each failure mode, assert hook exit code matches the expected suppress/forward.
- Smoke: install + uninstall — installer copies files to expected location with correct perms; uninstaller removes them cleanly.
- Manual: run on visits-01 with the bot-token setup we already use; assert no behavior change from current state (we're the canonical user).

## Files modified / created

Created:
- `tools/gh-auth-bot-guard/gh-auth-bot-guard.sh`
- `tools/gh-auth-bot-guard/lib/classify-auth-failure.sh`
- `tools/gh-auth-bot-guard/install.sh`
- `tools/gh-auth-bot-guard/uninstall.sh`
- `tools/gh-auth-bot-guard/README.md`
- `tools/gh-auth-bot-guard/tests/classify.bats`
- `tools/gh-auth-bot-guard/tests/integration.bats`
- `tools/gh-auth-bot-guard/tests/mocks/gh-mock.sh`

Modified:
- `CHANGELOG.md` — v4.2.0 entry citing CC#67055.
- `README.md` — `tools/` section addition pointing to the gh-auth-bot-guard subdir.

## Reviewer checklist (cache-fix side)

- [ ] Hook script is `shellcheck` clean.
- [ ] Classification table is documented; new failure modes can be added without touching the main script.
- [ ] Install / uninstall scripts are idempotent.
- [ ] No credential material is logged anywhere.
- [ ] README links CC#67055 explicitly and frames the tool as a workaround pending the upstream fix.
- [ ] Bats test suite passes on linux + macOS CI.
- [ ] CHANGELOG cites CC#67055 explicitly.

## Out of scope (explicit)

- Modifying CC's classifier behavior. Not our code; not our fix.
- Reporting telemetry to a remote endpoint. Local-only by design.
- Suppressing toasts for non-`gh auth status` failures. The hook is narrow; one classifier class, one fix.
- Bundling `gh` itself. Users install gh per the upstream gh-cli instructions; this tool only intercepts its auth-status call.

— AI Team Lead
