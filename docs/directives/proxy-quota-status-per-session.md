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

CC sends `x-claude-code-session-id` on every request. Verified against llm-relay's production extraction (`proxy/proxy.py:338,379,400,606`) and a same-day query of llm-relay's `requests` table — the column carries full CC session UUIDs that match the names of `~/.claude/projects/<project>/<session-id>.jsonl` files exactly. Stable across a session's lifetime, unique per session, populated by CC itself.

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

- Read `x-claude-code-session-id` from `ctx.headers` in `onResponseStart`. Fall back to `x-session-id` then `x-anthropic-session-id` for parity with microcompact (and to keep the extension working in non-CC test fixtures); if all three are absent, fall back to `"unknown"` with a single stderr warning gated on `CACHE_FIX_DEBUG`.
- Stash the resolved id on `ctx.meta._sessionId` (string).
- In the `message_delta` branch where the file is currently written, write **two** files:
  - `~/.claude/quota-status/account.json` — payload `{ ...quota, timestamp }` (every quota field except the `cache` block).
  - `~/.claude/quota-status/<session-id>.json` — payload `{ cache: {...}, timestamp, session_id }`. The `session_id` field is included in the body so a consumer who has the file but lost its filename context can still attribute it.
- Both writes are wrapped in `try/catch{}` (matches today's behaviour). Failures must not break the response stream.
- Use atomic writes (`writeFileSync(tmp, ...); renameSync(tmp, final)`) to eliminate partial-read races on consumers polling tightly. Tmp suffix shape: `<final>.tmp.<pid>.<crypto.randomBytes(4).toString('hex')>` — collision-resistant if a future change ever runs multiple writers (today's proxy is single-process; the cost is negligible and the property is free).
- `mkdirSync(join(homedir(), ".claude", "quota-status"), { recursive: true })` once per write call (idempotent, cheap).
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

- TTL: env var `CACHE_FIX_QUOTA_STATUS_TTL_DAYS`, default `7`. Anything in `~/.claude/quota-status/` (excluding `account.json`) with `mtime` older than `now - TTL_DAYS * 86400` is `unlinkSync`'d.
- Throttle: track a module-scoped `lastSweepMs`. Skip the sweep entirely if `Date.now() - lastSweepMs < 60_000`. Update `lastSweepMs` after a sweep runs (whether or not anything was deleted).
- Sweep failures (e.g. `unlinkSync` race against a consumer reading) are caught and ignored — same try/catch envelope as the writes.
- Sweep does **not** delete `account.json` even if it's older than the TTL — it's the always-current global snapshot.

This is intentionally simple: O(n) directory scan once a minute. For visits-01-class hosts (n ~ 6–12 per day, files retained 7 days → ~50–80 entries) this is sub-millisecond. A more expensive design (separate cron, persistent index, etc.) buys nothing measurable.

### Migration: shipped statusline + visits-01 hook + tests

| Consumer | Action |
|---|---|
| `tools/quota-statusline.sh` | Update to read CC stdin JSON's `session_id`, then read both `~/.claude/quota-status/account.json` and `~/.claude/quota-status/<session-id>.json`, merging fields. Add fallbacks: file-missing → blank; session_id missing from stdin → fall back to `<account.json>` only (statusline still shows quota %, just no per-session cache hit rate). |
| `tools/cross-version-cache-test.sh` | Update path: `~/.claude/quota-status/account.json` for the global pct read. The test's global facts read still works against the new path. |
| `tools/cache-test.sh` | Update `QUOTA_FILE` to `account.json`. Same reasoning. |
| `~/.claude/skills/coffee/SKILL.md` (visits-01) | Out of scope for this directive — handled at coffee#1. |
| `~/.claude/hooks/quota-statusline.sh` (visits-01) | Out of scope for this directive — visits-01-only artifact, updated by Lead/AI-Team-Lead alongside the merge. |
| `preload.mjs:2651,2758,2776` | Leave as-is. Preload-mode is single-session by construction (one CC instance imports `preload.mjs`), so the global path semantically matches; preload users don't see the bug, and the path is shrinking. |

### CHANGELOG

This is a breaking change for anyone running `tools/quota-statusline.sh` or any custom tool that reads `~/.claude/quota-status.json` directly. The file moves to `~/.claude/quota-status/account.json` (global facts) plus per-session files at `~/.claude/quota-status/<session-id>.json`.

CHANGELOG entry under `### Changed` for the next minor release (likely v3.5.0):

> **Breaking (path change):** `~/.claude/quota-status.json` replaced with `~/.claude/quota-status/account.json` (global quota fields) plus per-session `~/.claude/quota-status/<session-id>.json` (cache fields). Multi-agent users no longer see cross-session contamination. Custom statusline scripts that read the old path must update; the shipped `tools/quota-statusline.sh` has been migrated. Per-session files older than `CACHE_FIX_QUOTA_STATUS_TTL_DAYS` (default 7) are swept on write.

A separate `### Fixed` entry for the microcompact session-id fix:

> microcompact-stability: session-id fallback chain now includes `x-claude-code-session-id` (the canonical CC header). Previously returned null for most CC requests, weakening hashed-session attribution in microcompact diagnostics.

## Tests

### Unit: `test/proxy-cache-telemetry.test.mjs` (new file or extend existing)

Pure tests on the file-write logic. Exercise via the extension interface (`ext.onResponseStart(ctx)` + `ext.onStreamEvent(ctx)` for `message_start` and `message_delta`).

1. **Happy path, real session_id.** Headers carry `x-claude-code-session-id: <uuid>`. After running the response/stream sequence, assert:
   - `~/.claude/quota-status/account.json` exists, parses, carries the quota fields and `timestamp`.
   - `~/.claude/quota-status/<uuid>.json` exists, parses, carries the `cache` block, `timestamp`, and `session_id: "<uuid>"`.
   - Neither file is empty mid-write (atomic rename verified by reading file content immediately after).

2. **Fallback to `x-session-id`.** Only `x-session-id` set. Per-session file lands at `<x-session-id>.json`. Assertion symmetric to (1).

3. **Fallback to `x-anthropic-session-id`.** Same shape as (2).

4. **All three headers missing.** Per-session file lands at `unknown.json`. Account file still written.

5. **Two responses, different sessions.** Run extension twice with different `x-claude-code-session-id`. Assert two distinct per-session files exist, each carrying its own `cache` block; `account.json` reflects the second response's quota fields.

6. **Quota-only write skipped.** When `parseHeaders()` returns `null` (no quota headers in response), no files are written. (Mirrors today's `if (!quota) return null;` behaviour.)

7. **Atomic write contract.** Spy on or temporarily replace `writeFileSync` to assert the write target ends with a `.tmp.*` suffix and a subsequent `renameSync` moves it to the final path. Catches any future regression that drops the atomic-write step.

7a. **Legacy file cleanup on first invocation.** Pre-create `~/.claude/quota-status.json` (the old global path). Reset module state so `legacyCleanupDone = false`. Drive a response. Assert the legacy file is gone. Drive a second response and assert the cleanup syscall is not re-issued (e.g. by stubbing `unlinkSync` and counting calls — should be exactly 1 for the legacy path across multiple responses in the same process).

7b. **Legacy cleanup absence is silent.** Ensure `~/.claude/quota-status.json` does not exist. Reset module state. Drive a response. Assert no error is thrown and the response writes complete normally.

### Unit: TTL sweep behaviour (same test file)

8. **Sweep runs on first call, deletes stale files.** Pre-create three stub files in `~/.claude/quota-status/`: `<old>.json` (mtime 8 days ago), `<recent>.json` (mtime 1 day ago), `account.json` (mtime 30 days ago). Drive a real response. Assert:
   - `<old>.json` is gone.
   - `<recent>.json` and `account.json` survive.

9. **Sweep throttled to 60s.** Reset module state, run two responses back-to-back with a stale stub file pre-existing. After response #1 the stub is deleted (sweep ran). Re-create the stub between calls. After response #2, the stub still exists (throttle prevented a second sweep within 60s). Mock `Date.now()` rather than `sleep`.

10. **`CACHE_FIX_QUOTA_STATUS_TTL_DAYS` env override.** Set env to `0` (effectively "expire everything but `account.json`"). Stub a 30-second-old file. Drive a response. Assert the stub is gone.

11. **Sweep failure isolation.** Make `unlinkSync` throw on one file (e.g. permission error). Assert the response still completes, the throw doesn't propagate, and other deletable stub files in the same sweep are still deleted.

### Unit: `proxy/extensions/microcompact-stability.test.mjs` (extend existing)

12. **`hashSessionId` reads `x-claude-code-session-id`.** Build `reqCtx` with only that header. Assert the function returns a non-null 8-char hash equal to the first 8 chars of `sha256(<session-id>)`.

13. **Precedence: `meta.session_id` wins over canonical header.** Both set, different values. Hash matches `meta.session_id`'s.

14. **Precedence: canonical header wins over legacy headers.** `x-claude-code-session-id` and `x-session-id` both set. Hash matches the canonical one.

15. **All sources missing → returns null.** Existing test of this shape probably exists; verify and extend.

### Pipeline integration: `test/proxy-quota-status-pipeline.test.mjs` (new file)

These exercise the real extension order via `loadExtensions` against the real `proxy/extensions/` and `proxy/extensions.json`, then drive a synthetic response.

16. **End-to-end happy path.** A response with `x-claude-code-session-id` and a full quota header set. After the pipeline runs, both files exist on disk at the canonical paths and carry the expected fields. Locks in that no other extension's `onResponseStart`/`onStreamEvent` interferes.

17. **Two-session interleaving.** Drive two responses back-to-back with different session IDs (truly-concurrent execution isn't reliably testable on a single-threaded JS runtime without workers; the back-to-back shape exercises the same invariant deterministically). Assert per-session files don't overwrite each other; `account.json` reflects whichever response wrote last; both per-session files retain their own `cache` blocks.

### Tooling test (light): `tools/quota-statusline.sh`

The shell script's complexity is mostly Python in a heredoc, so a node-based test isn't a clean fit. Verify manually post-merge: feed the script a stdin JSON with `session_id`, populate the new files, run it, confirm the displayed label still parses. Not in CI, but called out in the PR's manual-verification checklist.

## Out of scope

- Migrating `~/.claude/skills/coffee/SKILL.md` — tracked at coffee#1; lives in a different repo.
- Migrating the visits-01-only `~/.claude/hooks/quota-statusline.sh` — Lead/AI-Team-Lead handles that on the visits-01 host alongside the merge.
- Updating community dashboards / Web Manager / npm-side consumers — none read the local file (verified by Lead in #104). No external migration required.
- preload.mjs — single-session path by construction; bug doesn't apply; deprecated and shrinking.
- A "last-request snapshot" backwards-compat alias at `~/.claude/quota-status.json`. Direction (2) was rejected; don't reintroduce it via a side door.
- Cross-session aggregation use cases ("worst quota across all my sessions"). Account-level quota is the same fact regardless of session, so `account.json` already covers the meaningful aggregate.

## Acceptance

- `proxy/extensions/cache-telemetry.mjs` writes `~/.claude/quota-status/account.json` and `~/.claude/quota-status/<session-id>.json` per the design above, atomically, with the TTL sweep throttled and configurable.
- Legacy `~/.claude/quota-status.json` is removed on the first invocation per proxy process and not recreated.
- `proxy/extensions/microcompact-stability.mjs` recognises `x-claude-code-session-id` in its fallback chain.
- `tools/quota-statusline.sh`, `tools/cache-test.sh`, `tools/cross-version-cache-test.sh` updated to the new paths.
- All new tests pass (#1–#17); full proxy test suite green.
- CHANGELOG entries drafted for `### Changed` (path migration) and `### Fixed` (microcompact session-id fix).
- Codex review with no blocking findings before merge.

— Proxy Builder
