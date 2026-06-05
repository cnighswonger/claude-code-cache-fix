# Directive: hot-reload opt-in (default off via envvar)

**Status:** DRAFT — Proxy Builder, 2026-06-05. Round 2 after Codex directive-stage review (CHANGES_REQUESTED on commit `3015cc7`). Pending re-review + AITL sign-off. **Targets v4.0.0** as a major release, not v3.10.0 — per `docs/release-workflow.md`, default-behavior changes warrant a major bump. Bundles with the `thinking-block-sanitize` default-on flip (also a defaults change) into a single v4.0.0 "Behavior changes" release.

**References:** [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196) (tracking issue — silent v2 load failure on hot reload). [#197](https://github.com/cnighswonger/claude-code-cache-fix/pull/197) (observability layer — `/health` returns 503 + degraded when extensions fail to load; complements but does not fix this directive's class). [#199](https://github.com/cnighswonger/claude-code-cache-fix/issues/199) (i18n follow-up — `README.zh.md` and `README.ko.md` updates tagged to @VictorSun92 and @ArkNill). Watcher source: `proxy/watcher.mjs`. Pipeline load path: `proxy/pipeline.mjs:8-53`. Startup wiring: `proxy/server.mjs:7,308,313,333`. `install-service` renderers (in-scope for this directive — see "What changes" below): `bin/install-service.mjs:21,89`, `templates/cache-fix-proxy.service.template:11`, `templates/com.cnighswonger.cache-fix-proxy.plist.template:12`. Existing extension activation pattern (per memory `feedback_extension_activation_pattern`): `enabled:true` in config + runtime env-gate. Release-policy reference: `docs/release-workflow.md:11` (default-behavior changes → major bump).

## Goal

Make the in-process file watcher / hot-reload behavior **opt-in** behind a new envvar `CACHE_FIX_HOT_RELOAD`. Default (unset or any value other than `on`) → watcher does not start; extensions load once at proxy boot and remain stable for the life of the process. Picking up a new extension or a code change to an existing one then requires `systemctl restart cache-fix-proxy.service` (or whatever supervisor is in use).

This is the root-cause fix for the #196 failure class. PR #197 adds observability so a load failure can't hide silently; this directive eliminates the conditions under which the class occurs at all on the safe default.

## Actual impact scope (refined, round 2)

Round-1 draft claimed "npm + restart bypasses the race" as a general statement. Codex's review correctly flagged this as too strong — distinguishing two separate sub-claims that don't both hold:

- **Sub-claim A (true): a cold restart on the new version clears the stale ESM cache.** Once the operator runs `systemctl restart cache-fix-proxy`, the new process starts with an empty module cache and the race cannot fire on that boot.
- **Sub-claim B (NOT demonstrated): the `npm install -g` step itself is immune to triggering hot-reload before the operator's manual restart.** The running proxy starts directly out of the installed package tree (per `README.md:17`); the default watched paths are that same tree's `proxy/extensions/` and `proxy/extensions.json` (per `proxy/config.mjs:18`); and `startProxy()` enables watching by default today. So `npm install -g` rewriting those files on a still-running proxy CAN trigger the watcher in the install window — before the operator's later restart — and that's exactly the failure mode of #196's class. The "npm flow bypasses the race" framing in round 1 was wrong.

Separately, round 1 referenced a "documented upgrade flow with explicit restart step." That documentation **does not currently exist in the repo at HEAD** (verified — `README.md` does not contain an upgrade-flow restart instruction). Adding that documentation is in scope for this directive; treating it as already-present was incorrect.

**Revised affected population:**

1. Anyone running `npm install -g cache-fix-proxy@new` (or `git pull` against a local checkout) on a host where the cache-fix proxy is currently running, regardless of whether they later restart the service. The install/pull step alone is sufficient to trigger the watcher and the race.
2. Sysadmins who drop a custom extension into the extensions dir on a live proxy expecting the watcher to pick it up.

This is functionally close to "all current users on long-running processes who upgrade in place." Cold-restart-on-upgrade does not bypass the race; it only recovers after the install step has already fired the watcher.

Default-off wins on the same three grounds as before, but now with a stronger urgency framing:

- It eliminates a footgun rather than mitigating it. The observability layer in #197 catches the failure within seconds, but "catch fast" is strictly weaker than "cannot occur."
- It closes the install-window race that the round-1 framing missed.
- The cost of the change is small and the opt-in path preserves the feature for users who actually want it.

So: scope of the *bug* is wider than the round-1 refinement suggested; scope of the *fix* (defaults change for everyone, plus install-service surface) covers it cleanly.

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

   Truthy values other than the literal string `"on"` (e.g. `"true"`, `"1"`, `"yes"`) are NOT accepted — consistent with the existing `CACHE_FIX_THINKING_SANITIZE` precedent (`thinking-block-sanitize.mjs` checks `=== "on"` specifically; matching that convention here avoids documenting two different "how to enable" rules in the README). Codex's round-1 review explicitly recommended keeping strict `=== "on"` over a generic `truthy()` helper; that recommendation is adopted. `options.watch === false` still overrides regardless of envvar — embedded callers (tests, `startProxy` consumers) keep their explicit control.

2. **Boot banner on stderr** unconditionally at startup, version-pin removed per Codex round-1 feedback (version framing belongs in CHANGELOG/README, not in long-lived service logs):

   - When opt-in active: `[cache-fix] hot-reload: on (CACHE_FIX_HOT_RELOAD=on) — long-running processes can hit a Node ESM stale-import race; see #196. systemctl restart is the recovery path.`
   - When default: `[cache-fix] hot-reload: off (set CACHE_FIX_HOT_RELOAD=on to enable). Extension changes require a service restart.`

   One line each, no formatting, ends in a newline. Hard to miss in `journalctl -u cache-fix-proxy` without being noisy for monitoring tools that line-grep stderr.

3. **`install-service` surface — first-class envvar support.** Per Codex's round-1 review, since `install-service` is the documented recommended deployment path (per `README.md:50,82`), the new envvar must be surfaced through it. Without this, opt-in users on the recommended install path would have to hand-edit the generated systemd unit / launchd plist after every upgrade, which is a documentation footgun in its own right.

   Specific changes:

   - **`bin/install-service.mjs`** — extend the renderer's accepted-envvar list to include `CACHE_FIX_HOT_RELOAD` alongside the existing `CACHE_FIX_PROXY_PORT` / `CACHE_FIX_PROXY_UPSTREAM` / `CACHE_FIX_DEBUG`. CLI flag: `--hot-reload` (boolean, defaults to off; presence emits the envvar binding in the unit/plist). When absent, the generated config does not set `CACHE_FIX_HOT_RELOAD` at all (preserves the safe default; the proxy code's strict `=== "on"` check treats unset and any other value identically).
   - **`templates/cache-fix-proxy.service.template`** — add an `Environment=` slot for `CACHE_FIX_HOT_RELOAD` (rendered conditionally, omitted entirely when `--hot-reload` was not passed). Per the systemd directives memory, the existing `Environment=` precedent in this template already covers the rendering shape — no new escaping concerns specific to this envvar.
   - **`templates/com.cnighswonger.cache-fix-proxy.plist.template`** — add a `<key>CACHE_FIX_HOT_RELOAD</key><string>on</string>` slot under `EnvironmentVariables`, rendered conditionally. Same escaping precedent as the rest of the plist.
   - **Install-service `--help` text** — document `--hot-reload` with a one-line description plus the #196 / #199 cross-reference for context.

4. **README** — new "Upgrading from v3.x" section (NOT a callout at the top of the proxy section — Codex round-1 recommended this scales better as future behavior changes accumulate). The section covers:

   - The hot-reload defaults change with the new envvar
   - The `thinking-block-sanitize` default-on flip (bundled into v4.0.0)
   - **The explicit upgrade flow that does NOT yet exist in the repo:** `npm install -g cache-fix-proxy@4 && sudo systemctl restart cache-fix-proxy` (or `launchctl unload/load` on macOS). Adding this documentation is itself in scope for the implementation PR.
   - A note pointing `install-service` users at `cache-fix-proxy install-service --hot-reload` if they want to restore prior behavior at the supervisor layer.

5. **CHANGELOG** — `## v4.0.0 — Behavior changes`:
   - `thinking-block-sanitize` now on by default (see #63147, #171)
   - Hot-reload now off by default. Set `CACHE_FIX_HOT_RELOAD=on` (or pass `--hot-reload` to `install-service`) to restore prior behavior. (See #196.)
   - Note: `systemctl restart cache-fix-proxy` is now required after `npm install -g` to pick up extension changes.

6. **i18n READMEs** — `README.zh.md` and `README.ko.md` updates tracked separately in [#199](https://github.com/cnighswonger/claude-code-cache-fix/issues/199), tagged to @VictorSun92 (zh) and @ArkNill (ko). Not in scope for this directive's implementation PR; will land as separate translation contributions after the English `README.md` change is in `main`.

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

- **Size/complexity budget (revised round 2).** Round-1 budget understated install-service work and direct `startWatcher` test coverage gap (both Codex round-1 findings). Revised:
  - `proxy/server.mjs` — ~15 LOC (gate + dual-mode banner)
  - `bin/install-service.mjs` — ~30 LOC (CLI flag, accepted-envvar list, help text)
  - `templates/cache-fix-proxy.service.template` + `templates/com.cnighswonger.cache-fix-proxy.plist.template` — ~5 LOC each (conditional envvar slot)
  - `README.md` — new "Upgrading from v3.x" section, ~40 LOC of prose
  - `CHANGELOG.md` — `v4.0.0` "Behavior changes" entry, ~10 LOC
  - Tests — ~60 LOC covering: default-off (no watcher), opt-in-on (watcher starts), `options.watch === false` overrides envvar, non-`"on"` envvar values treated as off, install-service rendering with and without `--hot-reload`, boot banner stderr capture, and a fresh direct `startWatcher` smoke test (currently no direct coverage per Codex round-1 finding). Probably 1–2 new test cases in `test/proxy-server.test.mjs` and additions to `test/install-service.test.mjs`.

  Total touched LOC budget: ≤ 200, ≤ 8 files. Materially larger than round-1's ≤ 100 / ≤ 4 because the install-service expansion adds real surface. Still small enough that the change reviews cleanly as one PR.

- **Threat model.** Envvar is a behavior switch, not a privilege boundary. No new attack surface — the watcher already existed; this change reduces the surface available to a default-installed proxy. No secret material crosses any new boundary. No request/response body is touched. The new `Environment=` slot in the systemd unit and the new `EnvironmentVariables` entry in the launchd plist follow the existing escape/quote precedent in their respective templates; no new injection surface.
- **Maintainability constraints.** No new abstractions. The gate is two lines at one call site in the existing convention. No back-compat shim for embedded callers (`options.watch === false` already covers them). The install-service changes are mechanical additions to existing renderer lists — no new architecture. The legacy hot-reload path is preserved (not deprecated) so we are not committing to a future removal.
- **Performance/reliability.** Default-off eliminates the only known code path that produces a silent-failure mode in long-running proxies. No perf delta on the request path (the watcher only ran on file events anyway). Boot banner is one stderr write; negligible.
- **Load-bearing? Yes.** This changes default behavior of the proxy on upgrade for every downstream user — a wire-adjacent contract by the spirit of "anything security-relevant or behavior-affecting at the system boundary." Requires Chris's human review before merge in addition to Lead + Codex per the AGENTS.md load-bearing rule.

## Test plan (revised round 2)

- **Default off (no envvar).** `startProxy()` does not start a watcher. File mutations in the extensions dir do NOT trigger `loadExtensions`. Verify by writing a new `.mjs` into the test extensions dir after startup, waiting past the debounce window, and asserting the registry is unchanged.
- **Opt-in on (`CACHE_FIX_HOT_RELOAD=on`).** Watcher starts, file mutations trigger reload, behavior matches the legacy pre-v4.0.0 path. Codex round-1 noted no direct `startWatcher` coverage exists today (existing server/embeddable/bootstrap suites all force `watch: false`) — so this case adds genuinely new coverage, not duplication.
- **Explicit `options.watch: false` still wins.** Even with `CACHE_FIX_HOT_RELOAD=on` set, `startProxy({ watch: false })` must NOT start a watcher. The embedded-caller escape hatch.
- **Envvar non-`"on"` values are treated as off.** `"true"`, `"1"`, `"yes"`, `""` → watcher does not start. Codifies the `=== "on"` strictness.
- **Boot banner content.** stderr capture asserts the off-banner and on-banner strings are emitted at the right time, and neither pins a version.
- **install-service `--hot-reload` rendering.** Both the systemd unit template and the launchd plist template emit the `CACHE_FIX_HOT_RELOAD=on` envvar slot when `--hot-reload` is passed; omit it entirely when absent. Existing `test/install-service.test.mjs` patterns already cover the analogous `--port` / `--upstream` / `--debug` rendering — new cases follow the same shape.
- **Existing 986-test suite.** Must remain green. Existing tests that pass `watch: false` explicitly are unaffected.

## Release coordination

**Bundles into v4.0.0** (major release) alongside the `thinking-block-sanitize` default-on flip (per the 7-day dogfood draft at `~/drafts/63147-7day-dogfood-post-draft.md`). Both are default-behavior changes; per `docs/release-workflow.md:11` default-behavior changes warrant a major bump, so v4.0.0 — not v3.10.0 — is the right vehicle. Combining them into one CHANGELOG entry under a single "Behavior changes" header is clearer for users reading the release notes than splitting across separate releases.

- v4.0.0 CHANGELOG lead section will be **Behavior changes**:
  1. `thinking-block-sanitize` is now **on by default** (was opt-in; see #63147 and #171).
  2. **Hot-reload** is now **off by default** (was on; see #196). Set `CACHE_FIX_HOT_RELOAD=on` (or pass `--hot-reload` to `install-service`) to restore prior behavior.
  3. `systemctl restart cache-fix-proxy` is now required after `npm install -g cache-fix-proxy@4` to pick up extension changes.

- v4.0.0 README upgrade section must call out all three points and the `install-service --hot-reload` flag.

## Round-1 review disposition

Codex's round-1 review flagged three blockers and several "needs attention" items. Disposition:

- **Blocker 1 (semver mismatch — minor vs major release).** Accepted. Retargeted to v4.0.0.
- **Blocker 2 (npm + restart bypass overstated).** Accepted. "Actual impact scope (refined, round 2)" rewritten to distinguish sub-claim A (true: cold restart clears stale cache) from sub-claim B (NOT demonstrated: install step itself is immune). Affected population widened accordingly. Documentation of the upgrade flow is now explicitly in scope.
- **Blocker 3 (install-service opt-in path underspecified).** Accepted. Scope expanded: `bin/install-service.mjs` adds `--hot-reload` flag, both templates get conditional envvar slots, install-service tests get new coverage. LOC budget revised upward.
- **Needs attention (i18n READMEs).** Accepted but out of scope for this directive's implementation PR. Tracking issue #199 opened, tagged to @VictorSun92 (zh) and @ArkNill (ko).
- **Needs attention (no direct startWatcher test coverage).** Accepted. Test budget revised; test plan explicitly calls out the new direct startWatcher case.
- **Needs attention (boot banner version pin).** Accepted. Version pin removed from the default-mode banner; version framing lives in CHANGELOG/README only.
- **Open question 1 (`=== "on"` vs `truthy()` helper).** Codex recommended strict `=== "on"`. Adopted.
- **Open question 2 (banner version pin).** Codex recommended strip version, keep in CHANGELOG. Adopted.
- **Open question 3 (README placement).** Codex recommended dedicated "Upgrading from v3.x" section over top-of-proxy callout. Adopted.

— Proxy Builder
