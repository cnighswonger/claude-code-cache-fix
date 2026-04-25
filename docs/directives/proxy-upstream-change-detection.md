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

## Activation model

This directive uses the **`prefix-diff` pattern**: `enabled: true` in `extensions.json` (so the module is always loaded) plus an internal env-var gate that no-ops the extension when the user hasn't opted in. Codex review of the previous draft caught the same issue that affected #79: `enabled: false` plus an env var cannot work because disabled extensions are never loaded by `proxy/pipeline.mjs`.

Concretely:
- `extensions.json` ships with `upstream-change-detection: { enabled: true }`.
- The extension's `onRequest` hook short-circuits on the very first line if `process.env.CACHE_FIX_UPSTREAM_DETECTION !== "1"`.
- No file is created, no baseline is loaded, no fingerprint is computed unless the env var is set.

## Hook lifecycle

| Hook / Event | Action |
|---|---|
| Module load | Best-effort read of `~/.claude/upstream-baseline.json` into a module-scope `Map<namespaceKey, fingerprint>`. Treat unreadable / corrupt as empty (debug-log, do not throw). |
| `onRequest(ctx)` | If env-gate off → return. Compute namespace key (model + sorted beta headers). Compute fingerprint from `ctx.body`. Look up baseline by namespace key. If absent → write `baseline_established` event to JSONL, store fingerprint in map, atomically persist to file. If present and equal → no-op. If present and different → compute diff, write `structural_change` event with diff to JSONL, replace baseline in map and persist. Emit one stderr line. Never throw. |
| Hot reload | The module-scope Map resets to empty. The next `onRequest` for a known namespace re-reads it from `~/.claude/upstream-baseline.json`. There is no false-positive flood because the file persists across reloads. |

State that lives in module scope (not persisted across hot-reload):
- `namespaceMap: Map<namespaceKey, fingerprint>` — repopulated from disk on first call after reload.

State that persists to disk:
- `~/.claude/upstream-baseline.json` — full per-namespace baseline (atomic tmp + rename).
- `~/.claude/upstream-changes.jsonl` — append-only event log (single-syscall append).

There is **no in-memory throttle state machine** — see "Out of scope" below for the rationale.

## Fingerprint shape

The fingerprint must satisfy three constraints:
1. **Stable across non-structural changes** — different prompt text, different timestamps, different gitStatus content must NOT change the fingerprint.
2. **Sensitive to structural changes** — added/removed `system[]` block, `cache_control` marker count change, beta header addition, tool added/removed, new system-reminder pattern must change the fingerprint.
3. **Mechanically content-free** — every persisted field must be a count, a position, a boolean, a bucket label, or a hash of stable identifiers (model strings, beta header names, tool names from a known schema). No parsed section names. No extracted message text. No file paths. A reviewer must be able to read the schema and confirm zero user data could leak even if the JSONL is shared.

Proposed structure (NO timestamp inside — timestamps live in event records, not in the fingerprint payload):

```json
{
  "version": 1,
  "namespace": {
    "model": "claude-opus-4-7-20260201",
    "beta_headers_sorted_hash": "<sha256(sorted-beta-header-names).slice(0,16)>",
    "beta_headers_count": 4
  },
  "system": {
    "block_count": 3,
    "block_types_in_order": ["text", "text", "text"],
    "block_size_buckets": ["small", "large", "small"],
    "known_section_marker_set_hash": "<sha256(sorted-detected-marker-indices-from-allowlist).slice(0,16)>",
    "known_section_marker_count": 2,
    "unknown_section_marker_present": false,
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
    "known_reminder_pattern_set_hash": "<sha256(sorted-detected-pattern-indices-from-allowlist).slice(0,16)>",
    "known_reminder_pattern_count": 3,
    "unknown_reminder_pattern_present": false
  },
  "request_extras": {
    "has_thinking": true,
    "has_metadata": true,
    "stream": true,
    "max_tokens_bucket": "8k-32k"
  }
}
```

### Closed allowlists

To detect "a new section marker" or "a new reminder tag" without persisting the actual text, the extension carries hardcoded allowlists:

```js
// proxy/extensions/upstream-change-detection.mjs
const KNOWN_SECTION_MARKERS = [
  "# Environment",
  "# System",
  "# Tools",
  "# Personality",
  "# Settings",
  "# Memory",
  // ... add more as observed
];

const KNOWN_REMINDER_PATTERNS = [
  "<system-reminder>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<git-status>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  // ... add more as observed
];
```

For each request, the extension scans system blocks / message text against the allowlist. The fingerprint records:
- **Which known items matched** as a hash of sorted indices into the allowlist (e.g., indices `[0, 2]` → matched "# Environment" and "# Tools" → hash `sha256("0,2")`).
- **How many known items matched** as a count.
- **Whether any text matched the *shape* of a marker but was not in the allowlist** as a single boolean (`unknown_section_marker_present` / `unknown_reminder_pattern_present`).

The "unknown present" boolean uses a tightly-bounded shape regex (e.g., `/^# [A-Z][a-zA-Z ]{1,30}$/` for section markers, `/<[a-z][a-z-]{1,30}>/` for reminder tags). It records ONLY whether one or more matches existed. It does NOT capture the matching text.

When the boolean flips false → true, that is the signal that "Anthropic shipped a new tag we haven't seen." The operator investigating the alert can run a one-shot diagnostic dump (e.g., `CACHE_FIX_UPSTREAM_DUMP_NEXT_BODY=1`, separate feature, NOT in v3.2.0) to capture the actual body of the next call for inspection. v3.2.0 only flags "something new exists"; it does not record what.

**Block size buckets**: tiny (<200 chars), small (200–2000), medium (2000–20000), large (>20000). Bucketed so prompt-content variation doesn't trip the fingerprint, but a sudden new 50KB system block would.

### What this fingerprint will NOT detect

Trade-offs of the content-free design:
- **Renaming a known marker** (e.g., `# Environment` → `# Env`) — the new name doesn't match the allowlist, so it appears as `unknown_section_marker_present: true`. We notice "something changed," but not what.
- **Two semantically-different markers being added simultaneously** — the `unknown_*_present` boolean flips once and stays true; the count of unknown items isn't recorded.
- **Reordering blocks within a same-types-and-sizes layout** — `block_types_in_order` and `block_size_buckets` would change if positions change, so reordering IS detected; but cosmetic-only reorders that preserve the type/size sequence would not be.

These are acceptable for v3.2.0. The goal is "we know something structural changed," not "we have a reproducer." If a v3.3.0 design wants more, it can opt in to a content-capture mode at the cost of explicit user consent.

## Diff and alert semantics

Equality is a structural comparison of the fingerprint payload. There is no timestamp inside the fingerprint object, so identical structures compare equal trivially.

Compare new fingerprint against the baseline for the same namespace:

1. If no baseline exists → write `{ ts: <ISO>, event: "baseline_established", namespace, fingerprint }` to `upstream-changes.jsonl`. Persist baseline. No alert.
2. If fingerprint matches baseline → no-op.
3. If fingerprint differs → compute structural diff, write `{ ts: <ISO>, event: "structural_change", namespace, diff: [...], previous, current }` to `upstream-changes.jsonl`. Persist new fingerprint as baseline. Emit one stderr line via `[upstream-change]` prefix.

The diff format lists each top-level field that changed:
```json
{
  "diff": [
    { "path": "system.cache_control_count", "from": 2, "to": 3 },
    { "path": "tools.count", "from": 31, "to": 33 },
    { "path": "messages.unknown_reminder_pattern_present", "from": false, "to": true }
  ]
}
```

**Timestamps live in event records, not in the fingerprint payload.** This separation is what makes structural equality a straight `JSON.stringify(a) === JSON.stringify(b)` (after the canonical key ordering the fingerprint builder uses).

**Alert dedup**: once a baseline updates, the next identical fingerprint is the new normal. We do NOT keep alerting on the same change. The diff itself is the alert; the baseline shifts atomically.

## Persistence and atomicity contracts

### `~/.claude/upstream-baseline.json` (full replace)

Shape:
```json
{
  "version": 1,
  "namespaces": {
    "<sha256(namespace).slice(0,16)>": {
      "namespace": { "model": "...", "beta_headers_sorted_hash": "...", "beta_headers_count": 4 },
      "fingerprint": { /* full fingerprint */ },
      "established_at": "<ISO>",
      "last_updated_at": "<ISO>",
      "update_count": 7
    }
  }
}
```

**Atomicity contract:** write the full JSON document to `<final>.tmp.<pid>.<unix-ms>.<random4>`, fsync the tmp file, then `fs.rename(tmpPath, finalPath)`. POSIX `rename(2)` is atomic on the same filesystem — readers either see the prior version or the new version, never a partial write. Same pattern as `prefix-diff.atomicWriteJson` (see `proxy/extensions/prefix-diff.mjs:144`). On rename failure the prior `<final>` is intact and the tmp file is unlinked in a `finally` block.

On extension load: best-effort read `<final>` (treat unreadable / corrupt JSON as empty map — debug-log, do not throw).

### `~/.claude/upstream-changes.jsonl` (append-only event log)

**Atomicity contract:** each event record is written via a single `fs.promises.appendFile(path, recordString + "\n")` call. POSIX guarantees that an `O_APPEND` open atomically combines the offset adjustment with the write, so concurrent appenders cannot lose each other's data to torn offsets. POSIX does NOT, however, guarantee that the write itself is non-interleaved at sub-write granularity for regular files — that is a kernel and filesystem implementation detail. (`PIPE_BUF` atomicity, often cited in this context, applies to pipes and FIFOs, not regular files. The previous draft of this directive overclaimed by citing it for this case.)

In practice on Linux with ext4 / xfs / btrfs and a single `write(2)` syscall of a buffer well under one page (4096 bytes), record-level interleaving does not occur. This is empirical Linux kernel behavior, not a portable POSIX guarantee. Test #14 in the test plan exercises it directly: 50 parallel writes, assert no interleaving. If that test ever fails on a platform we support, the implementation must escalate to a stronger mechanism.

We accept the empirical guarantee for v3.2.0 because:
- Each event record is well under 4 KB — small enough to land in a single kernel write buffer.
- Structural-change events are rare (one per fingerprint change per namespace), so contention is low even under proxy load.
- Loss or corruption of a single event record is annoying but not catastrophic — this is a diagnostic log, not transactional state.

If a future change makes records larger or events more frequent, the upgrade path is one of: per-record `tmp + rename` (same pattern as the baseline file), `flock(2)`-protected appends, or a single-writer queue. The choice gets documented when the need arises.

## Env vars

- `CACHE_FIX_UPSTREAM_DETECTION=1` — runtime activation gate (matches `prefix-diff` pattern). When unset, the extension is loaded but `onRequest` returns immediately on the first line. No file is created, no baseline is loaded, no fingerprint is computed.
- `CACHE_FIX_UPSTREAM_DIR` — override path for `upstream-baseline.json` and `upstream-changes.jsonl` (defaults to `~/.claude/`). Runtime override only.
- `CACHE_FIX_UPSTREAM_QUIET=1` — suppress stderr emission, keep JSONL.

## Test seam

Pure functions exported alongside `default`:
- `computeFingerprint(body)` → fingerprint object (no timestamp, deterministic)
- `diffFingerprints(prev, current)` → diff array
- `bucketBlockSize(size)` → string
- `matchKnownSectionMarkers(blockText)` → sorted array of allowlist indices
- `matchKnownReminderPatterns(messageText)` → sorted array of allowlist indices
- `hasUnknownSectionMarker(blockText)` → boolean
- `hasUnknownReminderPattern(messageText)` → boolean
- `namespaceKey(model, betaHeadersArr)` → string

Tests pass `dir` option directly to writers, mirroring the prefix-diff / image-strip / deferred-tools-restore conventions.

## Test plan

Minimum coverage:

1. **Stability across prompt variation**: same structural shape with different message text → identical fingerprint
2. **Stability across event timestamp drift**: same structural shape with different `Date.now()` at compute time → identical fingerprint (timestamps are not in the fingerprint payload)
3. **Detect cache_control count change**: 2 → 3 markers → diff captures `system.cache_control_count`
4. **Detect tool addition**: tools array grows → diff captures `tools.count` AND `tools.names_sorted_hash`
5. **Detect new known reminder tag**: a known tag appears for the first time → diff captures `messages.known_reminder_pattern_set_hash` AND `messages.known_reminder_pattern_count`
6. **Detect new UNKNOWN reminder tag**: a tag matching the shape regex but not in the allowlist appears → `messages.unknown_reminder_pattern_present` flips false → true
7. **Detect system block size jump**: a small block becomes large → diff captures `system.block_size_buckets`
8. **Namespace separation**: different model string → separate baseline, no cross-pollution
9. **Beta header addition**: same model, new beta header → separate namespace (different `beta_headers_sorted_hash` AND `beta_headers_count`)
10. **Baseline established event**: first-ever fingerprint for a namespace → `event: "baseline_established"`, no alert
11. **Baseline persistence**: write fingerprint, simulate proxy restart by clearing the in-memory map and re-importing → next call reads baseline from disk, no false alert
12. **Atomic baseline write — crash before rename**: inject a `rename` failure (mock fs) → prior baseline file remains intact, no corruption, tmp file cleaned up in `finally`
13. **Atomic baseline write — unique tmp suffix**: two concurrent baseline writes use distinct tmp paths and both succeed (last writer wins, no tmp collision)
14. **JSONL append concurrency**: spawn 50 parallel `appendFile` calls with distinct events → result file has exactly 50 well-formed JSON lines, no truncation, no interleaving
15. **Disabled**: env var unset → extension is no-op, no files created, no baseline read
16. **Quiet mode**: `CACHE_FIX_UPSTREAM_QUIET=1` → no stderr, JSONL still written
17. **Allowlist match correctness**: known section markers detected with correct allowlist indices; unknown markers do NOT appear in the indices array
18. **Content-free guarantee**: a fingerprint computed from a body containing the string `"SECRET-TOKEN-XYZ"` → assert `JSON.stringify(fingerprint).includes("SECRET-TOKEN-XYZ") === false`. This is the unit-level enforcement of the content-free invariant.

## Files modified / created

| File | Change |
|---|---|
| `proxy/extensions/upstream-change-detection.mjs` | NEW — extension module |
| `test/upstream-change-detection.test.mjs` | NEW — covers all 18 test-plan items |
| `extensions.json` | Add entry, `enabled: true` (extension is always loaded; runtime gated by `CACHE_FIX_UPSTREAM_DETECTION=1`) |
| `README.md` | Document new extension + env vars in the extensions table |

## Reviewer checklist

- [ ] Fingerprint contains NO prompt text, NO user content, NO file paths from gitStatus, NO message bodies — only counts, positions, bucketed sizes, hashes of stable identifiers (model strings, beta header names, tool names).
- [ ] Allowlist match results stored as hash-of-sorted-indices, not as the matched text itself.
- [ ] Unknown-marker / unknown-pattern detection records ONLY a boolean — never the matched text.
- [ ] Test #18 (content-free guarantee — secret string never appears in fingerprint) passes.
- [ ] Fingerprint payload contains NO timestamp; timestamps live in event records only.
- [ ] Pure functions exported for testing.
- [ ] No request mutation — `onRequest` only reads from `ctx.body`.
- [ ] Baseline file uses atomic write (tmp + rename) with unique-per-invocation tmp suffix.
- [ ] JSONL writes are single-syscall `appendFile` of `recordString + "\n"`; no record exceeds 4 KB at the time of writing. Atomicity is empirical Linux kernel behavior (NOT POSIX `PIPE_BUF`, which applies to pipes/FIFOs only); validated by test #14.
- [ ] First-ever fingerprint produces `baseline_established`, not an alert.
- [ ] All env vars follow `CACHE_FIX_UPSTREAM_*` naming pattern.
- [ ] `extensions.json` entry has `enabled: true`; runtime gated by `CACHE_FIX_UPSTREAM_DETECTION=1` (matches `prefix-diff` pattern).
- [ ] When `CACHE_FIX_UPSTREAM_DETECTION` is unset, `onRequest` returns on the first line — no file created, no baseline read.
- [ ] Tests live under `test/`, not `tests/`.
- [ ] No new top-level dependencies.
- [ ] Tests pass on Node 18, 20, 22 (CI matrix).
- [ ] README documents the new extension and links the issue.

## Out of scope (explicit)

- **Remote telemetry endpoint** (`CACHE_FIX_TELEMETRY_URL` POST). Deferred to v3.3.0+ pending privacy review and server endpoint design.
- **Cross-installation correlation dashboard.** Same reasoning.
- **Auto-remediation** when a structural change is detected. Detection only. Any fix is human-in-the-loop.
- **Heuristics that classify changes as "cache-busting" vs "benign."** v3.2.0 reports the structural diff verbatim; the human reading the alert decides what to do.
- **Alert-storm throttle.** Removed from v3.2.0 scope per Codex review feedback. Adding another time-window state machine to a feature whose only goal is read-only structural diffing is more complexity than the operational risk justifies. The fingerprint design itself prevents alert storms in normal operation: an alert fires only when the fingerprint changes, and a new baseline replaces the old one immediately so the same change cannot fire twice. If a fingerprint bug ever does produce an alert storm in production, that is a bug to fix at the source, not to suppress at a throttle. Reconsider in v3.3.0 if real-world data shows it's needed.
- **Content-capture mode** for investigating unknown markers / patterns. The boolean flip alone is the v3.2.0 signal. A separate one-shot diagnostic dump (e.g., `CACHE_FIX_UPSTREAM_DUMP_NEXT_BODY=1`) could land later as opt-in capture for post-alert investigation.
- **Detection of marker renames** (e.g., `# Environment` → `# Env`) beyond surfacing the rename as `unknown_section_marker_present: true`. We notice "something changed" but cannot reproduce it from the fingerprint alone.

— AI Team Lead
