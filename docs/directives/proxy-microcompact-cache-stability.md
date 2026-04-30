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
  Phase 2 is the complete fix but every one of those bullets is its own design decision. Ship Phase 1, gather data, decide if Phase 2 is needed.
- Direct intervention in the microcompact trigger — impossible from the proxy. The 90-minute timer lives inside CC's process state, not in the request body.
- Reliance on the `CACHED_MICROCOMPACT` server flag — not under our control; track but don't ship anything that breaks if it's enabled or disabled.

## Activation

**Prefix-diff pattern**:

- Extension flips to `enabled: true` in `proxy/extensions.json` and is registered at order 350.
- Two independent runtime gates inside the extension body:
  - `CACHE_FIX_DUMP_MICROCOMPACT=<path>` enables diagnostic dumping (read-only; no mutation).
  - `CACHE_FIX_NORMALIZE_MICROCOMPACT=1` enables sentinel normalization (mutates `ctx.body.messages[].content`).
- Both can be on simultaneously (you'll dump the post-normalized snapshot, which is useful for verifying the rule).
- If neither gate is set, the extension fires but exits early. No telemetry, no mutation.

The repeat error from PR #79 round-1 (`enabled: false` + env-var gate) is avoided by construction.

## Detection

CC's microcompact sentinel is documented as `[Old tool result content cleared]` in earlier comments on the project (per memory entry on microcompact monitoring), but we have not pinned down whether the sentinel embeds volatile fields. Phase 1 diagnostic captures the actual sentinel string from production traffic.

Candidate patterns to match (one or more, OR'd together):

```
^\[Old tool result content cleared\]\s*$
^\[Old tool result content cleared at .+?\]\s*$       // with timestamp variant
^\[Tool result truncated.*\]\s*$                       // alternative wording
^\[microcompact.*\]\s*$                                // future variants
```

Detection logic: walk `body.messages[].content[]`. For each block where `type === "tool_result"`:
- If `content` is a string, regex-match against the sentinel patterns.
- If `content` is an array of items, regex-match each `text` item.
- Match → record in stats, optionally normalize.

Edge cases:
- **Block has the sentinel but also has additional content** (e.g., partial truncation) → record but DO NOT normalize. Partial truncation suggests the sentinel doesn't represent the full microcompact rewrite, and normalizing might erase real data.
- **Multiple tool_result blocks all carry the sentinel** → walk all of them; record per-block stats.
- **The sentinel pattern changes between CC versions** → diagnostic capture (Phase 1) re-establishes ground truth; normalization rule is parameterized via env var override (`CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN=<regex>`) for hotfix-without-release.

## Diagnostic capture (Phase 1, always-on when env var set)

When `CACHE_FIX_DUMP_MICROCOMPACT=<path>` is set, before any normalization runs, the extension writes a JSONL record to the path for any request whose messages contain a sentinel match:

```json
{
  "ts": "2026-04-30T15:00:00Z",
  "session_id_hash": "abc123",
  "matched_sentinels": [
    {
      "msg_idx": 3,
      "block_idx": 1,
      "content_kind": "string",
      "matched_pattern": "^\\[Old tool result content cleared\\].*$",
      "sentinel_text": "[Old tool result content cleared at 2026-04-30T13:42:11Z]",
      "byte_length": 53
    }
  ],
  "total_messages": 12,
  "total_tool_results": 7,
  "model": "claude-opus-4-7-20260101"
}
```

Privacy: only the sentinel text itself is captured (which by definition doesn't carry user content — it's CC's replacement string). No real tool_result content is dumped. Session ID is hashed.

This file is the design input for the actual normalization rule. Without production samples we can only normalize against synthesized sentinels, and a wrong normalization rule is worse than no normalization (would produce inconsistent canonicalization across the fleet).

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
  bytes_original: number,             // sum of matched sentinel byte lengths before
  bytes_normalized: number,           // sum after normalization
  bytes_saved: number,                // original - normalized (often negative-ish; the value is "stability over savings")
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

  const matches = walkToolResultsForSentinels(reqCtx.body.messages);
  stats.sentinels_matched = matches.length;
  stats.total_tool_results_scanned = countToolResults(reqCtx.body.messages);

  if (isDumpEnabled() && matches.length > 0) {
    await appendDiagnosticRecord(getDumpPath(), {
      ts: new Date().toISOString(),
      session_id_hash: hashSessionId(reqCtx),
      matched_sentinels: matches.map(serializeMatch),
      total_messages: reqCtx.body.messages.length,
      total_tool_results: stats.total_tool_results_scanned,
      model: reqCtx.body.model,
    });
    stats.diagnostic_records_written = 1;
  }

  if (isNormalizeEnabled()) {
    const canonicalText = getCanonicalText();      // env-overridable
    for (const m of matches) {
      stats.bytes_original += m.text.length;
      normalizeToolResultContent(reqCtx.body.messages[m.msg_idx].content[m.block_idx], canonicalText);
      stats.bytes_normalized += canonicalText.length;
      stats.sentinels_normalized++;
    }
    stats.bytes_saved = stats.bytes_original - stats.bytes_normalized;
  }

  return stats;
}
```

## Test plan

### Pattern detection
1. tool_result content `[Old tool result content cleared]` → matches default pattern.
2. tool_result content `[Old tool result content cleared at 2026-04-30T13:42:11Z]` → matches with-timestamp variant.
3. tool_result content `[Tool result truncated by user]` → no match (not a microcompact sentinel).
4. tool_result content with prefix `[Old tool result content cleared]` followed by additional text → matches BUT recorded with `partial_match: true` (no normalize, by design).
5. User-supplied custom pattern via `CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN=<regex>` overrides the default list and matches accordingly.

### Tool_result content shapes
6. tool_result with `content` as a string containing the sentinel → matched and normalized at string level.
7. tool_result with `content` as an array `[{ type: "text", text: "<sentinel>" }]` → matched and normalized at the inner item level.
8. tool_result with mixed array (text + image) where only the text matches the sentinel → normalize the text item, leave the image untouched.

### Diagnostic dump
9. `CACHE_FIX_DUMP_MICROCOMPACT=/tmp/dump.jsonl` set, sentinel match present → JSONL line appended with the documented schema. session_id is hashed (no plaintext).
10. `CACHE_FIX_DUMP_MICROCOMPACT` unset → no file is created, no fs writes attempted.
11. Multiple matches in one request → ONE JSONL line with all matches in `matched_sentinels` array.

### Normalization
12. `CACHE_FIX_NORMALIZE_MICROCOMPACT=1`, default canonical → matched sentinel replaced with `[Old tool result content cleared]`. Other block fields (tool_use_id, type) preserved.
13. `CACHE_FIX_NORMALIZE_MICROCOMPACT=1` + `CACHE_FIX_MICROCOMPACT_NORMALIZED=<custom>` → matched sentinel replaced with the custom text.
14. Normalize disabled, dump enabled → matches recorded in dump but NOT mutated; ctx.body unchanged.
15. Two requests with timestamps `T1` and `T2` in the sentinel → after normalization, the request bodies are byte-identical (modulo other turn-by-turn changes).

### Activation
16. Both env vars unset → extension fires but exits early. No telemetry, no mutation, no fs activity.
17. Only diagnostic enabled → telemetry present, JSONL written, no mutation.
18. Only normalize enabled → telemetry present, mutation happens, no JSONL.
19. Both enabled → telemetry, mutation, AND JSONL all happen (diagnostic captures the post-normalization state).

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
- [ ] Diagnostic dump never writes user content, only the matched sentinel text + structural metadata. Test 9 verifies.
- [ ] Session ID is hashed in the dump (one-way; no plaintext). Test 9 verifies.
- [ ] Partial matches (sentinel as prefix only) are recorded but NOT normalized. Test 4 verifies.
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
