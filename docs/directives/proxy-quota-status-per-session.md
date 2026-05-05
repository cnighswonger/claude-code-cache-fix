# Directive: Per-session quota-status files

**Issue:** #104
**Branch:** `feature/quota-status-per-session`
**Stage:** directive

## Goal

Replace the proxy-global `~/.claude/quota-status.json` with per-session attribution so multi-agent users no longer see cross-session contamination when reading cache state. Add a paired bonus fix to `microcompact-stability`'s session-id fallback chain so it actually picks up the canonical CC header.

## Why

`proxy/extensions/cache-telemetry.mjs:5,108` writes `~/.claude/quota-status.json` on every response, unconditionally overwriting it. The path is process-global (one proxy serves N CC sessions), but every consumer treats it as "my session's state." On a multi-agent host (visits-01 runs 6+ concurrent CC sessions through one proxy), whichever request finishes most recently wins the file. Readers race against unrelated agents' traffic.

Concrete failure surfaced 2026-05-05: a `/coffee` warmer in one session reported "TTL just flipped to 5m" because it read the file in the millisecond after another agent's cold rebuild landed (`cache_read=0`, `cache_creation=652609`). Reader's actual tier hadn't changed. Misdiagnosis was harmless but cost an hour of root-causing because nothing carries per-session attribution.

The same race contaminates `/coffee`'s "is the cache still warm?" gate — false-warm reads skip a needed warmer ping (downgrade to 5m); false-cold reads fire an unnecessary cold rebuild. Both cost real money on the rebuild path.

Single-agent users are unaffected today and remain so under the fix — for them, "global" and "per-session" are equivalent.

## Session attribution

CC sends `x-claude-code-session-id` on every request. Lead corroborated this against llm-relay's production extraction (`proxy/proxy.py:338,379,400,606` per Lead's #104 comment) and a same-day query of llm-relay's `requests` table; the column carries full CC session UUIDs whose values match the names of `~/.claude/projects/<project>/<session-id>.jsonl` files exactly. The `~/.claude/projects/<project>/<session-id>.jsonl` correspondence is locally verifiable — `ls ~/.claude/projects/<project>/` on any active CC install shows UUID-named transcripts, and a packet capture of a request out of a CC instance confirms the header is sent. The header is stable across a session's lifetime, unique per session, populated by CC itself.

Bonus: `proxy/extensions/microcompact-stability.mjs:234–242` has a fallback chain that reads `x-session-id` and `x-anthropic-session-id` but **NOT** `x-claude-code-session-id` — so it currently returns null for most CC requests. Same scope, same header — fold the addition in here.

## File-shape decision: split account-global vs per-session

Today's `quota-status.json` payload mixes account-global fields (5h/7d util, status, overage, peak_hour, all_headers — same fact regardless of which session reports) with per-session fields (cache_creation, cache_read, ttl_tier, hit_rate). Three options were considered:

- (a) Same shape per session file, accept that quota fields duplicate across files.
- (b) Split into `account.json` + `<session-id>.json`. Each file carries one concern.
- (c) Same shape, document that quota fields can be read from any session's file.

(a)'s wrinkle: an idle session's per-session file shows stale quota fields indefinitely (the global facts are only refreshed by *that* session's next request). Same race shape as the bug we're fixing, smaller blast radius.

(b) eliminates that — `account.json` is updated by every request from any session, so account-global facts are always fresh. Per-session cache file only updates when that session requests, which is correct semantics. Cost is one extra write per response and one extra read for consumers (e.g. statusline) that need both views.

This directive adopts **(b)**.

## Design

### Modified: `proxy/extensions/cache-telemetry.mjs`

- Read `x-claude-code-session-id` from `ctx.headers` in `onResponseStart`. Fall back to `x-session-id` then `x-anthropic-session-id` for parity with microcompact (and to keep the extension working in non-CC test fixtures); if all three are absent, fall back to `null` (treated as "unknown" by the filename rule below) with a single stderr warning gated on `CACHE_FIX_DEBUG`.
- Stash the **raw** resolved id on `ctx.meta._sessionId` (string or null). Filename derivation (below) is a separate step from id resolution; the JSON payload writes the raw id so consumers can confirm attribution even if the filename was sanitized.
- File layout:
  - `~/.claude/quota-status/account.json` — global file at the directory root.
  - `~/.claude/quota-status/sessions/<filename>.json` — per-session files in a dedicated subdirectory. The subdirectory split is structural: it makes a stray session id of `account` (or any other reserved name) physically unable to collide with the global file, and gives sweep + readers a single directory to scan.
- **Per-session filename derivation rule (canonical writer/reader contract).** Both the writer (cache-telemetry) and every reader (`tools/quota-statusline.sh`, `tools/cache-test.sh`, `tools/cross-version-cache-test.sh`, `/coffee`, visits-01 hooks) must apply this rule identically:

  ```
  function sessionFilename(rawId):
    if rawId is null/undefined or trim(rawId) is empty: return "unknown"
    let s = trim(rawId)
    if s matches /^[A-Za-z0-9_-]{1,128}$/: return s
    return "inv-" + sha256(s).hexSlice(0, 16)
  ```

  Properties:
  - **Path-traversal safe.** Allowlist excludes `/`, `\`, `.`, NUL, and every other path-significant character. No input can produce nested paths or `..` segments.
  - **Length-bounded.** Upper bound 128 is well under `NAME_MAX` (255 on Linux/macOS). The `inv-` fallback is always exactly 20 chars.
  - **Deterministic.** Same input → same filename, on writer and reader. A reader can compute the filename from stdin `session_id` without coordinating with the writer.
  - **Collision-resistant on hash fallback.** Sha256 truncated to 16 hex chars (64 bits) — collision probability negligible for the cardinality of session ids one host produces.
  - **Reserved-name safe.** The `sessions/` subdirectory means filenames `account` or `unknown` are not special at the path level. They can appear as legitimate per-session filenames if some client genuinely sends those strings, without colliding with the global file.
  - **Original id preserved.** The JSON payload writes `session_id: <rawId>` so a consumer staring at an `inv-…json` file can attribute it. (For the empty-id case, payload writes `session_id: null`.)

  Implementation note: implement once as `proxy/extensions/_session-filename.mjs` (or inline as a small exported helper in cache-telemetry) and import it into the watcher/sweeper. The shell readers (`tools/quota-statusline.sh` etc.) implement the same rule in their stdin Python heredoc — the rule is short enough to inline reliably.

- In the `message_delta` branch where the file is currently written, write **two** files using the layout above. Payloads:
  - `account.json` — `{ ...quota, timestamp }` (every quota field except the `cache` block).
  - `sessions/<filename>.json` — `{ cache: {...}, timestamp, session_id: <rawId or null> }`.
- Both writes are wrapped in `try/catch{}` (matches today's behaviour). Failures must not break the response stream.
- Use atomic writes (`writeFileSync(tmp, ...); renameSync(tmp, final)`) to eliminate partial-read races on consumers polling tightly. Tmp suffix shape: `<final>.tmp.<pid>.<crypto.randomBytes(4).toString('hex')>` — collision-resistant if a future change ever runs multiple writers (today's proxy is single-process; the cost is negligible and the property is free).
- `mkdirSync(join(homedir(), ".claude", "quota-status", "sessions"), { recursive: true })` once per write call (idempotent, cheap; creates both `quota-status/` and `quota-status/sessions/` in one call).
- **Legacy file cleanup.** On first invocation per process, attempt `unlinkSync(join(homedir(), ".claude", "quota-status.json"))` wrapped in try/catch (no-op if missing). Tracked via a module-scoped `legacyCleanupDone = false` flag so the cost is exactly one syscall per proxy start. This removes the stale-artifact footgun where post-upgrade consumers that haven't been migrated would silently read state frozen at the moment of upgrade.

### Modified: `proxy/extensions/microcompact-stability.mjs:234–242`

Add `x-claude-code-session-id` to the front of the fallback chain:

```js
function hashSessionId(reqCtx) {
  const sid =
    reqCtx?.meta?.session_id ||
    reqCtx?.headers?.["x-claude-code-session-id"] ||
    reqCtx?.headers?.["x-session-id"] ||
    reqCtx?.headers?.["x-anthropic-session-id"] ||
    null;
  if (!sid) return null;
  return createHash("sha256").update(String(sid)).digest("hex").slice(0, 8);
}
```

Order matters: `meta.session_id` first (in case a future extension explicitly sets it), then the canonical CC header, then the legacy fallbacks. Existing behaviour for any request that already sets `meta.session_id` or one of the legacy headers is preserved.

### New: stale-file sweep in cache-telemetry

Per-session files accumulate forever otherwise. Sweep on write, throttled, configurable.

- TTL: env var `CACHE_FIX_QUOTA_STATUS_TTL_DAYS`, default `7`. Anything in `~/.claude/quota-status/sessions/` with `mtime` older than `now - TTL_DAYS * 86400` is `unlinkSync`'d.
- Throttle: track a module-scoped `lastSweepMs`. Skip the sweep entirely if `Date.now() - lastSweepMs < 60_000`. Update `lastSweepMs` after a sweep runs (whether or not anything was deleted).
- Sweep failures (e.g. `unlinkSync` race against a consumer reading) are caught and ignored — same try/catch envelope as the writes.
- Sweep operates only on `sessions/`. `account.json` lives in the parent directory and is never touched by the sweep.

This is intentionally simple: O(n) directory scan once a minute. For visits-01-class hosts (n ~ 6–12 per day, files retained 7 days → ~50–80 entries) this is sub-millisecond. A more expensive design (separate cron, persistent index, etc.) buys nothing measurable.

### Migration: shipped statusline + visits-01 hook + tests + docs

Every reader must apply the same filename derivation rule defined in the **Per-session filename derivation rule** section above.

| Consumer | Action |
|---|---|
| `tools/quota-statusline.sh` | Update to read CC stdin JSON's `session_id`, derive filename via the canonical rule, then read both `~/.claude/quota-status/account.json` and `~/.claude/quota-status/sessions/<filename>.json`, merging fields. Fallbacks: file-missing → blank; session_id missing from stdin → fall back to `account.json` only (statusline still shows quota %, just no per-session cache hit rate). |
| `tools/cross-version-cache-test.sh` | Update path: `~/.claude/quota-status/account.json` for the global pct read. |
| `tools/cache-test.sh` | Update `QUOTA_FILE` to `~/.claude/quota-status/account.json`. |
| `README.md` (and translated copies `README.zh.md`, `README.ko.md`, `README.pt-br.md`) | Sweep references to `~/.claude/quota-status.json` and update to the new layout. Don't introduce migration-instruction prose into the README itself — point at CHANGELOG. |
| `docs/TRACKED_ISSUES.md`, in-tree code-review docs that reference the path | Same sweep. References that describe past behaviour (changelog-style historical notes) may stay; references that describe present behaviour update. |
| `~/.claude/skills/coffee/SKILL.md` (visits-01) | Out of scope for this directive — handled at coffee#1. |
| `~/.claude/hooks/quota-statusline.sh` (visits-01) | Out of scope for this directive — visits-01-only artifact, updated by Lead/AI-Team-Lead alongside the merge. |
| `preload.mjs:2651,2758,2776` | Leave as-is. Preload-mode is single-session by construction (one CC instance imports `preload.mjs`), so the global path semantically matches; preload users don't see the bug, and the path is shrinking. |

### CHANGELOG

This is a breaking change for anyone running `tools/quota-statusline.sh` or any custom tool that reads `~/.claude/quota-status.json` directly. The file moves to `~/.claude/quota-status/account.json` (global facts) plus per-session files at `~/.claude/quota-status/sessions/<filename>.json`, where `<filename>` is derived from the canonical filename rule (above).

CHANGELOG entry under `### Changed` for the next minor release (likely v3.5.0):

> **Breaking (path change):** `~/.claude/quota-status.json` replaced with `~/.claude/quota-status/account.json` (global quota fields) plus per-session files under `~/.claude/quota-status/sessions/<filename>.json` (cache fields), where `<filename>` is derived from the request's `x-claude-code-session-id` header via a deterministic safe-name rule (UUIDs and similar safe ids pass through; malformed inputs are mapped to `inv-<sha256-prefix>`). Multi-agent users no longer see cross-session contamination. Custom statusline scripts that read the old path must update; the shipped `tools/quota-statusline.sh` has been migrated. Per-session files older than `CACHE_FIX_QUOTA_STATUS_TTL_DAYS` (default 7) are swept on write.

A separate `### Fixed` entry for the microcompact session-id fix:

> microcompact-stability: session-id fallback chain now includes `x-claude-code-session-id` (the canonical CC header). Previously returned null for most CC requests, weakening hashed-session attribution in microcompact diagnostics.

## Tests

### Unit: `test/proxy-cache-telemetry.test.mjs` (new file or extend existing)

Pure tests on the file-write logic. Exercise via the extension interface (`ext.onResponseStart(ctx)` + `ext.onStreamEvent(ctx)` for `message_start` and `message_delta`).

1. **Happy path, real session_id.** Headers carry `x-claude-code-session-id: <uuid>`. After running the response/stream sequence, assert:
   - `~/.claude/quota-status/account.json` exists, parses, carries the quota fields and `timestamp`.
   - `~/.claude/quota-status/sessions/<uuid>.json` exists, parses, carries the `cache` block, `timestamp`, and `session_id: "<uuid>"`.
   - Neither file is empty mid-write (atomic rename verified by reading file content immediately after).

2. **Fallback to `x-session-id`.** Only `x-session-id` set. Per-session file lands at `~/.claude/quota-status/sessions/<x-session-id>.json` (assuming the value passes the filename allowlist). Assertion symmetric to (1).

3. **Fallback to `x-anthropic-session-id`.** Same shape as (2), at `~/.claude/quota-status/sessions/<x-anthropic-session-id>.json`.

4. **All three headers missing.** Per-session file lands at `~/.claude/quota-status/sessions/unknown.json`. Account file still written at `~/.claude/quota-status/account.json`.

5. **Two responses, different sessions.** Run extension twice with different `x-claude-code-session-id`. Assert two distinct per-session files exist under `~/.claude/quota-status/sessions/`, each carrying its own `cache` block; `account.json` (at the parent directory) reflects the second response's quota fields.

6. **Quota-only write skipped.** When `parseHeaders()` returns `null` (no quota headers in response), no files are written. (Mirrors today's `if (!quota) return null;` behaviour.)

7. **Atomic write contract.** Spy on or temporarily replace `writeFileSync` to assert the write target ends with a `.tmp.*` suffix and a subsequent `renameSync` moves it to the final path. Catches any future regression that drops the atomic-write step.

7a. **Legacy file cleanup on first invocation.** Pre-create `~/.claude/quota-status.json` (the old global path). Reset module state so `legacyCleanupDone = false`. Drive a response. Assert the legacy file is gone. Drive a second response and assert the cleanup syscall is not re-issued (e.g. by stubbing `unlinkSync` and counting calls — should be exactly 1 for the legacy path across multiple responses in the same process).

7b. **Legacy cleanup absence is silent.** Ensure `~/.claude/quota-status.json` does not exist. Reset module state. Drive a response. Assert no error is thrown and the response writes complete normally.

### Unit: TTL sweep behaviour (same test file)

8. **Sweep runs on first call, deletes stale files.** Pre-create three stub files: `~/.claude/quota-status/sessions/<old>.json` (mtime 8 days ago), `~/.claude/quota-status/sessions/<recent>.json` (mtime 1 day ago), and `~/.claude/quota-status/account.json` (mtime 30 days ago, lives at the parent dir, not in `sessions/`). Drive a real response. Assert:
   - `sessions/<old>.json` is gone.
   - `sessions/<recent>.json` and `account.json` (parent dir) survive — `account.json` because the sweep doesn't traverse outside `sessions/`.

9. **Sweep throttled to 60s.** Reset module state, run two responses back-to-back with a stale stub pre-existing in `sessions/`. After response #1 the stub is deleted (sweep ran). Re-create the stub between calls. After response #2, the stub still exists (throttle prevented a second sweep within 60s). Mock `Date.now()` rather than `sleep`.

10. **`CACHE_FIX_QUOTA_STATUS_TTL_DAYS` env override.** Set env to `0` (effectively "expire every per-session file"). Stub a 30-second-old file in `sessions/`. Drive a response. Assert the stub is gone, and `~/.claude/quota-status/account.json` is unaffected.

11. **Sweep failure isolation.** Make `unlinkSync` throw on one file in `sessions/` (e.g. permission error). Assert the response still completes, the throw doesn't propagate, and other deletable stub files in the same sweep are still deleted.

### Unit: filename derivation rule (same test file or new `test/proxy-session-filename.test.mjs`)

11a. **UUID input → raw filename.** `sessionFilename("b16c607d-d484-4935-840e-e3f7ee78eb08")` → `"b16c607d-d484-4935-840e-e3f7ee78eb08"`.

11b. **Alphanumeric/underscore/dash inputs → raw filename.** `"abc123"`, `"with_underscore"`, `"with-dash"`, `"A1_b2-C3"` all return as-is.

11c. **Empty / whitespace / null / undefined → `"unknown"`.** `sessionFilename(null)`, `sessionFilename(undefined)`, `sessionFilename("")`, `sessionFilename("   ")` all return `"unknown"`.

11d. **Path-traversal characters → hashed `inv-` prefix.** Inputs containing `/`, `\`, `..`, `.`, NUL byte, `:`, control characters all yield `inv-<16 hex chars>`. Sample assertions:
- `sessionFilename("../etc/passwd")` matches `/^inv-[0-9a-f]{16}$/`.
- `sessionFilename("a/b")` matches the same pattern.
- `sessionFilename("normal.uuid.with.dots")` matches the same pattern (dots disallowed).
- `sessionFilename("with nul")` matches the same pattern.

11e. **Determinism.** `sessionFilename("malformed input")` returns the same value across multiple invocations (verifies the hash isn't seeded with anything random).

11f. **Length cap.** `sessionFilename("x".repeat(129))` returns `inv-<16 hex>` (length-128 boundary fails the allowlist; 129 chars trigger the fallback).

11g. **Length cap exact.** `sessionFilename("x".repeat(128))` returns the raw 128-char string (boundary case included).

11h. **Hash output is filesystem-safe.** Across a sample of 100 random malformed inputs, all returned filenames match `/^[A-Za-z0-9_-]+$/` and are `<= 128` chars. Smoke check that the rule is closed under its own allowlist.

11i. **Reserved-name passthrough.** `sessionFilename("account")` and `sessionFilename("unknown")` return `"account"` and `"unknown"` respectively (no special-casing — the `sessions/` subdirectory provides the structural separation from `account.json` at the path level).

### Pipeline-level test for filename rule integration

11j. **Malformed session-id ends up in a hashed file.** Drive a response with `x-claude-code-session-id: ../../../etc/passwd`. Assert:
- A file matching `~/.claude/quota-status/sessions/inv-[0-9a-f]{16}.json` is created.
- The JSON payload's `session_id` field carries the raw string `"../../../etc/passwd"` (preserved for attribution).
- `~/.claude/quota-status/account.json` is written normally — that's the global file and is expected on every response.
- No file is created at `~/.claude/quota-status.json` (the legacy global path is gone post-cleanup), `~/.claude/etc/passwd`, `~/.claude/quota-status/etc/passwd`, or any other path-traversal target outside `~/.claude/quota-status/sessions/`.

### Unit: `proxy/extensions/microcompact-stability.test.mjs` (extend existing)

12. **`hashSessionId` reads `x-claude-code-session-id`.** Build `reqCtx` with only that header. Assert the function returns a non-null 8-char hash equal to the first 8 chars of `sha256(<session-id>)`.

13. **Precedence: `meta.session_id` wins over canonical header.** Both set, different values. Hash matches `meta.session_id`'s.

14. **Precedence: canonical header wins over legacy headers.** `x-claude-code-session-id` and `x-session-id` both set. Hash matches the canonical one.

15. **All sources missing → returns null.** Existing test of this shape probably exists; verify and extend.

### Pipeline integration: `test/proxy-quota-status-pipeline.test.mjs` (new file)

These exercise the real extension order via `loadExtensions` against the real `proxy/extensions/` and `proxy/extensions.json`, then drive a synthetic response.

16. **End-to-end happy path.** A response with `x-claude-code-session-id` and a full quota header set. After the pipeline runs, both files exist on disk at the canonical paths and carry the expected fields. Locks in that no other extension's `onResponseStart`/`onStreamEvent` interferes.

17. **Two-session interleaving.** Drive two responses back-to-back with different session IDs (truly-concurrent execution isn't reliably testable on a single-threaded JS runtime without workers; the back-to-back shape exercises the same invariant deterministically). Assert per-session files don't overwrite each other; `account.json` reflects whichever response wrote last; both per-session files retain their own `cache` blocks.

### Tooling smoke test: `test/quota-statusline-smoke.test.mjs` (new file)

Codex flagged that the shipped statusline is the consumer most exposed to the new filename contract; a lightweight smoke test reduces regression risk on the migration.

The test runs `tools/quota-statusline.sh` as a subprocess (`spawnSync` with stdin/stdout pipes) under a tmpdir-based `HOME` so it doesn't touch the developer's real `~/.claude/`:

T1. **UUID session, both files present.** Pre-populate `$HOME/.claude/quota-status/account.json` (quota fields) and `$HOME/.claude/quota-status/sessions/<uuid>.json` (cache fields). Pipe stdin JSON `{"session_id": "<uuid>"}`. Assert stdout label parses and contains both quota-percent and TTL strings.

T2. **session_id missing from stdin.** Pre-populate only `account.json`. Pipe stdin JSON without `session_id`. Assert stdout label parses and contains quota-percent (no TTL).

T3. **per-session file missing (warming).** Pre-populate `account.json` only. Pipe stdin with a UUID. Assert stdout label parses and contains quota-percent (per-session block absent or shows blank — does not error).

T4. **Both files missing.** Pipe stdin with a UUID. Assert script exits cleanly (no stderr, exit 0) and emits no output.

T5. **Malformed session-id from stdin.** Pipe stdin with `{"session_id": "../foo"}`. Pre-populate the corresponding `inv-<hash>.json`. Assert stdout reads the hashed file (proves the script's filename rule matches the writer's).

The Python heredoc inside the shell script implements the same filename derivation rule as the writer; T5 specifically locks in the contract.

## Out of scope

- Migrating `~/.claude/skills/coffee/SKILL.md` — tracked at coffee#1; lives in a different repo.
- Migrating the visits-01-only `~/.claude/hooks/quota-statusline.sh` — Lead/AI-Team-Lead handles that on the visits-01 host alongside the merge.
- Updating community dashboards / Web Manager / npm-side consumers — none read the local file (verified by Lead in #104). No external migration required.
- preload.mjs — single-session path by construction; bug doesn't apply; deprecated and shrinking.
- A "last-request snapshot" backwards-compat alias at `~/.claude/quota-status.json`. Direction (2) was rejected; don't reintroduce it via a side door.
- Cross-session aggregation use cases ("worst quota across all my sessions"). Account-level quota is the same fact regardless of session, so `account.json` already covers the meaningful aggregate.

## Acceptance

- `proxy/extensions/cache-telemetry.mjs` writes `~/.claude/quota-status/account.json` and `~/.claude/quota-status/sessions/<filename>.json` (filename derived per the canonical rule) per the design above, atomically, with the TTL sweep throttled and configurable.
- Legacy `~/.claude/quota-status.json` is removed on the first invocation per proxy process and not recreated.
- `proxy/extensions/microcompact-stability.mjs` recognises `x-claude-code-session-id` in its fallback chain.
- `tools/quota-statusline.sh`, `tools/cache-test.sh`, `tools/cross-version-cache-test.sh` updated to the new paths.
- All new tests pass (#1–#17 plus #11a–#11j filename-rule tests and the `T1–T5` statusline smoke tests); full proxy test suite green.
- Per-session filename derivation rule is documented in this directive, implemented identically by both writer (cache-telemetry) and shipped readers (`tools/quota-statusline.sh`, `tools/cache-test.sh`, `tools/cross-version-cache-test.sh`), and locked in by tests.
- README / docs path references updated to the new layout.
- CHANGELOG entries drafted for `### Changed` (path migration) and `### Fixed` (microcompact session-id fix).
- Codex review with no blocking findings before merge.

— Proxy Builder
