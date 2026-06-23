# Review: v4.2.0 release PR #241

Date: 2026-06-23
Reviewed: PR #241 (`release/4.2.0`) at `e392ff7a7cd55a0ee384dbcb5d0f927250df9328`
Round: 1
Verdict: REQUEST_CHANGES
Label applied: changes-requested

Codex review: REQUEST_CHANGES on the v4.2.0 release gate.

## Audit A: CHANGELOG accuracy

FAIL.

Confirmed covered by the v4.2.0 changelog:

- `image-retry-circuit-breaker` from #217/#220.
- `jsonl-session-mirror` from #214/#221.
- `tools/gh-auth-status-shim` from #216/#222.
- Statusline served-model divergence from #223/#224/#225.
- Workflow agent-id synthesis from #215/#226.
- Proxy-owned OAuth refresh from #234/#236/#237.
- `cc-version-normalize` from #238/#239.
- `upstream-error-log` from #235/#240.
- The `CACHE_FIX_USAGE_LOG_REQID` default flip from this release commit.

The release window also contains directive-only or small maintenance commits that do not need standalone user-facing bullets: `proxy-model-id-sanitize` directive/review artifacts (#227), shared model-family helper extraction (#230), `TRACKED_ISSUES.md` cleanup (#232), and the pipeline cache-buster follow-up (#233).

Blocking accuracy issue: the v4.2.0 `gh-auth-status-shim` changelog bullet still says, "Sunset plan: uninstall when CC#67055 closes with an upstream fix; tracked in [`TRACKED_ISSUES.md`](TRACKED_ISSUES.md)." This same release window deletes `TRACKED_ISSUES.md` (`c6457b3`), so the release changelog would ship a newly stale/broken status pointer. The README now points at `tools/gh-auth-status-shim/README.md`, and that file has the live "Sunset plan" section; the changelog should either drop the `TRACKED_ISSUES.md` clause or point at the shim README instead.

## Audit B: Version bump matches scope

PASS.

`package.json` moves `4.1.0` to `4.2.0`. The release adds new opt-in extensions/env vars and one pre-announced `request_id` default flip. The flip does change default behavior, but the field shape already shipped in v4.1.0 as optional/gated, `v` remains `1`, and the v4.1.0 changelog explicitly pre-announced the v4.2.0 meter coupling. Treating this as a minor release is justified by the documented rollout contract.

## Audit C: No stray release files

PASS, with local-hook caveat.

The PR diff contains only:

- `CHANGELOG.md`
- `README.md`
- `package.json`
- `proxy/extensions/usage-log.mjs`
- `test/proxy-usage-log.test.mjs`

`proxy/extensions.json` is not in the PR diff. The local review worktree shows an unstaged `proxy/extensions.json` rewrite because the visits hook re-applies local `usage-log` and `rate-limit-log` entries; it is not part of `e392ff7` and is not staged for this review artifact commit.

## Audit D: Debug code, secrets, local-only patches

PASS.

The PR diff is limited to release docs/version plus the `usage-log` gate flip and test updates. I found no accidental `console.log`/debug additions, hardcoded secrets, or local-only patches in the changed release files.

## Audit E: Usage-log local mod / hook discipline

PASS.

`gh pr diff 241 --name-only` does not include `proxy/extensions.json`, and the commit diff against `main` does not include that file. The local hook rewrite is correctly excluded from the release commit.

## Audit F: `CACHE_FIX_USAGE_LOG_REQID` flip correctness

PASS.

The code changes the gate from `process.env.CACHE_FIX_USAGE_LOG_REQID === "on"` to `process.env.CACHE_FIX_USAGE_LOG_REQID !== "off"` in `proxy/extensions/usage-log.mjs`, making the env var a kill-switch. The tests cover unset/default-on, explicit `on`, missing header, explicit `off`, invalid content, runtime flipping, and end-to-end `off` suppression.

Meter publication precondition is met:

- `npm view claude-code-meter dist-tags --json` reports `latest: 0.8.0`.
- `npm view claude-code-meter versions --json | jq -r '.[]' | grep '^0\.7\.'` reports `0.7.0` and `0.7.1`.

## Audit G: README accuracy for new sections

PASS.

Spot checks matched code:

- `CACHE_FIX_NORMALIZE_CC_VERSION` default is off; modes are `strip` and `pin:<value>` with the documented pin validation.
- `CACHE_FIX_UPSTREAM_ERROR_LOG` default is off; `CACHE_FIX_UPSTREAM_ERROR_LOG_PATH` defaults to `~/.claude/usage-log/upstream-errors.jsonl`.
- `CACHE_FIX_OAUTH_REFRESH` default is off; the README env-var table matches `proxy/config.mjs` defaults for credential path, token URL, refresh margin, tick interval, and 8000 ms POST timeout.
- The usage-log table now documents `request_id` as default-on with `CACHE_FIX_USAGE_LOG_REQID=off` as the kill-switch, matching code and tests.

## Audit H: `npm pack --dry-run` tarball sanity

PASS.

`npm pack --dry-run` reports `claude-code-cache-fix@4.2.0`, 90 files, package size 293.8 kB, unpacked size 935.1 kB. The tarball is controlled by the package `files` allowlist and includes expected runtime assets under `preload.mjs`, `postinstall.js`, `tools/`, `hooks/`, `proxy/`, `bin/`, `templates/`, and `THIRD_PARTY_LICENSES`. It does not include `node_modules`, `.git`, `.claude`, tests outside shipped tool fixtures, or `docs/code-reviews`.

## Audit I: Tests and checks

PASS.

Focused suite passed in the dependency-ready release worktree at the same commit:

```text
node --test test/proxy-cc-version-normalize.test.mjs test/proxy-upstream-error-log.test.mjs test/proxy-usage-log.test.mjs test/oauth-refresher.test.mjs test/proxy-fingerprint-strip.test.mjs test/proxy-pipeline.test.mjs
tests 175
pass 175
fail 0
```

A first run in a fresh isolated worktree failed before executing `oauth-refresher` because `proper-lockfile` was not installed there; the rerun above used an existing local release worktree with dependencies present and the same `e392ff7` HEAD.

`gh pr checks 241` is green: Node test matrices 18/20/22 passed, GitGuardian passed, and Snyk passed.

## Blockers

1. Fix the stale `TRACKED_ISSUES.md` pointer in the v4.2.0 `gh-auth-status-shim` changelog bullet. The file is deleted in this release window, so the changelog should not ship a new link to it.

## Non-blocking Notes

- The v4.2.0 changelog is dense, but the density mostly reflects the release's accumulated feature scope rather than unrelated bloat.
- Directive-only artifacts merged during the window do not need user-facing release bullets unless the team wants the changelog to double as a process log.

## Bottom Line

Do not tag or publish until the one stale changelog pointer is corrected. The code, package contents, `request_id` flip, README sections, meter dependency precondition, and tests all pass the release gate.

— Codex review
