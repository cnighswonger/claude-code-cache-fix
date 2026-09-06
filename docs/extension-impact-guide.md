# Extension Impact Guide — Before & After

This document describes what each proxy extension and preload fix does, what happens when it's enabled vs disabled, and the measured impact from real-world telemetry.

All measurements unless noted are from our production telemetry: 24,667 calls (Apr 4-23, 2026), Max 5x account, Opus 4.6/4.7, direct Anthropic subscription auth through the cache-fix proxy.

## Proxy Extensions (v3.0.0+)

### 1. `fingerprint-strip` (order 100)

**What it fixes:** Claude Code computes a `cc_version` fingerprint (e.g. `2.1.92.a3f`) from `messages[0]` content including meta/attachment blocks. When blocks shift position on resume, the fingerprint changes, the system prompt changes, and the entire prefix cache busts.

**ON:** Strips the unstable fingerprint from the system prompt before forwarding. The API sees a stable system prompt regardless of block position.

**OFF:** Every resume session risks a full cache miss on the system prompt prefix (~6-30K tokens of cache_creation instead of cache_read).

**Measured impact:**
- In a 7.5-hour Windows session (536 calls), 81% of calls had fingerprint instability that the extension corrected. (@TomTheMenace, validated on v2.1.105)
- Cache hit rate with fingerprint-strip ON: 95-99%. Without: drops to 60-80% on resume sessions.

**When to disable:** If CC ships a fix for fingerprint computation. Check the health status — if it shows `dormant` across multiple sessions, the upstream bug may be fixed.

### 2. `sort-stabilization` (order 200)

**What it fixes:** Tool and MCP server definitions can arrive in different orders between turns. Since the API cache key includes the full request body, different tool ordering = different cache key = full cache miss.

**ON:** Sorts tool definitions alphabetically by name before forwarding. Every turn sees the same tool order.

**OFF:** Non-deterministic tool ordering causes intermittent cache misses. Most visible with MCP servers that register asynchronously.

**Measured impact:**
- On sessions with 3+ MCP servers, tool order jitter was observed on ~15% of calls.
- Each jitter event causes a full prefix rebuild: 150K-400K tokens of cache_creation depending on context size.
- @bilby91 (Crunchloop DAP) identified this as a distinct cache regression pattern via debug trace.

**When to disable:** If CC implements deterministic tool ordering. The sort is idempotent — if tools are already sorted, no modification occurs.

### 3. `fresh-session-sort` (order 250)

**What it fixes:** On the first turn of a fresh session, CC's `normalizeResumeMessages` has an early-return on `length < 2` that skips sorting. This means the first call after `/clear` or a new session has unsorted blocks, busting the cache prefix for that turn.

**ON:** Applies the same block sorting to the first turn that CC applies to subsequent turns.

**OFF:** First turn of every fresh session gets a full cache miss. Not catastrophic (one miss per session) but expensive on sessions with large system prompts.

**Measured impact:**
- @bilby91 validated: with fix, call 2 `cache_read` = call 1 `cache_creation` to the exact token. Without fix, call 2 was a full miss.

### 4. `identity-normalization` (order 300)

**What it fixes:** The identity string in `system[1]` differs between `Agent()` calls and `SendMessage()` calls. When an agent switches between these modes, the system prompt changes and cache busts.

**ON:** Normalizes the identity field to a canonical form regardless of how the session was initiated.

**OFF:** Agent SDK users who mix `Agent()` and `SendMessage()` get cache misses on every mode switch.

**Measured impact:**
- @labzink confirmed via mitmproxy: `system[1]` identity differs between Agent and SendMessage paths.
- Each switch causes a full system prompt rebuild.

**When to disable:** Primarily affects Agent SDK users. If you're running vanilla CC CLI, this extension rarely triggers.

### 5. `cache-control-normalize` (order 400)

**What it fixes:** `cache_control` markers (the `{"type": "ephemeral"}` annotations that tell the API what to cache) can appear at inconsistent positions across turns. When the marker moves, the cache boundary shifts and previously cached content may not match.

**ON:** Pins `cache_control` markers at canonical positions (last block of last user message).

**OFF:** Marker drift between turns causes partial cache misses — not full misses, but enough to increase `cache_creation` on each turn.

### 6. `ttl-management` (order 500)

**What it fixes:** Detects the server's cache TTL tier (1h or 5m) and ensures correct `cache_control` markers are injected. On cold starts, the server assigns 5m TTL until the first cached call promotes to 1h.

**ON:** Injects appropriate ephemeral markers to maximize cache reuse within the server's TTL window.

**OFF:** Requests may lack TTL markers entirely, leaving caching behavior to server defaults which may not be optimal.

**Measured impact:**
- A/B on v2.1.117: proxy (all extensions ON) achieved 95.5% cache hit rate vs 82.3% direct on first warm turn. TTL management is a significant contributor to this gap.

### 7. `cache-telemetry` (order 600)

**What it fixes:** Nothing — this is monitoring, not a fix. Extracts cache statistics from response headers and writes them to `~/.claude/quota-status/account.json` (account-global) and `~/.claude/quota-status/sessions/<filename>.json` (per-session) on every API call.

**ON:** Status bar shows live Q5h/Q7d utilization, TTL tier, cache hit rate, peak hour detection.

**OFF:** No quota monitoring. You fly blind on cost.

**Data written:**
- Q5h and Q7d utilization percentages
- TTL tier (1h or 5m)
- Cache hit rate
- Peak hour flag (weekday 13:00-19:00 UTC)
- All `anthropic-ratelimit-unified-*` response headers

### 8. `overage-warning` (order 610) — opt-in via `CACHE_FIX_OVERAGE_WARNING=1`

**What it fixes:** Nothing — advisory only. When Anthropic's response headers indicate the user is approaching or has crossed the overage threshold (`anthropic-ratelimit-unified-status: allowed_warning|throttled` plus a non-empty `anthropic-ratelimit-unified-7d-surpassed-threshold`), emits a one-time-per-threshold-per-Q5h-window warning to stderr AND appends a structured record to `~/.claude/overage-warnings.jsonl`.

**ON (`CACHE_FIX_OVERAGE_WARNING=1`):** You learn about a threshold crossing on the response that Anthropic flagged it on, with a coarse projection of minutes-to-100% and an estimated burn rate at API rates. The JSONL record is consumable by status lines, dashboards, or downstream alerting.

**OFF (env var unset, default):** No file is created, no state is allocated, no warning emitted. The extension is loaded but every hook returns on the first line.

**Stderr line format (full projection):**
```
[overage-warning] 2026-04-25T18:42:11Z Q5h=78% Q7d=82% (surpassed 0.75) — projected 100% in ~22 min, estimated continued burn ≈ $4.10/hr at API rates (coarse). Upgrade paths: upgrade_plan, overage.
```

**Stderr line format (warm-up — fewer than 3 stream samples available):**
```
[overage-warning] 2026-04-25T18:42:11Z Q5h=78% Q7d=82% (surpassed 0.75) — projection unavailable (warming up). Upgrade paths: upgrade_plan, overage.
```

**Important caveats:**
- The cost-per-hour number is **deliberately coarse** (single weighted constant in `proxy/rates.mjs`). It is right to one significant figure; it is not a precise quote. A precise per-tier cost engine is a v3.3.0 follow-up.
- Dedup state (which thresholds we've already warned at) lives in proxy memory and resets on proxy restart. You may see a duplicate warning for the same threshold in a Q5h window if the proxy restarted between calls.

**Other env vars:**
- `CACHE_FIX_OVERAGE_WARNING_QUIET=1` — suppress stderr emission, keep JSONL output.
- `CACHE_FIX_OVERAGE_WARNING_DIR=/path` — override JSONL output directory (defaults to `~/.claude/`).

See `docs/directives/proxy-overage-cost-warning.md` for the full design.

### 9. `image-strip` (order 150) — opt-in via `CACHE_FIX_IMAGE_GUARD=1`

**What it fixes:** Multi-image requests can fail in three different ways — per-image dimension limit (2000 px when count > 20, else 8000 px), 32 MB request body cap, and per-model image-count cap (100 for current models). The legacy `CACHE_FIX_IMAGE_MAX_DIM` shipped in v3.2.1 only addressed the dimension axis with a single static cap; the v3.3.0 pipeline addresses all three conditionally and adds an opt-in client-side Lanczos resize for users who want OCR-quality preservation rather than blind server-side downscale.

**ON (`CACHE_FIX_IMAGE_GUARD=1`):** Runs a pipeline of independent passes:

| Pass | When | Action |
|------|------|--------|
| Pass 0 (legacy) | `CACHE_FIX_IMAGE_KEEP_LAST=N` set | Strip tool_result images from user messages older than N most recent |
| Pass 3 | `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1` AND long edge > native cap | Lanczos resize to native cap (2576 px Opus 4.7, 1568 px otherwise). Requires optional `sharp` peer dep |
| Pass 1 | long edge > active rejection cap | Strip with forensic placeholder. Cap = `MAX_DIM` if set, else 2000 (count > 20) or 8000 (count ≤ 20) |
| Pass 2 | body bytes > `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX` (default 30 MB) | Drop oldest images until under budget |
| Count cap | image count > `CACHE_FIX_IMAGE_COUNT_MAX` (default 100) | Drop oldest images down to cap |

Execution order: **Pass 0 → Pass 3 → Pass 1 → Pass 2 → count cap**. Each pass triggers independently; Pass 1 never resizes, Pass 3 never strips.

**OFF (default):** Pipeline is dormant. Legacy `KEEP_LAST` and `MAX_DIM` continue to work exactly as in v3.2.1 for users who already have them set.

**Pass 3 trade-offs:**
- *Quality.* Lanczos resize via `sharp` is qualitatively different from the server's blind downscale (algorithm undocumented). For OCR, document extraction, and detail-sensitive workflows, client-side Lanczos is the right tool.
- *Dependency.* Requires `sharp` (~30 MB native binaries). Declared as an optional peer dependency — users who don't want it pay nothing. If `sharp` is missing, Pass 3 logs `library_missing` and skips; Pass 1 + Pass 2 still run.
- *Cost.* Resize is pure CPU on the proxy side. For typical workloads (a few images per request) it's well under 100ms per image.

**Telemetry surface (`ctx.meta.imageGuardStats`):**
```js
{
  total_images, count_axis_path,                          // population
  unsupported_format_count, dimension_probe_fail_count,   // probe outcomes
  resize_attempted, resize_succeeded, resize_failed,      // Pass 3 outcomes
  library_missing,                                        // sharp absent flag
  images_dropped_for_size, images_dropped_for_count_cap,  // Pass 2 / count cap
  request_bytes_before, request_bytes_after,              // body size
  request_bytes_headroom,                                 // budget - bytes_after
  image_bytes_total, image_bytes_dropped,                 // image-bytes telemetry
  estimated_image_tokens_total,                           // diagnostic, not enforcement
}
```

A single stderr line is emitted per processed request when the pipeline did anything observable (e.g. `[image-guard] resized=3 evicted=1 req_bytes=35M->28M (headroom=2M) images=8->7`).

See `docs/directives/proxy-image-guard-pipeline.md` for the full spec, including the precedence matrix for every documented combination of legacy + new env vars.

### 10. `microcompact-stability` (order 350) — opt-in via `CACHE_FIX_DUMP_MICROCOMPACT=<path>` and/or `CACHE_FIX_NORMALIZE_MICROCOMPACT=1`

**What it fixes:** When CC's `time_based_microcompact` (or the 90-minute cold-compact path via `FDY()`) fires, it replaces old `tool_result` content with a sentinel string. The original content is gone for cache purposes — that loss is unrecoverable from the proxy. But the sentinel itself may carry volatile fields (timestamps, IDs) that change between microcompact runs even when no new content was added, busting the cache for everything *after* the sentinel position. This extension normalizes the sentinel to a byte-stable canonical form so the "second microcompact, no new content" case stops churning the cache. Phase 1 only; Phase 2 (snapshot-and-restore) is deferred to v3.5.0+ pending production data from Phase 1.

**ON (`CACHE_FIX_DUMP_MICROCOMPACT=<path>`):** Diagnostic-only. Walks `body.messages[].content[]` looking for `tool_result` blocks whose text matches CC's sentinel pattern. Writes a JSONL line per affected request with structural metadata (msg_idx, block_idx, pattern matched, byte length) plus session_id_hash. **No mutation.**

**ON (`CACHE_FIX_NORMALIZE_MICROCOMPACT=1`):** Replaces matched sentinels with the canonical text (default `[Old tool result content cleared]` — the timestamp-stripped form). Only Mode A matches (exact match against confirmed patterns) are normalized. Mode B matches (prefix-only) are recorded in the dump but never mutated.

**OFF (both unset, default):** Extension is loaded but exits at the first line of `onRequest`. No telemetry, no mutation, no fs activity.

**Detection modes:**

| Mode | Match criterion | Normalization | Dump capture |
|------|-----------------|---------------|--------------|
| A (exact) | Whole text matches one of the confirmed regex patterns: bare `[Old tool result content cleared]` or the ISO-8601 variant `[Old tool result content cleared at YYYY-MM-DDTHH:MM:SS(.SSS)?Z]` | Eligible — replaced with canonical text when normalize is on | Full `sentinel_text` recorded |
| B (prefix) | Text begins with `[Old tool result content cleared` but does not exactly match a Mode A pattern | **Never** normalized | Redacted to `prefix_64` (configurable via `CACHE_FIX_MICROCOMPACT_REDACT_LEN`) |

The Mode A/B separation is the privacy guarantee: a Mode B match might be a CC sentinel followed by user-derived content (e.g., a tool that echoed user input back). Redaction prevents that content from landing in the dump.

**Custom patterns** can be added via `CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_<N>=<regex>` (1-indexed, sparse OK). To get the same Mode A/B treatment as defaults — including redacted prefix capture for variants of a custom family — pair each custom regex with a literal prefix via `CACHE_FIX_MICROCOMPACT_SENTINEL_PREFIX_<N>=<literal>`. The implementation can't safely derive a prefix from an arbitrary regex, so prefixes are supplied separately. Without the prefix env var, only exact-match (Mode A) capture works for that family.

**Telemetry surface (`ctx.meta.microcompactStats`):**
```js
{
  diagnostic_enabled, normalization_enabled,
  sentinel_pattern_used,                // first matched pattern source (Mode A only)
  total_tool_results_scanned,
  exact_matches_count, partial_matches_count,
  sentinels_matched,                    // exact + partial
  sentinels_normalized,
  bytes_original, bytes_normalized, bytes_saved,
  diagnostic_records_written,
}
```

`bytes_saved` is a side effect of the timestamp-strip default — the headline value is byte-stability across runs, not byte savings.

A single stderr line is emitted on enabled invocations that did something observable:
```
[microcompact] matched=3 normalized=3 bytes=159->90 sentinel_pattern=default
[microcompact] matched=2 dump=/tmp/microcompact-dump.jsonl (normalize disabled)
```

**Phase 2 (deferred to v3.5.0+):** snapshot-and-restore of original tool_result content. Requires persistent state across requests, snapshot-format versioning, GC policy, and multi-process write safety — every one a design decision with open questions. Phase 1 ships first; Phase 2 only if Phase 1 data shows normalization alone is insufficient.

See `docs/directives/proxy-microcompact-cache-stability.md` for the full spec.

### 11. `read-dedupe` (order 380) — opt-in via `CACHE_FIX_READ_DEDUPE=1`

**What it fixes:** In long Read-heavy sessions (build loops, doc-iterating agents, test triage), the same file is re-read across many turns and each `Read` tool_result carries the full file body. Once the cache prefix breaks for any reason, the proxy pays full input-token cost for every redundant copy. Empirically this also correlates with the SNR-collapse pattern that drives unrecoverable 500 errors (Lead reconfirm on CC 2.1.128: SNR 0.27 / 184 duplicate Reads in a single session, worse than the original 2026-04 incident referenced in issue #85).

This extension walks every `Read`-originated `tool_result`, keeps the **first** occurrence intact, and replaces later byte-identical occurrences with a stable pointer line referencing the keeper's `tool_use_id` and turn number.

**ON (`CACHE_FIX_READ_DEDUPE=1`):** Builds a `tool_use_id → tool_use` map over assistant messages, then walks user `tool_result` blocks. Buckets occurrences by `sha256(file_path, content, offset, limit)`. First-by-(msgIdx, blockIdx) is the keeper; later occurrences become `(unchanged — see tool_use_id=<id> in turn <N>)`. Eligible content shapes are `string` and single-element `[{type:"text", text}]`; mixed/multi-element arrays are recorded in `read_tool_results_skipped_mixed_array` and skipped at detection (the Codex blocker fix from directive review #1 — preserves the byte-identity guarantee).

**OFF (default):** The extension is loaded but exits on the first line of `onRequest`. Telemetry object is still attached with `enabled: false` so dashboards can detect the extension is present-but-inert.

**Measured impact:** Pending live measurement; default-off until validated against real workloads, then revisit. Expected upside scales with Read-heavy workflows: a 30-turn session that re-reads three 50 KB files five times each pays ~750 KB/turn of redundant `tool_result` content after the first cache miss; this extension collapses that to roughly 12 × ~60-byte pointer lines per turn after the first occurrence — orders of magnitude in pathological cases, zero in workflows that don't re-read.

**When to disable:** Always default. Disable for any workflow that legitimately depends on byte-identical replay of historical `Read` tool_results (rare, and would also break the cache anyway). Tracked under issue #85; directive at `docs/directives/proxy-read-dedupe.md`.

**Telemetry surface (`ctx.meta.readDedupeStats`):**
```js
{
  enabled,
  total_tool_results_scanned,
  read_tool_results_classified,
  read_tool_results_skipped,
  read_tool_results_skipped_mixed_array,
  unique_keys,
  duplicate_keys,
  replacements_written,
  bytes_original,
  bytes_after,
  bytes_saved,    // bytes_original - bytes_after; can be negative on tiny content (pointer text is ~55 bytes)
}
```

Stderr summary on every enabled invocation:
```
[read-dedupe] replaced=N keys=K bytes=A->B (saved=X%) reads_seen=R
[read-dedupe] no-op reads_seen=R (no duplicates)
```

`reads_seen` counts every Read-originated `tool_result` the extension considered (eligible + skipped). Mixed-array Reads land in `read_tool_results_skipped_mixed_array` and still increment `reads_seen` so the operator sees the true scanned-Read total during rollout.

**Byte-stability guarantee:** because the keeper is always the FIRST occurrence (not the last), pointer bytes never churn as new duplicates accumulate. The cache-miss profile is one miss per newly-added duplicate, not cascading. This was the load-bearing fix in directive Codex review #1.

## Preload-Only Features (v2.x, CC ≤v2.1.112)

These features only work with the preload interceptor (`NODE_OPTIONS="--import ..."`). They do NOT work on CC v2.1.113+ (Bun binary). Use the proxy extensions above for current CC versions.

### Block relocation (`CACHE_FIX_SKIP_RELOCATE`)

**What it fixes:** Attachment blocks (skills listing, MCP servers, deferred tools, hooks) drift from `messages[0]` to later messages on resume. This changes the cache prefix.

**ON:** Scans all user messages for relocated blocks and moves the latest version of each back to `messages[0]`.

**OFF:** Resume sessions have scattered blocks → cache prefix mismatch → full rebuild every turn.

**Measured impact:** This is the original bug that started the project. Resume sessions without this fix burn 10-20x more than expected (#34629).

### Image stripping (`CACHE_FIX_IMAGE_KEEP_LAST=N`)

**What it fixes:** Images read via the Read tool persist as base64 in conversation history and ride along on every subsequent API call.

**ON (e.g. =3):** Keeps images in the last 3 user messages, replaces older ones with a text placeholder.

**OFF:** A single 500KB image costs ~62,500 tokens per turn on Opus 4.6, ~85,000+ on Opus 4.7 (35% tokenizer inflation). Multiple images compound.

**Measured impact:** In a session with 4 screenshots, disabling image stripping added ~250K tokens per turn — equivalent to doubling the context window usage.

### Oversized-image guard (`CACHE_FIX_IMAGE_MAX_DIM=N`)

**What it fixes:** Anthropic enforces a per-image dimension ceiling on multi-image requests. When any single image exceeds the limit (currently 2000px on a side), the API returns:

> "An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images."

This fails the request entirely. Common triggers: hi-res manuscript scans, retina screenshots, photo attachments at full resolution.

**ON (e.g. =2000):** On every request, scan all PNG/JPEG images in both user messages and tool results. Replace any whose width OR height exceeds the limit with a forensic placeholder: `[image stripped — exceeded 2000px max dimension (was 3000x1500px)]`. The original dimensions stay visible to the model so it knows why the image was dropped.

**OFF (default):** No dimension check. Hi-res images pass through and the request fails with the dimension-limit error.

**Composes with `CACHE_FIX_IMAGE_KEEP_LAST`:** when both are set, `KEEP_LAST` runs first (drops images from old messages), then `MAX_DIM` runs on whatever remains (strips the oversized).

**Implementation notes:**
- Pure-JS PNG and JPEG header parsing — no native deps. Other formats (GIF, WebP, AVIF, BMP) are not detected; images of those types pass through unchanged regardless of dimension.
- Fail-open: if dimensions can't be parsed (truncated header, unsupported format), the image is kept rather than stripped. Better to send a request that might error than to strip a valid image we just couldn't measure.
- Pre-process locally when you can (`magick convert input.png -resize 2000x2000\> output.png`). This extension is the safety net for sources you forgot to pre-process.

### Output efficiency rewrite (`CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT`)

**What it fixes:** Nothing directly — allows replacing CC's `# Output efficiency` system prompt section with custom text.

**ON:** Your custom prompt replaces the default.

**OFF:** CC's default `# Output efficiency` section is used.

**Impact:** Behavioral, not cost-related. See [docs/output-efficiency-prompts.md](output-efficiency-prompts.md) for the three known variants.

### Git-status stripping (`CACHE_FIX_STRIP_GIT_STATUS`)

**What it fixes:** CC injects live `git status` output into the system prompt on every call. Any file edit changes git status → system prompt changes → entire prefix cache busts.

**Better alternative:** Use the CC native flag `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` instead of this preload fix. Same effect, no interceptor needed.

**Measured impact:**
- @wadabum validated: 18-token `cache_creation` across git state changes with the flag set (vs thousands without).
- Saves ~1,800 tokens per call (~7,180 chars of git instructions removed from system prompt + Bash tool description).

## Validating Impact Yourself

### Quick A/B test

```bash
# Baseline (no proxy)
claude  # note cache_read in /cost

# With proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude  # compare cache_read
```

### Detailed analysis

```bash
# Cost report from interceptor/proxy logs
node tools/cost-report.mjs --since 2h

# Quota analysis — test cache_read weight hypothesis
node tools/quota-analysis.mjs --since 24h

# Multi-mode cache test (fresh, resume, continue)
bash tools/cache-test.sh
```

### What to look for

| Metric | Healthy (proxy ON) | Degraded (proxy OFF or bug present) |
|--------|-------------------|-------------------------------------|
| `cache_read` / total | >95% | <80% |
| `cache_creation` per turn | <1K tokens | >10K tokens |
| Q5h burn rate | <0.5%/min | >2%/min |
| First-turn hit on resume | cache_read ≈ prior cache_creation | cache_read = 0 |
