# Directive: microcompact cache stability

**Issue:** #36
**Branch:** `directive/microcompact-cache-stability`
**Stage:** directive
**Milestone:** v3.4.0 (P1)

## Goal

Stop CC's `time_based_microcompact` and 90-minute cold-compact paths from busting the prompt cache **above and beyond** the unavoidable content loss. The microcompact rewrite happens; we can't prevent it from inside the proxy. But there are two distinct cache-busting effects from a single rewrite, and we can address one of them client-side:

1. **Content loss** (unavoidable from the proxy): old tool_result content is replaced with a sentinel string. The cache for that conversation position is permanently invalidated. We accept this; only Anthropic's `CACHED_MICROCOMPACT` server flag (mentioned in CC source) can recover it.
2. **Sentinel drift** (proxy-fixable): the sentinel string CC writes may differ between microcompact runs (embedded timestamps, IDs, ordering). Even when no new content is added, the rewrite alone moves bytes and busts the cache for everything *after* the sentinel position. We can normalize the sentinel to a byte-stable canonical form so that, for the unchanged-content case, repeat runs produce identical request bodies.

This directive ships **Phase 1**: diagnostic capture + conditional sentinel normalization. **Phase 2** (snapshot-and-restore of the original tool_result content) is documented as out-of-scope and explicitly deferred to v3.5.0+ pending Phase 1 production data.

## Why

A user returning from an idle period (coffee break, meeting, overnight) gets hit with two compounding effects:

1. **Cache TTL expired** during idle — expected, the cache just rebuilds on the next call.
2. **Microcompact rewrote the conversation** — the rebuild is now for *different content* than what was previously cached, so even if cache_control markers are sticky (per `cache-control-normalize`), the position they mark has different bytes and prefix-matching falls off at the first divergence.

We've already shipped `cache-control-normalize` to keep markers at canonical positions across microcompacts. That fixes marker placement but doesn't help if the underlying content at the marker position changed. The remaining client-side gap is sentinel-drift: when CC's microcompact writes a sentinel like `[Old tool result content cleared at 2026-04-30T13:42:11Z]`, the timestamp embedded in the sentinel changes every run, so even on a second microcompact pass against an already-stripped position, the bytes change and the cache busts again.

If CC's sentinel turns out to be byte-stable (no embedded volatile fields), Phase 1's normalization is a no-op and we ship the diagnostic only. If the sentinel has drift, normalization recovers cache for the "no new content, just second microcompact" case — which on long-idle sessions is the common path.

Reported by Jonathan via the veritassuperaitsolutions.com contact form (2026-04). Source references in CC v2.1.112 (verified against the decompiled bundle):

- `tengu_time_based_microcompact` — keeps the 5 most recent tool results, strips the rest.
- `FDY()` — checks `Date.now() - lastActivity >= 5400000` (90 min); triggers the cold-compact path.
- `qD4(q, K, {keepRecent: 5})` — the rewrite function. Replaces stripped tool_result content with the sentinel.
- `CACHED_MICROCOMPACT` — experiment flag suggesting Anthropic is working on a server-side cache-preserving variant. Track but don't depend on.

## Source of truth

This directive operationalizes issue #36 (Jonathan's report) plus the source-code findings the issue lists. The microcompact rewrite happens inside CC before the request hits the proxy, so the proxy sees the post-rewrite shape directly and we never see the original content unless we capture it from a live session before microcompact fires.

Key references:
- Issue #36 body — source-code function names, `keepRecent: 5`, 90-minute threshold, two-cache-bust-vector framing.
- `cache-control-normalize` extension (existing, v3.0.0+) — sticky cache_control markers across rewrites; sets the baseline this directive builds on.
- Memory `playbook_500_one_agent_failing.md` — context degradation patterns we've observed; microcompact is one root cause.

## Scope (v3.4.0 — Phase 1)

In scope:

1. New env var `CACHE_FIX_DUMP_MICROCOMPACT=<path>` — diagnostic. When set, every request whose `messages[]` contains the microcompact sentinel pattern dumps a redacted snapshot to the path. Used to characterize sentinel drift in production before designing the normalization rule.
2. New env var `CACHE_FIX_NORMALIZE_MICROCOMPACT=1` — opt-in normalization. Off by default until Phase 1 diagnostic data confirms a stable canonical form.
3. New extension `proxy/extensions/microcompact-stability.mjs` registered at order 350 (between `tool-input-normalize` at 340 and `cache-control-normalize` at 400). The extension runs BEFORE `cache-control-normalize` so the latter sees the post-normalized content when computing sticky-marker hashes.
4. Sentinel detection — pattern match against the canonical microcompact sentinel string (TBD from Phase 1 diagnostic data, but candidate patterns are documented in §Detection below).
5. Sentinel normalization — replace any volatile fields (timestamps, IDs) with stable canonical forms. The exact replacement rule is parameterized so we can adjust without re-shipping when CC's sentinel format changes.
6. Telemetry on `ctx.meta.microcompactStats` — sentinel-pattern matches, normalized blocks, original vs canonical bytes.
7. README env-var table additions; extension #11 entry in extension-impact-guide.

Out of scope (deferred to v3.5.0+ pending Phase 1 data):

- **Snapshot-and-restore** (Phase 2). Capture original tool_result content before microcompact strips it; restore on subsequent requests. Requires:
  - Persistent state across request boundaries (filesystem under `~/.claude/microcompact-snapshots/` or in-proxy LRU).
  - Detection of *when* microcompact is about to fire (we don't currently see it before the rewrite; CC fires it in the request-composition path internally).
  - Interaction with the v3.3.0 image-guard Pass 2 byte budget — restored content can re-inflate the body past the 30 MB threshold.
  - Risk of stale-restore: a snapshot from 90 minutes ago may not match what the user expects to be in context, especially if they've manually edited files between then and now.
  Phase 2 also has open questions Codex flagged that aren't yet in the bullet list:
  - **Snapshot retention / GC policy.** Per-session disk usage grows with conversation length × turn count; need a bounded LRU or TTL-based eviction. What's the right ceiling?
  - **Persisted-format versioning.** If we ship Phase 2 v1, then later change the snapshot format, we need a migration path (or accept that snapshots from prior versions become unreadable and degrade gracefully).
  - **Multi-process write safety.** If two CC instances connect to the same proxy, snapshot writes need to be atomic; otherwise concurrent microcompacts could clobber each other's snapshots.

  Phase 2 is the complete fix but every one of those bullets is its own design decision. Ship Phase 1, gather data, decide if Phase 2 is needed.
- Direct intervention in the microcompact trigger — impossible from the proxy. The 90-minute timer lives inside CC's process state, not in the request body.
- Reliance on the `CACHED_MICROCOMPACT` server flag — not under our control; track but don't ship anything that breaks if it's enabled or disabled.

## Activation

**Prefix-diff pattern**:

- Extension flips to `enabled: true` in `proxy/extensions.json` and is registered at order 350.
- Two independent runtime gates inside the extension body:
  - `CACHE_FIX_DUMP_MICROCOMPACT=<path>` enables diagnostic dumping (read-only; no mutation).
  - `CACHE_FIX_NORMALIZE_MICROCOMPACT=1` enables sentinel normalization (mutates `ctx.body.messages[].content`).
- Both can be on simultaneously. The dump always captures the **raw pre-normalization** sentinel text per §Diagnostic capture's contract; setting `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED=1` additionally records the normalized form alongside the raw text.
- If neither dump nor normalize is enabled, the extension fires but exits early. No telemetry, no mutation, no fs activity.

The repeat error from PR #79 round-1 (`enabled: false` + env-var gate) is avoided by construction.

## Detection

CC's microcompact sentinel is documented as `[Old tool result content cleared]` in earlier comments on the project (per memory entry on microcompact monitoring), but we have not pinned down whether the sentinel embeds volatile fields. Phase 1 diagnostic captures the actual sentinel string from production traffic.

### Two detection modes (Codex review fix)

The original draft conflated two distinct detection modes. The revised contract separates them:

**Mode A — exact sentinel match.** A `tool_result` content block (or a `text` item inside one) whose ENTIRE text matches one of the **confirmed** sentinel patterns:

```
^\[Old tool result content cleared\]\s*$
^\[Old tool result content cleared at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\]\s*$   // ISO-8601 timestamp variant
```

Mode A matches are **eligible for normalization** when `CACHE_FIX_NORMALIZE_MICROCOMPACT=1`. The text being matched is, by construction, a CC-emitted sentinel — it doesn't carry user content.

**Mode B — diagnostic-only partial match.** A `tool_result` content block (or `text` item) whose text begins with the prefix `[Old tool result content cleared` BUT does NOT exactly match a Mode A pattern. This catches:
- Sentinels with trailing additional content (truncation + appended notes).
- Future CC variants we haven't seen yet (hence the prefix-only check).

Mode B matches are **NEVER normalized**. The diagnostic dump for Mode B is **redacted**: only `msg_idx`, `block_idx`, `content_kind`, `byte_length`, and a 64-char prefix of the matched text are recorded. The full text is never dumped — this protects against the case where a Mode B match is actually a CC sentinel followed by user-derived content (e.g., a tool that echoed user input back into its result).

The candidate patterns from the prior draft (`^\[Tool result truncated.*\]`, `^\[microcompact.*\]`) are **removed from the default set**: too broad, false-positive risk on tool outputs unrelated to microcompact. They can be re-added via the `CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_<N>=<regex>` env-var family when Phase 1 data confirms a specific variant. Until then, Mode B's prefix detection is the right surface for capturing unknowns.

### Detection logic

Walk `body.messages[].content[]`. For each block where `type === "tool_result"`:
- If `content` is a string, run Mode A patterns first (exact match); then Mode B prefix check.
- If `content` is an array of items, do the same on each `text` item.
- A Mode A match is recorded in `exact_matches` (eligible for normalization).
- A Mode B match (prefix only) is recorded in `partial_matches` (redacted dump only, never normalized).
- A block can produce at most ONE classification (Mode A wins over Mode B if both would match).

### Edge cases

- **Block has Mode A sentinel as its full text** → Mode A match, normalize if enabled.
- **Block has the sentinel as a prefix plus additional content** → Mode B match, redacted dump only, no normalization.
- **Multiple tool_result blocks** → walk all of them; record per-block stats.
- **The sentinel pattern changes between CC versions** → Phase 1 diagnostic re-establishes ground truth via Mode B prefix capture; once a new exact form is identified, it's promoted to Mode A by adding to the env var pattern set.

## Diagnostic capture (Phase 1, always-on when env var set)

**Raw-before-normalize is the rule.** When `CACHE_FIX_DUMP_MICROCOMPACT=<path>` is set, the dump is written BEFORE any normalization runs (Codex review fix — the prior draft contradicted itself by also saying "if both gates are on, the dump captures the post-normalized snapshot," which would defeat Phase 1's whole purpose of characterizing real production sentinel drift). The dump always reflects the original matched bytes the proxy received from CC.

If verification of the normalization rule is also wanted, set `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED=1` to add a second `normalized_text` field to each match record. The raw `sentinel_text` field is preserved either way.

The dump record schema, with the two-mode separation:

```json
{
  "ts": "2026-04-30T15:00:00Z",
  "session_id_hash": "abc123",
  "exact_matches": [
    {
      "msg_idx": 3,
      "block_idx": 1,
      "content_kind": "string",
      "matched_pattern": "^\\[Old tool result content cleared at \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z\\]\\s*$",
      "sentinel_text": "[Old tool result content cleared at 2026-04-30T13:42:11Z]",
      "byte_length": 53,
      "normalized_text": "[Old tool result content cleared]"   // present only when CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED=1
    }
  ],
  "partial_matches": [
    {
      "msg_idx": 5,
      "block_idx": 0,
      "content_kind": "array_item",
      "byte_length": 142,
      "prefix_64": "[Old tool result content cleared at 2026-04-30T13:50:00Z] (with extr"
      // NOTE: NO full text. Mode B always redacts to a 64-char prefix.
    }
  ],
  "total_messages": 12,
  "total_tool_results": 7,
  "model": "claude-opus-4-7-20260101"
}
```

### Privacy guarantees (revised, defensible)

The Codex review correctly flagged that the prior "no user content" claim was too strong because Mode B partial matches and broad regexes could capture user-derived text. The revised contract is narrow:

- **Mode A (exact match) records**: `sentinel_text` is captured in full. This is safe because the text matches a confirmed CC sentinel pattern — by construction, no user content. The `\d{4}-\d{2}-...` ISO-8601 timestamp constraint in the regex bounds what trailing content the regex will accept.
- **Mode B (partial match) records**: ONLY `byte_length` and a 64-char prefix. The full text is NEVER dumped. The 64-char prefix is short enough that, for the worst case (CC sentinel + user-derived content concatenated), the user content is unlikely to begin within the first 64 chars (the CC sentinel base form is ~33 chars; a timestamp-bearing variant is ~52 chars; user-derived content begins after).
- **Session IDs**: always hashed (one-way; SHA-256 truncated to 8 hex chars). Plaintext session ID never written.
- **Model**: included verbatim — not user data.
- **Custom user patterns** via `CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_<N>` are subject to the same Mode A vs Mode B treatment: a custom pattern that matches exactly is dumped in full; a partial match against a custom prefix gets redacted to 64 chars.

If a deployment has stricter requirements, `CACHE_FIX_MICROCOMPACT_REDACT_LEN=N` overrides the 64-char Mode B prefix length (set to `0` to suppress the prefix entirely; only structural metadata remains).

### Why the dump is needed at all

Without production samples we can only normalize against synthesized sentinels. A wrong normalization rule is worse than no normalization (would produce inconsistent canonicalization across the fleet, churning cache *more*, not less). The diagnostic is the design input for the actual normalization rule.

## Normalization rule

When `CACHE_FIX_NORMALIZE_MICROCOMPACT=1` is set AND a sentinel match is found, replace the sentinel text with a canonical form. Default rule (overridable via env var):

| Volatile field | Canonical replacement |
|----------------|----------------------|
| ISO timestamp inside the sentinel | Empty string OR fixed placeholder `<TS>` |
| Numeric IDs / counters | `<N>` |
| Anything else volatile | Pinned at first observed value (per-session memo) |

Default canonical form (subject to Phase 1 verification):

```
[Old tool result content cleared]
```

— i.e., strip the timestamp suffix entirely. This is the maximally-stable form: identical bytes regardless of when the rewrite happened. If Phase 1 reveals additional volatile fields, the rule is extended via `CACHE_FIX_MICROCOMPACT_NORMALIZED=<text>` env var (the user supplies the canonical replacement string directly).

Mutation is in-place on `ctx.body.messages[].content[]`. We preserve all other block fields (tool_use_id, type, etc.) — only the text content changes.

## Telemetry

Full counter set on `ctx.meta.microcompactStats`:

```js
ctx.meta.microcompactStats = {
  diagnostic_enabled: boolean,        // CACHE_FIX_DUMP_MICROCOMPACT set?
  normalization_enabled: boolean,     // CACHE_FIX_NORMALIZE_MICROCOMPACT set?
  sentinel_pattern_used: string,      // regex source for the matched pattern
  total_tool_results_scanned: number,
  sentinels_matched: number,          // total matches across all blocks
  sentinels_normalized: number,       // matches that were rewritten (always ≤ matched)
  bytes_original: number,             // sum of matched sentinel byte lengths before normalization
  bytes_normalized: number,           // sum after normalization
  bytes_saved: number,                // bytes_original - bytes_normalized; usually positive (default rule strips timestamp suffix). The headline value of normalization is byte-stability across runs, not byte savings — the savings are a side effect.
  diagnostic_records_written: number, // count of JSONL lines this request produced
};
```

Stderr summary (one line per request when the extension did anything):

```
[microcompact] matched=3 normalized=3 bytes=159->90 sentinel_pattern=default
[microcompact] matched=2 dump=/tmp/microcompact-dump.jsonl  (normalize disabled)
```

## Implementation

### File map

| File | Change |
|------|--------|
| `proxy/extensions/microcompact-stability.mjs` | NEW — extension module per pipeline above |
| `proxy/extensions.json` | EXTEND — add `"microcompact-stability": { "enabled": true, "order": 350 }` |
| `test/proxy-microcompact-stability.test.mjs` | NEW — pattern detection, diagnostic dump, normalization, all skip paths |
| `README.md` | EXTEND — env-var table additions; brief explanation under "Microcompact stability" |
| `docs/extension-impact-guide.md` | EXTEND — extension #11 entry |
| `docs/monitoring.md` | EXTEND — env-var table rows |

### Pure functions exposed for tests

```js
export {
  matchesSentinelPattern,         // (text, patterns[]) → matched pattern source | null
  walkToolResultsForSentinels,    // (messages) → [{ msg_idx, block_idx, content_kind, matched, text }]
  normalizeToolResultContent,     // (block, canonicalText) → mutated block
  appendDiagnosticRecord,         // (path, record) → Promise<void>
  runMicrocompactStability,       // orchestrator
};
```

`matchesSentinelPattern` accepts a list of patterns (default + any user-supplied via env). It returns the FIRST matching pattern's source string, so telemetry can record which rule fired. This makes hotfixing easier when CC ships a new sentinel format.

### Pipeline (sketch)

```js
async function runMicrocompactStability(reqCtx) {
  const stats = initStats();
  if (!isDumpEnabled() && !isNormalizeEnabled()) return stats;

  const { exact_matches, partial_matches } = walkToolResultsForSentinels(reqCtx.body.messages);
  stats.exact_matches_count = exact_matches.length;
  stats.partial_matches_count = partial_matches.length;
  stats.total_tool_results_scanned = countToolResults(reqCtx.body.messages);

  // Diagnostic dump runs FIRST (before any normalization), capturing raw bytes.
  // Mode A records carry full sentinel_text; Mode B records carry only prefix_64.
  if (isDumpEnabled() && (exact_matches.length > 0 || partial_matches.length > 0)) {
    const includeNormalized = isIncludeNormalizedEnabled();
    const canonicalText = isNormalizeEnabled() ? getCanonicalText() : null;
    await appendDiagnosticRecord(getDumpPath(), {
      ts: new Date().toISOString(),
      session_id_hash: hashSessionId(reqCtx),
      exact_matches: exact_matches.map(m => serializeExactMatch(m, includeNormalized ? canonicalText : null)),
      partial_matches: partial_matches.map(m => serializePartialMatch(m, getRedactLen())),
      total_messages: reqCtx.body.messages.length,
      total_tool_results: stats.total_tool_results_scanned,
      model: reqCtx.body.model,
    });
    stats.diagnostic_records_written = 1;
  }

  // Normalization runs AFTER dump. Only Mode A matches are eligible.
  if (isNormalizeEnabled()) {
    const canonicalText = getCanonicalText();      // env-overridable
    for (const m of exact_matches) {
      stats.bytes_original += m.text.length;
      normalizeToolResultContent(reqCtx.body.messages[m.msg_idx].content[m.block_idx], canonicalText);
      stats.bytes_normalized += canonicalText.length;
      stats.sentinels_normalized++;
    }
    stats.bytes_saved = stats.bytes_original - stats.bytes_normalized;
  }
  // Mode B (partial_matches) is NEVER mutated, regardless of normalize state.

  return stats;
}
```

## Test plan

### Mode A — exact sentinel match (eligible for normalization)
1. tool_result content exactly `[Old tool result content cleared]` → Mode A match recorded in `exact_matches`.
2. tool_result content exactly `[Old tool result content cleared at 2026-04-30T13:42:11Z]` → Mode A match (timestamp variant). Verify regex requires the full ISO-8601 form (date + time + Z).
3. tool_result content `[Old tool result content cleared at not-a-real-timestamp]` → does NOT match Mode A (timestamp regex constrains accepted formats). Falls through to Mode B prefix check.
4. tool_result content `[Tool result truncated by user]` → no match in either mode (not in default pattern set; rejected from candidates per Codex review).

### Mode B — partial match (diagnostic-only, redacted, NEVER normalized)
4a. tool_result content `[Old tool result content cleared] (with extra notes)` → Mode B match recorded in `partial_matches` with `prefix_64` only. Full text is NEVER in the dump record. Mutation does NOT occur.
4b. tool_result content with prefix `[Old tool result content cleared at 2026-04-30T13:50:00Z]` followed by 200 chars of additional text → Mode B match. `prefix_64` captures only the first 64 chars; bytes 65-264 are NOT recorded.
4c. `CACHE_FIX_MICROCOMPACT_REDACT_LEN=0` set → Mode B match still recorded but `prefix_64` field is empty/absent.

### Custom patterns
5a. `CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_1=<regex>` adds a custom Mode A pattern. Match against it → recorded in `exact_matches` with the matched_pattern source.
5b. Custom pattern matched as a prefix only (block has trailing extra content) → recorded in `partial_matches`, redacted to `prefix_64`. Same redaction applies to user-supplied patterns as to defaults.

### Tool_result content shapes
6. tool_result with `content` as a string containing the sentinel → matched and normalized at string level.
7. tool_result with `content` as an array `[{ type: "text", text: "<sentinel>" }]` → matched and normalized at the inner item level.
8. tool_result with mixed array (text + image) where only the text matches the sentinel → normalize the text item, leave the image untouched.

### Diagnostic dump
9. `CACHE_FIX_DUMP_MICROCOMPACT=/tmp/dump.jsonl` set, sentinel match present → JSONL line appended with the documented schema. session_id is hashed (no plaintext).
10. `CACHE_FIX_DUMP_MICROCOMPACT` unset → no file is created, no fs writes attempted.
11. Multiple matches in one request → ONE JSONL line with all matches split across `exact_matches[]` and `partial_matches[]` arrays per the Mode A/B classification.

### Normalization
12. `CACHE_FIX_NORMALIZE_MICROCOMPACT=1`, default canonical → matched sentinel replaced with `[Old tool result content cleared]`. Other block fields (tool_use_id, type) preserved.
13. `CACHE_FIX_NORMALIZE_MICROCOMPACT=1` + `CACHE_FIX_MICROCOMPACT_NORMALIZED=<custom>` → matched sentinel replaced with the custom text.
14. Normalize disabled, dump enabled → matches recorded in dump but NOT mutated; ctx.body unchanged.
15. Two requests with timestamps `T1` and `T2` in the sentinel → after normalization, the request bodies are byte-identical (modulo other turn-by-turn changes).

### Activation
16. Both env vars unset → extension fires but exits early. No telemetry, no mutation, no fs activity.
17. Only diagnostic enabled → telemetry present, JSONL written, no mutation.
18. Only normalize enabled → telemetry present, mutation happens, no JSONL.
19. Both enabled → telemetry, mutation, AND JSONL all happen. Diagnostic captures the **raw pre-normalization** sentinel text (per the Mode A/B contract); the request body is then mutated. To additionally record the post-normalization form, set `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED=1` — adds a `normalized_text` field alongside (not replacing) the raw `sentinel_text` on Mode A records.

### Telemetry shape
20. `ctx.meta.microcompactStats` contains every documented field after a sentinel-bearing request.
21. Stderr summary line emitted when the extension did anything observable; format matches the spec.

### Regression
22. All v3.3.0 tests still pass (extension is additive at order 350, runs before `cache-control-normalize` but doesn't alter cache_control markers).
23. `cache-control-normalize` sticky-marker hashes are stable across normalization (since the post-normalize content is byte-stable, sticky hashes match across runs).

## Reviewer checklist

- [ ] Activation uses `enabled: true` + runtime env-gate (prefix-diff pattern). `extensions.json` updated.
- [ ] Extension order is 350 (between `tool-input-normalize` at 340 and `cache-control-normalize` at 400).
- [ ] Both diagnostic and normalize paths are independently gated; each can run alone.
- [ ] Default canonical text is the maximally-stable form (no timestamps, no IDs). Test 12 verifies.
- [ ] Custom sentinel pattern via env var overrides correctly. Test 5 verifies.
- [ ] Custom canonical text via env var overrides correctly. Test 13 verifies.
- [ ] Diagnostic dump captures **raw pre-normalization** sentinel bytes in `exact_matches[].sentinel_text`. Post-normalize text appears only when `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED=1` is set, alongside (not replacing) the raw text.
- [ ] Mode A (exact match) records full `sentinel_text`. Mode B (prefix match) records ONLY `prefix_64` plus structural metadata — full text is never in the dump. Tests 4a-4c verify.
- [ ] Privacy framing matches the implementation: Mode A = full capture (safe by construction), Mode B = redacted to 64 chars (configurable via `CACHE_FIX_MICROCOMPACT_REDACT_LEN`).
- [ ] Session ID is hashed in the dump (one-way; no plaintext). Test 9 verifies.
- [ ] Mode B (partial match) is NEVER normalized. Tests 4a-4b verify body bytes unchanged in those cases.
- [ ] All tool_result content shapes (string and array) are handled. Tests 6-8 verify.
- [ ] Telemetry surface includes the full counter set on every onRequest invocation when enabled.
- [ ] Phase 2 (snapshot-and-restore) is explicitly out-of-scope and documented as deferred.
- [ ] No new top-level dependencies.
- [ ] CI green on Node 18 / 20 / 22.
- [ ] README env-var table updated; "Microcompact stability" section added.
- [ ] At least one test fixture sourced from a real CC microcompact dump (not synthesized) — Phase 1 will provide.

## Out of scope (explicit, deferred)

- **Phase 2 — snapshot-and-restore of original tool_result content.** The complete fix; deferred until Phase 1 production data confirms whether sentinel normalization alone is sufficient. Phase 2 candidates: persistent state under `~/.claude/microcompact-snapshots/`, or in-proxy LRU keyed by session_id. Interacts with v3.3.0 image-guard Pass 2 byte budget; needs design.
- Server-side `CACHED_MICROCOMPACT` flag — not under our control; track but don't depend.
- Direct intervention in CC's microcompact trigger — impossible from the proxy.
- Per-tool-use_id reconstruction (trying to figure out what the original tool_result was from external state like the project filesystem) — too risky; the data may have changed since the original tool_use ran.

— AI Team Lead
