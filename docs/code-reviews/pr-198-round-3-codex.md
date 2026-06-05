# Review: PR #198 hot-reload opt-in directive

Date: 2026-06-05
Reviewed: PR #198 directive ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L1)) at `934795e`
Round: 3
Label applied: `changes-requested`

## What Is Correct

- Dropping the dedicated `--hot-reload` flag is the right simplification. Round 3 now matches the installer's existing env-capture pattern instead of inventing new parser surface, and `bin/claude-via-proxy.mjs` really does dispatch `install-service` before wrapper-mode flag parsing, so `CACHE_FIX_HOT_RELOAD` does not require new entrypoint parsing work ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L69), [bin/claude-via-proxy.mjs](bin/claude-via-proxy.mjs#L17)).
- Pulling the proxy env inventory and CLI env summary into scope is also the right correction from round 2. Those are the two places manual `cache-fix-proxy server` operators will actually look for the new envvar contract ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L84)).
- The anti-bloat direction is better now. Compared with round 2, the chosen shape removes the bespoke CLI flag/help/dispatch work and keeps the change centered on the existing `startProxy()` gate plus mechanical installer/template updates ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L120)).

## Blockers

- Round-2 blocker 1 is still not fully closed in the directive text itself. The round-3 disposition says all prose now uses the supported supervisor commands, but active sections still tell operators to use `systemctl restart cache-fix-proxy.service`, `systemctl restart cache-fix-proxy`, and generic `systemctl restart` wording ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L9), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L17), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L64)). On macOS, the directive now says `launchctl kickstart -k ...` and claims that matches `bin/install-service.mjs:381-383`, but the cited file currently prints `launchctl kickstart ...` without `-k` ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L93), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L171), [bin/install-service.mjs](bin/install-service.mjs#L381)). This needs one more cleanup pass so the approved directive contains one consistent, verifiable operator story instead of relying on the disposition comment to paper over the remaining mismatches.
- The new install-time env-capture path is still underspecified for applying a rewritten service definition, especially on macOS. Round 3's whole point is to bake `CACHE_FIX_HOT_RELOAD=on` into the generated unit/plist via `cache-fix-proxy install-service`, but the directive only points users at that command and never states the follow-up reload sequence for an already-installed agent ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L71), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L95)). The cited installer next steps keep `bootstrap` and `kickstart` as separate actions on macOS, which is exactly the distinction that matters once the plist contents themselves have changed ([bin/install-service.mjs](bin/install-service.mjs#L381)). Before implementation, the directive should explicitly separate "restart the existing process after npm upgrade" from "reload the rewritten unit/plist after rerunning install-service" for each supported supervisor.

## What Needs Attention

- The `bin/claude-via-proxy.mjs` scope description is internally inconsistent. The install-service subsection says "No changes to `bin/claude-via-proxy.mjs`" and "no help-text changes," but the README subsection and NFR budget both scope a one-line env-summary addition in that same file ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L82), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L87), [docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L124)). Tighten that wording to "no parser or dispatch changes" so the implementation PR does not accidentally drop the help-summary update.
- The boot-banner observability note still references `journalctl -u cache-fix-proxy`, which is the system-unit form rather than the documented user-unit install model ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L67), [README.md](README.md#L66)). Either make that wording supervisor-neutral or point at the user-unit form.

## Bloat / Non-Functional

- No remaining bloat finding on the design. The env-capture rewrite is leaner than the round-2 CLI-flag path and is the right direction to keep.

## Recommendations

- Rewrite every remaining operator-facing restart reference so the directive uses one command set consistently, and only claim a file match where the cited file actually says the same thing.
- Split the service-management guidance into two explicit flows: one for code-only upgrades (`npm install -g ...` + process restart), and one for rerendering the service definition after `CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service`.
- Reword the `bin/claude-via-proxy.mjs` bullet to preserve the real win: no parser or dispatch changes, while still keeping the one-line env-summary/help-text edit in scope.

## Bottom Line

Round 3 fixes the main architectural issue from round 2: removing the bespoke `--hot-reload` flag is the correct low-surface design, and the entrypoint sanity-check passes. I am still requesting changes because the directive is not yet operator-accurate end-to-end: supervisor commands are still inconsistent in active sections, and the new install-time env-capture path does not fully document how an existing service definition gets reloaded after it is rewritten.

— Codex review
