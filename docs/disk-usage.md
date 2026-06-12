# Disk usage — proxy-written files

This document covers the disk-footprint accounting for files cache-fix-proxy
writes outside of `~/.claude/usage.jsonl` (which is the meter's surface, not
the proxy's). See the individual extension docs for behavior; this doc is the
single place that adds up worst-case bytes per default configuration.

| Extension | Path(s) | Default rotation / retention | Worst-case footprint (defaults) |
|---|---|---|---|
| `bootstrap-defense` | `~/.claude/cache-fix-bootstrap-log.jsonl` (+ `.1`) | 5 MB single-tier | ≤ 10 MB |
| `image-retry-circuit-breaker` | `~/.claude/image-retry-events.jsonl` (+ `.1`) | 5 MB single-tier | ≤ 10 MB |
| `jsonl-session-mirror` (default-off) | `~/.claude/session-mirrors/<sessionFilename>/*.jsonl` + `~/.claude/session-mirrors/session-mirror-events.jsonl` | See below | See below |
| `cache-telemetry` | `~/.claude/quota-status/sessions/*.json` | TTL sweep (`CACHE_FIX_QUOTA_STATUS_TTL_DAYS`, default 30) | Bounded by # sessions × small per-file payload |

## `jsonl-session-mirror`

Per-session active-file rotation at `CACHE_FIX_SESSION_MIRROR_MAX_BYTES` (default 100 MB) AND a retention sweep at `CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS` (default 30) — rotated files past the retention window are unlinked by a throttled (60s) sweep modeled on `cache-telemetry.sweepStaleSessions`.

Worst-case disk footprint:

```
active_sessions × MAX_BYTES × (1 + rotations_within_retention_days)
```

For default configuration (100 MB cap × 30-day retention × 32 sessions × typical 2 rotations/session/month): **~9.6 GB worst case, more typically <500 MB.** Most chat sessions stay well below the 100 MB cap.

Operational events (open / rotate / sweep / error) are logged to `~/.claude/session-mirrors/session-mirror-events.jsonl` with 5 MB single-tier rotation, so the event log itself caps at ≤ 10 MB.

### Tunables for tighter bounds

- `CACHE_FIX_SESSION_MIRROR_MAX_BYTES=10485760` (10 MB) — tighter per-session cap, more frequent rotation.
- `CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS=7` — 7-day retention instead of 30.
- `CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS=128` — smaller LRU cap on the in-memory dedup state map (does NOT bound on-disk files; that's the retention sweep's job).
- `CACHE_FIX_SESSION_MIRROR_INCLUDE_THINKING=false` — excludes `thinking` content blocks from mirror records, reducing per-record bytes (varies by session content).

### Path traversal safety

Session-id resolution and filesystem encoding both reuse `cache-telemetry.sessionFilename(rawId)`:

- safe charset (`[A-Za-z0-9_-]{1,128}`) → raw passthrough
- otherwise → `inv-<sha256[:16]>` (the proxy can never escape `~/.claude/session-mirrors/`)
- sessionless requests bucket to a shared `unknown/` directory

### Default-off in v4.2.0 and v4.3.0

The mirror ships default-off. Flipping plaintext-conversation-persistence to on-by-default is a privacy-posture change that belongs to its own future directive after a real production-validation cycle.
