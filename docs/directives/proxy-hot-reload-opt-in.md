# Directive: hot-reload opt-in (default off via envvar)

**Status:** DRAFT — Proxy Builder, 2026-06-05. Pending Codex directive-stage review + AITL sign-off. Targets v3.10.0 alongside the `thinking-block-sanitize` default-on flip.

**References:** [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196) (tracking issue — silent v2 load failure on hot reload). [#197](https://github.com/cnighswonger/claude-code-cache-fix/pull/197) (observability layer — `/health` returns 503 + degraded when extensions fail to load; complements but does not fix this directive's class). Watcher source: `proxy/watcher.mjs`. Pipeline load path: `proxy/pipeline.mjs:8-53`. Startup wiring: `proxy/server.mjs:7,308,313,333`. Existing extension activation pattern (per memory `feedback_extension_activation_pattern`): `enabled:true` in config + runtime env-gate.

## Goal

Make the in-process file watcher / hot-reload behavior **opt-in** behind a new envvar `CACHE_FIX_HOT_RELOAD`. Default (unset or any value other than `on`) → watcher does not start; extensions load once at proxy boot and remain stable for the life of the process. Picking up a new extension or a code change to an existing one then requires `systemctl restart cache-fix-proxy.service` (or whatever supervisor is in use).

This is the root-cause fix for #196 for the vast majority of users. PR #197 adds observability so a load failure can't hide for 17 hours; this directive removes the conditions under which that class of failure occurs at all for everyone on the safe default.

## Background — why this is the right shape

The in-process hot reload (`startWatcher` → `loadExtensions`) is the only code path that triggers the Node ESM stale-import race. Cold starts have an empty ESM module cache; every `import()` reaches disk; the extension graph is fresh. The race only fires when the watcher re-imports an extension whose transitive dependencies are already cached — Node's loader cannot evict cached transitive modules, so the reload silently picks up a stale module graph (or throws on a missing-export mismatch, which is the failure shape #196 actually observed).

Three implementation options were considered:

- **A. Remove the watcher entirely.** Cleanest but unilaterally takes away a feature downstream users may depend on for adding custom extensions without a restart. Rejected.
- **B. Worker-thread-per-reload.** Each reload runs in a fresh `Worker` with clean ESM context. Works without a supervisor. Cost: ~100–150 LOC of plumbing plus a refactor of the extension contract to make hooks serializable across the worker boundary. Significant for a feature that's only marginally used. Rejected.
- **C. Envvar-gated, default off, loud user-facing comms.** Watcher code stays as-is; one gate added at the `startWatcher` call site; opt-in users get exactly the legacy behavior with a known caveat. Smallest diff, safest default, no supervisor assumption, preserves the feature for users who want it. **Chosen.**

C aligns with the existing cache-fix convention for behavior gating: extensions are `enabled:true` in their config + runtime env-gate at the extension entry point. The watcher is a peer to extension code by that lens — same pattern applies.

## Scope

### What changes

1. **Envvar gate in `proxy/server.mjs`** at the `startWatcher` call site (currently line 313). New behavior:

   ```js
   const hotReloadOptIn = process.env.CACHE_FIX_HOT_RELOAD === "on";
   const watch = options.watch !== false && hotReloadOptIn;
   ```

   Truthy values other than the literal string `"on"` (e.g. `"true"`, `"1"`, `"yes"`) are NOT accepted — consistent with the existing `CACHE_FIX_THINKING_SANITIZE` precedent (`thinking-block-sanitize.mjs` checks `=== "on"` specifically; matching that convention here avoids documenting two different "how to enable" rules in the README). `options.watch === false` still overrides regardless of envvar — embedded callers (tests, `startProxy` consumers) should keep their explicit control.

2. **Boot banner on stderr** unconditionally at startup:

   - When opt-in active: `[cache-fix] hot-reload: on (CACHE_FIX_HOT_RELOAD=on) — note: long-running processes can hit a Node ESM stale-import race (see #196). systemctl restart is the recovery path.`
   - When default: `[cache-fix] hot-reload: off (default since v3.10.0; set CACHE_FIX_HOT_RELOAD=on to restore prior behavior). Extension changes require a service restart.`

   One line each, no formatting, ends in a newline. Hard to miss in `journalctl -u cache-fix-proxy` without being noisy for monitoring tools that line-grep stderr.

3. **README** — new "Behavior change in v3.10.0" callout at the top of the proxy section linking to a deeper note in the extensions docs explaining the race, the envvar, and the upgrade flow. README is the only user-visible surface most downstream users will actually read; the rest is belt-and-suspenders.

4. **CHANGELOG** — lead bullet for v3.10.0: `Hot-reload is now opt-in (#196). Default behavior loads extensions once at startup; set CACHE_FIX_HOT_RELOAD=on to restore the prior watcher-based behavior. systemctl restart cache-fix-proxy is now required to pick up extension changes.`

5. **Upgrade runbook** (if one exists; otherwise a paragraph in the README upgrade section) — explicit "you must `systemctl restart cache-fix-proxy.service` after `npm install -g cache-fix-proxy@3.10.0`" note. The npm package itself doesn't carry a postinstall script that restarts the service (and shouldn't — postinstalls that touch system services are an anti-pattern in npm packaging), so this step must be in human-readable docs.

### What stays the same

- `proxy/watcher.mjs` — unchanged. Code remains in the tree, fully exercised by tests via direct `startWatcher` calls. The gate is *only* at the `startProxy` call site.
- `proxy/pipeline.mjs` and `getFailedExtensions()` from #197 — unchanged. Cold-start load failures (syntax error, missing dep, broken extension shipped in a new npm version) still surface via `/health` → 503. The two changes complement: #197 is the safety net for cold-start failures, this directive eliminates the hot-reload failure class entirely on the default.
- Embedded callers using `startProxy({ watch: false })` — unchanged behavior. `watch: false` still wins.

### What's explicitly NOT in scope

- **Worker-thread-per-reload.** Considered and rejected above. If a future requirement makes hot-reload-without-restart non-negotiable for the default, we revisit — that's a separate directive.
- **Removing `proxy/watcher.mjs`.** The watcher is still load-bearing for opt-in users; deletion would break them.
- **Auto-detecting a supervisor and self-restarting on file change.** Option A from the design discussion, rejected for the same reason (bare-node users would see process death instead of reload).
- **Changing `/health` semantics.** PR #197's contract is unchanged.
- **Postinstall script that prints a notice.** Postinstalls that print walls of text get flagged as spammy by npm tooling and ignored by most package managers. README + CHANGELOG + boot banner is sufficient.

## Non-Functional Requirements

- **Size/complexity budget.** ~10 LOC in `proxy/server.mjs` (gate + banner). ~30–50 LOC of README/CHANGELOG/runbook prose. ~20 LOC of test plumbing covering both the default-off and opt-in-on branches. Total touched LOC budget: ≤ 100, ≤ 4 files (`proxy/server.mjs`, `README.md`, `CHANGELOG.md`, one new test or additions to `test/proxy-server.test.mjs`).
- **Threat model.** Envvar is a behavior switch, not a privilege boundary. No new attack surface — the watcher already existed; this change reduces the surface available to a default-installed proxy. No secret material crosses any new boundary. No request/response body is touched.
- **Maintainability constraints.** No new abstractions. The gate is two lines at one call site, in the existing convention. No back-compat shim needed for embedded callers because `options.watch === false` already exists for that use case. No new files apart from possibly the test file. The legacy hot-reload path is preserved (not deprecated) so we are not committing to a future removal.
- **Performance/reliability.** Default-off eliminates the only known code path that produces a silent-failure mode in long-running proxies. No perf delta on the request path (the watcher only ran on file events anyway). Boot banner is one stderr write; negligible.
- **Load-bearing? Yes.** This changes default behavior of the proxy on upgrade for every downstream user — a wire-adjacent contract by the spirit of "anything security-relevant or behavior-affecting at the system boundary." Requires Chris's human review before merge in addition to Lead + Codex per the AGENTS.md load-bearing rule.

## Test plan

- **Default off (no envvar).** `startProxy()` does not start a watcher. File mutations in the extensions dir do NOT trigger `loadExtensions`. Verify by writing a new `.mjs` into the test extensions dir after startup, waiting past the debounce window, and asserting the registry is unchanged.
- **Opt-in on (`CACHE_FIX_HOT_RELOAD=on`).** Watcher starts, file mutations trigger reload, behavior matches the legacy pre-3.10.0 path. (This case may already be covered by existing watcher tests — re-use rather than duplicate.)
- **Explicit `options.watch: false` still wins.** Even with `CACHE_FIX_HOT_RELOAD=on` set, `startProxy({ watch: false })` must NOT start a watcher. This is the embedded-caller escape hatch.
- **Envvar non-`"on"` values are treated as off.** `"true"`, `"1"`, `"yes"`, `""` → watcher does not start. Codifies the `=== "on"` strictness.
- **Boot banner content.** stderr capture asserts the off-banner and on-banner strings are emitted at the right time.
- **Existing 985-test suite.** Must remain green. Existing tests that pass `watch: false` explicitly are unaffected.

## Release coordination

Bundles into **v3.10.0** alongside the `thinking-block-sanitize` default-on flip (per the 7-day dogfood draft at `~/drafts/63147-7day-dogfood-post-draft.md`). Both are "behavioral defaults adjustment" changes; combining them into one CHANGELOG entry under a single "Behavior changes" header is clearer for users reading the release notes than splitting across two minors.

- v3.10.0 CHANGELOG lead section will be **Behavior changes**:
  1. `thinking-block-sanitize` is now **on by default** (was opt-in; see #63147 and #171).
  2. **Hot-reload** is now **off by default** (was on; see #196). Set `CACHE_FIX_HOT_RELOAD=on` to restore.

- v3.10.0 README upgrade note must call out both defaults flips and the `systemctl restart` requirement.

## Open questions for review

1. **Envvar truthiness convention.** Directive specifies strict `=== "on"` matching the `CACHE_FIX_THINKING_SANITIZE` precedent. Codex / AITL: agree, or do you want to broaden to a `truthy(value)` helper (`"on" | "true" | "1" | "yes"`) for friendlier UX, accepting a one-time convention divergence?
2. **Boot banner verbosity.** The off-banner currently says "default since v3.10.0; set CACHE_FIX_HOT_RELOAD=on to restore prior behavior." That version pin will rot. Acceptable rot (it's a release-notes pointer, not a contract), or strip the version and just say "default since v3.10.0" elsewhere?
3. **README placement of the behavior-change callout.** Top of the proxy section, or a dedicated "Upgrading from v3.9.x" section? Both work; the latter scales better as future minor releases accumulate behavior changes.

— Proxy Builder
