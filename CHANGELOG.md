# Changelog

## [Unreleased]

## [3.6.0] - 2026-05-14

### Added

- **Embeddable proxy factory: `createProxyServer()` + `startProxy(options)` exported from `claude-code-cache-fix/proxy/server` (#123).** Lets Node/Bun hosts run the cache-fix proxy in-process instead of forking a child via the `cache-fix-proxy` bin. The CLI entrypoint (`node proxy/server.mjs`, `cache-fix-proxy server`, and the wrapper's child-fork path) is preserved — auto-listen and SIGTERM/SIGINT handlers are now gated behind an `import.meta.url === pathToFileURL(process.argv[1]).href` main-module check, so library imports have no side effects. `package.json` `exports` adds a `./proxy/server` subpath; the root entry (`./preload.mjs`) is unchanged. Adds 4 embeddable tests (factory shape, OS-assigned port, two instances coexisting, port reuse after close). README section added documenting the new API and the "one extension registry per process" constraint. Contributed by [@bilby91](https://github.com/bilby91) (Crunchloop DAP) — thank you, Martín.

### Fixed

- **`startProxy().close()` now also closes the file watcher.** The initial implementation in #123 captured the http server but discarded the handle returned by `startWatcher()`. Embedded hosts with `watch: true` (the default) that started/stopped the proxy across lifecycle iterations leaked two `fs.watch` handles per cycle. No regression test ships with this fix — verifying that `startProxy().close()` invokes the underlying watcher's `close()` requires either dependency injection on the production API or invasive module-scope inspection of `pipeline.mjs` state. The fix itself is a four-line capture+close in `proxy/server.mjs:startProxy()` and is verifiable by code review.

## [3.5.5] - 2026-05-12

### Fixed

- **`cache-telemetry`: overage-billing accounts had silent statusline (#121).** Accounts on Anthropic overage billing return `anthropic-ratelimit-unified-reset` and `anthropic-ratelimit-unified-overage-reset` instead of the 5h/7d-specific reset headers. The `parseHeaders` guard required `q5h_reset || q7d_reset` and returned `null` for every request on these accounts, so `cache-telemetry` wrote no `account.json` or session file and the statusline had no TTL/hit-rate data. Fix: parse `unified_reset` and widen the guard to accept any reset timestamp. Adds test 6a (overage-only header set → account/session files written, `five_hour.pct`/`seven_day.pct` correctly 0). Reported and fixed by [@TemaThe](https://github.com/TemaThe) — thank you.

### Tests

788 → 789 (+1): test 6a covers the overage-billing header shape end-to-end through `onResponseStart` and `onStreamEvent`.

## [3.5.4] - 2026-05-09

### Added

- **`THIRD_PARTY_LICENSES`: Apache 2.0 attribution for the NDJSON proxy log schema (#116, closes #115).** The schema used by `tools/usage-to-dashboard-ndjson.mjs` (field names, structure, `proxy-YYYY-MM-DD.ndjson` file naming convention, `cache_health` semantics, and `cost_factor` methodology) originates from [@fgrosswig](https://github.com/fgrosswig)'s [claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard) (Apache License 2.0). This release adds the formal Section 4 attribution as a `THIRD_PARTY_LICENSES` file and ensures it ships in the npm tarball via the `package.json` `files` array. cache-fix overall remains MIT-licensed; only the NDJSON schema portion is governed by Apache 2.0. Reported and authored by [@fgrosswig](https://github.com/fgrosswig); the `package.json` packaging fix was pushed to his branch via maintainer-edits. Thank you, Falk.

### Changed

- `tools/usage-to-dashboard-ndjson.mjs`: file header acknowledges the Apache 2.0 origin of the NDJSON schema portion (the rest of the file remains under cache-fix's MIT license per the repo `LICENSE`).

## [3.5.3] - 2026-05-08

### Fixed

- **`tools/usage-to-dashboard-ndjson.mjs`: documented dashboard-integration bridge silently dropped every v:1 usage row (#112).** The translator was written for the preload-era `usage.jsonl` schema (`entry.timestamp`, `entry.q5h_pct` / `entry.q7d_pct` as int 0-100). The proxy `usage-log` extension introduced in v3.2.0 writes MeterRowSchema v:1 with three field renames (`entry.ts`, `entry.q5h` / `entry.q7d` as float 0-1). The translator's entry guard `if (!entry.timestamp) return null` silently dropped every v:1 row, so external dashboards consuming the bridge received zero data from proxy-mode sessions. The integration is documented in our README's Companion Tools section and `docs/dashboard-integration.md` — this was a documented-feature regression. Fix: entry guard, quota-header reconstruction, `ts_start`/`ts_end` mapping, and `req_id` generation now accept both schemas via fallback (preload-era field if present, else v:1 field). Backwards-compatible — both formats work, no migration required. Adds 16 regression tests covering both schemas plus parity (`req_id` is identical for the same logical request expressed in either schema, so dashboards that dedup on `req_id` won't see duplicates from a user upgrading preload→proxy). Reported by [@TomTheMenace](https://github.com/TomTheMenace) with a tested patch already in the issue body — thank you.

### Tests

772 → 788 (+16): regression coverage for the dashboard-integration translator (#112) — preload-era and v:1 entry guard, ts_start/ts_end mapping, quota-header reconstruction with the legacy-takes-precedence rule, deterministic req_id, and full record parity between schemas.

## [3.5.2] - 2026-05-07

### Security

- **`tools/quota-statusline.sh`: shell injection via Python triple-quoted literal (#108).** The v3.5.0 statusline rewrite interpolated CC's hook stdin payload directly into a Python triple-quoted string (`json.loads('''$input''')`). A `'''` byte sequence anywhere in the payload closed the literal early and let the following bytes execute as Python in the user's CC process. Because CC's hook payload reflects user-controlled paths (`cwd`, `workspace.current_dir`, `workspace.project_dir`, `transcript_path`) and apostrophes are legal in filesystem paths, a hostile directory name on disk (planted via `git clone`, archive extraction, npm package, etc.) could trigger arbitrary local code execution at the user's privilege every time CC redrew the statusline. **Severity: local code execution, persistent re-fire on every statusline tick, no user interaction beyond `cd`-ing into the hostile path.** Fix: capture stdin in bash, `export CC_INPUT`, and pipe the Python source through a single-quoted heredoc (`<<'PYEOF'`) which disables ALL bash interpolation in the body. Python now reads the JSON via `os.environ.get('CC_INPUT')`, where the bytes are inert at every layer. Adds T6 + T7 regression tests that drive the exact `'''+__import__('os').system(...)+'''` pattern against the script under a tmpdir-rooted `HOME` and assert the sentinel file is never created. Reported by [@schuay (Jakob Linke)](https://github.com/schuay) in [#108](https://github.com/cnighswonger/claude-code-cache-fix/issues/108) — thank you for the responsible disclosure.

### Tests

735 → 737 (+2): T6 and T7 regression coverage for the #108 injection vector — payload in `session_id` and in non-`session_id` user-controlled fields (`cwd`, `workspace.current_dir`, `transcript_path`).

## [3.5.1] - 2026-05-05

### Fixed

- `cache-telemetry`: session-id headers (`x-claude-code-session-id` and the legacy fallbacks) live on the **request**, not the response. The v3.5.0 implementation read them from `ctx.headers` in `onResponseStart` — but that ctx carries response headers, and Anthropic doesn't echo session-id back. Net effect on multi-agent hosts running v3.5.0: every per-session file landed at `sessions/unknown.json` with `session_id: null`, defeating the whole point of the per-session split. Captured production failure on visits-01 immediately after v3.5.0 rollout. Fix moves session-id resolution into a new `onRequest` hook (request headers); `onStreamEvent` reads from `ctx.meta._sessionId` as before. The proxy server passes the same `meta` object through `onRequest → onResponseStart → onStreamEvent`, so the threading works end-to-end. Adds two regression tests that drive request and response headers separately to prevent recurrence.

### Tests

733 → 735 (+2): regression coverage for the request-vs-response ctx split (capture from request, fallback when absent).

## [3.5.0] - 2026-05-05

### Changed

- **Breaking (path change):** `~/.claude/quota-status.json` (single global file) replaced with `~/.claude/quota-status/account.json` (account-global quota fields: Q5h/Q7d, status, overage) plus `~/.claude/quota-status/sessions/<filename>.json` (per-session cache fields: TTL tier, hit rate, cache_creation/read). `<filename>` is derived from the request's `x-claude-code-session-id` header via a deterministic safe-name rule (UUIDs and similar safe ids pass through; malformed inputs are mapped to `inv-<sha256-prefix>`). Multi-agent users no longer see cross-session contamination — each session's cache state is attributed correctly. Custom statusline scripts that read the old global path must update to the new layout; the shipped `tools/quota-statusline.sh` has been migrated. The legacy file is auto-deleted on first request after upgrade. Per-session files older than `CACHE_FIX_QUOTA_STATUS_TTL_DAYS` (default `7`) are swept on write. **If you have your own consumer of `quota-status.json`, see the new [Migration: v3.4.x → v3.5.0+](README.md#migration-v34x--v350) section in the README for the try-new-fall-back-to-legacy pattern.** (#105, closes #104)

### Fixed

- `microcompact-stability`: session-id fallback chain now includes `x-claude-code-session-id` (the canonical CC header). Was previously checking only `meta.session_id`, `x-session-id`, and `x-anthropic-session-id`, returning null hashed-session-id for most CC requests in the wild and weakening per-session attribution in microcompact diagnostics. (#105)

### Tests

698 → 733 (+35): new tests for the `sessionFilename` rule, file-write happy paths and fallbacks, atomic write contract, legacy-file cleanup (one-shot per process), TTL sweep behavior + throttling + env-override, microcompact session-id fallback chain precedence, and pipeline integration covering happy path, two-session interleaving, and path-traversal safety. Plus T1–T5 statusline smoke tests covering UUID happy path, missing session_id (file present and absent), warming-state, all-files-missing clean exit, and malformed session_id reading the hashed filename.

## [3.4.0] - 2026-05-04

### Added

- New extension `messages-cache-breakpoint` (order 410, opt-in via `CACHE_FIX_INJECT_MESSAGES_BREAKPOINT=1`) — injects the missing breakpoint #3 `cache_control` marker at the boundary between Claude Code's auto-injected `messages[0]` blocks (hooks, skills, project CLAUDE.md, deferred-tools, MCP server descriptions) and the first real user content. Anthropic's prompt cache supports up to 4 markers per request; CC currently uses 3, leaving the auto-injected span uncached. Conservative: skips on 0 markers (non-CC baseline) and refuses at 4 markers (would 400 the request). Five-kind boundary detection with fail-open classification. Adds `CACHE_FIX_DUMP_MESSAGES_HEAD=<path>` diagnostic dump for fixture sourcing. (#90, closes #12; @wadabum's 4-breakpoint analysis at anthropics/claude-code#47098)
- New extension `microcompact-stability` (order 350) — Phase 1 of a two-phase fix for the cache-prefix invalidation observed when CC's `time_based_microcompact` writes a sentinel string that differs byte-wise between firings. Phase 1 ships diagnostic capture (`CACHE_FIX_DUMP_MICROCOMPACT=<path>`) and opt-in normalization (`CACHE_FIX_NORMALIZE_MICROCOMPACT=1`); both default off pending production data. Default canonical form `[Old tool result content cleared]` overridable via `CACHE_FIX_MICROCOMPACT_NORMALIZED=<text>` / `CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN=<regex>`. Phase 2 (snapshot-and-restore) deferred to a future release. (#91, closes #36)
- New extension `ttl-tier-detect` (order 75, default-enabled, no env var required) — detects `cache_control.ttl="5m"` markers in the incoming payload before downstream extensions strip them, recording the result on `ctx.meta._ttlTier`. Pure detection, no mutation. Ports the in-payload tier-detection from `preload.mjs:1815-1828`. (#100, closes #97; @vmfarms surfaced this)

### Changed

- `ttl-management` now consumes `ctx.meta._ttlTier` and auto-upgrades injected TTL: when the incoming payload carries any `ttl="5m"` marker, all injected `cache_control` blocks get `ttl="5m"`, even if `CACHE_FIX_TTL_MAIN` / `CACHE_FIX_TTL_SUBAGENT` is set to `1h`. Env value `none` still suppresses injection entirely. (#100)

### Fixed

- `identity-normalization`: the `SessionStart:resume → :startup` rewrite was a silent no-op — the marker constant matched the post-rewrite output instead of the input, so users on proxy mode silently lost the resume-block stabilization that preload mode performs correctly. Single-character fix; new tests mirror preload-side coverage. (#99, closes #96; @vmfarms surfaced this)
- `image-strip`: legacy `[image-strip]` and v3.3.0 `[image-guard]` operational stderr summaries fired on every request that did observable work, regardless of `CACHE_FIX_DEBUG`. Both now require `CACHE_FIX_DEBUG=1`. The `PRESERVE_DETAIL`-without-`GUARD` misconfiguration warning stays unconditional. (#99, closes #98; @vmfarms surfaced this)

### Other

- Author info and blog-link references migrated to vsits.co. (#95)
- New canonical release procedure documented at `docs/release-workflow.md`. (#101)

### Tests

597 → 698 (+101): new extension tests for `messages-cache-breakpoint`, `microcompact-stability`, `ttl-tier-detect`, plus pipeline-level integration tests for tier-detection and new tests for the two `identity-normalization` and `image-strip` bug fixes.

---

## 3.3.0 (2026-04-30)

**`image-guard` pipeline** (#87, closes design discussion in #87 thread):

Replaces v3.2.1's static `CACHE_FIX_IMAGE_MAX_DIM` with a conditional pipeline that mirrors Anthropic's actual image rules: the per-image dimension ceiling depends on image count (2000 px when count > 20, else 8000 px), the API enforces a 32 MB request body cap independently, and current-generation models accept up to 100 images per request. The new pipeline addresses all three axes; `MAX_DIM` only addressed the dimension axis with a single static value that overcorrected for ≤20-image requests.

Five passes, all gated by a single top-level env var (`CACHE_FIX_IMAGE_GUARD=1`):

| Pass | Trigger | Action |
|------|---------|--------|
| Pass 0 (legacy back-compat) | `CACHE_FIX_IMAGE_KEEP_LAST=N` set | Strip tool_result images from user messages older than N most recent |
| Pass 3 (opt-in) | `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1` AND long edge > model native cap | Lanczos resize via `sharp` to native cap (2576 px Opus 4.7, 1568 px otherwise), preserve aspect ratio and media type |
| Pass 1 | long edge > active rejection cap | Strip with forensic placeholder. Cap = `MAX_DIM` if set, else 2000 (count > 20) or 8000 (count ≤ 20) |
| Pass 2 | request body bytes > `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX` (default 30 MB) | Drop oldest images until under budget |
| Count cap | image count > `CACHE_FIX_IMAGE_COUNT_MAX` (default 100) | Drop oldest images down to cap |

Execution order: **Pass 0 → Pass 3 → Pass 1 → Pass 2 → count cap**. Each pass is independent — Pass 1 never resizes; Pass 3 never strips. README's precedence matrix documents every supported env-var combination.

**Optional `sharp` peer dependency.** Pass 3 requires [sharp](https://www.npmjs.com/package/sharp) for Lanczos resize. Declared in `peerDependenciesMeta` only (not `peerDependencies`) — users who don't want it pay nothing. If `sharp` is missing, Pass 3 logs `library_missing` and skips; Passes 0/1/2 + count cap still run.

**Telemetry.** New `ctx.meta.imageGuardStats` carries the full counter set (counts + bytes + estimated tokens + library_missing flag). One stderr line per processed request when the pipeline did anything observable.

**New env vars:**
- `CACHE_FIX_IMAGE_GUARD=1` — top-level pipeline gate
- `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1` — enable Pass 3 Lanczos resize via `sharp`
- `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX=<bytes>` — Pass 2 byte budget (default 31457280 = 30 MB)
- `CACHE_FIX_IMAGE_COUNT_MAX=<n>` — hard image-count cap (default 100; legacy Claude 1/2.x/Instant users can set 600)

**Back-compat.** All v3.2.1 legacy paths (`CACHE_FIX_IMAGE_KEEP_LAST` only, `CACHE_FIX_IMAGE_MAX_DIM` only, both together) continue to work exactly as before — no migration required for existing users.

**Tests:** 553 → 597 (44 new in `proxy-image-guard.test.mjs`, covering activation, every Pass, count cap, all 10 precedence-matrix rows, telemetry shape, sharp-unavailable + sharp-throws fallbacks, Pass 1 stderr emission, post-count-cap byte recompute). Pass 3 sharp tests use injected mocks — no real `sharp` install required to run the suite.

**Reviewer dance:** Codex implementation review found 2 blockers + 1 telemetry-drift note; all addressed in commit `91017e8`. Final approval at commit `9983d6a`. Both gates met (`approved-by-lead` + `approved-by-codex-agent`) before merge.

---

## 3.2.1 (2026-04-27)

**Oversized-image guard for `image-strip`** (#84, requested by @X-15):

New `CACHE_FIX_IMAGE_MAX_DIM=<pixels>` env var on the existing `image-strip` extension. When an image's pixel dimensions exceed the cap (Anthropic's per-image dimension ceiling for many-image requests is 2000px), the image is replaced with a forensic placeholder noting the original dimensions and tool_use_id. Covers both user-message direct images and tool_result-nested images. Pure-JS PNG and JPEG header parsing in new `proxy/image-dimensions.mjs` — no native dependencies.

Composes with the existing `CACHE_FIX_IMAGE_KEEP_LAST` (count axis): when both are set, `KEEP_LAST` runs first (drops images from old messages), then `MAX_DIM` runs on whatever survives (caps the size of the kept ones). Common triggers for the dimension axis: hi-res manuscript scans, retina screenshots, photos at full resolution.

**Tests**: 526 → 553 (27 new — 16 in `proxy-image-dimensions.test.mjs` covering synthesized PNG/JPEG headers, 11 in `proxy-image-strip.test.mjs` covering MAX_DIM behavior, fail-open semantics, and KEEP_LAST + MAX_DIM composition).

No behavior change for users not setting `CACHE_FIX_IMAGE_MAX_DIM`. No migration required.

---

## 3.2.0 (2026-04-25)

Three new opt-in extensions plus a `usage-log` rewrite that aligns the proxy's per-call JSONL with `claude-code-meter`'s strict validator.

**`overage-warning` extension** (#79, closes #47) — opt-in via `CACHE_FIX_OVERAGE_WARNING=1`:

When Anthropic's response headers indicate the user is approaching or has crossed the overage threshold (`anthropic-ratelimit-unified-status: allowed_warning|throttled` plus a non-empty `anthropic-ratelimit-unified-7d-surpassed-threshold`), emit a one-time-per-threshold-per-Q5h-window warning to stderr AND append a structured record to `~/.claude/overage-warnings.jsonl`. Carries a 15-minute rolling sample window to project minutes-to-100% with a coarse cost-per-hour estimate (labeled `coarse` everywhere — the precise per-tier cost engine is a v3.3.0 follow-up). Single emission per response guaranteed by an `emitted` flag on `ctx.meta`. Cross-response dedup keyed by `(threshold, q5h_resets_at)`. New shared rate constant in `proxy/rates.mjs`.

**`upstream-change-detection` extension** (#80, closes #39) — opt-in via `CACHE_FIX_UPSTREAM_DETECTION=1`:

Read-only structural fingerprinter that detects when CC ships updates that change `/v1/messages` request shape (cache_control marker count, system block layout, tools list, system-reminder patterns, beta headers). Per-namespace baseline persists across proxy restarts at `~/.claude/upstream-baseline.json` (atomic tmp + rename with unique suffix). Events appended to `~/.claude/upstream-changes.jsonl`. **Mechanically content-free**: every persisted field is a count, position, boolean, bucket label, or hash of stable identifiers. Allowlist matches stored as hash-of-sorted-indices, never the matched text. Unknown-marker / unknown-pattern detection records ONLY a boolean. Tested with a "secret string" planted throughout a request body — never appears in the fingerprint.

**`usage-log` rewritten to MeterRowSchema v:1** (#81, closes #70):

The proxy's `~/.claude/usage.jsonl` now emits exactly the 29-field record shape that `claude-code-meter`'s strict `z.strictObject({ v: z.literal(1), ... })` validator expects. The wire format is now the cross-repo contract — claude-meter v0.4.0+ tails the proxy's JSONL via `claude-meter ingest --watch`, validates strictly, and persists into the local store the existing analyze/share/status/history/rates already read from. **Breaking change for the `usage-log` row format** — old 9-field rows (with `peak_hour`) in any pre-existing `usage.jsonl` files will fail claude-meter's strict validator and be skipped on the reader side. `peak_hour` is no longer in the wire format (recomputable from `ts` if needed). `org_id` hashed with `sha256(raw).digest("hex").slice(0, 16)` — bit-exact match with claude-meter's algorithm, never raw. Activation pattern unchanged: opt-in via `extensions.json` entry, `CACHE_FIX_USAGE_LOG` is path override only.

**Cross-repo release ordering**: cache-fix v3.2.0 ships first. claude-meter v0.4.0 follows, declaring `claude-code-cache-fix >= 3.2.0` as its supported producer. The two packages are NOT independently shippable for the proxy-mode ingestion path.

**Tests**: 465 → 512+ (47+ new). No migration required for proxy or its other extensions.

---

## 3.1.1 (2026-04-25)

**`cache-fix-proxy install-service` subcommand** (#73, closes #48):

- New CLI dispatch supports `install-service` (systemd on Linux, launchd on macOS), `uninstall-service`, `server` (run just the proxy in foreground for ExecStart), and `help`.
- Existing `cache-fix-proxy` no-subcommand wrapper behavior is unchanged (back-compat).
- Refuses to overwrite existing config without `--force`. Picks up `CACHE_FIX_PROXY_PORT`, `CACHE_FIX_PROXY_UPSTREAM`, `CACHE_FIX_DEBUG` from the env at install time.
- Templates ship in new `templates/` directory.

**Healthcheck companion for proxy auto-recovery** (#75):

After the 2026-04-25 incident where the proxy was stopped by an unidentified caller during the Anthropic outage and stayed down for ~10 hours (`Restart=on-failure` doesn't fire on clean stops), `install-service` now also drops a healthcheck companion on Linux:

- `cache-fix-proxy-healthcheck.service` — oneshot that does `curl -fs http://127.0.0.1:<port>/health` and `systemctl --user start cache-fix-proxy.service` if the probe fails
- `cache-fix-proxy-healthcheck.timer` — fires the oneshot 30s after boot then every 2 minutes (AccuracySec=15s)
- `uninstall-service` stops the timer FIRST, then the proxy, then removes all three files

Recovery within 2 minutes from any stop cause: clean stop, crash, OOM, an external `systemctl stop`. macOS doesn't need it — launchd's `KeepAlive` already auto-restarts on any exit.

**Hardening + security**:

- Port string is now validated before being interpolated into the healthcheck shell command. A hostile `CACHE_FIX_PROXY_PORT` value (with shell metacharacters) would have allowed command injection; rejected with a clear error message now.
- Symmetric existence check on the healthcheck pair: refuses overwrite if either the service file OR the timer file exists (caught case where one was a half-installed stale artifact).
- Half-install rollback: if the healthcheck install throws after the main unit is written, the main unit is removed so users aren't left in a partial state.

**New doc: `docs/security-hardening.md`** (#74):

Honest assessment of the trust model around running CC + cache-fix proxy. Ranked threat surface, practical mitigations, what we explicitly DON'T defend against. Includes the proposed dangerous-command filter as a future v3.2.0 candidate, and audit-trail enablement docs (systemd user manager debug logging) for forensic recovery.

**Tests**: 433 → 465 (32 new). No breaking changes. No migration required.

---

## 3.1.0 (2026-04-25)

**New proxy extensions** (drop-in, behavior described inline):

- **`prefix-diff`** (opt-in via `CACHE_FIX_PREFIXDIFF=1`) — pure diagnostic. On every request, snapshots a small projection of the prefix (system prompt + tools + first 5 messages) to `~/.claude/cache-fix-snapshots/<key>-last.json`. If a prior snapshot exists and content differs, also writes `<key>-diff.json` and emits a one-line stderr summary. Atomic writes; per-call diff (no boot-flag gating). Closes #59 item 9. (#65)
- **`deferred-tools-restore`** (defaults ON; opt out via `CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE=1`) — preserves cache prefix across the MCP-reconnect race. On `claude --continue`, if MCP servers haven't reconnected before the first post-resume request, the deferred-tools attachment block at `msg[0]` shrinks dramatically and busts the cache at the very top (entire ~940K prompt re-caches). This extension persists the clean form of the block and substitutes it on subsequent shrunken requests, with strict downgrade guard (snapshot must be strictly longer than current). Snapshot keyed on the cwd parsed from CC's `# Environment` section in the system prompt — line-based section parser with ambiguity guard fails open on parse failure. Closes #59 item 6. (#66)

**Default config update** (#69):

- Three pre-existing extensions now enabled in the default `extensions.json`:
  - `smoosh-split` (order 320) — peels system-reminders out of `tool_result.content` into standalone blocks
  - `content-strip` (order 330) — removes per-turn bookkeeping reminders (`Token usage:`, `Output tokens —`, idle-tool nudges)
  - `tool-input-normalize` (order 340) — normalizes tool input fields for cache-stable JSON serialization
- Triggered by a real-world cache-miss event: a 606K-message context with a warmer running dropped to 5.9% hit rate; recovered to 99.9% within ~2 calls after enabling these. They were Codex-reviewed and merged days ago but had remained dormant.

**Issue #59 closed** (10/10 items resolved): #65 + #66 are the last two ports; item 10 (git-status strip) intentionally not ported because the proxy can't reach the system prompt before CC composes it. README updated to document the technical reason and point users at the native `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` flag.

**Docs**:

- README + ko/zh translations: removed `claude-code-meter` sharing references — the integration loaded via `NODE_OPTIONS` which CC v2.1.113+ ignores (Bun binary). Tracked in #70 for future refactor. (#71)
- TRACKED_ISSUES.md backfilled with Apr 23 activity (v3.0.3/4/5 ship notes, three filed CC issues, three new contributor entries). (#68)
- `docs/deferred/proxy-session-serializer.md` — preserves the Phase 3b session-serializer design as a deferred reference. Tracked in #67. (#68)

**Tests**: 391 → 433 (added 42 for `deferred-tools-restore`, 25 for `prefix-diff`).

**No breaking changes.** No migration required.

---

## 3.0.0 – 3.0.5 (2026-04-22 to 2026-04-23)

CHANGELOG entries were not added for the v3.x patch series at the time. Release notes for each are on GitHub:

- [v3.0.0](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.0.0) — local proxy with hot-reloadable extension pipeline
- [v3.0.1](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.0.1) — README restructure, bin entry fix
- [v3.0.2](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.0.2) — Windows proxy fix + preload empty-content guard
- [v3.0.3](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.0.3) — corporate proxy support, updated translations
- [v3.0.4](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.0.4) — fix proxy telemetry: `quota-status.json` was never written
- [v3.0.5](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.0.5) — fix status bar reading stale data

---

## 2.0.6 (2026-04-20)

- **BUGFIX: `manual-compact.sh` path conversion failed on directories with underscores** — CC normalizes underscores to hyphens in project paths (e.g. `kanfei_test` → `kanfei-test`). The script now handles this. Also improved output to show the exact copy-paste message with the real session ID.

16 total cache-stability fixes. 163 tests.

## 2.0.5 (2026-04-20)

- **BUGFIX: TTL ordering violation causes 400 error at Q5h=100%** — When the user's quota hit 100%, CC places `ttl: "5m"` markers. Our interceptor then added `ttl: "1h"` markers on other blocks, violating Anthropic's ordering constraint (1h cannot follow 5m in tools→system→messages order). Fix: detect existing TTL tier from the payload before any extension runs. If any block has `ttl: "5m"`, all injected markers (TTL injection, `cache_control_normalize`, `cache_control_sticky`) now use `5m` to match. Reported by @cowwoc (#44).

16 total cache-stability fixes. 163 tests.

## 2.0.4 (2026-04-19)

- **New tool: `manual-compact.sh`** — Manual compaction for sessions using the 1M context hack (`DISABLE_COMPACT=1`). Extracts conversation from JSONL, weights recent turns heavily for active-work fidelity, summarizes via Claude Sonnet. Supports project directory auto-detection with confirmation prompt, and optional user context file for known gaps. Tested at 95% active-work fidelity. See `tools/MANUAL-COMPACT.md`.
- **Development workflow** — Added formal PR review process, agent identification requirement, label policy, and cross-LLM review workflow to CLAUDE.md.
- **TRACKED_ISSUES.md** — Updated with v2.1.112/113 context, new issues (#35, #36, #39, #40, #41, #50083), media coverage section, and new contributors (deafsquad, wadabum, cowwoc, stellaraccident).

16 total cache-stability fixes. 162 tests.

## 2.0.3 (2026-04-17)

- **BUGFIX: `cache_control_sticky` still exceeded 4-marker limit on CC v2.1.112** — v2.0.2 reduced `MAX_POSITIONS` from 3→2 assuming CC uses exactly 2 markers (1 system + 1 messages). CC v2.1.112 uses 3 markers in some configurations, so 2 sticky + 3 CC = 5, still exceeding the hard limit. Fix: count all existing `cache_control` markers across the full body (system + messages) before adding sticky markers, and cap the total at 4. No more assumptions about CC's marker budget. Caused `400 invalid_request_error` in production.

16 total cache-stability fixes. 162 tests.

## 2.0.2 (2026-04-17)

- **BUGFIX: `cache_control_sticky` exceeded Anthropic's 4-marker limit** — Reduced `MAX_POSITIONS` from 3 to 2. With 1 system marker + 1 canonical from `cache_control_normalize` + 3 historical = 5, exceeding Anthropic's hard limit of 4 `cache_control` blocks per request. Caused `400 invalid_request_error` on sessions with enough history to fill all 3 slots. Now: 1 system + 1 canonical + 2 historical = 4.

## 2.0.1 (2026-04-17)

- **`cache_control_sticky`** — Preserves historical `cache_control` marker positions across turns. CC maintains one user-side marker at a time, dropping previous positions (~43 bytes of JSON framing per dropped position). On long sessions this causes tail-of-message byte drift that invalidates downstream cached blocks. This extension tracks up to 2 historical marker positions by stable message hash and reinstates them on subsequent turns (2 historical + 1 canonical from normalize + 1 system = 4, Anthropic's hard limit). Runs after `cache_control_normalize`. Credit: [@deafsquad](https://github.com/deafsquad) (PR #33).

16 total cache-stability fixes. 160 tests.

## 2.0.0 (2026-04-17)

Major release — 7 new cache-stability fixes, expanding the interceptor from 8 fixes to 15. Combined stack reduces first-request cache creation by up to 99.8% on affected accounts (940K → 1.7K tokens measured by @deafsquad). Confirmed compatible with CC v2.1.112 and Opus 4.7.

### New fixes

- **`smoosh_split`** — Universal un-smoosh: peels any trailing `<system-reminder>` content out of `tool_result.content` strings back into standalone text blocks. Reverses CC's `smooshSystemReminderSiblings` folding that causes per-turn byte drift in tool results. Defaults ON. Credit: [@deafsquad](https://github.com/deafsquad) (PR #26).
- **`session_start_normalize`** — Rewrites `SessionStart:resume` → `:startup`, strips `<session-id>` and `Last active:` timestamps that differ between startup and resume, eliminating content drift at `messages[0]` block 0. Credit: [@deafsquad](https://github.com/deafsquad) (PR #27). Targets anthropics/claude-code#43657.
- **`continue_trailer_strip`** — Removes the `"Continue from where you left off."` text block CC injects on `--continue` that changes the prefix shape vs a normal turn. Credit: [@deafsquad](https://github.com/deafsquad) (PR #28).
- **`deferred_tools_restore`** — Snapshots the MCP deferred-tools block and restores it on reconnect race, preventing cache bust when MCP disconnects and reconnects mid-session with different content. Credit: [@deafsquad](https://github.com/deafsquad) (PR #29).
- **`reminder_strip`** — Drops Token usage / USD budget / output tokens / TodoWrite / turn-counter bookkeeping `<system-reminder>` blocks that change every turn. Credit: [@deafsquad](https://github.com/deafsquad) (PR #30).
- **`cache_control_normalize`** — Pins the `cache_control` marker at a canonical position to stop per-turn drift when CC moves the marker between blocks. Credit: [@deafsquad](https://github.com/deafsquad) (PR #31).
- **`tool_use_input_normalize`** — Strips non-schema keys from `tool_use.input` and canonicalizes key order to schema declaration order. CC's serialization of past `tool_use` blocks can drift between turns when the caller passes extra fields not in `input_schema.properties` — a 2334-byte drift on a single block caused a 620K-token cache miss. New miss class identified live on 2026-04-17. Credit: [@deafsquad](https://github.com/deafsquad) (PR #32).

### Existing fixes (from beta series)

- **`smoosh_normalize`** — Pattern-based normalization of 4 known dynamic system-reminder values (token_usage, budget_usd, output_token_usage, todo_reminder) in both smooshed and unsmooshed form. Opt-in via `CACHE_FIX_NORMALIZE_SMOOSH=1`.
- **`cwd_normalize`** — Replaces volatile CWD and path references in system prompt with stable placeholders for cross-worktree cache reuse. Opt-in via `CACHE_FIX_NORMALIZE_CWD=1`. Credit: [@wadabum](https://github.com/wadabum) for the architectural analysis (anthropics/claude-code#48236).

### Opus 4.7 advisory

Metered data shows Opus 4.7 burns Q5h at ~2.4x the rate of 4.6 due to invisible adaptive thinking tokens not reported in the API usage response. Workaround: `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` (may reduce quality). See [Discussion #25](https://github.com/cnighswonger/claude-code-cache-fix/discussions/25).

### Contributors

This release adds [@deafsquad](https://github.com/deafsquad) as contributor #10 — source-level function attribution of the resume scatter bug, OTEL telemetry discovery, and 7 PRs (#26-32) providing universal cache-stability coverage.

## 1.11.0 (2026-04-15)

- **Fingerprint verification fix for CC v2.1.108+** — CC v2.1.108 changed fingerprint computation to skip `<system-reminder>` blocks via an `isMeta` filter. The safety check now tries both the new extraction method (v2.1.108+) and the legacy method, keeping fingerprint stabilization working across CC versions. `CACHE_FIX_SKIP_FINGERPRINT=1` workaround is no longer needed. Credit: [@ArkNill](https://github.com/ArkNill) (PR #21).
- **Korean README** — Full setup and usage guide in Korean (README.ko.md). Credit: [@ArkNill](https://github.com/ArkNill) (PR #22).

## 1.10.0 (2026-04-14)

Security transparency release.

- **Postinstall security notice** — On `npm install`, displays a clear notice that the interceptor has full read/write access to API requests, confirms all telemetry is local-only, and links to source and independent audit.
- **First-run security log** — On first API call, logs the security posture to the debug log alongside the health status line.
- **Security Model section in README** — Moved to top of README. Documents the MITM position, what the interceptor does and does not do, supply chain profile, and links the independent audit by @TheAuditorTool.
- **Confirmed through v2.1.107** — salt and fingerprint indices unchanged.

## 1.9.2 (2026-04-14)

- **`/clear` artifact stripping** — Removes `<local-command-caveat>`, `<command-name>`, and `<local-command-stdout>` blocks that bleed into `messages[0]` after `/clear`, breaking prefix cache match vs a fresh session. Credit: [@wadabum](https://github.com/wadabum) (anthropics/claude-code#47756).
- **Status line fallback to `quota-status.json`** — `quota-statusline.sh` now works without `claude-code-meter` installed by reading quota data from the interceptor's `quota-status.json`. Fixes #18. Credit: [@dmurat](https://github.com/dmurat).
- **VS Code extension** — VSIX extension available for one-click activation. Auto-configures `claudeProcessWrapper`. No manual wrapper scripts or C compilation needed. Credit: [@JEONG-JIWOO](https://github.com/JEONG-JIWOO), [@X-15](https://github.com/X-15) (#16). Download: [GitHub Releases](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest).
- **README: VS Code section rewritten** — VSIX as Option A (recommended), manual wrapper as Option B. Documents `claudeCode.claudeProcessWrapper` as the correct integration path.

## 1.9.1 (2026-04-13)

- **Windows: URL-encode npm root in `claude-fixed.bat`** — Fixes `ERR_MODULE_NOT_FOUND` on default Windows Node.js installs where npm root contains spaces (e.g. `C:\Program Files\nodejs\node_modules`). Uses PowerShell `[System.Uri]::EscapeUriString` to encode the path; no-op on space-free paths. Credit: [@beekamai](https://github.com/beekamai) (PR #17).

## 1.9.0 (2026-04-13)

Cache-busting mitigation, configurable TTL, and diagnostic tooling.

- **Git-status stripping** (#11) — Opt-in removal of volatile `gitStatus` section from system prompt. CC injects live git status (branch, changed files, recent commits) that changes on every file edit, busting the entire prefix cache. Set `CACHE_FIX_STRIP_GIT_STATUS=1` to replace with a stable placeholder. The model can still run `git status` via Bash when it needs context. Kill switch: `CACHE_FIX_SKIP_GIT_STATUS=1`.
- **Configurable TTL per request type** (#14) — TTL injection now distinguishes main-thread from subagent requests. `CACHE_FIX_TTL_MAIN` and `CACHE_FIX_TTL_SUBAGENT` accept `1h` (default), `5m`, or `none` (pass-through). Subagent detection reuses the Agent SDK identity string from `system[1]`. Users on API keys or custom `ANTHROPIC_BASE_URL` can now control TTL per call type.
- **Cache breakpoint dump** (#12) — Diagnostic env var `CACHE_FIX_DUMP_BREAKPOINTS=<path>` writes the full `cache_control` breakpoint structure (system blocks + message blocks) to a JSON file. Maps breakpoint positions, types, TTLs, and content previews. Used to investigate the missing breakpoint #3 (skills/CLAUDE.md) identified by @wadabum.
- **Cost-report tier fix** (#7) — `cost-report.mjs` now correctly assigns cache creation tokens to the 1h write rate when `ephemeral_1h_input_tokens > 0`. Previously all creation was assumed 5m when the ephemeral breakdown fields were zero, understating cost for 1h-tier sessions.

## 1.8.1 (2026-04-13)

- **nvm-compatible wrapper script** — README wrapper now uses `npm root -g` for dynamic path resolution instead of hardcoded `$HOME/.npm-global`. Fixes setup for nvm, volta, and other Node version managers. Adds existence check for the interceptor module. Credit: [@arjansingh](https://github.com/arjansingh) (PR #15).

## 1.8.0 (2026-04-13)

Safety, lifecycle management, and self-deprecation features. Merges @thepiper18's hardening PR (#8) — 28 new tests bringing the suite to 75.

- **Fingerprint round-trip safety check (P0)** — Before rewriting `cc_version`, verifies our salt/indices reproduce the fingerprint CC sent. If verification fails (CC changed its algorithm), the rewrite is skipped automatically. The interceptor can never make cache performance *worse* than stock CC.
- **Master kill switch + per-fix toggles** — `CACHE_FIX_DISABLED=1` disables all bug fixes while keeping monitoring + optimizations active. Per-fix: `CACHE_FIX_SKIP_{RELOCATE,FINGERPRINT,TOOL_SORT,TTL,IDENTITY}`.
- **Persistent effectiveness stats** — `~/.claude/cache-fix-stats.json` tracks per-fix applied/skipped/safetyBlocked counts with 30-day auto-prune and atomic writes.
- **Startup health status line** — On first API call, logs per-fix status: `active(2h ago)`, `dormant(5 clean sessions)`, `safety-blocked(Nx)`, `waiting`. Includes advisory messages for dormant fixes.
- **Cache regression detector** — In-memory ring buffer tracking `cache_read` ratio. Warns if ratio drops below 50% across 5+ consecutive calls — especially useful when fixes are disabled and CC regresses.
- **Portuguese guide** (`docs/guia-pt-br.md`) — Full setup and usage guide in Portuguese. Credit: @thepiper18.
- **"Graduating from Fixes" + "Safety" README sections** — Documents the three-purpose lifecycle model (bug fixes / monitoring / optimizations) and the fail-safe design guarantee.

## 1.7.2 (2026-04-12)

- **Status line for real-time quota/TTL warnings** — Ships `tools/quota-statusline.sh`, a Claude Code status line script that displays live Q5h%, Q7d%, burn rates, TTL tier, cache hit rate, peak-hour flag, and overage status. When the server downgrades to 5m TTL at Q5h ≥ 100% (Layer 2 quota-aware downgrade), the status line shows `TTL:5m` in red — a visible "stop and wait" signal that prevents users from power-driving through overage and compounding the drain. Setup: copy the script to `~/.claude/hooks/` and add `"statusLine": { "command": "~/.claude/hooks/quota-statusline.sh" }` to `~/.claude/settings.json`.
- **README: "Status line — quota warnings in real time"** — New section with feature list, setup instructions, and explanation of why TTL visibility matters for Layer 2 behavior.

## 1.7.1 (2026-04-12)

- **Windows support** — Added `claude-fixed.bat` wrapper for Windows users where `NODE_OPTIONS="--import ..."` doesn't work. Dynamically resolves npm global root, constructs `file:///` URL with forward-slash conversion, launches Claude Code with the interceptor active. Credit: [@TomTheMenace](https://github.com/anthropics/claude-code/issues/38335).
- **README: Windows setup guide** — Step-by-step instructions for Windows users alongside the existing Linux/macOS wrapper, alias, and direct-invocation options.
- **Contributors: @TomTheMenace** — First Windows platform validation: 7.5-hour, 536-call Opus 4.6 session with 98.4% cache hit rate. 81% of calls had fingerprint instability corrected by the interceptor. Contributed the `.bat` wrapper.

## 1.7.0 (2026-04-11)

Investigation release — cross-version regression analysis, interop with @fgrosswig's claude-usage-dashboard, and diagnostic tooling for per-version tool-schema drift.

- **`CACHE_FIX_DUMP_TOOLS` diagnostic hook** — Env-gated dump of the outgoing `tools` array to a JSON file, recording per-tool name, description, schema size, and total serialized size. Used during the 2026-04-11 cross-version regression investigation to identify that Claude Code v2.1.101's +7,207 character tool-schema growth is 92% attributable to two new tools (`Monitor` and `ScheduleWakeup`) shipped in that release. Inert unless `CACHE_FIX_DUMP_TOOLS=<path>` is set.
- **Full `anthropic-*` response header capture** — Widened the response header capture in `preload.mjs` from specific unified-ratelimit headers to the entire `anthropic-*` namespace plus `request-id`/`cf-ray`. Saved to `~/.claude/quota-status.json` under a new `all_headers` key. Future-proofs against Anthropic adding new headers without requiring code changes. Pattern borrowed from @fgrosswig's claude-usage-dashboard proxy.
- **`cost-factor` metric in `cost-report.mjs`** — Adds an overhead-ratio metric: `(input + output + cache_read + cache_creation) / output`. Single-number indicator of how much context is being paid per useful output token; rising values over long sessions signal cache-efficiency degradation. Surfaced in text, JSON, and Markdown output modes. Credit: @fgrosswig (methodology from claude-usage-dashboard).
- **`tools/sim-cost-reconcile.sh`** — One-liner wrapper around `cost-report.mjs` for running simulation logs against the Anthropic admin API. Auto-loads the admin key from `~/.config/anthropic/admin-key` or `ANTHROPIC_ADMIN_KEY`, resolves a sim directory to its simulation.log, and passes through extra args.
- **`tools/usage-to-dashboard-ndjson.mjs`** — New translator tool that reads `~/.claude/usage.jsonl` and emits NDJSON records in the schema expected by @fgrosswig's claude-usage-dashboard. Writes to `~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson` (the path his dashboard auto-discovers). Supports one-shot, follow, and stdout modes. Interceptor-specific fields (`ttl_tier`, `ephemeral_1h_input_tokens`, `peak_hour`, quota state) pass through his dashboard's tolerant schema unchanged. No coordination with fgrosswig required — the integration is fully one-way.
- **README: "Works with @fgrosswig's dashboard" section** — Documents the interop pattern with a quick-setup example, explains the complementary architecture (our per-call capture + his visualization), and adds @fgrosswig to Related research and Contributors.
- **docs/march-23-regression-investigation.md** — Full methodology and measurements from the 2026-04-11 cross-version analysis of Claude Code v2.1.81, v2.1.83, v2.1.90, and v2.1.101. Documents the release-timing argument (regression starts mid-release-cycle → server-side change), per-version prefix sizes, per-section breakdown, per-tool drift table, and the `ScheduleWakeup` tool description quote confirming the 5-minute TTL baseline from Anthropic's own product code.

## 1.5.0 → 1.6.4 (2026-04-08 to 2026-04-10) — backfilled

The CHANGELOG was not kept in sync during this release window. The major shipped features across these versions:

- **1.6.4** — `quota-analysis` tool for Q5h counting investigation; test infrastructure hardening; Crunchloop DAP / @bilby91 production-validation credit.
- **1.6.3** — Unit tests + CI workflow; `tengu_onyx_plover` GrowthBook flag tracking for `autoDream` visibility.
- **1.6.2** — Fresh-session sort/pin fix for @bilby91's #44045 case (removed the `messages.length < 2` early return); opt-in identity normalization for Agent SDK `system[1]` cache parity via `CACHE_FIX_NORMALIZE_IDENTITY=1` (@labzink #44724); opt-in output-efficiency system-prompt rewrite via `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT` (@VictorSun92 PR).
- **1.6.1** — Quota utilization (`q5h_pct`, `q7d_pct`) logged per-call to `usage.jsonl` for drain-rate analysis.
- **1.6.0** — Enforce 1-hour cache TTL on accounts blocked by client-side gating. Interceptor injects `ttl: "1h"` into every outgoing `cache_control` block unconditionally.
- **1.5.1** — Fix MCP registration jitter cache busts (deferred-tools block sort, @bilby91 #44045).
- **1.5.0** — Add usage telemetry logging to `~/.claude/usage.jsonl`; `cost-report.mjs` CLI tool with pricing from `rates.json`, admin API cross-reference, and per-call breakdown.

For full per-commit detail on any of these releases, see `git log` in the repository.

## 1.4.1 (2026-04-08)

- **Peak hour detection** — Detects Anthropic's weekday peak hours (13:00–19:00 UTC, Mon–Fri) when quota drains at an elevated rate. Writes `peak_hour: true/false` to `quota-status.json` and logs `PEAK HOUR` when `CACHE_FIX_DEBUG=1`. Enables status line and data analysis to separate peak vs off-peak burn rates.

## 1.4.0 (2026-04-08)

- **TTL tier detection** — Clones the API response and drains the SSE stream to extract `ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens` from the usage object. Determines which cache TTL tier the server applied (1h vs 5m) and writes it to `~/.claude/quota-status.json` alongside quota data. Logs per-call cache hit rate and TTL tier when `CACHE_FIX_DEBUG=1`. Useful for diagnosing stuck TTL issues (#42052).
- **Quota file merge** — Header-based quota writes now merge with existing `quota-status.json` instead of replacing it, preserving the async TTL/cache data across writes.

## 1.3.0 (2026-04-08)

- **Prompt size measurement** — When `CACHE_FIX_DEBUG=1`, every API call now logs character counts for the system prompt, tool schemas, and per-type injected blocks (skills listing, MCP instructions, deferred tools, hooks). Helps users with large plugin/skill setups quantify the per-turn token cost of their configuration.
- **Removed prefix lock feature** — The prefix lock (`CACHE_FIX_PREFIX_LOCK`) has been removed. Testing revealed that the system prompt includes dynamic content (gitStatus, session-specific data) that changes on every resume, making the lock unable to match in practice. The `CACHE_FIX_PREFIX_LOCK` env var is now ignored.
- **Confirmed on v2.1.96** — Tested and verified against Claude Code v2.1.96.

## 1.2.1 (2026-04-08)

- **Removed prefix lock feature** — The prefix lock (`CACHE_FIX_PREFIX_LOCK`) has been removed. Testing revealed that the system prompt includes dynamic content (gitStatus, session-specific data) that changes on every resume, making the lock unable to match in practice. The feature never successfully fired in real cross-session usage. The `CACHE_FIX_PREFIX_LOCK` env var is now ignored.

## 1.2.0 (2026-04-07)

- **Prefix lock content hash guard** — Additional safety guard hashes all non-system-reminder user content in messages[0]. Prevents prefix lock from firing if substantive context changed between sessions, even if the first 200 chars match.

## 1.1.0 (2026-04-07)

New features:

- **Image stripping from old tool results** — Base64 images from Read tool persist in conversation history and are sent on every subsequent API call (~62,500 tokens per 500KB image per turn). Set `CACHE_FIX_IMAGE_KEEP_LAST=N` to strip images from tool results older than N user turns. Only targets tool_result images; user-pasted images are preserved. (Default: 0 = disabled)
- **Prefix lock for resume cache hit** — Saves messages[0] content after all fixes are applied; replays it on resume to produce a byte-identical prefix and avoid a full cache rebuild. Five safety guards prevent stale or incorrect prefix replay. Set `CACHE_FIX_PREFIX_LOCK=1` to enable. (Default: 0 = disabled)
- **GrowthBook flag dump** — Logs cost/cache-relevant server-controlled flags (tengu_hawthorn_window, pewter_kestrel, slate_heron, etc.) from `~/.claude.json` on first API call when `CACHE_FIX_DEBUG=1`
- **Microcompact monitoring** — Detects `[Old tool result content cleared]` markers in outgoing messages and logs count. Warns when total tool result chars approach the 200K budget threshold
- **False rate limiter detection** — Logs when the client generates synthetic rate limit errors (`model: "<synthetic>"`) without making a real API call
- **Prefix snapshot diffing** — Set `CACHE_FIX_PREFIXDIFF=1` to capture and diff message prefix across process restarts for cache bust diagnosis

## 1.0.0 (2026-04-06)

Initial release. Fixes three prompt cache bugs in Claude Code (tested through v2.1.92):

- **Partial block scatter on resume** — Relocates attachment blocks (skills, MCP, deferred tools, hooks) back to `messages[0]` when they drift to later messages during `--resume`
- **Fingerprint instability** — Stabilizes the `cc_version` fingerprint by computing it from real user text instead of meta/attachment blocks
- **Non-deterministic tool ordering** — Sorts tool definitions alphabetically for consistent cache keys across turns
