# Review: PR #198 hot-reload opt-in directive

Date: 2026-06-05
Reviewed: PR #198 directive ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L1)) at `951c5d0`
Round: 4
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- The remaining supervisor-command mismatches from round 3 are closed in the active directive text. Goal, impact-scope, README upgrade flow, and release-coordination sections now consistently use `systemctl --user restart cache-fix-proxy` on Linux and `launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy` on macOS, matching the repo's current install-service output rather than the old system-wide or `-k` forms ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L9), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L17), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L92), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L118), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L171), [bin/install-service.mjs](bin/install-service.mjs#L358), [bin/install-service.mjs](bin/install-service.mjs#L381)).
- The README Flow 1 / Flow 2 split closes the remaining reload-sequence gap. Code-only upgrades are now correctly scoped to a process restart, while rewritten service definitions are scoped to `daemon-reload` + restart on Linux and `bootout` + `bootstrap` + `kickstart` on macOS. That is the right precision level for this directive, and it is consistent with the repo's existing launchd lifecycle split between bootstrap and bootout ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L88), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L95), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L111), [bin/install-service.mjs](bin/install-service.mjs#L381), [bin/install-service.mjs](bin/install-service.mjs#L438)). I do not see a directive-stage reason to reopen this in favor of a speculative `launchctl bootstrap -F` shortcut.
- The `bin/claude-via-proxy.mjs` scope wording is now internally consistent where it matters: no parser or dispatch changes are being claimed, while the one-line env-summary text addition remains explicitly in scope in both the README section and the NFR budget ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L82), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L87), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L142), [bin/claude-via-proxy.mjs](bin/claude-via-proxy.mjs#L14), [bin/claude-via-proxy.mjs](bin/claude-via-proxy.mjs#L31), [bin/claude-via-proxy.mjs](bin/claude-via-proxy.mjs#L54)).
- The boot-banner observability note is now supervisor-neutral and uses the documented user-unit log form on Linux rather than the old system-unit phrasing ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L64)).

## Blockers

None.

## What Needs Attention

None.

## Bloat / Non-Functional

None.

## Recommendations

- Approve for directive stage. The remaining work belongs in the implementation PR, including the directive's already-noted live validation of the macOS Flow 2 sequence before merge ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L113)).

## Bottom Line

Round 4 closes the remaining precision findings from round 3 without reopening the already-approved architecture. The directive is now operator-accurate end-to-end, aligned with the repo's current install-service behavior, and ready for directive-stage approval. I am approving this round; AITL can apply `plan-approved` if otherwise satisfied.

— Codex review
