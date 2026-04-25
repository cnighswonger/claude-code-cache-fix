# Review: install-service / uninstall-service subcommands

Date: 2026-04-25
Reviewed: PR #73 implementation (`bin/claude-via-proxy.mjs`, `bin/install-service.mjs`, templates, tests, README)
Label applied: changes-requested

## What Is Correct

- Subcommand dispatch preserves wrapper-mode parsing for the main back-compat case. I verified `CACHE_FIX_CLAUDE_CMD='node -p JSON.stringify({argv:process.argv.slice(1),base:process.env.ANTHROPIC_BASE_URL})' node bin/claude-via-proxy.mjs --proxy-port 9802 some-claude-arg` and got `{"argv":["some-claude-arg"],"base":"http://127.0.0.1:9802"}`.
- `cache-fix-proxy server` does run only the proxy in the foreground. With `CACHE_FIX_PROXY_PORT=9988`, `timeout 3s node bin/claude-via-proxy.mjs server` printed `proxy listening on 127.0.0.1:9988` and did not go through wrapper mode.
- `SERVER_PATH = resolve(__dirname, "..", "proxy", "server.mjs")` resolves correctly in both layouts I checked:
  - git checkout: `/home/manager/git_repos/claude-code-cache-fix/proxy/server.mjs` exists
  - packed npm tarball: `/tmp/.../package/proxy/server.mjs` exists after `npm pack`
- Template placeholder coverage looks correct after the `replaceAll` fix. The only repeated placeholder is `{{LOG_DIR}}` in the launchd plist, and all placeholders in both templates render with no leftovers.
- Platform detection for unsupported OS values is intentionally graceful at the helper level (`getPaths("freebsd") -> { kind: "unsupported" }`), which matches the requested behavior.
- Scope is appropriate. I did not find the PR sneaking in the wrapper health-check from issue #48; it stays focused on service install/uninstall and README guidance.

## Blockers

- `--force` is parsed by the CLI but dropped before the install helpers are called, so the advertised overwrite path does not work in real usage. In [bin/claude-via-proxy.mjs](/home/manager/git_repos/claude-code-cache-fix/bin/claude-via-proxy.mjs:31) the subcommand passes `install({ force })`, but in [bin/install-service.mjs](/home/manager/git_repos/claude-code-cache-fix/bin/install-service.mjs:190) `install()` ignores that parameter and calls `installSystemd({ paths })` / `installLaunchd({ paths })` without forwarding `force`. I verified the actual CLI behavior with a temporary `HOME`: first `install-service` succeeds, then `install-service --force` still returns `already-installed`. This breaks one of the core requirements for the PR.

## What Needs Attention

- Test coverage misses the exact blocker above because it only exercises `installSystemd(..., force: true)` directly, not the shipped CLI/orchestration path through `dispatch()` and `install()`. See [test/install-service.test.mjs](/home/manager/git_repos/claude-code-cache-fix/test/install-service.test.mjs:164). A CLI-level or orchestration-level test would have caught this regression.
- The new tests do not cover the back-compat wrapper dispatch path, even though this PR changes the top-level command-routing logic in [bin/claude-via-proxy.mjs](/home/manager/git_repos/claude-code-cache-fix/bin/claude-via-proxy.mjs:17). I manually verified `--proxy-port 9802 some-claude-arg`, but this should be automated because dispatch ordering is the riskiest compatibility point in the bin refactor.
- Failure-mode handling for missing templates and filesystem permission errors is currently just raw exceptions bubbling out of `readFile`, `mkdir`, and `writeFile` in [bin/install-service.mjs](/home/manager/git_repos/claude-code-cache-fix/bin/install-service.mjs:122) and [bin/install-service.mjs](/home/manager/git_repos/claude-code-cache-fix/bin/install-service.mjs:152). That is survivable, but not very operator-friendly for a user-facing install command. I would treat this as non-blocking for this PR if the core `--force` bug is fixed first.

## Recommendations

- Forward `force` from `install()` into `installSystemd()` / `installLaunchd()`.
- Add one CLI/orchestration test that proves `cache-fix-proxy install-service --force` overwrites an existing config via the public entrypoint.
- Add one dispatch back-compat test for `cache-fix-proxy --proxy-port 9802 some-claude-arg`.
- Consider catching `ENOENT`/`EACCES` around template reads and writes so the subcommand prints a concise prefixed error instead of a raw stack trace.

## Bottom Line

REQUEST CHANGES. The overall shape is sound: dispatch behavior is mostly correct, the service templates are safe, path resolution works from both a checkout and a packed install, and the PR stays within scope. But the published `install-service --force` behavior is broken at the real CLI layer, which is a direct miss against the stated requirements and user-facing README guidance. Fix that and add a top-level test for it before merging.
