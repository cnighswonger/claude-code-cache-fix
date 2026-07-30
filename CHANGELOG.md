# Changelog

## [Unreleased]

### Fixed

- **`--remote-control` no longer clobbers another component's `NODE_EXTRA_CA_CERTS`.** That variable takes exactly one file, so on a host where something else also MITMs `api.anthropic.com` (a corporate agent, an account-pinning proxy) the last writer won and every other CA was silently untrusted — measured breaking Remote Control inbound. The launcher now publishes its own CA to `${CLAUDE_CONFIG_DIR:-~/.claude}/ca-trust.d/ccf.pem` (own filename only, never a sibling's, rewritten every launch, atomically via temp + `rename`) and reads a merged `ca-trust.pem` if one exists. It never writes the merged bundle: merging needs ambient corporate-root discovery, which is environment-specific and belongs outside this repo. The bundle is used only when every PEM block in it parses **and** one of them is our own CA (compared by DER) — a bundle that is torn or predates our publish is worse than none, since it makes the client distrust the very proxy it is routed through. On a host with no other MITM and no bundle, behavior is byte-identical to before. New opt-in env var: `CACHE_FIX_CA_TRUST_DIR`. See [Coexisting with another MITM](README.md#coexisting-with-another-mitm-on-the-same-machine-ca-trustd).

### Documentation

- **`CACHE_FIX_DOWNLOAD_REWRITE=on` disables `claude update` entirely**, which the flag's name does not suggest. Rewriting a download URL requires MITM-ing `downloads.claude.ai`, whose release client pins public roots only, so the version check fails before anything downloads. It cannot be narrowed to the binary path (MITM is decided per host at `CONNECT`, and the version check shares the host) and no client-side override reaches that client. Documented with the measurement in the README.

## [4.3.0] - 2026-07-17

Headline: **Remote Control works through the proxy.** Claude Code ≥ 2.1.196 disables Remote Control / mobile session visibility (and `/schedule`, claude.ai MCP connectors) whenever `ANTHROPIC_BASE_URL` is set — which is exactly how reverse-proxy mode routes the client. This release adds an opt-in **forward-proxy mode** that keeps the client first-party (`ANTHROPIC_BASE_URL` unset, `HTTPS_PROXY` set) so those features keep working while the proxy still sees and transforms `/v1/messages`. All changes are additive and backward-compatible; every new mode is opt-in and defaults are unchanged.

### Added

- **Opt-in forward-proxy mode ([#251](https://github.com/cnighswonger/claude-code-cache-fix/pull/251), implements [#248](https://github.com/cnighswonger/claude-code-cache-fix/issues/248); contributed by [@codeslake](https://github.com/codeslake)).** With `CACHE_FIX_FORWARD_PROXY=on`, the proxy also handles HTTP `CONNECT` and MITMs **only** the upstream host (`api.anthropic.com`) with a locally-generated CA, terminating TLS so the same extension pipeline runs, and **blind-tunnels every other CONNECT** (mcp-proxy, telemetry, npm, …) untouched. The client wires `HTTPS_PROXY` at the proxy plus `NODE_EXTRA_CA_CERTS` at the generated CA, and leaves `ANTHROPIC_BASE_URL` unset — so Claude Code stays first-party and Remote Control / mobile session visibility keeps working. Non-`/v1/messages` paths (RC credential fetches, OAuth, `/api/*`) are relayed verbatim; WebSocket/Upgrade to the upstream host is relayed as-is. The CA is generated once under `${CLAUDE_CONFIG_DIR:-~/.claude}/cache-fix-ca/` (override `CACHE_FIX_CA_DIR`) with private keys at mode `0600`; generation is lock-serialized (pid-owned `.gen.lock`, reclaimed only if the owner is dead) and the leaf's key/cert pair is proven to match (SPKI compare) before it is served, so concurrent proxies sharing a CA dir can't publish a leaf that doesn't chain to the CA the client was told to trust. A failed attach (e.g. `openssl` missing) falls back to reverse-proxy behavior and `/health` reports the effective mode (`forward_proxy`). **Default OFF; reverse-proxy behavior is unchanged when the flag is unset.** New env vars, all opt-in: `CACHE_FIX_FORWARD_PROXY`, `CACHE_FIX_CA_DIR`, `CACHE_FIX_CA_FORCE_ROTATE`, `CACHE_FIX_CA_LOCK_WAIT_MS`, plus opt-in download-acceleration (`CACHE_FIX_DOWNLOAD_REWRITE`/`_BUCKET`/`_BINARY`). **Load-bearing** (TLS termination, MITM CA, credential-bearing wire path): reviewed by Codex and human lead, and validated end-to-end against a live session (Remote Control restored, phone connected). See the [Forward-proxy mode](README.md#forward-proxy-mode-keeps-remote-control-working) section of the README, which also documents the shared-service crash-semantics tradeoff.

- **`--remote-control` launcher flag ([#254](https://github.com/cnighswonger/claude-code-cache-fix/pull/254)).** `cache-fix-proxy --remote-control` is the one-command equivalent of the manual forward-proxy wiring: it spawns the proxy with `CACHE_FIX_FORWARD_PROXY=on`, waits for the CA, and launches `claude` with `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` set and `ANTHROPIC_BASE_URL` left unset. Without the flag the launcher stays in reverse-proxy mode (sets `ANTHROPIC_BASE_URL`), unchanged. The launcher resolves the CA path from the same inputs and precedence as the proxy (`CACHE_FIX_CA_DIR` first, then `CLAUDE_CONFIG_DIR`, then `~/.claude`). `cache-fix-proxy --help` documents two operator caveats found in live validation: Remote Control's trusted-device enrollment can need a few `/remote-control` retries on first connect (a Claude Code step that runs upstream, not a proxy failure), and enabling RC on an already-warm session costs a single one-time prompt-cache rebuild (RC adds an `anthropic-beta` the cache keys on) — launching with `--remote-control` from the start avoids that flip.

### Changed

- **Honor `CLAUDE_CONFIG_DIR` for all on-disk proxy state ([#246](https://github.com/cnighswonger/claude-code-cache-fix/pull/246); contributed by [@codeslake](https://github.com/codeslake)).** All on-disk proxy state (quota-status, usage.jsonl, session-mirrors, snapshots, OAuth/credential paths, the forward-proxy CA dir) now resolves under `CLAUDE_CONFIG_DIR` when set, via a single `claudeHome()` helper (`CLAUDE_CONFIG_DIR || ~/.claude`), matching how Claude Code itself relocates its config root. Previously these were hardcoded to `~/.claude`, so running one proxy per config dir made them clobber each other's `account.json` / credentials. Falls back to `~/.claude` when unset — no behavior change for the default single-config setup.

- **Statusline `ttl_tier` derived from the measured ephemeral split ([#252](https://github.com/cnighswonger/claude-code-cache-fix/pull/252), fixes [#247](https://github.com/cnighswonger/claude-code-cache-fix/issues/247); contributed by [@codeslake](https://github.com/codeslake)).** The statusline's cache-TTL indicator was guessed from `cache_read` presence (and hardcoded `ephemeral_5m = 0`), which mislabeled two real cases: a fresh 1h-cached prefix (`cache_read=0`) shown as `5m`, and a genuine 5m downgrade (`cache_read>0` with a 5m split) hidden as `1h`. It now reads the measured `usage.cache_creation.{ephemeral_1h,ephemeral_5m}_input_tokens` split when the API provides it, falling back to the old heuristic only when the split is absent. A mixed split is labeled by its dominant tier (so a 5m-dominant mixed response now correctly surfaces the red `TTL:5m` warning). No output-schema change; the statusline consumes the same `ttl_tier` field.

### Fixed

- **Forward-proxy passthrough success-path is now traceable ([#253](https://github.com/cnighswonger/claude-code-cache-fix/issues/253)).** `handlePassthrough` logged only on error, so a successful RC-credential relay left no server-side trace. It now emits a `CACHE_FIX_DEBUG=1`-gated line (method + path + status only — no headers or body, since this path carries credentials), making forward-mode passthrough observable without a client in the loop. No-op unless debug logging is enabled.

## [4.2.1] - 2026-06-23

### Fixed

- **OAuth refresh narrowed token scopes, causing remote-bridge / code-session 401s (hotfix; affects v4.2.0 only when `CACHE_FIX_OAUTH_REFRESH=on`).** v4.2.0's proxy-owned OAuth refresher hardcoded the refresh-grant `scope` field to `user:inference user:profile`. Real Claude Code credentials hold a wider set (typically `user:file_upload user:inference user:mcp_servers user:profile user:sessions:claude_code`). When the proxy refreshed, the server happily issued the narrower token — `/v1/messages` kept working because it only needs `user:inference`, but **remote-bridge / code-session API calls 401'd because `user:sessions:claude_code` was missing from the rotated token**. Observed end-to-end on 2026-06-23: proxy refreshed at 17:48 UTC, remote-bridge sessions started returning 401 at 20:01 UTC, recovery required an interactive `/login`. The fix reads `claudeAiOauth.scopes` from the credential file inside the in-lock re-read and serializes them verbatim onto the refresh POST (space-separated per RFC 6749 §3.3), with dedupe + filter for malformed entries. `CACHE_FIX_OAUTH_SCOPE` env var is honored as an operator override; a `user:inference user:profile` fallback applies only when the credential file has no `scopes` array (unusual). 6 new regression tests assert scope round-trip, the load-bearing `user:sessions:claude_code` preservation, persisted-credential scope passthrough, env override, fallback, and dedupe behavior. The fix is purely additive to the refresh-POST body; `/v1/messages` upstream traffic was never affected. **Operators on v4.2.0 with `CACHE_FIX_OAUTH_REFRESH=on` should upgrade immediately** — the next proxy-initiated refresh will issue a token that does not work for remote bridges, even though local CC traffic continues.

## [4.2.0] - 2026-06-23

### Changed

- **`CACHE_FIX_USAGE_LOG_REQID` is now default-on; env-var becomes a kill-switch (#210 follow-up).** Per the v4.1.0 changelog's release-ordering contract, the flip waits until claude-meter ≥ v0.7.0 is published. With meter v0.7.0, v0.7.1, and v0.8.0 all on npm-latest, the precondition is met. v4.2.0 emits `request_id` on every `~/.claude/usage.jsonl` row by default (when the upstream `request-id` response header is present and ≤ 64 chars). `CACHE_FIX_USAGE_LOG_REQID=off` now omits the field — the env-var is repurposed as a kill-switch for operators stuck on a pre-v0.7.0 meter install. Schema stays at `v: 1` (pure semantic flip; field shape unchanged). **Upgrade requirement:** operators running cache-fix v4.2.0 + claude-meter < v0.7.0 will see every meter row rejected by the strict-object validator until they either upgrade meter or set `CACHE_FIX_USAGE_LOG_REQID=off`. See [`docs/directives/proxy-usage-log-request-id.md`](docs/directives/proxy-usage-log-request-id.md) for the original release-ordering contract.

### Added

- **Proxy-owned OAuth refresh ([#234](https://github.com/cnighswonger/claude-code-cache-fix/issues/234), directive [#236](https://github.com/cnighswonger/claude-code-cache-fix/pull/236), implementation [#237](https://github.com/cnighswonger/claude-code-cache-fix/pull/237)).** Default-OFF subsystem that makes the cache-fix proxy the single, proactive, lock-cooperative refresher of the OAuth credential shared by all concurrent Claude Code clients running as the same OS user. Closes the refresh-token rotation race that revokes the whole token family and 401s the entire fleet at once — a failure no client-side restart can recover (only an interactive `/login`). Acquires the **same `~/.claude/.oauth_refresh.lock`** the client uses via `proper-lockfile` with `realpath:false` and `stale:10000` to guarantee mutual exclusion against waking clients. New §2a contract: the refresh POST has a hard `CACHE_FIX_OAUTH_POST_TIMEOUT_MS` deadline (default 8000 ms, strictly below the client's 10000 ms stale-break window) covering BOTH the headers AND the response body read; on timeout the outcome is **UNKNOWN** → no credential write, no retry, distinct `oauth_refresh_timeout` event, back off ≥ one stale window. Atomic persist: temp-write (mode 0600) + fsync FD + rename + fsync parent dir, preserving every other credential field. Validation gates on every read: not a symlink, mode 0600, owner-matches-uid, JSON-shape valid; per-failure distinct event. Seven distinct event classes in `~/.claude/cache-fix-oauth-events.jsonl`: `oauth_refreshed`, `oauth_family_revoked` (distinct loud event + stderr banner for the unrecoverable case), `oauth_refresh_timeout`, `oauth_refresh_error`, `oauth_refresh_skipped`, `oauth_lock_contended`, `oauth_cred_*` validation events. Threat-model discipline: token material is constructed-into-non-existence on the event path — events carry only `{event, outcome, status_code, expires_at, err_class, elapsed_ms}`, never the token strings, never the raw POST body, never the raw token-endpoint response body. Adds `proper-lockfile` as a runtime dependency. Default OFF via `CACHE_FIX_OAUTH_REFRESH=on`; inert until an operator deliberately enables it and restarts the proxy. Backout is gate-off + restart. See [`docs/directives/proxy-owned-oauth-refresh.md`](docs/directives/proxy-owned-oauth-refresh.md) for the full contract + the binary-forensics-corrected root cause (CC 2.1.148 has a lock; the lock has a 10 s stale-break hole; proxy refresh sits inside the hole to win the race by timing AND by holding the same lock).

- **`cc-version-normalize` extension ([#238](https://github.com/cnighswonger/claude-code-cache-fix/issues/238), [#239](https://github.com/cnighswonger/claude-code-cache-fix/pull/239)).** Default-off opt-in that rewrites the `cc_version` value inside the `x-anthropic-billing-header` of the system prompt to prevent per-build cache invalidation. Some Claude Code distribution channels (notably the VS Code extension under auto-update) emit `cc_version` with a trailing per-build hash segment on top of MAJOR.MINOR.PATCH, e.g. `2.1.185.<buildhash>`. That value lives inside the cacheable prefix, so when the build-hash mutates mid-session (binary auto-updates between turns), every subsequent turn pays full `cache_creation` cost until the suffix stabilizes — Anthropic's prefix cache is byte-exact and the field is in scope. Existing `fingerprint-strip` does NOT cover this case: it only rewrites suffixes whose value matches a CC-generated fingerprint of the user message text, so a binary build-hash fails verification and the extension returns null without rewriting. The new extension runs at order 90 (before `fingerprint-strip` at 100), produces a 3-segment version, and `fingerprint-strip`'s `dotParts.length < 4` guard then makes it a no-op — the two cooperate cleanly. Three modes via `CACHE_FIX_NORMALIZE_CC_VERSION`: `off` (default), `strip` (collapses `cc_version=X.Y.Z(.suffix)+` to `cc_version=X.Y.Z`), `pin:<value>` (replaces with operator literal; useful for fleets that want one stable identifier across all clients). Field-boundary anchored regex `(^|[;\s:])cc_version=([^;\s]+)` so a `cc_version=` substring embedded in another field's value cannot be accidentally rewritten. Pin-value validation `^[A-Za-z0-9.\-]+$` (max 64 chars) so semicolons/equals/whitespace fail-open to off with a one-shot stderr warning rather than mutating the body. Atomic fail-open: planned rewrites stage in a local array and apply only after the scan completes; any error during the scan leaves the body byte-intact. Surfaced by [@X-15](https://github.com/X-15) running cache-fix v4.1.0 — the existing `prefix-diff` extension correctly flagged the mutation but the proxy had no mitigation path until this. The design contract is in the issue body of [#238](https://github.com/cnighswonger/claude-code-cache-fix/issues/238); no separate directive document was authored.

- **`upstream-error-log` extension ([#235](https://github.com/cnighswonger/claude-code-cache-fix/issues/235), [#240](https://github.com/cnighswonger/claude-code-cache-fix/pull/240)).** Default-off opt-in that emits a structured JSONL record for every non-200 upstream response to `~/.claude/usage-log/upstream-errors.jsonl`. The existing `usage-log` only records successful (200) responses; non-200 responses (429 capacity throttling, 5xx errors) leave only an unstructured line in the debug log, so server-side throttling has been effectively invisible to any analysis built on the usage stream. Two distinct 429 classes that look identical to a user: **account/usage-limit** carries `anthropic-ratelimit-unified-*` headers + `retry-after`; **infrastructure/capacity** is Cloudflare-fronted, carries `x-should-retry: true` only, NO ratelimit headers (the "Server is temporarily limiting requests, not your usage limit" case). The load-bearing discriminator is `has_ratelimit_headers` (bool): with headers → usage limit; without → capacity event. SUPERSET of the existing `rate-limit-log` extension — `rate-limit-log` triggers only on the canonical `rate_limit_error` body envelope and misses capacity-class 429s whose body shape differs; `upstream-error-log` triggers on every `status >= 400` regardless of body shape. Independent JSONL streams (`upstream-errors.jsonl` vs `rate-limit-events.jsonl`); analysts join on `session_id + ts`. Hook is `onResponseStart`, not `onResponse` — `onResponse` only fires when the proxy successfully JSON-parses the response body, and many non-200 responses (especially Cloudflare-level errors) return HTML or empty bodies that fail to parse. Record fields: `schema_version`, `ts`, `type`, `session_id`, `requested_model`, `request_path`, `response_status`, `upstream_message`, `has_ratelimit_headers`, `ratelimit_status`, `ratelimit_overage_status`, `x_should_retry` (normalized to bool from string), `retry_after`, `upstream_request_id`, `upstream_connection_id`. Default OFF via `CACHE_FIX_UPSTREAM_ERROR_LOG=on`. Override the log path via `CACHE_FIX_UPSTREAM_ERROR_LOG_PATH`.

- **`workflow-agent-id-synthesis` extension ([#215](https://github.com/cnighswonger/claude-code-cache-fix/issues/215), refs upstream [anthropics/claude-code#66761](https://github.com/anthropics/claude-code/issues/66761)).** Closes the per-Workflow-leg cost-attribution gap that CC#66761 left open: CC sets `x-claude-code-agent-id` on Task/Agent-tool subagents but not on Workflow-tool–spawned subagents (`agent()` / `parallel()` / `pipeline()`), so fan-out workflows are indistinguishable from the parent conversation's traffic at the proxy. The new extension stashes a normalized `ctx.meta._workflowAgentId = { id, parentId, source }` on `onRequest` covering three states: **canonical present** (Task subagent — pass-through with `source: "cc_header"`), **derived** (Workflow subagent — `sha256(sessionId + markerId + sha256(first-user-message text))[:16]` with `source: "cache_fix_derived"`), and **neither** (top-level traffic — no stash). **Per-leg discriminator binary-inspection finding**: CC's workflow factory keeps every per-leg distinguishing field (CC's internal `agentId` UUID, `agentType`, `spawnedByWorkflowRunId`, workflow phase index) in IN-PROCESS state, not in the wire request body — the Anthropic Messages API has no slots for them. From the proxy's wire vantage, the **only Workflow-distinguishing content the wire carries is the system-prompt marker (used for detection) and the user-supplied `agent(prompt)` argument**. The first-user-message text digest is the only stable, leg-distinct, retry-deterministic discriminator available. **Known limitation**: a `parallel()` fan-out where every leg passes the SAME prompt collides on the discriminator — operators get one bucketed id rather than wrong attribution. Identical-prompt fan-out is uncommon (the canonical pattern is "do thing X to file Y", "do thing X to file Z", ...); when it happens, the `cache_fix_derived` source flag tells dashboards the attribution is heuristic. The derived ids are **proxy-only attribution keys**; nothing this extension produces reaches Anthropic upstream. **Detection** requires the conjunction of session-id present, canonical agent-id absent, AND a position-anchored match against the binary-verified marker catalog at `proxy/workflow-markers.mjs` (seeded from CC 2.1.177 sha256 `ff41753634b20c869ef6a32a20863521b33d4186ac0d6a49379ab48a48395ee7`). **Drift canary**: when the first two conditions hold but no marker matches, a throttled `agent_id_source: "drift_canary"` event is written to `~/.claude/workflow-derivation-events.jsonl` (5 MB single-tier rotation) — the early warning that a new CC release has shifted the marker text. **Tools-list churn invariance**: the derived id never includes `tools[*]`, so a `deferred-tools-restore` MCP reconnect race cannot split one leg's traffic across two ids. `usage-log.mjs` reads `ctx.meta._workflowAgentId` and emits `agent_id` + `agent_id_source` on its row when **`CACHE_FIX_USAGE_LOG_AGENT_ID=on`**. **Cross-repo contract**: `claude-code-meter >= 0.8.0` accepts these fields; older meter installs reject rows that carry them — the env-var is the operator's attestation of meter v0.8.0+, NOT a runtime version probe. Setting it against meter v0.7.x produces rows the strict-object schema rejects (visible symptom: nonzero `skipped=` counter on `claude-meter ingest` tick output; logged under `CLAUDE_METER_DEBUG=1`). Master switch: **`CACHE_FIX_WORKFLOW_AGENT_DERIVATION=off`** disables the extension entirely. Default-off `CACHE_FIX_USAGE_LOG_AGENT_ID` in v4.2.0 first ship per the established `request_id` rollout precedent (cache-fix v4.1.0 → v4.2.0); the v4.3.0 default-on flip is gated on a sim-validation precondition against a v0.8.0 meter install on real Workflow fan-out traffic. The directive frames this as **derived-not-authoritative**: when CC eventually backfills the canonical header upstream, the `canonical_present` branch fires first and the derivation path goes inert without migration. See [`docs/directives/proxy-workflow-agent-id-synthesis.md`](docs/directives/proxy-workflow-agent-id-synthesis.md) and companion meter PR [cnighswonger/claude-code-meter#31](https://github.com/cnighswonger/claude-code-meter/pull/31).

- **Statusline served-model divergence indicator ([#223](https://github.com/cnighswonger/claude-code-cache-fix/issues/223), refs upstream [anthropics/claude-code#66728](https://github.com/anthropics/claude-code/issues/66728)).** First real-time operator surface for the classifier-driven swap pattern documented in CC#66728. `proxy/extensions/cache-telemetry.mjs` now captures `event.message.model` on `message_start` and compares it against `ctx.telemetry.requestedModel` on `message_delta`, persisting `requested_model` / `served_model` / `model_divergence_recent` / `model_divergence_sticky` / `model_divergence_first_seen` to the per-session JSON when the pair diverges. `tools/quota-statusline.sh` renders the indicator after the existing TTL block: red `requested → served` for a recent divergence, black-on-yellow for sticky state, no extra label segment on matched turns. **Sticky heuristic is family-aware**: cross-family swap (Fable→Opus, Sonnet→Haiku) latches sticky immediately; same-family swap (Opus 4.7→Opus 4.8) requires 3 consecutive divergent turns at the same `(requestedModel, servedModel)` pair. Counter state is keyed by `(sessionFilename, requestedModel)` so interleaved background utility calls (haiku title-generation, etc.) at a different requested model do not pollute the main-model counter. Sticky survives proxy restart for the currently-active pair via rehydration from the persisted JSON, **guarded on `requested_model` equality** so the persisted single-record cannot leak sticky into a different pair after a `/model` change. The `[1m]` suffix renders on the **requested side only** (the proxy has no signal for served-side 1m context). The family map is the only piece of business logic that needs to update when Anthropic ships new models. **Operator note:** clearing sticky requires removing the persisted per-session JSON **AND** evicting the in-memory map entry (restart, time-based sweep, or new session). File deletion alone does not work — the map will re-emit the persisted fields on the next turn. See [`docs/directives/proxy-statusline-served-model-divergence.md`](docs/directives/proxy-statusline-served-model-divergence.md) for the full design.

- **`image-retry-circuit-breaker` extension ([#217](https://github.com/cnighswonger/claude-code-cache-fix/issues/217), refs upstream [anthropics/claude-code#66815](https://github.com/anthropics/claude-code/issues/66815)).** Short-circuits the CC harness retry storm on permanent `image could not be processed` failures. When the same session retries with the same image content (SHA-256 of decoded bytes) within a 30s sliding cool-off window, the proxy returns a wire-format-correct synthesized response — SSE event sequence for `stream:true` requests, JSON envelope otherwise — so the harness consumes the failure as a normal completed turn instead of resubmitting full context 18 more times. Bounds the loss from CC#66815's reported pattern (19 retries × 34 MB of context tokens) to one upstream call. Default-off in v4.2.0 first ship via `CACHE_FIX_IMAGE_RETRY_BREAKER` env var (`on` / `off` / `dry-run`); tunables are `CACHE_FIX_IMAGE_RETRY_COOLOFF_MS` (default 30000) and `CACHE_FIX_IMAGE_RETRY_MAX_ENTRIES` (default 4096). Breaker fires write a structured JSONL event log at `~/.claude/image-retry-events.jsonl` (5 MB single-tier rotation); short-circuited requests bypass `usage-log` / `cache-telemetry` entirely (no row written — the JSONL event log is the sole observability surface). Carries `needs-sim-validation` as a merge gate per the wire-format dependency on real CC harness consumption. See [`docs/directives/proxy-image-retry-circuit-breaker.md`](docs/directives/proxy-image-retry-circuit-breaker.md) for the full design.

- **`tools/gh-auth-status-shim/` — contributed PATH-resolved `gh` wrapper (refs upstream [anthropics/claude-code#67055](https://github.com/anthropics/claude-code/issues/67055)).** Workaround — not a fix — for CC Desktop's false "GitHub CLI authentication expired" toast. CC Desktop's PR poller runs `gh auth status --hostname github.com` with a 5-second `timeoutMs` and maps **any** non-zero return (including the spawn timeout itself) to the `"auth"` toast category, producing repeated false toasts during Keychain slow-reads, network blips, and multi-agent CPU contention. The shim is a bash script named `gh` placed earlier on the user's PATH than the real `gh` binary; it intercepts `gh auth status` invocations, runs the real `gh` with a ~4s internal timeout (inside CC's 5s window), classifies the outcome, and returns exit 0 to suppress the false toast on transient/timeout signals while letting genuine expiry (`not logged in`, `HTTP 401`) propagate so CC's toast fires when it should. Every other `gh` subcommand passes through to the real binary unchanged via `exec`. Install via `tools/gh-auth-status-shim/install.sh` (default target `$HOME/.local/bin/gh`); uninstall via the matching script. bash 3.2 floor (runs on stock macOS); no GNU coreutils dependency; no `jq`. Known limitations called out at install time and in the README: (1) the shim rewrites `gh auth status` exit-code semantics for **every caller in this PATH scope**, including non-CC tools — documented behavioral-change disclosure, (2) on macOS, GUI apps inherit `launchd`'s PATH not the user's shell PATH, so the shim may be invisible to CC Desktop on macOS even if `which gh` shows it in the shell — macOS coverage is unverified pending external validator from the CC#67055 thread, (3) native Windows CC Desktop is NOT covered by a bash shim. Sunset plan: uninstall when CC#67055 closes with an upstream fix; see the "Sunset plan" section of [`tools/gh-auth-status-shim/README.md`](tools/gh-auth-status-shim/README.md). See [`docs/directives/tool-gh-auth-status-shim.md`](docs/directives/tool-gh-auth-status-shim.md) for the full design and the prototype-validation requirement.

- **`jsonl-session-mirror` extension (refs upstream [anthropics/claude-code#66734](https://github.com/anthropics/claude-code/issues/66734) and [anthropics/claude-code#66486](https://github.com/anthropics/claude-code/issues/66486)).** Belt-and-suspenders backup against CC's in-place transcript stub-rewrite (CC#66734) and missing-transcript regression (CC#66486). The proxy mirrors every assistant message + the tool results / user inputs it observes into a per-session JSONL file under user control, independent of CC's own transcript writer. CC's transcript remains canonical when it survives; the mirror is the user's recovery path when CC's transcript is lost. Storage root `~/.claude/session-mirrors/<sessionFilename(sessionId)>/<timestamp>.jsonl`. Envelope shape matches CC 2.1.148's verified transcript shape exactly so existing transcript readers (including `restore-claude-history-linux`) parse mirror files unchanged. The single distinguishing field is `source: "cache-fix-proxy-mirror"`. Read-only with respect to upstream traffic; no requests or responses modified. Default-off in v4.2.0 and v4.3.0 via `CACHE_FIX_SESSION_MIRROR=on` (privacy-posture change of flipping plaintext-conversation-persistence on-by-default belongs to its own future directive). Tunables: `CACHE_FIX_SESSION_MIRROR_DIR`, `CACHE_FIX_SESSION_MIRROR_MAX_BYTES` (default 100 MB), `CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS` (default 30), `CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS` (default 1024), `CACHE_FIX_SESSION_MIRROR_INCLUDE_THINKING` (default `true`). Operational events (open / rotate / sweep / error) logged to `~/.claude/session-mirrors/session-mirror-events.jsonl` (5 MB single-tier rotation). Three known limitations documented at write time: (1) `cwd` is `null` (proxy does not know caller working directory), (2) `uuid` is dash-formatted (`8-4-4-4-12`) but the version/variant bits are not RFC-valid — the bits encode `(sessionId, timestamp, messageId)` deterministically so the chain is reconstructable, (3) tool-result user records omit `toolUseResult` and `sourceToolAssistantUUID` (CC-internal enriched objects the proxy cannot reconstruct). Carries `needs-sim-validation` as a merge gate per the envelope-shape parity dependency. See [`docs/directives/proxy-jsonl-session-mirror.md`](docs/directives/proxy-jsonl-session-mirror.md) for the full design and [`docs/disk-usage.md`](docs/disk-usage.md) for the disk-footprint accounting.

## [4.1.0] - 2026-06-10

### Added

- **Optional `request_id` field on usage-log rows (#210).** Sources from the upstream `request-id` response header. Gated default-off via `CACHE_FIX_USAGE_LOG_REQID=on` for this release. When enabled, every `~/.claude/usage.jsonl` row gains the field, recovering per-CC-session attribution that the proxy-boot-sticky `sid` field alone cannot provide. The field is the natural post-hoc join key against CC's per-session JSONL transcripts at `~/.claude/projects/<project>/<session-uuid>.jsonl` (which already carry `requestId` for every API call). **Cross-repo contract:** `claude-code-meter >= v0.7.0` accepts the optional field; older meter installs reject unknown keys via the strict-object schema, hence the gate stays default-off in this release. The gate flips default-on in v4.2.0; operators upgrading to v4.2.0 must run claude-meter v0.7.0+. Schema stays at `v: 1` (pure addition; no consumer's reading of existing fields changes). See [`docs/directives/proxy-usage-log-request-id.md`](docs/directives/proxy-usage-log-request-id.md) for the full design and the release-ordering contract.
- **server.mjs debug logging (#190).** Opt-in per-request trace log via `CACHE_FIX_DEBUG=1`, written to `~/.claude/cache-fix-debug.log` (override path via `CACHE_FIX_DEBUG_LOG`). Captures route-level Claude → Proxy → Upstream traffic for operators debugging proxy behavior. Authorization / x-api-key / cookie / proxy-authorization headers are redacted at capture time (the log writer never touches raw header values). Dispatcher catches async handler rejections inside an awaited try/catch so promise rejections from `preForward()` or pipeline hooks no longer escape to `unhandledRejection`. The 500 fallback body is generic — no internal `error.message` echo. Contributed by [@nisqatsi](https://github.com/nisqatsi).
- **`tools/cache_analysis.py` reference helper (#138).** Python helper for reading the proxy's per-session quota-status files at `~/.claude/quota-status/sessions/<id>.json` (with v3.4.x fallback to `~/.claude/quota-status.json`). Now version-controlled in this repo and shipped via the existing `tools/` package.json entry. Closes part 1 of [`cnighswonger/claude-code-meter#22`](https://github.com/cnighswonger/claude-code-meter/issues/22) — the host-installed copy at `~/.claude/mcp/cache_analysis.py` had been silently returning `None` for 15 days post-v3.5.0 because the local helper lacked the new-path fallback.
- **install-service threads `CACHE_FIX_PROXY_CA_FILE` and `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED` to the rendered unit (#189).** Corp-proxy and custom-CA configurations now survive install-service round-trips on both systemd and launchd. Hardens the systemd `Environment=` value escape against `%` (specifier expansion) and `\` (C-string unescape), and the launchd plist value escape against all five XML entities. Contributed by [@nisqatsi](https://github.com/nisqatsi).

### Fixed

- **Preserve base-path component in upstream URL forming (#188).** Configurations that chain cache-fix-proxy through another reverse proxy that mounts the Anthropic API under a path prefix (e.g., `https://corp.example/api/anthropic/v1/messages`) now forward correctly. Previously, the proxy concatenated only the upstream host with the inbound path, dropping the base-path component. Adds a pure `buildUpstreamUrl(base, clientUrl)` helper with 8 regression cases (no-path, trailing-slash, mirror, multi-segment, query strings, http+port). Contributed by [@nisqatsi](https://github.com/nisqatsi).

### Documentation

- **Scrub npm token location, org name, and rotation cadence from public docs (#208).** `docs/release-workflow.md` step 8 previously named the on-disk token path, the `vsitsllc` npm org, and the 90-day rotation cadence — the combination narrowed an attacker's search surface. Replaced both load-bearing references with "internal deployment notes" placeholders per CLAUDE.md "Public-Repo Information Hygiene". The historical disclosure remains in immutable git history at the prior PR refs (cannot be retracted); this PR stops further on-main propagation.

## [4.0.0] - 2026-06-07

A major release because two long-standing defaults change. Both flips are backed by empirical data; both have explicit opt-out paths.

### Changed

- **`thinking-block-sanitize` v1 is now on by default (#162, #63147, #201).** Was opt-in via `CACHE_FIX_THINKING_SANITIZE=on` in v3.8.0–v3.9.x. Seven days of prod dogfood (2026-05-29 → 2026-06-05) across 37 sessions: zero `cannot be modified` 400s, cache hit-rate aggregate 94.66% vs. 92.44% baseline (no prefix degradation), sanitize fired on ~35% of sessions with ~800 blocks dropped per day, max 938K context healthy. Set `CACHE_FIX_THINKING_SANITIZE=off` to explicitly disable. Credit to [@yurukusa](https://github.com/yurukusa) for the [13E cluster taxonomy](https://yurukusa.github.io/cc-safe-setup/cluster-tracker.html#cluster-extended-thinking-wedge) and the [22:32 UTC 2026-05-29 synthesis comment](https://github.com/anthropics/claude-code/issues/63147#issuecomment-4580358273) on #63147 that made the v2 predicate (cache-fix #171) tractable.
- **In-process extension hot-reload is now off by default (#196, #198, #200).** Was on in v3.x. Set `CACHE_FIX_HOT_RELOAD=on` in the proxy's runtime environment (or in the install-service environment if using `cache-fix-proxy install-service`) to restore the prior behavior. Off-by-default eliminates the Node ESM stale-import race that silently broke `thinking-block-sanitize v2` for 17 hours after PR #192's merge — the watcher re-imports an extension whose transitive dependencies are already cached by Node's loader, and Node cannot evict cached transitive modules in-process. Cold starts are unaffected.
- **A supervisor-level proxy restart is now required after `npm install -g claude-code-cache-fix@4`** to pick up extension changes. See [Upgrading from v3.x](README.md#upgrading-from-v3x) for per-platform restart commands.
- **Embedder note (Bun hosts, DAP-style integrations using `createProxyServer()` / `startProxy()`).** v4.0.0 flips `CACHE_FIX_THINKING_SANITIZE` from default-off to default-on. The v1 omitted-text drop will run on every request body passing through the embedded proxy. If your host depends on the prior no-sanitization behavior (e.g., your downstream code expects empty `thinking` blocks to survive the proxy round-trip), set `CACHE_FIX_THINKING_SANITIZE=off` in the host environment, or `process.env.CACHE_FIX_THINKING_SANITIZE = "off"` in your code at any point before request handling (the mode is read per-request via `modeFromEnv()`, not cached at module load). The flip is backed by the same 7-day dogfood data above. See [PR #201](https://github.com/cnighswonger/claude-code-cache-fix/pull/201) and [#63147](https://github.com/anthropics/claude-code/issues/63147).

### Added

- **`thinking-block-sanitize` v2 — tools-hash-mismatch drop (opt-in, #171, #192).** A new mode of the sanitize extension that detects cross-request tools-surface change via a per-session tools-hash baseline and strips ALL prior-turn signed thinking (both `thinking` blocks with non-empty text AND `redacted_thinking` blocks) when the hash flips. Targets yurukusa's [13E (ToolSearch) sub-pattern](https://yurukusa.github.io/cc-safe-setup/cluster-tracker.html#cluster-extended-thinking-wedge) of [anthropics/claude-code#63147](https://github.com/anthropics/claude-code/issues/63147), where dynamically-loaded tools mid-conversation invalidate the prior assistant turn's thinking signature and produce a per-turn 400 + retry tax. **Opt-in via `CACHE_FIX_THINKING_SANITIZE=v2`** (a strict superset of `=on` — v2 mode also runs v1's omitted-text drop). Stays opt-in pending its own prod-dogfood window, now that #196 has closed the silent-load failure mode that prevented v2 from running in prior testing. New `proxy/extensions/signature-surface-hash.mjs` helper computes the deterministic 16-char sha256 hash over the canonicalized tools surface.
- **`/health` extension-load observability (#196, #197).** When an extension fails to import — including the Node ESM stale-import race that originally surfaced in #196 — every failure is recorded on the pipeline module and surfaced via `/health` as `503 + {status:"degraded", failed_extensions:[...], hint:"restart the proxy via your supervisor to recover..."}`. Healthy proxies still return `200 + {status:"ok"}`. Catches load failures within seconds of the bad import instead of leaving the operator to grep the journal. New `getFailedExtensions()` export on `proxy/pipeline.mjs` for any other operator-facing tool that wants to surface the same state.

## [3.9.0] - 2026-06-03

Two upstream-CC-bug workarounds routed through our new cc-triage pipeline: **`auto-1m-guard`** (proxy extension, the *intercept* side) for the auto-1M-context overage case (upstream `anthropics/claude-code#64919`), and **`worktree-edit-guard`** (client-side hook, the *boundary-enforcement* side) for the worktree parent-checkout corruption case (upstream `anthropics/claude-code#59628`).

### Added

- **`auto-1m-guard` proxy extension (#179, #185, #186) — addresses CC#64919.** Detects the `context-1m-2025-08-07` token on the outbound `anthropic-beta` request header and either annotates the session JSON (warn) or removes the token before forwarding (strip), depending on the mode. Three modes via `CACHE_FIX_AUTO_1M_GUARD`: `off`, `warn` (default — annotation + stderr log line, no request mutation), `strip` (opt-in — additionally removes the token, defensive against duplicates, rejoins remaining tokens with the CC-canonical `, ` separator). Order 520 (between `ttl-management` and `thinking-block-sanitize`). Annotation flows through `ctx.meta._auto1mGuard` with fields `auto_1m_detected` / `auto_1m_action` / `auto_1m_advice`, spread top-level into the per-session JSON by `cache-telemetry`. Header read is case-insensitive and whitespace-tolerant (mirrors `proxy/extensions/upstream-change-detection.mjs:200-207`).

  **Why the proxy, not the CC env var.** CC's `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` env var disables the entire 1M-context path when it reaches the CC process, but on the VS Code Extension surface it's reportedly unreliable (the extension doesn't always propagate the env var to the spawned CC process). The proxy intercept acts on the outbound wire regardless of which CC launcher produced the request.

  **Binary-walk in the directive established the wire signal.** Verified against CC v2.1.148 AND v2.1.161 (same code body, minified identifiers churn): CC sanitizes the `[1m]` suffix from `req.body.model` via the model sanitizer (`sL` in v2.1.148 / `kJ` in v2.1.161) at every `messages.create` call site BEFORE the request leaves. So the proxy-visible signal is the `anthropic-beta` header token (`context-1m-2025-08-07`), not the model field. The 1M-beta gate (`W2` / `bZ`) keys on `/\[1m\]/i.test(model)` against the internal model string; the kill switch (`xKH` / `E9H`) reads `process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT`. See [`docs/directives/proxy-auto-1m-guard.md`](docs/directives/proxy-auto-1m-guard.md) for the full binary references and a name-translation table for future re-verifications.

  **Out of scope for v1.** No subscription-tier classification (cache-fix has no `subscription_tier` field today; the original sketch's "if Pro" conditional is unimplementable without separate infrastructure); the directive replaces it with explicit user opt-in (`warn` default, `strip` explicit). No `[2m]` / `context-2m-*` handling (the model sanitizer covers `[2m]` but no active gate exists in the binary yet — revisit if 2M ships). No SessionStart hook complement (different surface; out of scope here).

- **`worktree-edit-guard` PreToolUse hook (#182, #183, #184) — addresses CC#59628.** New shipped example under `hooks/examples/worktree-edit-guard.py` plus an install + behavior doc at `docs/hooks/worktree-edit-guard.md` and a `hooks/README.md` landing page. Independent of the proxy — pure client-side hook that users install by pointing at it from their own `~/.claude/settings.json` (`PreToolUse` event, matcher `Edit|Write|MultiEdit|NotebookEdit`). Blocks tool calls whose realpath'd target falls outside the active git worktree, addressing the upstream-documented data-loss case where worktree sessions can dirty the parent main checkout's branch with no guardrail.

  **Containment shape.** Strict-containment via realpath comparison (rejects any target outside the worktree, including extra writable directories opted in via `--add-dir` — the directive blesses this incompatibility as the deliberate tradeoff). Worktree detection is depth-stable: compares the realpaths of `git rev-parse --git-dir` and `git rev-parse --git-common-dir` (they match in a regular checkout from any depth and differ inside a linked worktree), so the hook is safe to install globally and is a no-op outside worktrees. Symlink-escape is covered for both existing targets (direct `realpath`) and not-yet-existing targets (parent-dir realpath catches a symlinked parent). CC's `PreToolUse` blocking contract: `exit 2` with stderr feedback to the agent.

  **Per-tool path field**: `file_path` for `Edit` / `Write` / `MultiEdit`, `notebook_path` for `NotebookEdit`. Posture: fail-open on environmental failures (git timeout, malformed stdin, not-in-a-git-repo), fail-closed on protocol-shape mismatches (missing expected path field on an in-scope tool — stderr names the missing field).

  **Real load-bearing bug caught during review.** Codex's implementation review flagged that the initial `resolved_target()` always used parent-dir realpath + basename, which let an existing symlink-file target resolve back to itself instead of its destination — a silent symlink-escape bypass. Fix uses `os.path.lexists(target)` to detect whether the target exists (including as a symlink or broken symlink) and realpath the target directly when it does; parent-dir reconstruction is reserved for the not-yet-existing case.

- **`ctx.meta._auto1mGuard` session-JSON annotation channel** (additive). `~/.claude/quota-status/sessions/<id>.json` now also carries `auto_1m_detected`, `auto_1m_action`, and `auto_1m_advice` when the `auto-1m-guard` extension fires. Fields are written by the existing single per-session writer (`cache-telemetry`); existing consumers are unaffected (all use optional reads). Field absent when the extension is `off`, the outbound request had no `context-1m-2025-08-07` token, or the request had no `anthropic-beta` header at all.

### Changed

- **`tools/manual-compact.sh`: Opus summarizer + relaxed recent-turn truncation (#169).** The manual-compaction dev tool now defaults to `claude-opus-4-7` (was `claude-sonnet-4-6`), overridable via `MANUAL_COMPACT_MODEL`, and keeps more per-turn detail in the extract (active turns 2000→8000 chars, working 400→1500, foundational 200→300) for higher-fidelity summaries. Doc adds a troubleshooting note for the oversized-extract / empty-output case (use a `[1m]`-window model or lower the caps). Includes a `Limitations` subsection documenting CC's `cleanupPeriodDays`-driven transcript sweep (#62272) so manual-compact users planning to keep the on-disk JSONL as a "just in case" backup understand the retention window.

- **`statusline`: round bar tick like fill (#155, schuay).** `draw_bar` previously rounded the fill but truncated the tick. With `consumed=15%` and `elapsed=19.6%` that gave `fill=2` and `tick=1`, placing the tick inside the filled run — the visual reserved for over-pace. Both are now rounded symmetrically; monotonicity keeps the tick at-or-past the fill whenever `consumed <= elapsed`. Community contribution; thanks @schuay.

- **README (zh) refreshed to match the latest English (#178).** Translation regenerated and reviewed section-by-section against the English source. Includes the proxy extensions pipeline, `bootstrap-defense`, image-guard pipeline, cache breakpoints, microcompact stability, thinking-summaries / session-health / thinking-block-sanitize, and the v3.5.0+ per-session quota-status migration.

### Tests

927 → 950 (+23): the `auto-1m-guard` integration + helper suite (23 cases — three-mode integration over the directive's test matrix plus pure-helper unit tests for `findBetaHeader`, `parseBetaTokens`, `planSanitizeBetaHeader`, `joinBetaTokens`; defensive coverage of duplicate-token strip semantics, single-element header → empty string, case-insensitive header lookup, and whitespace-tolerant detection). The `worktree-edit-guard` hook tests (20 cases, also new) live as a separate top-level suite — covering in-tree allow, parent-checkout block, totally-out-of-tree block, target-symlink-escape block, parent-symlink-escape block (not-yet-existing case), MultiEdit single-file shape, NotebookEdit `notebook_path` shape, schema-drift fail-closed cases for both `Edit` and `NotebookEdit`, regular-checkout pass-through both at the repo root AND from a nested subdirectory (validates the realpath-equality detection rule), non-git-repo pass-through, deterministic `git` timeout via PATH shim, relative-path fallback, and out-of-scope `Read` pass-through.

### Notes

- **New `hooks/` directory ships in the npm tarball.** v3.9.0 adds `hooks/` to the npm `files` allowlist so users installing via npm get `hooks/examples/worktree-edit-guard.py` and `hooks/README.md` locally. The script's absolute path (used in the `command` field of the `PreToolUse` hook config) for an npm install is `<npm-prefix>/lib/node_modules/claude-code-cache-fix/hooks/examples/worktree-edit-guard.py` — see [`docs/hooks/worktree-edit-guard.md`](docs/hooks/worktree-edit-guard.md) for the full install snippet.

- **First release routed through cc-triage.** Both v3.9.0 features came in via a new daily LLM-classified upstream-CC-issue queue (internal tooling; see internal deployment notes), then through standard cache-fix tracking issues and the directive → implementation review workflow. AITL surfaces the issues from the queue; Proxy Builder does the implementation; Codex reviews; Lead + Chris human review for load-bearing items (per CLAUDE.md). Both v3.9.0 PRs were classified load-bearing — `auto-1m-guard` for modifying outbound wire bytes with billing implications, `worktree-edit-guard` for being a filesystem-boundary enforcement control whose threat model centers on symlink escape.

## [3.8.0] - 2026-05-29

The thinking-desync response (upstream `anthropics/claude-code#63147`): the *warn-before* half (session-health, #160) and the *mitigate* half (thinking-block-sanitize, #162), plus the `ttl-management` thinking-block guard (#157/#159).

### Added

- **session-health early-warning extension (#158, #160).** A new read-only observation extension (`proxy/extensions/session-health.mjs`, order 590) that flags long-running Opus 4.7 `[1m]` sessions approaching the thinking-desync wedge (upstream `anthropics/claude-code#63147`) before they die. It never mutates the request/response body and never attempts to repair the desync — it only warns so the operator can retire the session deliberately. This is the *warn-before* half of the thinking-desync response; mitigation (#162) and offline heal are tracked separately.

  **New per-session JSON fields (additive).** `~/.claude/quota-status/sessions/<id>.json` now also carries `context_tokens` (latest live context = `input + cache_read + cache_creation`), `thinking_block_count` (`thinking`/`redacted_thinking` blocks in the latest request), `thinking_block_max` (session high-water, carried across proxy restarts), `first_seen`, `request_count`, and `thinking_desync_risk` (`ok`/`warn`/`high`). Fields are written by the existing single per-session writer (`cache-telemetry`); existing consumers are unaffected (all use optional reads). Counts only — no thinking text or signatures are ever recorded.

  **Token-gated warning.** `thinking_desync_risk` is computed from `context_tokens` against `CACHE_FIX_THINKING_RISK_HIGH_TOKENS` (default `340000`, just under the observed ~382K trip) and `CACHE_FIX_THINKING_RISK_WARN_TOKENS` (default `250000`). On first crossing into `high`, a one-time content-free stderr line is emitted. Block-count is recorded but does not yet gate the warning (calibrated fast-follow). `CACHE_FIX_THINKING_RISK=off` suppresses the warning signal (stderr line + risk field) while raw count telemetry keeps recording.

- **thinking-block-sanitize mitigation extension (#162), opt-in.** A new request-path extension (`proxy/extensions/thinking-block-sanitize.mjs`, order 550) that drops the *omitted* (`thinking:""` + signature) extended-thinking blocks CC re-sends on history-replay paths, before the request is forwarded — heading off the permanent `400 ... thinking blocks ... cannot be modified` wedge (upstream `anthropics/claude-code#63147`). This is the *mitigate* half (the *warn-before* half is session-health above). **Opt-in:** only runs when `CACHE_FIX_THINKING_SANITIZE=on` (default off) — it mutates request bodies and full live-coverage validation is pending.

  **Turn-selection rule (empirically resolved).** Drops omitted thinking from all prior assistant turns **and** the latest assistant turn — *unless* the latest turn is an active tool-continuation (its last block is a `tool_use` with a following `tool_result`), where the API requires the signed thinking intact and the proxy must not strip it (that case is uncoverable here — no env var both preserves thinking and avoids the wedge; `CLAUDE_CODE_DISABLE_THINKING=1`/`MAX_THINKING_TOKENS=0` stop it only by disabling thinking entirely, `DISABLE_INTERLEAVED_THINKING=1` does not stop the 400, so the answer there is heal/retire). Never touches non-empty thinking; `redacted_thinking` is out of scope for v1 (a full scan of the worst-case wedged transcript found zero). Deterministic and cache-prefix-stable. Emits a per-request `thinking_blocks_dropped` count into the per-session JSON (counts only — never content), via the existing `cache-telemetry` writer.

### Fixed

- **`ttl-management`: never inject a TTL into `thinking` / `redacted_thinking` blocks (#157).** `injectTtl` iterated every block in the request; if a `cache_control: {type: "ephemeral"}` breakpoint landed on a thinking block (possible on Opus 4.7 interleaved-thinking turns), it rewrote the block to add `ttl`, which mutates a signed thinking block — the API rejects that with `400 ... thinking blocks ... cannot be modified`. The injector now skips `thinking`/`redacted_thinking` blocks entirely (the chokepoint covers both the system-block and message-block paths). Defensive hardening: this was not the cause of the 2026-05-28 interleaved-thinking incident (that was CC-side, `anthropics/claude-code#63172`), but it's a real latent mutation path with zero upside to keeping. Regression tests pin the skip and the still-inject-on-non-thinking happy path.

## [3.7.1] - 2026-05-27

### Added

- **bootstrap-defense extended to the env-var-selected GrowthBook prompt-injection surface (#153, #154).** Claude Code v2.1.152 (shipped 2026-05-27) added a new consumer pattern over the existing `/api/claude_cli/bootstrap` response body: in remote-control mode (`CLAUDE_CODE_REMOTE` set), the env var `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE` selects a GrowthBook flag key whose cached value is used as the agent's system prompt body. Same delivery channel as v3.7.0's `tengu_heron_brook` heron-brook surface, new key-selection layer over the same payload. v3.7.0 audited the legacy surface only; v3.7.1 closes the gap by auditing both.

  **New audit-log fields (schema v1 → v2).** Each `~/.claude/cache-fix-bootstrap-log.jsonl` record now carries `surface` (`"bootstrap"` | `"prompt_injection_gb"`), `prompt_key` (the key read as the prompt source, or null), `prompt_value_hash` (SHA-256 of the value, first 16 hex chars — never the value itself), `remote_mode` (whether `CLAUDE_CODE_REMOTE` is set), and `stripped_keys` (which keys allowlist mode removed from the response body, empty otherwise). Existing v1 readers see all v1 fields unchanged; new fields default to null/empty for the legacy no-injection-detected case. Multi-surface responses (both keys present, including env-var-aliases-legacy-key) emit one record per surface, correlated by `request_id` + timestamp window.

  **New `allowlist` mode** alongside the existing `audit` (default) and `block` modes. Set `CACHE_FIX_BOOTSTRAP_MODE=allowlist` to deny-by-default for prompt-source-eligible keys, allowlist-overridable via `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=comma,separated,list`. Default allowlist is `tengu_heron_brook` (the only known-legitimate historical key); pass `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=` (explicit empty) for full deny-all. Allowlist mode strips non-allowlisted prompt-source keys from the response body before returning it to CC; other GrowthBook flag keys pass through untouched. Documented as experimental — may need updates if Anthropic adds legitimate prompt-source keys in future CC releases.

  **Default behavior unchanged.** v3.7.0 → v3.7.1 is a patch release; existing users running `bootstrap-defense` in audit mode get expanded coverage for the new surface, not a new behavior class. `block` mode semantics are unchanged (empty 200 from onRequest still defeats both surfaces by preventing any flag map from reaching the on-disk GrowthBook cache).

  **Out of scope for v3.7.1.** Stale on-disk GrowthBook cache reuse — if CC reads a flag value cached from a prior bootstrap fetch that didn't pass through this proxy run, v3.7.1 will not emit a fresh audit record for that session. Users wanting belt-and-suspenders should use `block` or `allowlist` mode, which prevent new injection-class keys from reaching the cache going forward. Granular `block` mode (parse-strip-reserialize as the default block) and content-pattern key filtering are deferred to v3.8.0+.

### Tests

850 → 871 (+21): bootstrap-defense surface-detection suite (cases 1–6 audit-mode surface fires, alias case 3a preserving operator-visibility signal with same-key-different-surface emission); allowlist-mode suite (cases 8–12 plus alias case 13); hash-derivation pin (fixture against silent refactor drift); empty-string env-var truthiness pin (4 cases asserting `CLAUDE_CODE_REMOTE=""` and `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE=""` are treated as unset, plus inverse non-empty assertions); integration case 14 in `test/proxy-server-bootstrap.test.mjs` proving `ctx.body` mutation flows end-to-end through `JSON.stringify(resCtx.body)` serialization back to the client; integration case 14b proving audit-mode multi-surface emission produces two correlated records end-to-end through `handleBootstrap`.

### Release tests

Docker smoke test (`docs/release-tests/v3.7.1-docker-smoke-2026-05-27.md`): five-section validation of the v3.7.1 build in a `node:22-alpine` container against a stubbed bootstrap upstream. Covers container boot/`/health`, extension manifest version (`SCHEMA_VERSION=2`, `EXTENSION_VERSION="v3.7.1"`), audit-mode single-surface record shape, audit-mode multi-surface emission with shared `request_id` correlation, block-mode empty-200 with upstream-not-called assertion, and allowlist-mode on-the-wire key stripping. Verdict: GREEN.

## [3.7.0] - 2026-05-26

### Added

- **Bootstrap-channel handling and audit logging (#149, #146).** Adds explicit handling for `/api/claude_cli/bootstrap` to the proxy router, with audit logging at `~/.claude/cache-fix-bootstrap-log.jsonl` (5 MB cap, `.1` rotation). Log records include forward-compatible fields (`baseline_hash`, `anomaly_status`, `mode`, `extension_version`) that v3.8.0 will populate as the bootstrap-defense extension matures on the pipeline framework.

  **Behavior change for existing cache-fix users.** Prior versions routed only `/v1/messages` and `/health`, returning 404 for any other Anthropic API path including bootstrap. As a result, bootstrap-section content was not previously reaching CC for cache-fix users. v3.7.0 default mode is `audit`: bootstrap responses now proxy through to CC and are logged locally for inspection. Users who want to preserve v3.6.2's de-facto block behavior should set `CACHE_FIX_BOOTSTRAP_MODE=block` in the proxy environment, which short-circuits the upstream call and returns a 200 with an empty JSON body.

  **Background.** Claude Code v2.1.150 added a prompt-section consumer (`nAA()` / `heron_brook`) that reads server-supplied strings from `/api/claude_cli/bootstrap` and merges them into the agent's behavioral-instructions prompt. We filed the behavior with Anthropic via HackerOne VDP on 2026-05-25; the report was closed as *Informative* on 2026-05-26, with Anthropic treating TLS as the transport-integrity boundary and declining to add application-layer authenticity checks. This release gives cache-fix users local visibility into bootstrap-channel content (audit mode) and an opt-in path to drop it (block mode). See [`docs/disclosure/heron-brook-2026-05.md`](docs/disclosure/heron-brook-2026-05.md) for the full disposition record.

  **Operational notes.**
  - Audit mode writes metadata about bootstrap fetches to a local log file. The log never leaves the host. Records are scalar-only by design (no headers, no bodies) — PII discipline is enforced at the writer's call signature.
  - Block mode also writes to the audit log (the block event itself is logged); auditability of blocks matters more than log volume.
  - Upstream errors on the bootstrap path are also routed through the audit pipeline (`phase: upstream_error_audited`). Anomaly-friendly: a DNS-shenanigan or upstream-outage probe leaves a record before the client receives a 502.
  - Log path is `~/.claude/cache-fix-bootstrap-log.jsonl` by default; override with `CACHE_FIX_BOOTSTRAP_LOG_PATH` if you need to redirect it (used for test isolation; useful for sandboxed deployments).
  - No statusline signal in v3.7.0 — check the log file directly. The env-flag-detector statusline pattern (#144) will absorb bootstrap-log surfacing in v3.8.0.
  - Single-process invariant: the cache-fix proxy is one Node process per host, so the audit writer relies on intra-process serialization. Future changes must preserve this.
  - Pipeline framework: this release adds a new pipeline hook for the bootstrap path; v3.8.0's anomaly + baseline + dismissal extension binds to it.

### Changed

- **`tools/quota-statusline.sh`: autoselect d/h vs h/m time format, unify burn-rate warmup gate to 5m (#143).** Time-unit autoselect: when the duration is ≥ 1 day, render as `Nd Hh` (e.g., `3d13h`, `3d0h`); below a day, render as `Hh Mm` (e.g., `13h25m`). Replaces the prior `3d 13h` / `0d13h` shapes — both windows now drop the day token automatically when sub-day. Burn-rate warmup gate is now a unified 5-minute (`300s`) threshold for both Q5h and Q7d, replacing the prior asymmetric `60s` / `360s` per-window gates; the rationale is that a single early call dominates the rate, so the gate is about smoothing the rate-of-change estimate, not about per-window calibration. Named constants (`BURN_WARMUP_SEC`, time-unit `SEC_PER_*` etc.) replace bare integer literals in the script. README example tokens updated to the new compact form. Contributed by [@schuay](https://github.com/schuay) — thank you.

### Tests

831 → 850 (+20): bootstrap-defense unit suite (mode resolution, route-scoping skip, PII discipline grep, audit/block/error-path JSONL shape, log rotation), proxy-server bootstrap integration (audit/block/empty-body stderr-cleanliness, ECONNREFUSED 502 path, non-JSON upstream response), and `T16` pinning the new `300s` `BURN_WARMUP_SEC` at 100s elapsed (between the legacy 60s Q5h gate and the new 300s gate — closes the contract gap where `T13`'s 30s elapsed passed under both old and new gate values).

## [3.6.2] - 2026-05-22

### Added

- **README: "Recommended CC operational config" section (#139).** Documents three `~/.claude/settings.json` env vars (`CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`) that solve adjacent CC problems the proxy can't reach — silent model swap on update, ambiguous model fallback. Plus a caveat on `autoCompactWindow=1M` (only works on 1M-eligible models) and a footnote on `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (strips tool fields outside the canonical four). Findings sourced from [@fgrosswig](https://github.com/fgrosswig)'s binary analysis of CC v2.1.91 — public methodology (PowerShell + ASCII string extraction), privately shared punch list. Thank you, @fgrosswig.

### Fixed

- **README: removed incorrect "npm provenance" claim from the supply-chain paragraph (#134).** Prior README copy stated "npm provenance links each published version to its source commit." Verified against the npm registry: no published release (including v3.6.0 and v3.6.1) carries sigstore provenance attestations — only the default `signatures` field. The claim has never been factual. Corrected to "Published builds carry npm's default registry signatures; sigstore provenance attestation is not currently published — tracked as a follow-up." No package behavior change; doc-accuracy correction only.

### Changed

- **`tools/quota-statusline.sh`: Q5h/Q7d now render as a quota bar with an elapsed-time tick, plus an exhaust-vs-reset projection (#140).** Each window shows a 10-cell bar `[███░┃░░░░░]` where filled cells are consumed quota and the heavy-vertical tick marks wall-clock elapsed position. Tick in the empty region = under pace; tick inside the fill = burning faster than time. The suffix `(exhaust X, reset Y)` replaces the previous burn-rate display: `exhaust` is projected time-to-100% at the current burn rate, `reset` is wall-clock time until the window rolls over. When `exhaust < reset` the user is on track to hit 100% before the window resets — the comparison is the actionable signal, which the raw `%/min` rate didn't convey without mental math. Output line shape changes from `Q5h: 42% (+0.4%/m)` to `Q5h [████░░░░░┃] 42% (exhaust 0h32m, reset 2h50m)`; downstream consumers that grep `Q5h: N%` need to switch to `Q5h \[.{10}\] N%`. Suffix segments are dropped piecewise when projection isn't meaningful: at `pct == 0` or `pct == 100` only `reset` is shown; during the burn-rate warmup (≤60s for Q5h, ≤360s for Q7d) `exhaust` is held back; a stale `resets_at` drops both. The bar uses standard Unicode block characters (`█┃░`); terminals without Unicode font coverage will need a Unicode-capable monospace font. TTL/hit-rate/PEAK/OVERAGE suffix segments are unchanged. Contributed by [@schuay](https://github.com/schuay) — thank you.

### Tests

824 → 831 (+7): seven new format-contract tests (`T8`-`T14`) pin bar content and the `(exhaust X, reset Y)` wording for under-pace, over-pace, missing-`resets_at`, stale-window, fresh-window (`pct=0`), pre-warmup, and at-cap (`pct=100`) cases. Anchored against a fixed `now` via `account.json.timestamp` so timestamps are deterministic across CI runs.

## [3.6.1] - 2026-05-17

### Added

- **`thinking-display` extension: restores Opus 4.7 thinking summaries in non-interactive CC surfaces (#131, closes #130).** Anthropic flipped the `thinking.display` API default to `"omitted"` on Opus 4.7, and Claude Code's CLI gates `display: "summarized"` behind `!getIsNonInteractiveSession()` — so every CC subprocess spawned with `--input-format stream-json` (VS Code chat panel, Antigravity panel, SDK, `claude --print`, etc.) sends a thinking-enabled request without `display`, and the API returns thinking blocks whose `thinking` field is empty plus a multi-KB signature. The UI shows a static "Thinking" stub but no reasoning content. This extension injects `thinking.display = "summarized"` at the proxy boundary when the request is on `claude-opus-4-7*`, `thinking.type` is `"enabled"` or `"adaptive"`, and `display` is unset — works on any CC version routed through cache-fix-proxy without waiting on the upstream CLI fix. Upstream root cause / patch proposal in [anthropics/claude-code#59844](https://github.com/anthropics/claude-code/issues/59844) — credit to [@ojura](https://github.com/ojura). Default is `summarized` (default-on for Opus 4.7) after the cache-prefix test on PR #131 measured 0% absolute drop in steady-state `cache_read` ratio (5 sequential `claude -p` calls per window, baseline vs injected — both windows held 1.000 cache_read ratio from call 2 onward, comfortably inside the ≤5% "preserved" threshold pinned in the PR body before the test ran). Users who want no injection set `CACHE_FIX_THINKING_DISPLAY=disabled`; users who want explicit thinking suppression set `CACHE_FIX_THINKING_DISPLAY=omitted`. User opt-out is always preserved — if a request already has `thinking.display` set (either `"summarized"` or `"omitted"`), the extension never overwrites. Model-gated regex is intentionally narrow (`/^claude-opus-4-7/`); Sonnet 4.7 and future versions require explicit verification + a cache-fix bump rather than auto-applying unverified behavior.

- **`docs/parallel-proxy-test-harness.md`: developer test harness for end-to-end extension testing.** Documents the pattern used during #131 work: spin up a parallel proxy on `:9802` from the feature branch, route `claude -p` traffic through it (bypassing the local wrapper that hardcodes `:9801`), capture real request bodies via a diagnostic extension, run baseline-vs-injected comparisons against live Anthropic API. The harness surfaced the spec/reality mismatch on #130 (CC v2.1.131 ships `thinking.type: "adaptive"`, not `"enabled"` as the upstream issue described) that no unit test would have caught — captured here as a standing pattern for every future extension PR. Six gotchas inlined (`~/bin/claude` wrapper hardcoding, `--verbose` requirement for `stream-json`, env-vars-need-restart, PID-discovery via `ss -tlnp`, `pkill -f` self-kill risk, adaptive-thinking-is-model-decided).

### Tests

793 → 824 (+31): 31 new tests for `thinking-display` covering `resolveMode` (env values, fallback, garbage rejection), `MODEL_REGEX` (Opus 4.7 + 1m variant, negative cases for 4.6, Sonnet, future 4.8), `shouldInject` (all combinations of model × thinking state × display state, including the `adaptive` type discovered during live test), and `onRequest` end-to-end (each mode × each body shape, plus the pinned user-opt-out preservation case for both explicit `"omitted"` and explicit `"summarized"`).

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

- `cache-telemetry`: session-id headers (`x-claude-code-session-id` and the legacy fallbacks) live on the **request**, not the response. The v3.5.0 implementation read them from `ctx.headers` in `onResponseStart` — but that ctx carries response headers, and Anthropic doesn't echo session-id back. Net effect on multi-agent hosts running v3.5.0: every per-session file landed at `sessions/unknown.json` with `session_id: null`, defeating the whole point of the per-session split. Captured production failure on <internal-host> immediately after v3.5.0 rollout. Fix moves session-id resolution into a new `onRequest` hook (request headers); `onStreamEvent` reads from `ctx.meta._sessionId` as before. The proxy server passes the same `meta` object through `onRequest → onResponseStart → onStreamEvent`, so the threading works end-to-end. Adds two regression tests that drive request and response headers separately to prevent recurrence.

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
