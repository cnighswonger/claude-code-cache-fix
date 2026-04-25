# Directive: claude-meter compatibility with proxy mode

**Issue:** #70
**Branch:** `feature/claude-meter-compat`
**Stage:** directive (revised after Codex review — see `docs/code-reviews/pr-81-claude-meter-compat-directive-review-2026-04-25.md`)
**Milestone:** v3.2.0

## Goal

Restore `claude-code-meter` functionality for users on CC v2.1.113+ (Bun binary) by repointing it from the broken NODE_OPTIONS preload at the existing `usage-log` JSONL stream the proxy already writes. Keep claude-meter's privacy and validation guarantees intact; eliminate the duplicate collection logic that no longer fires.

## Why

`claude-code-meter` was wired into the legacy CC wrapper via `NODE_OPTIONS="--import .../claude-meter/preload.mjs"`. CC v2.1.113+ ships as a Bun binary that ignores NODE_OPTIONS. Result: every modern CC install silently drops claude-meter rows. We've already pulled the broken README references in v3.1.0 (PR #71); this directive does the actual fix.

The proxy already produces `~/.claude/usage.jsonl` via the `usage-log` extension (`enabled: false` by default). It can capture every field claude-meter needs from the same response stream. Refactoring claude-meter to consume from this file:

- Works for both Bun and Node CC installs
- Decouples claude-meter from CC's binary lifecycle entirely
- Eliminates duplicate fetch-patching logic
- Keeps the proxy as the single point of telemetry collection

## Schema decision

After Codex review, the directive is anchored on a single coherent contract: **the proxy emits EXACTLY the `MeterRowSchema` v:1 shape that claude-meter's strict validator already enforces.** No new schema version. No proxy-only extras. The wire format becomes the single source of truth, owned by the schema file in `claude-code-meter`.

Why this and not the previous "v:2 superset" approach:
- `MeterRowSchema` is `z.strictObject({ v: z.literal(1), ... })` — it rejects extra keys AND requires `v: 1`. Emitting v:2 with extra fields like `peak_hour` would fail validation immediately. Adapting claude-meter to accept v:2 is a real cross-repo coordination cost we don't need.
- Anything the proxy currently emits beyond `MeterRowSchema` (today: `peak_hour`) is either trivially recomputable from `ts` (peak_hour is) or not actually needed downstream.
- Same wire format = simplest possible cross-repo contract.

The current proxy `usage-log` shape (9 fields including `peak_hour`) is replaced wholesale. Existing rows from people who manually enabled `usage-log` were never schema-validated and have no production consumer — they're skipped by the new claude-meter ingest path with a debug log. Documented as a one-time "old format rows are ignored" event in CHANGELOG.

The exact field set the proxy must emit (from `MeterRowSchema` in `claude-code-meter/src/log/schema.mjs`):

| Field | Type | Source |
|---|---|---|
| `v` | literal `1` | constant |
| `ts` | ISO-8601 datetime | `new Date().toISOString()` |
| `sid` | 8-char lowercase hex | proxy session id (sticky for proxy lifetime) |
| `model` | string ≤64, `[a-z0-9._-]+` | `event.message.model` from `message_start` |
| `requested_model` | string ≤64, `[a-z0-9._-]*` (opt) | request body `model` field |
| `model_mismatch` | bool (opt) | `requested_model && model && requested_model !== model` |
| `speed` | enum `"standard"\|"fast"\|""` | `event.message.usage.speed` from `message_start`, fallback `""` |
| `service_tier` | string ≤32, `[a-z0-9_-]*` | `event.message.usage.service_tier` from `message_start`, fallback `""` |
| `input_tokens` | int ≥0 | `event.message.usage.input_tokens` |
| `output_tokens` | int ≥0 | `event.usage.output_tokens` from `message_delta` |
| `cache_creation_input_tokens` | int ≥0 | `event.message.usage.cache_creation_input_tokens` |
| `cache_read_input_tokens` | int ≥0 | `event.message.usage.cache_read_input_tokens` |
| `ephemeral_1h_input_tokens` | int ≥0 | `event.message.usage.cache_creation.ephemeral_1h_input_tokens`, fallback `0` |
| `ephemeral_5m_input_tokens` | int ≥0 | `event.message.usage.cache_creation.ephemeral_5m_input_tokens`, fallback `0` |
| `web_search_requests` | int ≥0 | `event.message.usage.server_tool_use.web_search_requests`, fallback `0` |
| `q5h` | float 0-2 | `anthropic-ratelimit-unified-5h-utilization` |
| `q7d` | float 0-2 | `anthropic-ratelimit-unified-7d-utilization` |
| `q5h_reset` | int ≥0 (unix sec) | `anthropic-ratelimit-unified-5h-reset` |
| `q7d_reset` | int ≥0 (unix sec) | `anthropic-ratelimit-unified-7d-reset` |
| `qstatus` | string ≤32, `[a-z_]*` | `anthropic-ratelimit-unified-status` |
| `qoverage` | string ≤32, `[a-z_]*` | `anthropic-ratelimit-unified-overage-status` |
| `qclaim` | string ≤16, `[a-z_]*` | `anthropic-ratelimit-unified-claim` |
| `qfallback_pct` | float 0-1 | `anthropic-ratelimit-unified-fallback-percentage` |
| `qoverage_util` | float ≥0 (opt) | `anthropic-ratelimit-unified-overage-utilization`, only if header present |
| `qrepresentative_claim` | string ≤16, `[a-z0-9_]*` (opt) | `anthropic-ratelimit-unified-representative-claim`, only if header present |
| `org_id` | string ≤64 (opt) | `sha256(anthropic-organization-id-header).digest("hex").slice(0, 16)`, only if header present — never raw |
| `overage_disabled_reason` | string ≤64 (opt) | header same name, only if header present |
| `cache_hit_rate` | float 0-1 | `cache_read_input_tokens / (input + cache_creation + cache_read)`, `0` when total is `0` |
| `q5h_delta` | float | `q5h - prev_q5h`, `0` on first call after restart |
| `q7d_delta` | float | `q7d - prev_q7d`, `0` on first call after restart |

**`peak_hour` is dropped from the proxy JSONL output.** It can be derived from `ts` if any consumer needs it.

## Scope (v3.2.0)

This directive spans **two repositories** and has a hard ordering requirement.

### Release ordering (mandatory)

1. **First**: `claude-code-cache-fix` ships the expanded `usage-log` shape on a new tag (e.g. `v3.2.0`) with the schema-change CHANGELOG note.
2. **Then**: `claude-code-meter` ships its new `ingest` subcommand on its own next release (e.g. `v0.4.0`), declaring `claude-code-cache-fix >= 3.2.0` as the supported producer in its README.

claude-meter cannot ship the new ingestion path independently — there is no proxy-emitted v:1 row to read until the proxy release lands. The two PRs are NOT independently shippable. State this in both repos' CHANGELOGs.

### Repo 1: `claude-code-cache-fix` (this PR)

In scope:
- Rewrite `proxy/extensions/usage-log.mjs` to emit the exact `MeterRowSchema` v:1 record listed above.
- State capture across stream events: `message_start` provides `model`, `usage.speed`, `usage.service_tier`, `usage.input_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation.ephemeral_1h_input_tokens`, `usage.cache_creation.ephemeral_5m_input_tokens`, `usage.server_tool_use.web_search_requests`. `message_delta` provides `usage.output_tokens`. The extension MUST stash `message_start` data into `ctx.meta._usageLog` and assemble the final record in the `message_delta` handler.
- Generate session id `sid` once per proxy lifetime: `crypto.createHash("sha256").update(`${process.pid}-${Date.now()}`).digest("hex").slice(0, 8)`.
- Hash `org_id` with the EXACT algorithm claude-meter uses: `crypto.createHash("sha256").update(headerValue).digest("hex").slice(0, 16)`.
- Track previous q5h/q7d in module-scope variables to compute deltas. First call after restart → deltas are `0`.
- Update the existing test file `test/proxy-usage-log.test.mjs` (don't create a new one).
- Document the schema change in CHANGELOG and README.

Out of scope (this repo, this milestone):
- Default-enabling `usage-log` — defer to v3.3.0 once adoption pattern is clear.
- Backwards-compat with the old 9-field shape on the writer side. Old rows in users' existing `~/.claude/usage.jsonl` will fail claude-meter's validator and be skipped (with a debug log on the reader). No backfill.
- Extending `MeterRowSchema` or adding new fields — that's a coordinated future change owned by the schema file in `claude-code-meter`.

### Activation (this repo)

This is the existing `usage-log` pattern, unchanged:

- Default in the extension's own export: `enabled: false`. (The module is built with this default; the loader respects it.)
- Users opt in by adding an entry to `proxy/extensions.json` like `"usage-log": { "enabled": true, "order": 650 }`. That's the entire activation gesture.
- `CACHE_FIX_USAGE_LOG=<path>` is **only a path override** for the destination file. It is NOT an enable flag and never has been. Setting it without enabling the extension does nothing.
- No env var for activation.
- `extensions.json` is parsed with `JSON.parse` — no comments allowed. Any documentation we want to give users about enabling lives in the README, not in that file.

### Repo 2: `claude-code-meter` (separate PR in that repo, not this PR)

In scope (documented here so this directive captures the full shape; actual code change is in the other repo's PR):
- New module `src/ingest/jsonl-tailer.mjs` — reads `~/.claude/usage.jsonl` forward from a saved offset.
- Reuses existing `MeterRowSchema` validation unchanged. **Strict v:1 only.** Rows that fail validation (including old-format proxy rows) are logged at debug level and skipped. No silent acceptance.
- Reuses existing share/upload logic unchanged.
- Bin entry adds `claude-meter ingest [--source <path>] [--once] [--watch]`.
- Persist offset to `~/.claude/.claude-meter-ingest-offset` so restart doesn't re-process rows.
- Deprecate `src/interceptor/preload.mjs` — keep with a console warning for users who still have it pinned in NODE_OPTIONS, schedule removal for the next major.
- Drop `./preload` from `package.json` exports.
- README rewrite: install cache-fix proxy ≥3.2.0 → enable `usage-log` in `proxy/extensions.json` → run `claude-meter ingest`.

Out of scope (claude-meter, this milestone):
- Changes to the share/upload protocol. Same wire format, same endpoints.
- Backfill of the historical preload-written `~/.claude/claude-meter.jsonl` data.
- New analytics features. Keep this change purely structural.

### Repo 3: wrapper script (`~/bin/claude` on each user host)

In scope (documented in cache-fix README, not committed code):
- Remove the legacy `NODE_OPTIONS="--import .../claude-meter/preload.mjs"` line for v2.1.113+ users.
- The cache-fix proxy with `usage-log` enabled is the only production wiring needed for usage capture going forward.

## Implementation choice (cache-fix side)

Stay inside `proxy/extensions/usage-log.mjs`. Don't split across files.

- Keep the existing extension contract (`order: 650`, `onStreamEvent`, `enabled: false` default in the export).
- Module-scope state:
  - `let _sid = generateSid()` — sticky session id for proxy lifetime.
  - `let _lastQ5h = null; let _lastQ7d = null;` — for delta tracking.
- Per-call state on `ctx.meta._usageLog` — accumulated from `message_start`, finalized in `message_delta`.
- Pure exported functions (test seam):
  - `generateSid()` → 8-char hex
  - `hashOrgId(rawOrgId)` → 16-char hex
  - `extractMessageStartFields(event)` → partial record
  - `extractMessageDeltaFields(event)` → partial record (just `output_tokens`)
  - `parseQuotaHeaders(responseHeaders)` → quota object
  - `assembleRecord({ start, delta, quota, headers, sid, prevQ5h, prevQ7d, now })` → full v:1 record
  - `computeDelta(current, previous)` → numeric delta
- Atomic-append per write — single-syscall `fs.promises.appendFile(path, JSON.stringify(record) + "\n")`. Records are well under 4 KB, so `O_APPEND` + `PIPE_BUF` (4096 bytes on Linux) gives record-level atomicity.

## Test plan (cache-fix side)

Update `test/proxy-usage-log.test.mjs`. Cover:

1. **Schema match**: assemble a record from synthesized stream events, validate it against an inline copy of MeterRowSchema requirements (no zod dep — manual asserts on shape and types). Every required field present, every regex satisfied.
2. **Optional fields omitted when absent**: missing `org_id` header → `org_id` not in record (not present as `undefined`, not present at all).
3. **Required-with-default zero when source absent**: missing `web_search_requests` → field present as `0`.
4. **`message_start` state capture**: simulated `message_start` event populates `ctx.meta._usageLog` with model, speed, service_tier, ephemeral split, web_search_requests.
5. **`message_delta` finalization**: simulated `message_delta` event reads from `ctx.meta._usageLog`, adds output_tokens, emits the final record.
6. **Delta computation**: two consecutive calls with q5h=0.5 then q5h=0.6 → second record's `q5h_delta` is `0.1`.
7. **First-call deltas zero**: first call after module load → `q5h_delta` and `q7d_delta` are `0`.
8. **Session ID stability**: multiple calls within a process → same `sid`.
9. **Session ID format**: matches `/^[0-9a-f]{8}$/`.
10. **Cache hit rate**: `cache_read=80, cache_creation=10, input=10` → `cache_hit_rate = 0.8`. `total=0` → `cache_hit_rate = 0`.
11. **org_id hashing**: input `acct-abc123` → output is `sha256("acct-abc123").digest("hex").slice(0, 16)`. Bit-exact match with claude-meter's algorithm. Never the original.
12. **Schema version**: every record has `v: 1`. (Yes, `1`, not `2`. We're not bumping.)
13. **`peak_hour` absent**: assert `peak_hour` is NOT in the emitted record.
14. **Disabled extension**: extension config off → no file writes, no state mutation.
15. **Concurrency**: spawn 50 parallel `appendFile` calls → result file has exactly 50 well-formed JSON lines.
16. **Header absence resilience**: missing every quota header → record is still assembled with safe defaults (numeric `0`, empty string for enums).

## Test plan (claude-meter side — for the separate PR)

Will be detailed in claude-meter's own PR. Summary:
1. Tailer reads valid `usage.jsonl` rows.
2. Tailer rejects (debug-log + skip) invalid rows without crashing.
3. Tailer rejects old 9-field proxy rows (no `v` field).
4. Offset persists across restarts; no double-ingestion.
5. Watch mode picks up appended rows in <1s.
6. Once mode reads to current EOF and exits.

## Files modified / created

### `claude-code-cache-fix` (this PR)

| File | Change |
|---|---|
| `proxy/extensions/usage-log.mjs` | REWRITE — emits exact MeterRowSchema v:1 record; adds sessionId, message_start state capture, q5h/q7d delta tracking; drops `peak_hour` |
| `test/proxy-usage-log.test.mjs` | EXPAND existing file — 16 cases per test plan |
| `extensions.json` | UNCHANGED — `usage-log` continues to default `enabled: false` (extension's own export) |
| `README.md` | Document the new schema (link to claude-meter's MeterRowSchema as the canonical source); update claude-meter integration instructions |
| `CHANGELOG.md` | Note breaking change: usage-log row format changes; old rows in existing files will fail claude-meter validation and be skipped |
| `docs/directives/proxy-claude-meter-compat.md` | THIS file (revised) |

### `claude-code-meter` (separate PR in that repo, not this PR)

| File | Change |
|---|---|
| `src/ingest/jsonl-tailer.mjs` | NEW |
| `src/log/schema.mjs` | UNCHANGED — strict v:1 validation continues to enforce the wire contract |
| `bin/claude-meter.mjs` | Add `ingest` subcommand |
| `src/interceptor/preload.mjs` | Add deprecation notice |
| `package.json` | Drop `./preload` export; bump version (e.g. v0.4.0); document `>= cache-fix 3.2.0` requirement in README |
| `README.md` | Rewrite integration section |

## Reviewer checklist (cache-fix side)

- [ ] Emitted record matches `MeterRowSchema` v:1 EXACTLY — every field name, every type, every regex constraint. Tests assert this in detail.
- [ ] `peak_hour` is NOT in the emitted record.
- [ ] `v` field is the literal number `1`.
- [ ] `org_id` hashing matches claude-meter's algorithm bit-exactly: `sha256(raw).digest("hex").slice(0, 16)`. Never raw.
- [ ] `sid` regex matches `/^[0-9a-f]{8}$/`.
- [ ] `message_start` data captured into `ctx.meta._usageLog`; `message_delta` reads from it and adds `output_tokens` to assemble the final record.
- [ ] Optional fields are OMITTED (not `undefined`) when source data is absent.
- [ ] Required-with-default fields are present as `0` (numeric) or `""` (string enums) when source is absent.
- [ ] q5h/q7d delta tracking uses module-scope state and resets to `0` for the first call after a proxy restart.
- [ ] Pure functions exported for testing.
- [ ] No request mutation.
- [ ] JSONL writes are single-syscall `appendFile` of `record + "\n"`; records are well under 4 KB.
- [ ] `extensions.json` is NOT modified by this PR (`usage-log` keeps its existing config).
- [ ] CHANGELOG explicitly calls out the breaking row-shape change for anyone parsing the old 9-field format.
- [ ] README documents the v:1 wire format AND points to `claude-code-meter/src/log/schema.mjs` as the canonical schema.
- [ ] Tests live in `test/`, not `tests/`.
- [ ] Tests pass on Node 18, 20, 22 (CI matrix).

## Out of scope (explicit)

- **Default-enabling `usage-log`** — defer to v3.3.0.
- **claude-meter share-protocol changes** — wire format and endpoints unchanged.
- **Backfill of historical preload-written `~/.claude/claude-meter.jsonl` data** — already-collected data is what it is.
- **Backwards-compat for the old 9-field proxy `usage.jsonl` rows** — those rows fail claude-meter's strict validator and are skipped on the reader side. Documented in CHANGELOG.
- **`MeterRowSchema` extensions** — owned by `claude-code-meter`. Any future field additions are a coordinated cross-repo change with its own ordering and migration story.
- **The dangerous-command filter** from the security doc — separate proposal.
- **Real-time streaming beyond watch-mode polling** — JSONL append is the boundary.

— AI Team Lead
