# Directive: add `request_id` to usage-log row schema

**Issue:** TBD (will be filed alongside this directive)
**Branch:** `feature/usage-log-request-id`
**Stage:** directive
**Milestone:** v4.1.0 (minor — additive schema field)

## Goal

Add a single field, `request_id`, to the `MeterRowSchema v:1` wire format emitted by the `usage-log` extension. Source the value from the upstream `request-id` response header. Make the field optional in the schema so existing consumers don't break. With this, post-hoc joins between `~/.claude/usage.jsonl` and CC's per-session JSONL transcripts at `~/.claude/projects/<project>/<CC-session-id>.jsonl` become a one-line `jq` operation, recovering session attribution for every meter row without changing any other schema field.

## Why

`~/.claude/usage.jsonl` is the meter-pipeline source of truth for token/quota burn across the proxy. It carries `sid` (8-char hex), but `sid` is `sha256(pid + Date.now() + Math.random()).slice(0,8)` generated **once at proxy boot** and sticky for the proxy's lifetime. Every CC session served by that proxy boot shares the same `sid`. There is no per-row CC session identifier and no signal that could be reliably joined against CC's own session records.

This makes session-level questions unanswerable from the meter view:

- "Which session burned 80% of today's Opus tokens?" — unanswerable
- "What was session X's hit-rate trajectory over the last 4 hours?" — unanswerable
- "Did the ANTHROPIC_SMALL_FAST_MODEL side calls dominate this session's cost?" — unanswerable
- "Which sessions hit overage today?" — partially answerable from `rate-limit-events.jsonl` (which DOES carry `session_id`), but only for the 429 subset

Inference from existing fields (`ts` clustering, `cache_read` reset patterns, model coherence) gives ~80% accuracy on single-user hosts and collapses on multi-session ones. It's a heuristic, not a join.

CC's per-session JSONL transcripts at `~/.claude/projects/<project-slug>/<session-uuid>.jsonl` already carry `requestId` for every API call (verified shape: `req_011CbQL6e8qVERUXKwYqUMMi`). The upstream `request-id` response header is the same value. Capturing it in the meter row makes the join trivial:

```bash
# Find which CC session each usage.jsonl row belongs to:
for row in $(jq -c . < ~/.claude/usage.jsonl); do
  req=$(jq -r .request_id <<< "$row")
  grep -l "\"requestId\":\"$req\"" ~/.claude/projects/*/*.jsonl
done
```

That single addition unlocks every session-attribution view that's currently missing. No model change, no privacy concern (request_id is already in plain text in both the proxy log header and CC's local transcripts).

## Non-Functional Requirements

- **Size/complexity budget:** trivial — one field extraction in `usage-log.mjs`, one corresponding addition in `MeterRowSchema` over in `claude-code-meter`, plus tests on both sides. ~30 LOC total in cache-fix; similar on meter side. Flag at review if it grows past that.
- **Threat model:** `request-id` is opaque, server-generated, and already visible in plain text in CC's local transcripts and in upstream response headers. No new sensitive surface. The field MUST be optional in the schema (some response paths may not carry the header — defensive failures, mocked test traffic, etc.) so absent rows still validate.
- **Maintainability constraints:** reuse the existing `usage-log` extension's onResponseStart hook to capture the header (which is where current quota-header parsing already happens). No new abstractions. Schema change is a single line addition in `MeterRowSchema`. No back-compat shims needed beyond the optional marker.
- **Performance/reliability:** O(1) per request. The header is already in the response context — no additional parsing.
- **Load-bearing? yes** — wire-format contract change with `claude-code-meter` as the cross-repo consumer. Additive (no field removed, no field renamed), schema version stays at `v: 1`, so existing meter installs ignore the field cleanly. But it IS a schema change and requires the same release-ordering discipline as the original meter-compat directive (`proxy-claude-meter-compat.md`): cache-fix ships first, then meter declares the new producer minimum in its README.

## Schema decision

**Field name:** `request_id` (snake_case, matching every other field in `MeterRowSchema v:1`).

**Type:** `z.string().max(64).optional()` — `request-id` headers observed in production are ~26 chars (`req_011CbQL6e8qVERUXKwYqUMMi`); a 64-char ceiling gives us 2.5× headroom for any future format expansion without re-versioning the schema. Optional because missing on response paths that don't carry the header (test mocks, certain error responses).

**Source:** the upstream `request-id` response header. Captured in the existing `onResponseStart` hook in `usage-log.mjs` where quota headers are already parsed. Not the request-side `x-request-id` — that's a CC-generated client id that may or may not match upstream, and the upstream-generated id is what CC's transcript actually records as `requestId`.

**Why we can stay at `v: 1`:** `MeterRowSchema` is `z.strictObject(...)`. Adding an optional field to a strict object is a schema-level breaking change for unmodified consumers — they'd reject rows with the new key. So the meter-side update has to land in lockstep. This means:

- cache-fix ships v4.1.0 with the new field
- meter ships v0.5.0 (or whatever its next is) with the schema update declaring `request_id?` as optional
- meter's README declares "claude-code-cache-fix >= 4.1.0" as the supported producer minimum (mirroring the v3.2.0 contract)

Stays at `v: 1` because it's a pure addition; no consumer's interpretation of any existing field changes. If we ever need to *remove* or *rename* a field, that's `v: 2`. This isn't that.

## Scope

This directive spans **two repositories** with a hard ordering requirement (same shape as the original meter-compat directive).

### Release ordering (mandatory)

1. **First:** `claude-code-cache-fix` v4.1.0 ships the new field. Existing meter installs fail to validate rows carrying the field; this is acceptable IF AND ONLY IF the meter-side update lands in the same week. Document in CHANGELOG that the field is opt-in for now: gated behind `CACHE_FIX_USAGE_LOG_REQID=on` for the v4.1.0 release ONLY, becoming the default in v4.2.0 once meter has shipped. (See below for why this gate is needed.)
2. **Then:** `claude-code-meter` ships its schema update accepting the new optional field. Once released, the gate flips to default-on in cache-fix v4.2.0.

### Why the env-gate for v4.1.0

Without the gate, anyone on cache-fix v4.1.0 + an unpatched meter ingestor would see every row rejected by the strict-object validation. The gate gives operators (and us, on visits-01) a way to ship the cache-fix change without breaking meter ingestion until the meter side catches up. Users running cache-fix without meter (the common case) have no reason to care, and can leave it off.

### Gate env var: `CACHE_FIX_USAGE_LOG_REQID`

Naming follows the brevity of `CACHE_FIX_THINKING_SANITIZE`, `CACHE_FIX_IMAGE_GUARD`, `CACHE_FIX_AUTO_1M_GUARD` (noun/feature without subfield qualifier). `REQID` over `REQUEST_ID` matches the project's preference for compact env names; the docstring, CHANGELOG, and README carry the full word.

### Note for the v4.2.0 follow-up directive

When v4.2.0 ships default-on, any operator running v4.2.0 + a pre-v0.5.0 (or whatever-the-meter-min-version-becomes-by-then) meter sees row rejection on every meter row. The follow-up directive's reviewer checklist must call out this upgrade coupling explicitly ("v4.2.0 requires meter >= v0.5.0; upgrade meter first") and the v4.2.0 CHANGELOG must front-load it.

### Repo 1: `claude-code-cache-fix` (this PR)

Files to modify:

- `proxy/extensions/usage-log.mjs` — capture `request-id` response header in `onResponseStart`, stash on `ctx.meta._upstreamRequestId`, emit in `assembleRecord` when the gate env var is on AND the header was present
- `test/proxy-usage-log.test.mjs` — add cases: header present + gate on → field emitted; header absent + gate on → field absent (optional); gate off → field never emitted; field is a string of expected shape
- `CHANGELOG.md` — `### Added` entry under the v4.1.0 section explaining the field, the gate, and the release-ordering pair with claude-meter
- `README.md` — extend the existing usage-log section (which currently shows the `MeterRowSchema` field table) with the `request_id` row, document its semantics in the same style as the other field rows, and include a one- or two-line operational example showing the post-hoc join against CC's per-session JSONL transcripts. The directive's earlier "do not disclose join details" framing was misjudged — the README already documents every other field's semantics, and the join recipe IS the field's value.

### Repo 2: `claude-code-meter` (separate PR in that repo, not this PR)

- `src/log/schema.mjs` — add `request_id: z.string().max(64).optional()` to `MeterRowSchema`
- `src/log/schema.test.mjs` — schema tests covering the field
- `README.md` — declare `claude-code-cache-fix >= 4.1.0` as the supported producer minimum
- `CHANGELOG.md` — note the schema acceptance change

### Repo 3: cache-fix v4.2.0 (later, follow-up directive)

Flip the default-on. Drop the env-gate. CHANGELOG note: "request_id is now default-on; meter >= v0.5.0 required."

## Implementation choice (cache-fix side)

Capturing the header at `onResponseStart` mirrors the existing quota-header parse path in the same extension. The header reaches the extension via `ctx.headers` (response headers). Existing `onResponseStart` hook in `cache-telemetry.mjs` is the precedent — same shape.

Pseudocode for the addition in `usage-log.mjs`:

```js
// Inside onResponseStart, alongside existing quota parsing:
const upstreamReqId = ctx.headers?.["request-id"];
if (upstreamReqId && typeof upstreamReqId === "string" && upstreamReqId.length <= 64) {
  ctx.meta._upstreamRequestId = upstreamReqId;
}

// Inside assembleRecord, after the optional-fields block:
const enabled = process.env.CACHE_FIX_USAGE_LOG_REQID === "on";
if (enabled && _upstreamRequestId) {
  record.request_id = _upstreamRequestId;
}
```

The env-read happens per-call (matching the `image-strip` debug-gate pattern) so operators can flip it at runtime without proxy restart.

## Test plan (cache-fix side)

- **Unit:** header present + gate on → emitted; header absent + gate on → field omitted from record; gate off → field never emitted regardless of header; field validates against shape (string, ≤64 chars); existing rows without the field still validate against the existing `MeterRowSchema v:1` shape.
- **Integration (Proxy Test Agent):** live request through proxy with gate on, verify `request_id` field is present in the emitted JSONL row, verify the captured value matches what `gh api` or `curl` would observe on the same request, verify a parallel CC session's JSONL transcript at `~/.claude/projects/...` records the same `requestId` value for the same request.
- **Regression:** existing `proxy-usage-log.test.mjs` cases pass unchanged with gate off.

## Test plan (claude-meter side — for the separate PR)

- Schema test: a v:1 row with `request_id` validates; a v:1 row without `request_id` validates; a row with `request_id` longer than 64 chars fails; non-string `request_id` fails.
- Ingest test: ingesting rows from a sample `usage.jsonl` produced by cache-fix v4.1.0 with the gate on produces no validation errors.

## Files modified / created

### `claude-code-cache-fix` (this PR)

- `proxy/extensions/usage-log.mjs` — capture + emit
- `test/proxy-usage-log.test.mjs` — new cases
- `CHANGELOG.md` — v4.1.0 entry
- `README.md` — extend usage-log section

### `claude-code-meter` (separate PR in that repo, not this PR)

- `src/log/schema.mjs` — accept optional field
- `src/log/schema.test.mjs` — coverage
- `README.md` — supported-producer note
- `CHANGELOG.md` — schema-acceptance note

## Reviewer checklist (cache-fix side)

- [ ] Field name is `request_id` (snake_case, matching the rest of the schema)
- [ ] Field is optional, max length 64
- [ ] Source is upstream `request-id` response header (not request-side `x-request-id`)
- [ ] Gate env var is `CACHE_FIX_USAGE_LOG_REQID` and ships default-off in v4.1.0
- [ ] Existing rows (gate off, or gate on but header missing) still validate against the unmodified `MeterRowSchema v:1`
- [ ] CHANGELOG explicitly calls out the release-ordering requirement with claude-meter
- [ ] README extension documents `request_id` semantics in the same style as the rest of the `MeterRowSchema` field table, including a brief operational example of the post-hoc join against CC's per-session JSONL transcripts (per AITL review of the directive: the rest of the README documents every other field's semantics; hiding only this one's recipe would be inconsistent)
- [ ] Tests cover all four cells: (gate on, header present) / (gate on, header absent) / (gate off, header present) / (gate off, header absent)

## Out of scope (explicit)

- **Embedding the CC session id directly in the row.** That would require the proxy to read the `x-claude-code-session-id` request header, which it already does for `cache-telemetry` per-session JSON files. Skipping this in favor of `request_id` because: (1) `request_id` is a single value present in upstream responses regardless of which proxy extension is reading it; (2) it's the natural join key against CC's own transcript records, so it gives session attribution AND request-level correlation in one field; (3) carrying both would be redundant — a row's CC session id is recoverable from `request_id` via the transcript join. If a future use case argues for direct session-id embedding, that's a separate field addition.
- **Schema versioning.** This is a pure addition to `v: 1`; no consumer's reading of existing fields changes. If a future change removes or renames a field, that's `v: 2`. This isn't that.
- **Retroactive backfill of `request_id` on existing rows.** Not technically possible — the upstream `request-id` is not stored anywhere we can recover it from past `usage.jsonl` rows. Forward-only.
- **Changes to `rate-limit-events.jsonl`.** That log already carries `upstream_request_id` (verified in current production samples) and `session_id`. No changes needed there.
- **Changes to per-session `quota-status/sessions/<id>.json`.** Those files are session-keyed by filename already; no row-level join key is needed.
