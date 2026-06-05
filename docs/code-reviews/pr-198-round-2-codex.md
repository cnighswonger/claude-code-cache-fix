# Review: PR #198 hot-reload opt-in directive

Date: 2026-06-05
Reviewed: PR #198 directive ([docs/directives/proxy-hot-reload-opt-in.md](docs/directives/proxy-hot-reload-opt-in.md#L1)) at `8eb2a42`
Round: 2
Label applied: `changes-requested`

## What Is Correct

- Retargeting this work to `v4.0.0` resolves the round-1 semver blocker. The directive now matches the repo's own "changed default behavior => major" rule in `docs/release-workflow.md` (`docs/directives/proxy-hot-reload-opt-in.md:3`, `docs/release-workflow.md:11`).
- The refined impact-scope section is now materially more accurate. It distinguishes "restart clears stale cache" from "the install step itself can still fire the watcher before that restart," which is the right split for this runtime topology (`docs/directives/proxy-hot-reload-opt-in.md:13`, `README.md:17`, `proxy/config.mjs:23`, `proxy/config.mjs:24`, `proxy/server.mjs:293`). I also reproduced this locally in a throwaway global-prefix install: reinstalling a new package tarball over a running install emitted `fs.watch` events on both `proxy/extensions.json` and multiple `.mjs` files under `proxy/extensions/`, so the install-window race is real in practice, not just hypothetical.
- Keeping the runtime gate at `startProxy()` and preserving strict `process.env.CACHE_FIX_HOT_RELOAD === "on"` remains the right minimal design. That keeps the watcher implementation unchanged while moving the default at the single real startup seam (`docs/directives/proxy-hot-reload-opt-in.md:53`, `proxy/server.mjs:288`, `bin/claude-via-proxy.mjs:17`).
- Pulling the banner version pin out of runtime logs and splitting the i18n READMEs into follow-up issue `#199` are both good corrections to the round-1 nits (`docs/directives/proxy-hot-reload-opt-in.md:62`, `docs/directives/proxy-hot-reload-opt-in.md:90`).

## Blockers

- The planned upgrade and recovery commands still do not match the repo's documented service model. The directive repeatedly frames Linux recovery as `systemctl restart cache-fix-proxy(.service)` and the README upgrade flow as `npm install -g ... && sudo systemctl restart cache-fix-proxy`, while the recommended install path is explicitly a **systemd user unit** under `~/.config/systemd/user/` with `systemctl --user ...` commands, and the macOS path uses `launchctl bootstrap` / `enable` / `kickstart`, not `launchctl unload/load` (`docs/directives/proxy-hot-reload-opt-in.md:9`, `docs/directives/proxy-hot-reload-opt-in.md:17`, `docs/directives/proxy-hot-reload-opt-in.md:82`, `docs/directives/proxy-hot-reload-opt-in.md:88`, `docs/directives/proxy-hot-reload-opt-in.md:140`, `README.md:60`, `README.md:66`, `README.md:77`, `bin/install-service.mjs:358`, `bin/install-service.mjs:381`). As written, the implementation PR would ship inaccurate operator instructions into README/CHANGELOG. Rewrite those flows to the actual supported supervisor commands, or generalize them so they do not prescribe the wrong ones.
- The new `install-service --hot-reload` path still does not scope the actual CLI entrypoint that has to parse and advertise that flag. The shipped `cache-fix-proxy` binary points at `bin/claude-via-proxy.mjs`, and that file currently only peels off `--force` for `install-service` and owns the top-level help text (`package.json:11`, `bin/claude-via-proxy.mjs:31`, `bin/claude-via-proxy.mjs:40`). The directive scopes `bin/install-service.mjs`, the templates, and rendering tests, but not the entrypoint file or any dispatch/help verification (`docs/directives/proxy-hot-reload-opt-in.md:73`, `docs/directives/proxy-hot-reload-opt-in.md:76`, `docs/directives/proxy-hot-reload-opt-in.md:108`, `docs/directives/proxy-hot-reload-opt-in.md:114`, `docs/directives/proxy-hot-reload-opt-in.md:130`). That means the round-2 scope still does not actually guarantee `cache-fix-proxy install-service --hot-reload` will work end-to-end, and the `<= 8 files` budget is still understated once the real entrypoint and its tests are included.

## What Needs Attention

- The README scope should include the canonical proxy env inventory, not just the new "Upgrading from v3.x" section. `CACHE_FIX_HOT_RELOAD` is a new runtime envvar, so manual `cache-fix-proxy server` users will reasonably look for it in the proxy configuration table (`README.md:137`) and the CLI environment summary (`bin/claude-via-proxy.mjs:54`), not only in upgrade notes.

## Bloat / Non-Functional

- The dedicated `--hot-reload` flag is not obviously wrong, but it is no longer the lowest-cost path. `install-service` already snapshots install-time configuration from env for port/upstream/debug (`bin/install-service.mjs:21`), so a one-off boolean flag adds extra parser/help/test surface in `bin/claude-via-proxy.mjs` on top of the renderer/template work. If the project wants the smallest operator-complete solution, capturing `CACHE_FIX_HOT_RELOAD` at install time like the other settings would achieve that with less CLI surface.

## Recommendations

- Fix the Linux/macOS upgrade prose before implementation starts. For the recommended service path, the Linux command set should be written in `systemctl --user` terms, and the macOS wording should match the repo's existing `launchctl bootstrap` / `kickstart` flow instead of switching to `unload/load`.
- Decide explicitly whether the project wants a new `--hot-reload` CLI flag or wants to stay with the installer's existing env-at-install-time model. Either can work; the current directive mixes the two without fully scoping the first one.
- If the flag stays, add `bin/claude-via-proxy.mjs` to scope, bump the file/LOC budget accordingly, and require at least one CLI-level test that proves `cache-fix-proxy install-service --hot-reload` is parsed and surfaced in help text, not just rendered correctly once it reaches `install-service.mjs`.
- Keep the round-2 impact-scope rewrite. That part is now on solid ground.

## Bottom Line

Round 2 fixes the semver blocker, corrects the core install-window-race analysis, and brings the service-install surface into scope. I am still requesting changes because the directive now contains supervisor commands that do not match the repo's own recommended deployment flow, and the new `--hot-reload` path still stops short of the real CLI entrypoint and its verification surface.

— Codex review
