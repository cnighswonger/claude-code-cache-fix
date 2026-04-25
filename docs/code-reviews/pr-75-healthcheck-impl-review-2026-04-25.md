# Review: PR #75 healthcheck companion implementation

Date: 2026-04-25
Reviewed: `templates/cache-fix-proxy-healthcheck.service.template`, `templates/cache-fix-proxy-healthcheck.timer.template`, `bin/install-service.mjs`, `test/install-service.test.mjs`, `README.md`
Label applied: `changes-requested`

## What Is Correct

- The systemd design is directionally right for the incident being fixed. The timer is not active just because the files are written; it only activates after the explicit `systemctl --user enable --now cache-fix-proxy-healthcheck.timer` step documented in [README.md](/home/manager/git_repos/claude-code-cache-fix/README.md:61) and printed by [bin/install-service.mjs](/home/manager/git_repos/claude-code-cache-fix/bin/install-service.mjs:299).
- The uninstall ordering is correct. `uninstall()` stops and disables the healthcheck timer before stopping the proxy, which avoids the intended race where the companion would immediately restart the proxy during teardown ([bin/install-service.mjs](/home/manager/git_repos/claude-code-cache-fix/bin/install-service.mjs:353)).
- The timer unit itself is appropriately inert until enabled, and the cadence is reasonable for the recovery goal ([templates/cache-fix-proxy-healthcheck.timer.template](/home/manager/git_repos/claude-code-cache-fix/templates/cache-fix-proxy-healthcheck.timer.template:1)).
- The added helper-level tests pass locally (`node --test test/install-service.test.mjs`) and they do cover the basic round-trip install/remove behavior of the new companion files.

## Blockers

- Codex review: The healthcheck service shells out through `/bin/sh -c` and interpolates `{{PORT}}` directly into a single-quoted command string, but `defaults.port` comes straight from `CACHE_FIX_PROXY_PORT` with no validation or escaping ([templates/cache-fix-proxy-healthcheck.service.template](/home/manager/git_repos/claude-code-cache-fix/templates/cache-fix-proxy-healthcheck.service.template:7), [bin/install-service.mjs](/home/manager/git_repos/claude-code-cache-fix/bin/install-service.mjs:21), [bin/install-service.mjs](/home/manager/git_repos/claude-code-cache-fix/bin/install-service.mjs:102)). A value containing `'`, shell metacharacters, or whitespace can break quoting and change the executed command. Realistic operators will use numeric ports, but this installer is currently trusting unvalidated environment input when generating a shell command. That needs a hard numeric validation step before rendering, or the shell wrapper needs to be removed.

- Codex review: `installSystemdHealthcheck()` claims atomic "if either exists" semantics, but the implementation only checks `servicePath` and ignores an already-present timer file ([bin/install-service.mjs](/home/manager/git_repos/claude-code-cache-fix/bin/install-service.mjs:176)). In the `service missing, timer exists` case, a non-`--force` install will silently overwrite the timer and create the service instead of refusing. In the inverse case, it refuses based only on the service file even if the timer is the stale artifact that actually needs replacement. This is exactly the force-semantics edge case called out in the review request and it is not implemented correctly.

## Nits

- `installSystemd()` writes the main unit before attempting the healthcheck pair, so a later `readFile()`/`writeFile()` failure in `installSystemdHealthcheck()` leaves the user half-installed with only the proxy service written ([bin/install-service.mjs](/home/manager/git_repos/claude-code-cache-fix/bin/install-service.mjs:153)). The current CLI surfaces the filesystem error, but it does not roll back the already-written main unit or clearly describe the partial state.

## Nice-to-haves

- The new tests are concentrated at the helper layer. They do not currently exercise the public `uninstall()` orchestration path, so the stop/disable ordering and the user-facing uninstall behavior are unverified in tests ([test/install-service.test.mjs](/home/manager/git_repos/claude-code-cache-fix/test/install-service.test.mjs:367)).
- There is no negative test for malformed or hostile `CACHE_FIX_PROXY_PORT` input, and no test for the asymmetric `service missing, timer exists` / `timer missing, service exists` cases in `installSystemdHealthcheck()`.
- README coverage is adequate, but once port validation exists it would be worth stating plainly that the installer expects a numeric `CACHE_FIX_PROXY_PORT` value.

## Recommendation

Revise before approval. The recovery mechanism itself is the right fix for the 2026-04-25 clean-stop incident, the timer activation/uninstall sequencing is sound, and the documentation matches the intended operator flow. But the shell interpolation of an unvalidated env-derived port and the incomplete overwrite guard for the companion pair are both correctness issues in the shipped implementation. After those are fixed, I would re-review the remaining partial-install/test-gap items as follow-up quality improvements rather than release blockers.

Codex Review Agent

## Follow-up verified

- Reviewed follow-up commit `9dcc54653b0f0246db969bbb4a67b4a79b64a391`.
- Confirmed blocker 1 is fixed: `validatePort()` now enforces plain decimal ports in `1..65535` before any template rendering, and `reportFsError()` surfaces invalid input cleanly.
- Confirmed blocker 2 is fixed: `installSystemdHealthcheck()` now checks both companion paths and refuses non-`--force` overwrite when either side already exists.
- Confirmed the prior nit is addressed: `installSystemd()` now rolls back the main unit if companion install fails after the main unit is written.
- Re-ran `node --test test/install-service.test.mjs`: `32` tests passed, `0` failed.

Codex Review Agent
