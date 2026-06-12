# `gh-auth-status-shim`

A PATH-resolved `gh` wrapper that suppresses Claude Code Desktop's false **"GitHub CLI authentication expired"** toast. Addresses [anthropics/claude-code#67055](https://github.com/anthropics/claude-code/issues/67055).

**Status:** workaround pending Anthropic's classifier fix. **Not** a replacement for `gh`. Uninstall when CC#67055 closes.

---

## The bug

CC Desktop's PR poller runs `gh auth status --hostname github.com` with a **5-second** `timeoutMs`. **Any** non-zero return — including the 5s spawn timeout itself — maps to the `"auth"` toast category. CC#67055 documents at least four feeder paths into the same false-positive surface:

1. **Slow `gh` exceeding CC's 5s** (Keychain slow-read on macOS, event-loop stalls under multi-agent CPU contention).
2. **Anonymous-401 fallback** when `gh` silently treats credentials as missing under cli/cli#13317.
3. **Network transients** (timeout, connection refused, DNS hiccup).
4. **Deleted-`cwd` spawn failure** during PR-creation race.

Items 1–3 are workaround-able with PATH interception. Item 4 spawns before the shim can run; documented as not covered.

## How the shim works

```
User shell PATH:  ~/.local/bin/gh   →   /usr/bin/gh
                     (shim)              (real)
```

When something runs `gh`, your shell finds the shim first.

For `gh auth status` invocations:

1. The shim runs the real `gh auth status` with an **internal 4-second timeout** — fits inside CC Desktop's 5s spawn-abandonment window.
2. Classifies the outcome:

   | Real `gh` outcome | Shim verdict | Why |
   |---|---|---|
   | Exit 0, stdout `"Logged in to github.com"` | Exit 0 | Genuine success — pass through. |
   | Exit non-zero, stdout/stderr matches `not logged in` / `HTTP 401` / `no credentials configured` | **Propagate** (original exit code) | Genuine expiry — let CC's toast fire. |
   | Timed out at 4s | Exit 0 | Transient — suppress the toast. CC abandoned the spawn at 5s anyway. |
   | Exit non-zero, stderr matches `timeout` / `connection refused` / `could not resolve host` / `temporary failure` / `network unreachable` / `service unavailable` / `operation timed out` | Exit 0 | Transient network — suppress. |
   | Exit non-zero, ambiguous output | **Propagate** | Conservative default — let CC see. Worst case: slightly delayed surfacing of a real failure; not a silent loss. |

3. Stdout and stderr are preserved through their **original streams** (no `2>&1` re-merge — `gh` historically moves auth-status output between streams; merging would compound the drift).

For every other subcommand (`gh pr list`, `gh issue create`, `gh release`, …) the shim `exec`s the real binary unchanged. No process overhead, no output rewriting.

## Install

```bash
tools/gh-auth-status-shim/install.sh
```

Default target: `$HOME/.local/bin/gh`. Override with `--target /path/to/dir`.

The installer:

- Verifies the target directory is on your PATH AHEAD of the real `gh`.
- If PATH ordering isn't correct, prints the export line you need to add to your shell rc.
- Backs up an existing shim to `<target>.bak.<timestamp>` before overwriting (different content only — same content is a no-op).
- **Refuses** to overwrite a non-shim file at the target.
- Does **not** modify your shell rc files.

After install:

```bash
which gh   # should show ~/.local/bin/gh
gh --version  # passes through to real gh; should show real gh version
```

To activate inside CC Desktop on Linux, you typically need no further action — CC Desktop inherits the user's PATH at launch. On macOS, see the limitations below.

## Uninstall

```bash
tools/gh-auth-status-shim/uninstall.sh
```

Default target: `$HOME/.local/bin/gh`. Override with `--target /path/to/dir`.

The uninstaller:

- Removes the shim at the target.
- Removes any `<target>.bak.*` shim backups created by prior installs (verifies each is a shim before removing).
- **No restore-from-backup step.** Every `.bak.*` file is by construction an older shim (install refuses to overwrite non-shim files), so restoring would silently reinstate an outdated shim.
- Idempotent — running twice is benign.
- Reports the export line you can remove from your shell rc.

## Limitations

These are intentional design choices, not bugs.

### Behavioral-change disclosure

The shim **rewrites `gh auth status` exit-code semantics** for every caller in the shim's PATH scope. That includes:

- CC Desktop's PR poller (the intended audience).
- Your shell prompt's auth status check, if you have one.
- CI scripts that gate on `gh auth status` exit code.
- Other tools that consume `gh auth status` for security-relevant decisions.

In all those cases, a transient `gh` failure (timeout, network hiccup) returns exit 0 from the shim. The worst case is a slightly-delayed surfacing of a real auth failure — not a silent loss — because every other `gh` subcommand (the ones that actually need auth, like `gh pr list`) still gets the real outcome from the real `gh`.

If you don't want the shim affecting non-CC callers, install it at a target dir that's only on CC Desktop's PATH and not your shell PATH.

### macOS

GUI applications launched from Finder/Dock on macOS inherit **`launchd`**'s PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), NOT your shell PATH. A shim installed in `~/.local/bin` is invisible to CC Desktop on macOS unless:

- You install the shim at a path inside `launchd`'s default PATH (requires `sudo` and arguably worse than the false toast), OR
- You modify `launchd`'s PATH globally via `launchctl config user path …` (system-wide, affects every GUI app).

The `install.sh` PATH-ordering check inspects your **shell** PATH, which can give macOS users false confidence. The shim still installs and the `which gh` check passes; it just doesn't affect CC Desktop's `gh` resolution.

**macOS coverage is currently unverified.** If you're on macOS and willing to validate, please post results to [CC#67055](https://github.com/anthropics/claude-code/issues/67055).

### Native Windows CC Desktop

Native Windows CC Desktop spawns `gh.exe` through Windows PATH resolution. A bash shim on a WSL or Git-Bash PATH is invisible to that spawn.

- Windows users running CC inside WSL (CC Desktop also inside WSL): covered, but an unusual configuration.
- Windows users running native CC Desktop: **NOT covered**. Wait for Anthropic's classifier fix or for a future PowerShell port (not in this repo's scope).

### `gh auth status --json` not used

`gh` supports `--json hosts` for structured output. The shim uses text matching because:

1. The `--json hosts` output is intended for hostname queries and its `state` field semantics for the specific failure cases the shim has to classify (timeout, transient network, Keychain anonymous-fallback HTTP 401) are not documented and may not be present on the stderr-stream-only failure paths.
2. `gh`'s text output has been stable across recent versions on the specific strings the classifier anchors on (`"Logged in to github.com"`, `"not logged in"`, `"HTTP 401"`).
3. The conservative-default posture (ambiguous → propagate) means classifier drift produces "slightly delayed surfacing of a real failure," not a security regression.

If a future Codex review or sim run surfaces a structural-output failure path the regex misses, the classifier can be rewritten to use `--json`.

### Classification table is validated against a specific `gh` range

The classifier strings are anchored on `gh`'s output as of the version range below. `gh`'s output has historically reworded across releases — when that happens, the table needs refresh.

**Validated against:** `gh` v2.40.0 through v2.50.0 (sampling). If you observe a `gh` version producing strings the classifier doesn't match, please open an issue or PR with the captured text.

## Debug logging

Set `GH_AUTH_STATUS_SHIM_DEBUG_LOG=/path/to/file` to capture per-invocation logs:

```
[gh-auth-status-shim 2026-06-12T19:58:25Z] auth status: invoking real gh at /usr/bin/gh (timeout 4s)
[gh-auth-status-shim 2026-06-12T19:58:26Z] auth status: real gh exit=0 stdout_len=58 stderr_len=0
[gh-auth-status-shim 2026-06-12T19:58:26Z] auth status: classified exit=0 (real_exit=0)
```

The log is append-only, never rotated by the shim. Useful for diagnosing whether CC Desktop is actually resolving `gh` through the shim and what classifier verdict each call received.

## Internal timeout tuning

The shim's internal timeout is 4s by default. Override with `GH_AUTH_STATUS_SHIM_TIMEOUT=N` (in seconds, integer).

- **Don't set it above 4s** unless you have a reason. CC Desktop's spawn-abandonment window is 5s; a shim that doesn't return by then is irrelevant.
- **Don't set it below 2s** unless you've measured your local `gh auth status` latency. Tightening below normal latency creates false-transient classifications that suppress real expiry signals if the real `gh` itself is in a slow path.

## Sunset plan

When CC#67055 closes with an Anthropic fix:

1. CC Desktop version `X` ships the classifier fix.
2. This README updates to "no longer needed if you're on CC version ≥ X."
3. The tool is **not** deleted from this repo (preserves the install path for users on older CC versions).
4. A future cache-fix release deprecates the tool with a removal date 6 months out.

Track the issue status: [anthropics/claude-code#67055](https://github.com/anthropics/claude-code/issues/67055). When it closes, run `uninstall.sh` and remove the `export PATH=…` line you added.

## Coverage scope

| Platform | CC Desktop launch path | Shim covered? |
|---|---|---|
| Linux desktop, CC Desktop launched from shell | shell PATH inherited | **Yes** |
| Linux desktop, CC Desktop launched from `.desktop` file | Desktop Entry's PATH (often shell PATH) | **Yes if shell PATH inherits** — varies by desktop environment |
| macOS, CC Desktop launched from Finder/Dock | `launchd` PATH | **Not by default** — see macOS limitations |
| macOS, CC Desktop launched from terminal | shell PATH inherited | **Yes** |
| Windows native, CC Desktop launched from Start Menu | Windows PATH (separate from WSL) | **No** — bash shim invisible |
| Windows inside WSL, CC Desktop also inside WSL | WSL shell PATH | Yes (unusual config) |

## Per-feeder-path coverage

| CC#67055 feeder path | Shim coverage |
|---|---|
| Slow `gh` exceeding CC's 5s (Keychain slow-read, event-loop stalls) | **Covered** — shim's 4s internal timeout returns exit 0 before CC's 5s abandonment. |
| Anonymous-401 from gh's silent Keychain fallback (cli/cli#13317) | **Covered** — fast-failing exit; classifier matches HTTP 401 in stderr and returns 0. |
| Network transient (timeout, connection refused, resolve failure) | **Covered** — classifier matches stderr signals and returns 0. |
| Deleted-`cwd` spawn failure (CC#67055 issue update feeder #4) | **NOT covered** — spawn fails before any `gh` (real or shim) executes. |
| Genuinely expired token | **Correctly propagates** — classifier matches `"not logged in"` and returns the real exit code, letting CC's toast fire as intended. |

## Troubleshooting

**Q: `which gh` shows the shim but CC Desktop still produces the toast.**
A: On macOS, see the launchd PATH note above. On Linux, check that CC Desktop was launched from a context that inherits your shell PATH; relaunch from `~/.config/autostart/` or from a shell that has the export line.

**Q: My non-CC `gh auth status` checks broke after install.**
A: Expected — see the behavioral-change disclosure. Install at a target dir that's only on CC Desktop's PATH if you need to preserve your shell's `gh auth status` semantics.

**Q: The shim isn't honoring my `--hostname` flag.**
A: Report this as a bug. The shim should pass all flags through to the real `gh`.

**Q: How do I know what classification verdict the shim made for a given call?**
A: Set `GH_AUTH_STATUS_SHIM_DEBUG_LOG=/path/to/log` and inspect the log after the call.

**Q: I'm on `gh` version X and the classifier isn't matching the output I'm seeing.**
A: `gh`'s text output has historically reworded across releases. Capture the failing output and open an issue. As a workaround, set `GH_AUTH_STATUS_SHIM_DEBUG_LOG=` to confirm the classifier sees the unrecognized text, and the conservative default will propagate the real exit code (which means worst case is one false toast — your behavior before the shim).

## Contributing

See `lib/classify-auth-status.sh` for the classification table. Adding a new failure-mode classification:

1. Add a regex to `_GHASS_*_RE` at the top of the helper.
2. Add a case to `classify_auth_status_output_text`.
3. Add a case to `classify_auth_status_exit_code` (suppress vs propagate).
4. Add a bats unit test covering the new classification.

CI runs `bats tools/gh-auth-status-shim/tests/` on Linux + macOS, with the macOS run explicitly invoking the bats suite under `/bin/bash` (3.2) to verify the bash 3.2 floor. `shellcheck` runs in CI default mode (not `-s sh`, which enforces POSIX sh and would reject legal bash 3.2 constructs).

## License

Same as the parent repo (MIT).
