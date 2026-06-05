# Directive: hot-reload opt-in (default off via envvar)

**Status:** DRAFT — Proxy Builder, 2026-06-05. Round 4 after Codex directive-stage reviews (CHANGES_REQUESTED on commits `3015cc7`, `8eb2a42`, and `934795e`). Pending re-review + AITL sign-off. **Targets v4.0.0** as a major release per `docs/release-workflow.md` ("changed default behavior" → major bump). Bundles with the `thinking-block-sanitize` default-on flip (also a defaults change) into a single v4.0.0 "Behavior changes" release.

**References:** [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196) (tracking issue — silent v2 load failure on hot reload). [#197](https://github.com/cnighswonger/claude-code-cache-fix/pull/197) (observability layer — `/health` returns 503 + degraded when extensions fail to load; complements but does not fix this directive's class). [#199](https://github.com/cnighswonger/claude-code-cache-fix/issues/199) (i18n follow-up — `README.zh.md` and `README.ko.md` updates tagged to @VictorSun92 and @ArkNill). Watcher source: `proxy/watcher.mjs`. Pipeline load path: `proxy/pipeline.mjs:8-53`. Startup wiring: `proxy/server.mjs:7,308,313,333`. `install-service` renderers (in-scope for this directive — see "What changes" below): `bin/install-service.mjs:21,89`, `templates/cache-fix-proxy.service.template:11`, `templates/com.cnighswonger.cache-fix-proxy.plist.template:12`. Existing extension activation pattern (per memory `feedback_extension_activation_pattern`): `enabled:true` in config + runtime env-gate. Release-policy reference: `docs/release-workflow.md:11` (default-behavior changes → major bump).

## Goal

Make the in-process file watcher / hot-reload behavior **opt-in** behind a new envvar `CACHE_FIX_HOT_RELOAD`. Default (unset or any value other than `on`) → watcher does not start; extensions load once at proxy boot and remain stable for the life of the process. Picking up a new extension or a code change to an existing one then requires a supervisor-level restart of the proxy process — `systemctl --user restart cache-fix-proxy` on Linux per the install-service-generated user unit (`bin/install-service.mjs:358-361`), `launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy` on macOS per the install-service-generated launchd agent (`bin/install-service.mjs:381-383`).

This is the root-cause fix for the #196 failure class. PR #197 adds observability so a load failure can't hide silently; this directive eliminates the conditions under which the class occurs at all on the safe default.

## Actual impact scope (refined, round 2)

Round-1 draft claimed "npm + restart bypasses the race" as a general statement. Codex's review correctly flagged this as too strong — distinguishing two separate sub-claims that don't both hold:

- **Sub-claim A (true): a cold restart on the new version clears the stale ESM cache.** Once the operator runs `systemctl --user restart cache-fix-proxy` (Linux) or `launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy` (macOS), the new process starts with an empty module cache and the race cannot fire on that boot.
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

   - When opt-in active: `[cache-fix] hot-reload: on (CACHE_FIX_HOT_RELOAD=on) — long-running processes can hit a Node ESM stale-import race; see #196. Restart the proxy via your supervisor to recover.`
   - When default: `[cache-fix] hot-reload: off (set CACHE_FIX_HOT_RELOAD=on to enable). Extension changes require a supervisor-level proxy restart.`

   One line each, no formatting, ends in a newline. Both forms are supervisor-neutral so they read correctly under the install-service user-unit model (`journalctl --user -u cache-fix-proxy` on Linux, `log show --predicate 'subsystem == "com.cnighswonger.cache-fix-proxy"'` or `tail -F ~/Library/Logs/cache-fix-proxy.log` on macOS) and any other supervisor an operator might use. Hard to miss in the log without being noisy for monitoring tools that line-grep stderr.

3. **`install-service` surface — install-time env-capture (not a CLI flag).** Round 2 had this as a `--hot-reload` boolean CLI flag, but Codex round-2 review correctly flagged that as the higher-cost path: `install-service` already snapshots install-time configuration from environment variables for the existing `CACHE_FIX_PROXY_PORT` / `CACHE_FIX_PROXY_UPSTREAM` / `CACHE_FIX_DEBUG` settings (`bin/install-service.mjs:21-28`), with zero CLI parser surface. Adding a one-off boolean flag would add unique parser/help/test surface in `bin/claude-via-proxy.mjs` that the precedent does not require.

   Round 3 adopts the precedent. **No new CLI flag.** The operator opts in at install time by setting the envvar on the install-service invocation, exactly as they do for port/upstream/debug today:

   ```
   CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service
   ```

   Specific changes:

   - **`bin/install-service.mjs`** — extend `getDefaults()` (currently lines 21-28) to read `process.env.CACHE_FIX_HOT_RELOAD` into a `hotReload` field, paralleling `port` / `upstream` / `debug`. Add a `hotReloadLine` derivation analogous to `upstreamLine` / `debugLine` so the renderer can conditionally emit the slot. No CLI flag, no `--help` text changes, no entrypoint changes.
   - **`templates/cache-fix-proxy.service.template`** — add an `{{HOT_RELOAD_LINE}}` slot for `CACHE_FIX_HOT_RELOAD`, rendered as `Environment=CACHE_FIX_HOT_RELOAD=on` when the install-time env was `"on"`, omitted entirely otherwise. Existing `Environment=` precedent in this template covers the rendering shape — no new escaping concerns.
   - **`templates/com.cnighswonger.cache-fix-proxy.plist.template`** — add a conditional `<key>CACHE_FIX_HOT_RELOAD</key><string>on</string>` slot under `EnvironmentVariables`. Same escaping precedent as the rest of the plist.
   - **No parser or dispatch changes to `bin/claude-via-proxy.mjs`.** The entrypoint dispatches `install-service` as-is; no new argument parsing, no help-text dispatch logic, no new dispatch tests. The README subsection below scopes a separate one-line addition to the entrypoint's printed env summary (line 54), which is a text edit, not parser surface — the two scopes are compatible because the parser does not consult the env summary.

4. **README — proxy env inventory + new "Upgrading from v3.x" section.**

   - **`README.md:137` (proxy configuration table)** — add a `CACHE_FIX_HOT_RELOAD` row alongside the existing `CACHE_FIX_PROXY_PORT` / `CACHE_FIX_PROXY_BIND` / etc. rows. One line, matches the table's existing format.
   - **`bin/claude-via-proxy.mjs:54` (CLI environment summary)** — add `CACHE_FIX_HOT_RELOAD` to the env summary text the entrypoint prints. One line, matches the summary's existing format. (Note: this is a one-line text addition, not a parser change — preserves the env-capture-only contract above.)
   - **New "Upgrading from v3.x" section** (Codex round-1 recommended this scales better than a top-of-proxy callout). Two distinct flows, because Codex round-3 review correctly flagged that the directive previously conflated them:

     **Flow 1 — code-only npm upgrade (no install-service rerun).** Existing unit / plist unchanged; only the proxy code on disk is updated by npm; the running process needs to be restarted to pick up the new code.

     - **Linux (systemd user unit):** `npm install -g cache-fix-proxy@4 && systemctl --user restart cache-fix-proxy`. No `daemon-reload` because the unit file content is unchanged.
     - **macOS (launchd user agent):** `npm install -g cache-fix-proxy@4 && launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy`. `kickstart` (no `-k`) re-execs the agent under the existing plist; matches `bin/install-service.mjs:383` verbatim.

     **Flow 2 — install-service rerun to opt into hot-reload at the supervisor layer.** Operator wants `CACHE_FIX_HOT_RELOAD=on` baked into the unit/plist so it persists across reboots. Requires regenerating the unit/plist AND reloading the supervisor's view of the new file content.

     - **Linux (systemd user unit):**
       ```
       CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service
       systemctl --user daemon-reload
       systemctl --user restart cache-fix-proxy
       ```
       `daemon-reload` here is required because the unit file content changed.
     - **macOS (launchd user agent):**
       ```
       CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service
       launchctl bootout gui/$(id -u)/com.cnighswonger.cache-fix-proxy
       launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
       launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
       ```
       `bootout` / `bootstrap` is the sequence launchd requires to load new plist contents; `kickstart` alone (Flow 1) does not pick up plist changes. This is the distinction Codex's round-3 review specifically called out, and it matches the `launchctl bootout` reference in `bin/install-service.mjs:438` (the uninstall path uses the same `bootout` for the same reason).

     The commands above match the install-service-generated unit / plist (`bin/install-service.mjs:358-361, 381-383`), NOT system-wide `systemctl` or the deprecated `launchctl unload/load` flow. Implementation PR should validate the macOS Flow 2 sequence against the actual repo install before merging.

5. **CHANGELOG** — `## v4.0.0 — Behavior changes`:
   - `thinking-block-sanitize` now on by default (see #63147, #171)
   - Hot-reload now off by default. Set `CACHE_FIX_HOT_RELOAD=on` to restore prior behavior (env-capture: set before `cache-fix-proxy install-service`, or in the runtime environment for manual `cache-fix-proxy server` users). (See #196.)
   - A user-unit restart is now required after `npm install -g cache-fix-proxy@4` to pick up extension changes. Commands per platform in the README's "Upgrading from v3.x" section.

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

- **Size/complexity budget (revised round 3).** Round-3 adopts install-time env-capture over a CLI flag, which drops the entrypoint parser/help/test surface. Revised numbers:
  - `proxy/server.mjs` — ~15 LOC (gate + dual-mode banner)
  - `bin/install-service.mjs` — ~15 LOC (extend `getDefaults()` + `hotReloadLine` derivation, no CLI surface)
  - `templates/cache-fix-proxy.service.template` + `templates/com.cnighswonger.cache-fix-proxy.plist.template` — ~5 LOC each (conditional envvar slot)
  - `bin/claude-via-proxy.mjs` — ~1 LOC (one-line addition to the env summary text at line 54)
  - `README.md` — proxy env table row (~1 LOC) + new "Upgrading from v3.x" section (~40 LOC prose). Total ~45 LOC.
  - `CHANGELOG.md` — `v4.0.0` "Behavior changes" entry, ~10 LOC
  - Tests — ~50 LOC covering: default-off (no watcher), opt-in-on (watcher starts), `options.watch === false` overrides envvar, non-`"on"` envvar values treated as off, install-service rendering with and without `CACHE_FIX_HOT_RELOAD=on` in env at install time, boot banner stderr capture, and a fresh direct `startWatcher` smoke test (currently no direct coverage per Codex round-1 finding). 1–2 new test cases in `test/proxy-server.test.mjs` and additions to `test/install-service.test.mjs`.

  Total touched LOC budget: ≤ 160, ≤ 8 files (`proxy/server.mjs`, `bin/install-service.mjs`, two templates, `bin/claude-via-proxy.mjs`, `README.md`, `CHANGELOG.md`, plus test files). Down from round-2's ≤ 200 because the env-capture pattern eliminates the CLI parser surface. Still no new abstractions, no new architectural surface.

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
- **install-service env-capture rendering.** Both the systemd unit template and the launchd plist template emit the `CACHE_FIX_HOT_RELOAD=on` envvar slot when `process.env.CACHE_FIX_HOT_RELOAD === "on"` at install time; omit it entirely when the env is unset or any other value. Existing `test/install-service.test.mjs` patterns already cover the analogous env-capture for port/upstream/debug — new cases follow the same shape.
- **Existing 986-test suite.** Must remain green. Existing tests that pass `watch: false` explicitly are unaffected.

## Release coordination

**Bundles into v4.0.0** (major release) alongside the `thinking-block-sanitize` default-on flip (per the 7-day dogfood draft at `~/drafts/63147-7day-dogfood-post-draft.md`). Both are default-behavior changes; per `docs/release-workflow.md:11` default-behavior changes warrant a major bump, so v4.0.0 — not v3.10.0 — is the right vehicle. Combining them into one CHANGELOG entry under a single "Behavior changes" header is clearer for users reading the release notes than splitting across separate releases.

- v4.0.0 CHANGELOG lead section will be **Behavior changes**:
  1. `thinking-block-sanitize` is now **on by default** (was opt-in; see #63147 and #171).
  2. **Hot-reload** is now **off by default** (was on; see #196). Set `CACHE_FIX_HOT_RELOAD=on` in the install-service environment, or in the proxy's runtime environment for manual `cache-fix-proxy server` users, to restore prior behavior.
  3. A user-unit restart is now required after `npm install -g cache-fix-proxy@4` to pick up extension changes. Linux: `systemctl --user restart cache-fix-proxy`. macOS: `launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy`.

- v4.0.0 README upgrade section must call out all three points and the per-platform restart commands matching the install-service-generated unit / plist.

## Round-1 review disposition

- **Blocker 1 (semver mismatch — minor vs major release).** Accepted. Retargeted to v4.0.0.
- **Blocker 2 (npm + restart bypass overstated).** Accepted. Impact-scope section rewritten (see "Actual impact scope" above).
- **Blocker 3 (install-service opt-in path underspecified).** Accepted, then re-refined in round 3 to drop the CLI flag (see round-2 disposition below).
- **Needs attention (i18n READMEs).** Accepted, out of scope for the implementation PR. Tracking #199 (tagged @VictorSun92, @ArkNill).
- **Needs attention (no direct startWatcher test coverage).** Accepted. Test budget revised.
- **Needs attention (boot banner version pin).** Accepted. Version pin removed.
- **Open questions 1–3.** All three of Codex's round-1 recommendations adopted (strict `=== "on"`, no banner version pin, dedicated "Upgrading from v3.x" section).

## Round-2 review disposition

Codex's round-2 review (commit `8eb2a42`) flagged two remaining blockers and one bloat finding. Disposition:

- **Round-2 blocker 1 (supervisor commands don't match the install-service-generated unit / plist — `systemctl restart` vs `systemctl --user restart`; `launchctl unload/load` vs `launchctl bootstrap/kickstart`).** Accepted; refined again in round 4 after Codex round-3 caught that two leftover `systemctl restart cache-fix-proxy.service` references remained in active sections and that the `launchctl kickstart -k` form did not match the file (which uses `kickstart` without `-k`). All references now use the verbatim file-cited forms.
- **Round-2 blocker 2 (`bin/claude-via-proxy.mjs` CLI entrypoint not in scope; `cache-fix-proxy install-service --hot-reload` would not actually parse).** Accepted. Round-3 design moves to **install-time env-capture** (no CLI flag), eliminating the entrypoint parser work entirely. The directive's install-service surface now matches the existing PORT/UPSTREAM/DEBUG precedent.
- **Round-2 bloat finding (`--hot-reload` flag not the lowest-cost path; env-capture at install time matches the precedent with less CLI surface).** Accepted. The flag is removed. The only `bin/claude-via-proxy.mjs` change is a one-line addition to the env-summary text at line 54 — not a parser change.
- **Round-2 needs attention (proxy env inventory + CLI env summary need the new var, not just upgrade notes).** Accepted. `README.md:137` table and `bin/claude-via-proxy.mjs:54` env summary both now in scope.

Net change between round 2 and round 3: ≤ 200 LOC → ≤ 160 LOC, ≤ 8 files unchanged in count but the entrypoint touch is now mechanical (one summary line) rather than CLI-parser surface.

## Round-3 review disposition

Codex's round-3 review (commit `934795e`) approved the architectural direction (env-capture over CLI flag) but flagged two precision blockers and two needs-attention items. Disposition:

- **Round-3 blocker 1 (supervisor-command prose still inconsistent in active sections; `launchctl kickstart -k` did not match the file's `kickstart` without `-k`).** Accepted. All `systemctl restart cache-fix-proxy.service` and `systemctl restart cache-fix-proxy` references in active sections now read `systemctl --user restart cache-fix-proxy`. All `launchctl kickstart -k` references now read `launchctl kickstart` without `-k`, matching `bin/install-service.mjs:383` verbatim.
- **Round-3 blocker 2 (install-time env-capture doesn't document the reload sequence for a rewritten unit/plist; `kickstart` alone doesn't pick up plist changes on macOS).** Accepted. README "Upgrading from v3.x" section is now split into two explicit flows: (1) code-only npm upgrade (process restart only — `systemctl --user restart` / `launchctl kickstart`) and (2) install-service rerun with a rewritten unit/plist (`daemon-reload` + restart on Linux, `bootout` + `bootstrap` + `kickstart` on macOS). The macOS Flow 2 sequence matches `bin/install-service.mjs:438` (`launchctl bootout` is what the uninstall path uses for the same reason).
- **Round-3 needs attention 1 (`bin/claude-via-proxy.mjs` wording inconsistent — "No changes" in one section, "one-line addition" in another).** Accepted. Rewritten to "No parser or dispatch changes" + explicit note that the one-line env-summary edit at line 54 is a text addition compatible with the parser-untouched contract.
- **Round-3 needs attention 2 (boot-banner note referenced system-wide `journalctl -u cache-fix-proxy` rather than the user-unit form).** Accepted. Banner observability note is now supervisor-neutral with per-platform log-inspection forms (`journalctl --user -u cache-fix-proxy` on Linux, `~/Library/Logs/cache-fix-proxy.log` on macOS).

No design changes in round 4; precision-only.

— Proxy Builder
