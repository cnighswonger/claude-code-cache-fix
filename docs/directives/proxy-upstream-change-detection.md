# Directive: Upstream change detection extension

**Issue:** #39
**Branch:** `feature/upstream-change-detection`
**Stage:** directive
**Milestone:** v3.2.0

## Goal

Detect when Anthropic ships CC updates that change the structural shape of `/v1/messages` requests, so we learn about cache-busting structural changes proactively rather than from user cost-spike reports. Read-only — no mutation, just fingerprint + diff + alert.

## Why

Recent costly examples we discovered the hard way:

| Version | Change | How we found out |
|---|---|---|
| v2.1.112 | `cache_control` marker count went 2 → 3 | User cost-spike reports + manual diffing |
| v2.1.112 | `[1m]` context tag silently removed from model string | CC issue #50083 |
| v2.1.113 | Bun binary replaced Node, killing preload | User reports + retro investigation |

Each one took days to characterize after-the-fact. A passive structural fingerprint compared call-to-call would have surfaced "marker count went from 2 to 3 on this request" within a few minutes of the first v2.1.112 invocation — and the fingerprint difference would have pointed straight at the structural delta to investigate.

This is not a fix mechanism. It is an early-warning sensor.

## Scope (v3.2.0)

In scope:
- New extension `upstream-change-detection.mjs`.
- Pure-function fingerprinter that produces a stable structural hash of each request body (NO prompt content, NO user data — only counts, positions, hashes of immutable identifiers).
- Maintain an in-memory "current baseline" fingerprint per `(model_string, beta_headers_set)` keyed namespace.
- On every call: produce fingerprint, compare to baseline. If different → write alert + update baseline.
- Local debug log line via existing `[upstream-change]` prefix on `CACHE_FIX_DEBUG=1`.
- Structured JSONL alerts file at `~/.claude/upstream-changes.jsonl` (always written when an alert fires; readable by downstream tooling).
- Sticky baseline: persist the latest baseline per namespace to `~/.claude/upstream-baseline.json` so a proxy restart doesn't trigger a false-positive flood on the first call. **First-ever run** for a namespace produces a "baseline established" record, not an "alert".

Out of scope (deferred):
- Remote telemetry endpoint (the `CACHE_FIX_TELEMETRY_URL` POST). Tracked as a follow-up — design needs a privacy review and a server endpoint to receive it; v3.2.0 ships the local detection only. Issue body's "remote telemetry" section becomes a v3.3.0 candidate.
- Cross-installation correlation / dashboard. Same reasoning.
- Anything that mutates the request.

## Implementation choice

New standalone extension. `cache-telemetry` reads response headers; this reads request body. They live in different lifecycle phases (`onRequest` vs `onResponseStart`) and have unrelated state machines.

Order: 50 (very early in the request pipeline, before any mutation extension touches the body — we want the fingerprint of what CC actually sent, not what we rewrote it to).

Lifecycle hook: `onRequest(ctx)` — read `ctx.body`, compute fingerprint, compare, log/write. Read-only.

## Fingerprint shape

The fingerprint must satisfy two constraints:
1. **Stable across non-structural changes** — different prompt text, different timestamps, different gitStatus content must NOT change the fingerprint.
2. **Sensitive to structural changes** — added/removed `system[]` block, `cache_control` marker count change, beta header addition, tool added/removed, new system-reminder pattern must change the fingerprint.

Proposed structure:

```json
{
  "version": 1,
  "timestamp": "<ISO>",
  "namespace": {
    "model": "claude-opus-4-7-20260201",
    "beta_headers_sorted": ["claude-extended-cache-ttl-2025-04-11", "..."]
  },
  "system": {
    "block_count": 3,
    "block_types_in_order": ["text", "text", "text"],
    "block_size_buckets": ["small", "large", "small"],
    "block_role_markers": [null, "Environment", null],
    "cache_control_count": 2,
    "cache_control_positions": [1, 2]
  },
  "tools": {
    "count": 31,
    "names_sorted_hash": "<sha256(sorted-names).slice(0,16)>",
    "schema_shape_hash": "<sha256(stringify(sorted-name-to-param-keys-map)).slice(0,16)>"
  },
  "messages": {
    "count": 142,
    "first_role": "user",
    "cache_control_count_in_messages": 1,
    "system_reminder_patterns_seen": ["<system-reminder>", "<command-name>", "<command-message>"]
  },
  "request_extras": {
    "has_thinking": true,
    "has_metadata": true,
    "stream": true,
    "max_tokens_bucket": "8k-32k"
  }
}
```

**Block size buckets**: tiny (<200 chars), small (200–2000), medium (2000–20000), large (>20000). Bucketed so prompt-content variation doesn't trip the fingerprint, but a sudden new 50KB system block would.

**Block role markers**: parse the first ~80 chars of each system block for stable section markers (`# Environment`, `# System`, `# Tools` etc.). Helps distinguish a re-ordered system block from a brand-new one.

**system_reminder_patterns_seen**: collect distinct opening tags that appear in any message's text content (`<system-reminder>`, `<command-name>`, `<git-status>`, etc.). Sorted set. New tag = potential new injection vector worth knowing about.

## Diff and alert semantics

Compare new fingerprint against the baseline for the same namespace:

1. If no baseline exists → write `{ event: "baseline_established", fingerprint }` to `upstream-changes.jsonl`. Persist baseline. No alert.
2. If fingerprint matches baseline → no-op.
3. If fingerprint differs → compute structural diff, write `{ event: "structural_change", diff: [...], previous, current }` to `upstream-changes.jsonl`. Persist new fingerprint as baseline. Emit one stderr line via `[upstream-change]` prefix.

The diff format lists each top-level field that changed:
```json
{
  "diff": [
    { "path": "system.cache_control_count", "from": 2, "to": 3 },
    { "path": "tools.count", "from": 31, "to": 33 },
    { "path": "messages.system_reminder_patterns_seen", "added": ["<new-tag>"], "removed": [] }
  ]
}
```

**Alert dedup**: once a baseline updates, the next identical fingerprint is the new normal. We do NOT keep alerting on the same change. The diff itself is the alert; the baseline shifts atomically.

**Throttle**: if more than 10 alerts fire within 60 seconds (e.g., something is genuinely thrashing), emit a single `{ event: "alert_storm", count }` entry and suppress further alerts for 5 minutes. Document this. Belt-and-suspenders against a fingerprint bug producing infinite alerts.

## Baseline persistence

`~/.claude/upstream-baseline.json` shape:
```json
{
  "version": 1,
  "namespaces": {
    "<sha256(namespace).slice(0,16)>": {
      "namespace": { "model": "...", "beta_headers_sorted": [...] },
      "fingerprint": { /* full fingerprint */ },
      "established_at": "<ISO>",
      "last_updated_at": "<ISO>",
      "update_count": 7
    }
  }
}
```

Atomic write: write to `.tmp` with unique suffix, then rename. Same pattern as prefix-diff and deferred-tools-restore.

On extension load: read existing baseline file (treat unreadable as empty — log via debug, don't throw).

## Env vars

- `CACHE_FIX_UPSTREAM_DETECTION=1` — opt-in, default off (this is a new diagnostic).
- `CACHE_FIX_UPSTREAM_DIR` — override path for `upstream-baseline.json` and `upstream-changes.jsonl` (defaults to `~/.claude/`). Standard runtime override.
- `CACHE_FIX_UPSTREAM_QUIET=1` — suppress stderr emission, keep JSONL.

## Test seam

Pure functions exported alongside `default`:
- `computeFingerprint(body)` → fingerprint object
- `diffFingerprints(prev, current)` → diff array
- `bucketBlockSize(size)` → string
- `extractSystemReminderPatterns(messages)` → sorted Set→Array
- `namespaceKey(model, betaHeadersArr)` → string

Tests pass `dir` option directly to writers, mirroring the prefix-diff / image-strip / deferred-tools-restore conventions.

## Test plan

Minimum coverage:

1. **Stability across prompt variation**: same structural shape with different message text → identical fingerprint
2. **Stability across timestamp drift**: same structural shape with different timestamps → identical fingerprint
3. **Detect cache_control count change**: 2 → 3 markers → diff captures `system.cache_control_count`
4. **Detect tool addition**: tools array grows → diff captures `tools.count` AND `tools.names_sorted_hash`
5. **Detect new system-reminder tag**: a new `<…>` opening tag appears → diff captures `messages.system_reminder_patterns_seen.added`
6. **Detect system block size jump**: a small block becomes large → diff captures `system.block_size_buckets`
7. **Namespace separation**: different model string → separate baseline, no cross-pollution
8. **Beta header addition**: same model, new beta header → separate namespace
9. **Baseline established event**: first-ever fingerprint for a namespace → `event: "baseline_established"`, no alert
10. **Baseline persistence**: write fingerprint, restart (re-import), read baseline → identical, no false alert on next call
11. **Atomic write**: kill mid-write (simulated via tmp file collision) → never leaves a corrupt baseline
12. **Throttle**: 11 changes in <60s → 10 events + 1 `alert_storm` + suppression
13. **Disabled**: env var unset → extension is no-op, no files created
14. **Quiet mode**: `CACHE_FIX_UPSTREAM_QUIET=1` → no stderr, JSONL still written
15. **Concurrency**: parallel calls don't corrupt JSONL (atomic-append) or baseline (atomic-rename)
16. **Block role marker extraction**: known markers (`# Environment`, `# System`) parsed correctly; unknown blocks → `null`

## Files modified / created

| File | Change |
|---|---|
| `proxy/extensions/upstream-change-detection.mjs` | NEW — extension module |
| `tests/upstream-change-detection.test.mjs` | NEW — covers all 16 test-plan items |
| `extensions.json` | Add entry, default `enabled: false` |
| `README.md` | Document new extension + env vars in the extensions table |

## Reviewer checklist

- [ ] Fingerprint contains NO prompt text, NO user content, NO file paths from gitStatus, NO message bodies — only counts, positions, bucketed sizes, hashes of immutable identifiers.
- [ ] Pure functions exported for testing.
- [ ] No request mutation — `onRequest` only reads from `ctx.body`.
- [ ] Baseline file uses atomic write (tmp + rename) with unique tmp suffix.
- [ ] JSONL writes are atomic-append, never partial-write a record.
- [ ] First-ever fingerprint produces `baseline_established`, not an alert.
- [ ] Throttle behaves correctly under simulated alert storm.
- [ ] All env vars follow `CACHE_FIX_UPSTREAM_*` naming pattern.
- [ ] No new top-level dependencies.
- [ ] Tests pass on Node 18, 20, 22 (CI matrix).
- [ ] `extensions.json` default is `enabled: false`.
- [ ] README documents the new extension and links the issue.

## Out of scope (explicit)

- **Remote telemetry endpoint** (`CACHE_FIX_TELEMETRY_URL` POST). Deferred to v3.3.0+ pending privacy review and server endpoint design.
- **Cross-installation correlation dashboard.** Same reasoning.
- **Auto-remediation** when a structural change is detected. Detection only. Any fix is human-in-the-loop.
- **Heuristics that classify changes as "cache-busting" vs "benign."** v3.2.0 reports the structural diff verbatim; the human reading the alert decides what to do.

— AI Team Lead
