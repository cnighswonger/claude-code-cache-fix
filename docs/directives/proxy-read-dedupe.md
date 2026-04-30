# Directive: read-dedupe extension

**Issue:** #85
**Branch:** `directive/read-dedupe`
**Stage:** directive
**Milestone:** v3.4.0 (P2)

## Goal

New extension `proxy/extensions/read-dedupe.mjs` that detects duplicate `Read` tool results in the request body's message history and replaces all-but-the-most-recent occurrence with a stable byte-stable pointer. Targets the SNR-collapse failure mode that the llm-relay Context Health panel flags as "tool results dominate context. Consider starting a new session to restore signal quality." That collapse correlates with downstream Anthropic 500 errors that don't recover on retry.

## Why

The cache-fix proxy already addresses prefix-stability (image-strip, content-strip, smoosh-split, identity-normalization, TTL injection) and request-size pressure (image-guard Pass 2 byte budget). It does NOT address request-body bloat from the same file being `Read` repeatedly across turns. Empirical evidence:

- **2026-04-26**: Sim Agent at SNR 0.27 / 94 dup reads / "tool results dominate" warning → 500-error cascade that retrying never recovered.
- **2026-04-27 morning**: AI Team Lead session at SNR 0.27 / 122 dup reads / same warning → recovered only via `/compact`.

In both cases, the 500 errors weren't transient. The downstream symptom was a body whose SNR (signal-to-noise: user/assistant text divided by tool-result/thinking bytes) dropped below 0.30, which appears to put the request in a regime Anthropic's API mishandles. The duplicate-read case is the dominant contributor: a long debugging session re-reads the same handful of files dozens of times, each time appending a fresh ~5–30 KB tool_result block that the model has already seen.

The extension dedupes only when the byte-identical content has appeared before. Drift = no dedupe (the model needs to see the new bytes). The most-recent occurrence is preserved intact so the agent's working copy of each file is current; older occurrences become byte-stable pointers like `(unchanged — see tool_use_id=X in turn N)`.

## Source of truth

This directive operationalizes issue #85 (originally drafted by AI Team Lead 2026-04). The issue body already carries most of the design scaffolding; this directive resolves the open questions, adds detection precision, and pins the test surface.

Key references:
- Issue #85 body — design scaffolding, activation pattern, key shape (file_path, sha256, offset, limit).
- llm-relay Context Health panel (`/api/v1/context-health` endpoint) — the SNR computation that surfaces the collapse pattern.
- Memory `playbook_500_one_agent_failing.md` — context degradation as the dominant root cause for unrecoverable 500s.

## Scope (v3.4.0)

In scope:

1. New env var `CACHE_FIX_READ_DEDUPE=1` — opt-in pipeline gate. Default off until validated against real workloads.
2. New extension `proxy/extensions/read-dedupe.mjs` registered at order 380 (between `tool-input-normalize` at 340 and `cache-control-normalize` at 400). Order matters: must run BEFORE cache-control-normalize so the latter's sticky-marker hashes are computed against the post-dedupe content.
3. Detection of `Read`-originated `tool_result` blocks via the `(file_path, sha256(content), offset, limit)` key (see §Detection).
4. Replacement of older occurrences with the stable pointer text; most recent stays intact.
5. Telemetry surface on `ctx.meta.readDedupeStats` with: scanned tool_results, Read-classified tool_results, duplicate keys found, replacements written, bytes saved.
6. README env-var table addition + extension-impact-guide entry (#11 if microcompact-stability is #11, otherwise #12).

Out of scope (explicitly):

- **Dedupe of non-Read tool_results.** The key is content-stability per file path; non-Read tools (Bash, Grep) produce results that aren't keyed by file. Out of scope. Issue #85 calls this out explicitly.
- **Cross-session dedupe.** Each request is treated independently; no persistent state across requests. (Phase 2 candidate if data warrants.)
- **Image dedupe.** Image content goes through `image-strip` + `image-guard`; this extension stays text-only.
- **Soft dedupe** (replacing with a summary instead of a pointer). The model loses information either way; the pointer is the simpler contract and cheaper to test.

## Activation

**Prefix-diff pattern**:

- Extension `enabled: true` in `proxy/extensions.json`, registered at order 380.
- Runtime gate inside `onRequest`: `if (!isEnabled()) return;` at top. Default off.
- No legacy back-compat; this extension didn't exist before.

The PR #79 round-1 mistake (`enabled: false` + env-var gate cannot work because the loader skips disabled extensions) is avoided by construction.

## Detection

### Identifying Read-originated tool_result blocks

A `tool_result` block can be matched to its originating `tool_use` by `tool_use_id`. The originating block lives in an earlier `assistant` message in the same conversation. Walk pattern:

1. Build a map `tool_use_id → tool_use_block` by scanning all assistant messages once (forward pass).
2. For each `tool_result` block in any user message, look up its `tool_use_id` to find the originating `tool_use`.
3. A `tool_use` is Read-originated when:
   - `tool_use.name === "Read"` (case-sensitive — CC's tool registry uses TitleCase).
   - `tool_use.input.file_path` is a non-empty string.
4. If the originating tool_use is missing (truncated history, hook stripped) or the tool_use name is not Read, skip the block (don't dedupe).

### Content key

For each Read-originated tool_result, compute the dedupe key:

```
key = sha256(file_path + "\0" + content + "\0" + (offset ?? "") + "\0" + (limit ?? ""))
```

Notes:
- Null-byte separators (`\0`) prevent boundary ambiguity (e.g., `file=foo\noffset=10` colliding with `file=foo\noffset=` + `10`).
- `content` is the actual `tool_result.content` text (or array-text concatenation for array content).
- `offset` and `limit` come from the originating `tool_use.input` (Read may be partial). Different offsets/limits = different keys = no dedupe.
- SHA-256 keeps key length bounded (64 hex chars) and collision-resistant. The cost is ~microseconds per key on modern CPUs; non-issue.

### Walk + replace logic

1. Single forward pass through `body.messages` collecting Read-originated tool_result refs (indexed by msg_idx, block_idx, item_idx | null), keyed as above.
2. For each key with ≥2 occurrences, mark all but the LAST occurrence as "replace candidates."
3. For each replace candidate, mutate the tool_result content in place to the pointer text (see §Replacement contract).
4. Stats accumulate in `ctx.meta.readDedupeStats`.

This is O(n) over total tool_result count. n is typically 50–200 in long sessions; trivial.

## Replacement contract

The replacement text follows a stable byte-stable format so repeat runs produce identical pointer bytes for the same source position. Format:

```
(unchanged — see tool_use_id=<KEEPER_ID> in turn <KEEPER_TURN>)
```

Where:
- `KEEPER_ID` = `tool_use_id` of the most-recent (kept) occurrence's originating tool_use.
- `KEEPER_TURN` = 1-indexed conversation turn count, computed from the message position. A "turn" is a user→assistant pair; `messages[0]` (first user message) starts turn 1; the kept occurrence's containing user message determines its turn number via `Math.floor(msg_idx / 2) + 1`.

The pointer is byte-stable across requests as long as the keeper's tool_use_id is stable (it is — it's CC-assigned and survives turn boundaries) AND the turn count is stable (it is — turns don't renumber retroactively).

### Tool_result content shape preservation

`tool_result.content` may be:
- A string → replace with the pointer string directly.
- An array of items (mostly `{ type: "text", text }`, occasionally with images) → replace the matched text item with `{ type: "text", text: <pointer> }`. Other items in the array (images, non-matching text) are NOT touched. Image-bearing tool_results are unusual for Read but possible; handle defensively.

## Open questions resolved

The issue body raised three open questions. Resolutions for this directive:

### 1. Prefix cache impact

**Concern:** mutating earlier-turn tool_result content changes those bytes. Does the prefix cache invalidate when historical turns are mutated, or only check up to the current cache breakpoint?

**Resolution:** the prefix cache invalidates on any byte change before the current cache_control marker. So replacing earlier-turn content WILL bust the cache once on the first turn the dedupe kicks in. Every subsequent turn benefits from a tighter (smaller, more cacheable) prefix.

The one-time cache miss is acceptable because:
- The request was already over-bloated; the SNR collapse + 500-error pattern is worse than a cache miss.
- After the dedupe stabilizes, the smaller prefix is byte-stable across subsequent turns and re-caches normally.
- The pointer text itself is byte-stable (per §Replacement contract), so subsequent dedupes against the same key produce identical bytes.

We do NOT scope to dedupe-only-within-most-recent-turn. The whole-history sweep is the higher-value behavior. The extension does NOT need to track "first time we deduped" — every fresh dedupe is independent and the pointer is deterministic.

### 2. Age cap

**Concern:** limit dedupe to last N turns?

**Resolution:** no age cap in v1. The dedupe key is stable; a duplicate from 50 turns ago is just as wasteful as one from 3 turns ago. If real workloads show the sweep cost as significant (it shouldn't — it's O(n) with tiny constants), revisit in v2.

### 3. Interaction with image-strip

**Concern:** does this conflict with image stripping?

**Resolution:** no. Image-strip / image-guard operate on `type === "image"` source blocks; this extension operates on `type === "text"` tool_result content where the originating tool_use is `Read`. Read tool returns text; image bytes never enter this extension's path. Documented in §Scope.

## Telemetry

Full counter set on `ctx.meta.readDedupeStats`:

```js
ctx.meta.readDedupeStats = {
  enabled: boolean,
  total_tool_results_scanned: number,
  read_tool_results_classified: number,    // matched a Read originating tool_use
  read_tool_results_skipped: number,       // tool_use missing / drift / non-Read
  unique_keys: number,                     // distinct (file, content, offset, limit) tuples
  duplicate_keys: number,                  // keys with ≥2 occurrences
  replacements_written: number,            // total older occurrences replaced
  bytes_original: number,                  // sum of replaced content bytes (pre-dedupe)
  bytes_after: number,                     // sum of pointer text bytes (post-dedupe)
  bytes_saved: number,                     // bytes_original - bytes_after; positive if dedupe helped
};
```

A single stderr line is emitted per processed request when the extension did anything observable:

```
[read-dedupe] replaced=12 keys=4 bytes=156234->840 (saved=99.5%) reads_seen=18
[read-dedupe] no-op reads_seen=3 (no duplicates)
```

The "no-op" case is logged so operators can verify the extension is firing — important during initial rollout when most sessions won't have duplicates yet.

## Implementation

### File map

| File | Change |
|------|--------|
| `proxy/extensions/read-dedupe.mjs` | NEW — extension module per pipeline above |
| `proxy/extensions.json` | EXTEND — add `"read-dedupe": { "enabled": true, "order": 380 }` |
| `test/proxy-read-dedupe.test.mjs` | NEW — detection, key computation, replacement, telemetry, no-op |
| `README.md` | EXTEND — env-var table addition; brief "Read deduplication" section |
| `docs/extension-impact-guide.md` | EXTEND — new extension entry (next available number) |
| `docs/monitoring.md` | EXTEND — env-var table row |

### Pure functions exposed for tests

```js
export {
  buildToolUseMap,                  // (messages) → Map<tool_use_id, tool_use_block>
  isReadToolUse,                    // (tool_use_block) → boolean
  computeDedupeKey,                 // (file_path, content, offset, limit) → sha256 hex
  walkReadToolResults,              // (messages, toolUseMap) → [{ ref, key, content, content_kind }]
  buildReplacementText,             // (keeper_tool_use_id, keeper_turn) → pointer string
  runReadDedupe,                    // orchestrator
};
```

`computeDedupeKey` is exported separately because it's the load-bearing correctness primitive — tests must verify byte-stable hashing across runtime invocations.

### Pipeline (sketch)

```js
async function runReadDedupe(reqCtx) {
  const stats = initStats();
  if (!isEnabled()) return stats;

  const messages = reqCtx.body.messages;
  if (!Array.isArray(messages)) return stats;

  const toolUseMap = buildToolUseMap(messages);
  const reads = walkReadToolResults(messages, toolUseMap);
  stats.total_tool_results_scanned = countToolResults(messages);
  stats.read_tool_results_classified = reads.length;

  // Group by key, finding duplicates
  const byKey = new Map();
  for (const r of reads) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  stats.unique_keys = byKey.size;

  for (const [key, occurrences] of byKey) {
    if (occurrences.length < 2) continue;
    stats.duplicate_keys++;
    // Keep the LAST one; replace all earlier ones.
    const keeper = occurrences[occurrences.length - 1];
    const keeperTurn = computeTurn(keeper.ref.msg_idx);
    const pointer = buildReplacementText(keeper.tool_use_id, keeperTurn);
    for (let i = 0; i < occurrences.length - 1; i++) {
      const old = occurrences[i];
      stats.bytes_original += old.content.length;
      stats.bytes_after += pointer.length;
      replaceContentInPlace(messages, old.ref, old.content_kind, pointer);
      stats.replacements_written++;
    }
  }
  stats.bytes_saved = stats.bytes_original - stats.bytes_after;
  return stats;
}
```

## Test plan

### Detection
1. Single Read tool_result, no duplicates → `replacements_written === 0`, body unchanged.
2. Two Read tool_results, same `(path, content, offset, limit)` → 1 replacement, older one becomes pointer.
3. Three Read tool_results with same key → 2 replacements (oldest two become pointers; most recent stays).
4. Two Reads, same path + content but different `offset` → 0 replacements (different keys).
5. Two Reads, same path + offset but different content (file changed mid-session) → 0 replacements (different keys).
6. tool_result whose `tool_use_id` doesn't resolve in toolUseMap (truncated history) → skipped, recorded in `read_tool_results_skipped`.
7. tool_result whose originating tool_use is `Bash` not `Read` → skipped, not classified as Read.
8. tool_result where Read's `input.file_path` is missing → skipped (defensive; shouldn't happen but defends against malformed bodies).

### Key computation
9. `computeDedupeKey("/a/b.txt", "hello", 0, 100)` returns a 64-char hex string.
10. Two calls with identical args return identical keys (byte-stable).
11. Changing any field changes the key (file_path / content / offset / limit each independently).
12. Null `offset` and `limit` produce a stable key (Read with no offset/limit case is the common case).
13. Boundary safety: `(file="a\nb=10", content, offset=null)` does NOT collide with `(file="a", content="\nb=10", offset=null)` — null-byte separators handle it.

### Content shape
14. tool_result with `content` as a string → replaced with pointer string.
15. tool_result with `content` as `[{ type: "text", text: "<file content>" }]` → text item replaced; structure preserved.
16. tool_result with `content` as `[{ type: "text", text: "<file content>" }, { type: "image", ... }]` → text item replaced; image item untouched. (Defensive — Read shouldn't return images, but handle gracefully.)
17. tool_result with empty content `""` → key is computed and matches; treated as a normal duplicate if seen twice.

### Replacement contract
18. Pointer text format matches `(unchanged — see tool_use_id=<id> in turn <n>)` exactly.
19. Pointer text is byte-stable across two invocations on identical input (no embedded timestamps or counters).
20. Keeper's `tool_use_id` is the LAST occurrence's id, never an earlier one.
21. Keeper's turn number is computed correctly — `messages[0]` user → turn 1; `messages[2]` user → turn 2; `messages[N]` user → turn `Math.floor(N/2) + 1`.

### Activation
22. `CACHE_FIX_READ_DEDUPE` unset → extension fires but exits early. No telemetry, no mutation.
23. `CACHE_FIX_READ_DEDUPE=1`, no Reads in body → telemetry present (all zeros), no mutation.
24. `CACHE_FIX_READ_DEDUPE=1`, no duplicates → telemetry shows `replacements_written=0`, body unchanged.
25. `CACHE_FIX_READ_DEDUPE=1`, duplicates present → telemetry counts replacements, body mutated.

### Telemetry shape
26. `ctx.meta.readDedupeStats` contains every documented field after a duplicate-bearing request.
27. `bytes_saved` is positive when there are duplicates; equals 0 when extension fires but finds nothing to dedupe.

### Pipeline order
28. `read-dedupe` runs at order 380, BEFORE `cache-control-normalize` at 400. Verify by mocking both extensions in pipeline order and checking that `cache-control-normalize` sees post-dedupe content.

### Regression
29. All v3.3.0 + #90/#91 tests still pass — extension is additive, doesn't touch any other extension's mutations.

## Reviewer checklist

- [ ] Activation uses `enabled: true` + runtime env-gate (prefix-diff pattern). `extensions.json` updated.
- [ ] Extension order is 380 (between `tool-input-normalize` at 340 and `cache-control-normalize` at 400).
- [ ] `computeDedupeKey` uses null-byte separators. Test 13 verifies boundary safety.
- [ ] Read tool_use detection is case-sensitive on `name === "Read"`. Test 7 verifies Bash isn't matched.
- [ ] Tool_use map is built once per request (single forward pass), not per-block. O(n) overall.
- [ ] Older occurrences are replaced; the LAST occurrence is preserved. Test 3 verifies.
- [ ] Pointer text is byte-stable — no timestamps, no counters. Test 19 verifies.
- [ ] All tool_result content shapes (string, text-array, mixed array with image) are handled. Tests 14-16 verify.
- [ ] Telemetry surface includes the full counter set on every onRequest invocation when enabled.
- [ ] Stderr summary line emitted on both duplicate-found and no-op cases (so operators can verify firing).
- [ ] No new top-level dependencies (sha256 via Node's built-in `crypto` module).
- [ ] CI green on Node 18 / 20 / 22.
- [ ] README env-var table updated; brief "Read deduplication" section added.
- [ ] `docs/extension-impact-guide.md` entry added.
- [ ] At least 3 fixture bodies in tests sourced from real CC traffic (CACHE_FIX_DEBUG=1 with the duplicate-Read pattern), not synthetic-only.

## Out of scope (explicit, deferred)

- Dedupe of non-Read tool_results (Bash, Grep, etc.).
- Cross-session persistent dedupe state.
- Image content (handled by image-strip / image-guard).
- Soft dedupe / summary-replacement (pointer is the v1 contract).
- Whole-history sweep age cap (no cap in v1; revisit if O(n) cost shows up in profiling).

— AI Team Lead
