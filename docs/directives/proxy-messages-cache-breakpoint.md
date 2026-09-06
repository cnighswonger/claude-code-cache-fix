# Directive: messages[0] cache breakpoint #3 injection

> **Superseded — retained as a design record, not as current behaviour.**
> `insertion-normalization` (#272, merged 2026-08-05) covers this directive's
> rationale by recognising a message across re-serializations through content
> identity, rather than pinning its position with a `cache_control` marker —
> and so without spending the 4th breakpoint slot, which the API caps at four
> per request and Claude Code already occupies three of. The extension
> described below was removed from `main`; `main` does not match this document.

**Issue:** #12
**Branch:** `directive/messages-cache-breakpoint`
**Stage:** superseded (was: directive)
**Milestone:** v3.4.0 (P1)

## Goal

Inject the missing `cache_control: { type: "ephemeral", ttl: "1h" }` breakpoint at the boundary between Claude Code's auto-injected blocks (skills listing, project CLAUDE.md content, deferred tools, MCP server lists) and the first "real" user content inside `messages[0]`. This is the cache breakpoint that wadabum identified as **completely missing** from CC's request shape — the third of the four breakpoints Anthropic supports, and the one most relevant to multi-turn cache hits across fresh sessions and `/clear`.

## Why

Anthropic's prompt cache is **prefix-based**: it matches from the beginning of the request forward, and a `cache_control` marker turns the position immediately before it into a cacheable boundary. A request can have up to four such markers. CC currently uses three of the four available breakpoints:

| Breakpoint | Position | Status |
|---|---|---|
| 1 | After tools (in `system[2]` second-block cache_control) | ✓ Working |
| 2 | After system prompt | ✓ Present, broken by volatile content (#11 git-status) |
| 3 | **After skills + CLAUDE.md inside `messages[0]`** | **✗ Missing entirely** |
| 4 | First user message | ✓ Present |

Without breakpoint #3, the entire span of auto-injected content — skills listing, project CLAUDE.md, deferred tools registration, MCP server descriptions — has no cache marker on it. Every change to any of those blocks busts the cache for everything that follows, which on a new turn is the entire conversation. On a fresh session or `/clear`, regenerated skills/CLAUDE.md content can differ in subtle ways (ordering, whitespace, deferred-tool registration timing) and force a full `cache_creation` even seconds after the prior session ended.

@X-15 dumped the breakpoint structure on VS Code and confirmed only **two** breakpoints present there (vs three on CLI), making the gap even more pronounced for VS Code users. wadabum filed the upstream issue ([anthropics/claude-code#47098](https://github.com/anthropics/claude-code/issues/47098)) and projected that adding the missing breakpoint would reduce first-turn `cache_creation` by ~6,505 tokens per fresh session — that's the typical size of the un-cached skills + CLAUDE.md span.

This is the **last major cache optimization the interceptor can do client-side**. It's also the last breakpoint we can add: at four markers we hit Anthropic's limit, so the directive must include logic to refuse injection if the request already has four.

## Source of truth

This directive operationalizes the design discussion on issue #12 (closed by wadabum's confirmation that breakpoint #3 is the missing one), [anthropics/claude-code#47098](https://github.com/anthropics/claude-code/issues/47098), and the X-15 VS Code dump in #16.

Key references in the issue thread:
- wadabum's 4-breakpoint analysis (2026-04-13) — the canonical mapping table.
- AI Team Lead's status update (2026-04-16) — `CACHE_FIX_DUMP_BREAKPOINTS` diagnostic shipped, X-15 VS Code dump confirms breakpoint #3 absent on both surfaces.
- v3.3.0 release notes — confirms the `image-guard` pipeline is settled, clearing the v3.4.0 deck for this work.

## Scope (v3.4.0)

In scope:

1. New env var `CACHE_FIX_INJECT_MESSAGES_BREAKPOINT=1` — opt-in pipeline gate. Default off until validated against community data.
2. New env var `CACHE_FIX_DUMP_MESSAGES_HEAD=<path>` — diagnostic-only dump of `messages[0].content` structure (block kinds + text first 200 chars per block + cache_control presence) to a JSONL path. Read-only; no mutation. Provides the test-fixture source the implementation review needs (the existing `CACHE_FIX_DUMP_BREAKPOINTS` only dumps blocks that ALREADY have `cache_control`, so it cannot capture the unmarked skills/CLAUDE.md/deferred-tools/MCP/hooks blocks this directive targets — Codex flagged this gap on the prior draft).
3. New extension `proxy/extensions/messages-cache-breakpoint.mjs` registered at order 410 (immediately after `cache-control-normalize`, so we operate on a normalized marker baseline).
4. Detection of the auto-injected content boundary in `messages[0].content` per the five-kind taxonomy in §Detection below.
5. Injection of `cache_control: { type: "ephemeral", ttl: "1h" }` on the LAST detected auto-injected block.
6. **Hard refusal to inject if the request already carries 4 cache_control markers** (counting both `system[]` and `messages[].content[]` positions). Anthropic's limit is 4; exceeding it returns a 400.
7. Telemetry surface on `ctx.meta.messagesBreakpointStats` — boundary index, blocks examined, injected/skipped reason.
8. README env-var table additions; precedence note in extension-impact-guide.

Out of scope (deferred):

- Migration of skills/CLAUDE.md content from `messages[0]` to `system[]`. Architecturally cleaner but high-risk: CC reads `messages[0]` to compose tool_use_id continuity, and moving content would require parallel modification of every following turn's `tool_result` references. A v4.0.0+ candidate.
- Synthesizing breakpoint #3 from scratch when the request shape doesn't include the auto-injected blocks at all (Agent SDK / API direct usage). The fix only adds value when CC has injected the blocks; otherwise we'd be inserting a marker against random user content, which busts the cache for that user message instead of helping it.
- VS Code-specific breakpoint #2 recovery. Per X-15's dump, VS Code is missing both #2 and #3. We address #3 here because it's the higher-impact one and the boundary detection is the same on both surfaces. #2 belongs in a follow-up directive.
- Per-block TTL override. Always inject `1h` to match `ttl-management`'s default; if the user is in 5m tier the server downgrades server-side anyway.

## Activation

**Prefix-diff pattern** (the `overage-warning` / `image-strip` shape):

- Extension flips to `enabled: true` in `proxy/extensions.json` and is registered at order 410.
- Runtime gate inside the extension body: `if (!isEnabled()) return;` at the top of `onRequest`. Default off.
- No legacy back-compat layer needed — this extension didn't exist before.

The repeat error from PR #79 round-1 (`enabled: false` + env-var gate cannot work because the loader skips disabled extensions) is avoided by construction.

## Detection

### Complete observed auto-injected block set

Per `preload.mjs:7` ("attachment blocks (hooks, skills, deferred-tools, MCP)") and `preload.mjs:339` (`<system-reminder>...hook success`), the **full observed** set is **five** kinds:

| Block kind | Signature (case-sensitive substring match on text content) |
|------------|------------------------------------------------------------|
| **Hooks** | `type: "text"`, text begins with `<system-reminder>` AND contains `hook success` (matches `SessionStart:startup hook success`, `SessionStart:resume hook success`, and PreToolUse / PostToolUse variants per `preload.mjs:195`, `preload.mjs:341`, `preload.mjs:358`) |
| **Skills listing** | `type: "text"`, text begins with `<system-reminder>` AND contains either `<available-skills>` OR `<plugin-skills>` |
| **Project CLAUDE.md** | `type: "text"`, text contains `<system-reminder>` AND matches the regex `Contents of /[^\n]*?CLAUDE\.md` (anchored on absolute paths starting with `/`) |
| **Deferred tools registration** | `type: "text"`, text contains the exact substring `<deferred-tools>` (block-kind sentinel; CC always wraps the tool list in this tag pair per `findDeferredToolsBlockInBody` in `preload.mjs`) |
| **MCP server descriptions** | `type: "text"`, text contains either `<mcp-resources>` OR the exact substring `Available MCP servers:` (the two known sentinels CC uses to introduce MCP block content) |
| Image attachments / user-pasted content | `type: "image"` OR `type: "text"` without any `<system-reminder>` wrapper. NOT auto-injected. |

The hooks addition is **load-bearing**: a request shaped as `[skills, hooks, user-text]` would, under the original four-kind taxonomy, classify hooks as user-content and place breakpoint #3 at index 0 — leaving the hooks block uncached. Adding hooks to the taxonomy correctly places the boundary at index 1.

### Detection logic

Walk `messages[0].content` from index 0 forward. Track `lastAutoInjectedIdx` (initialized to `-1`). For each block, classify by running the signature checks **in the order shown above** (hooks → skills → CLAUDE.md → deferred-tools → MCP). The first signature to match wins (so a block is classified by its FIRST matching signature, not OR-combined). Set `lastAutoInjectedIdx = i` whenever any auto-injected signature matches. After the walk, `lastAutoInjectedIdx` is the boundary; breakpoint #3 goes on `messages[0].content[lastAutoInjectedIdx]`.

### Signature precision

The signatures above are tightened to avoid the over-matching Codex flagged on the prior draft:

- **Skills**: anchored on `<system-reminder>` opening tag at start of text — won't match user messages that quote `<available-skills>` from documentation.
- **CLAUDE.md**: regex anchored on absolute path prefix (`/`) — won't match user text that says "see CLAUDE.md".
- **Deferred-tools**: exact substring `<deferred-tools>` — only the block-wrapping XML tag matches, not user prose mentioning "deferred tools".
- **MCP**: two specific sentinels (`<mcp-resources>` tag OR `Available MCP servers:` literal) — not the abstract "an MCP server enumeration" of the prior draft.
- **Hooks**: requires both `<system-reminder>` opening AND `hook success` substring — narrow enough that user messages discussing hook semantics won't false-positive.

### Edge cases

- **No auto-injected blocks found** → `lastAutoInjectedIdx = -1`; skip injection, telemetry records `boundary_not_found`.
- **All blocks are auto-injected** → boundary is the last block of `messages[0].content`. Inject there — that's the cleanest cut between session-stable content and the eventual user content in `messages[1]`.
- **Auto-injected blocks interleaved with user content** → impossible in current CC behavior (auto-injected always come first), but the algorithm correctly handles it by taking the LAST auto-injected position. Future-proof for behavior changes.
- **`messages[0]` is not a user message** → CC always sends `messages[0]` as user; if not, skip and record `unexpected_role_or_shape` (consistent literal value across pseudocode, telemetry surface, and tests).

The signatures fail open: a block we can't classify defaults to "user content". Under-detection means we miss the optimization on that turn; over-detection would inject a marker mid-user-content, which would fragment the cache.

## Cache_control marker count guard

Anthropic enforces a maximum of **4** `cache_control` markers per request. Exceeding the limit returns a `400 invalid_request_error`. We must count every existing marker BEFORE deciding to inject.

```js
function countAllCacheControlMarkers(body) {
  let n = 0;
  // system[] blocks
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block?.cache_control) n++;
    }
  }
  // messages[*].content[*]
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block?.cache_control) n++;
      }
    }
  }
  return n;
}
```

Decision matrix:

| Existing markers | Injection action |
|------------------|------------------|
| 0 | Skip (unexpected/non-CC request baseline — the extension is intentionally CC-specific, and a request with zero markers indicates either a major CC refactor we should investigate before mutating, or an Agent SDK / API-direct request that this extension shouldn't touch) |
| 1–3 | **Inject** breakpoint #3 on the detected boundary |
| 4 | Skip (at the limit; injecting would 400 the request). Telemetry records `at_marker_limit`. |
| 5+ | Skip + log warning. The request is already malformed — Anthropic should have rejected it. Don't make it worse. |

The "0 markers" skip is conservative and important: this extension is CC-specific by design, and the absence of any cache markers means either (a) CC has shipped a major refactor that removes them, in which case we should investigate before mutating, or (b) the request is an Agent SDK / API-direct call that doesn't carry the auto-injected `messages[0]` shape this extension is built for. Either way the safe default is "don't touch, record the skip, surface to telemetry."

## Pipeline

The pipeline runs in a single pass on `onRequest`:

```js
async function injectMessagesBreakpoint(reqCtx) {
  const stats = initStats();
  const messages = reqCtx.body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return stats;
  if (messages[0].role !== "user" || !Array.isArray(messages[0].content)) {
    stats.skip_reason = "unexpected_role_or_shape";
    return stats;
  }

  // Marker count guard — must run before any other logic.
  const existingMarkers = countAllCacheControlMarkers(reqCtx.body);
  stats.existing_marker_count = existingMarkers;
  if (existingMarkers === 0) { stats.skip_reason = "no_existing_markers"; return stats; }
  if (existingMarkers >= 4) { stats.skip_reason = "at_marker_limit"; return stats; }

  // Boundary detection.
  const boundaryIdx = detectAutoInjectedBoundary(messages[0].content);
  stats.boundary_idx = boundaryIdx;
  stats.blocks_examined = messages[0].content.length;
  if (boundaryIdx === -1) { stats.skip_reason = "boundary_not_found"; return stats; }

  // Injection.
  const target = messages[0].content[boundaryIdx];
  if (target.cache_control) {
    // Already has cache_control — could be a user-pasted image or pre-existing marker.
    // Don't overwrite; record and skip.
    stats.skip_reason = "boundary_already_marked";
    return stats;
  }
  messages[0].content[boundaryIdx] = {
    ...target,
    cache_control: { type: "ephemeral", ttl: "1h" },
  };
  stats.injected = true;
  return stats;
}
```

## Telemetry

Full counter set on `ctx.meta.messagesBreakpointStats`:

```js
ctx.meta.messagesBreakpointStats = {
  enabled: boolean,
  injected: boolean,
  boundary_idx: number,                      // -1 if no boundary found
  boundary_block_kind: string | null,        // "hooks" | "skills" | "claude_md" | "deferred_tools" | "mcp_resources"
  blocks_examined: number,
  existing_marker_count: number,             // pre-injection marker count
  skip_reason: string | null,                // if not injected, why
};
```

A single stderr line is emitted per processed request when the extension was enabled and ran (including no-op skips, so users can verify the extension is firing):

```
[messages-breakpoint] injected boundary_idx=3 kind=claude_md existing_markers=3
[messages-breakpoint] skipped reason=at_marker_limit existing_markers=4
```

## Implementation

### File map

| File | Change |
|------|--------|
| `proxy/extensions/messages-cache-breakpoint.mjs` | NEW — extension module per the pipeline above |
| `proxy/extensions.json` | EXTEND — add `"messages-cache-breakpoint": { "enabled": true, "order": 410 }` |
| `test/proxy-messages-cache-breakpoint.test.mjs` | NEW — boundary detection, marker counting, injection paths, all skip reasons |
| `README.md` | EXTEND — env-var table addition, brief explanation under a "Cache breakpoints" section |
| `docs/extension-impact-guide.md` | EXTEND — extension #10 entry (after image-strip's #9 from v3.3.0) |
| `docs/monitoring.md` | EXTEND — env-var table row |

### Pure functions exposed for tests

```js
export {
  classifyBlock,                  // (block) → "skills" | "claude_md" | "deferred_tools" | "mcp_resources" | "user"
  detectAutoInjectedBoundary,     // (content[]) → idx | -1
  countAllCacheControlMarkers,    // (body) → number
  injectMessagesBreakpoint,       // (reqCtx) → stats (orchestrator)
};
```

`classifyBlock` is the most surface-area function — it's where signature drift will bite us first. Tests must cover the full set of CC-injected block patterns we've observed (with fixture text from real requests dumped via `CACHE_FIX_DUMP_BREAKPOINTS`).

## Test plan

### Detection
1. `messages[0]` with [skills, CLAUDE.md, user-text] → boundary at index 1 (CLAUDE.md).
2. `messages[0]` with [skills, deferred-tools, mcp-resources, CLAUDE.md, user-text] → boundary at index 3.
3. `messages[0]` with [user-text only] → boundary -1, skip reason `boundary_not_found`.
4. `messages[0]` with [skills only] → boundary 0, inject on the only block.
5. `messages[0]` with auto-injected blocks interleaved with user text (defensive, doesn't happen in current CC) → boundary at the LAST auto-injected position.
5a. `messages[0]` with [skills, hooks, user-text] → boundary at index 1 (hooks). **This is the load-bearing test for the hooks-taxonomy correction Codex flagged.**
5b. `messages[0]` with [hooks, skills, deferred-tools, mcp-resources, CLAUDE.md, user-text] → boundary at index 4.
5c. `messages[0]` is an assistant message (CC contract violation, defensive) → skip with `unexpected_role_or_shape`. Verify the literal string matches the telemetry field exactly.
5d. `messages[0]` is a user message but `content` is a string (legacy shape, not array) → skip with `unexpected_role_or_shape`. Verify body is unchanged.

### Block classification
6. Skills block (`<system-reminder>...<available-skills>`) → `skills`.
7. Plugin-skills block (`<system-reminder>...<plugin-skills>`) → `skills`.
8. Project CLAUDE.md block (`<system-reminder>...Contents of /path/to/proj/CLAUDE.md`) → `claude_md`. Use a real absolute path; verify the regex is anchored on `/`.
8a. User text "see also CLAUDE.md in the docs" → `user` (over-match guard: not anchored on `/` prefix).
9. Deferred-tools block (`<deferred-tools>...`) → `deferred_tools`.
9a. User text "the deferred tools feature is broken" → `user` (over-match guard: requires the literal `<deferred-tools>` tag, not the phrase).
10. MCP resources block via `<mcp-resources>` → `mcp_resources`.
10a. MCP resources block via `Available MCP servers:` literal → `mcp_resources`.
10b. User text "I configured my MCP server" → `user` (over-match guard: requires one of the two known sentinels).
11. Hooks block (`<system-reminder>...SessionStart:resume hook success: ...`) → `hooks`. **Hooks-taxonomy fixture test.**
11a. Hooks block (`<system-reminder>...PreToolUse hook success: ...`) → `hooks`.
11b. User text "the hook success message is in the logs" → `user` (over-match guard: requires `<system-reminder>` opening AND `hook success` substring).
12. Image block → `user`.
13. Plain user text → `user`.
14. Empty content → `user` (defensive; treats unknown as user-content to avoid over-injection).

### Marker count guard
15. Body with 0 existing markers, IMAGE_GUARD-style request → skip with reason `no_existing_markers`.
16. Body with 3 existing markers → inject (count becomes 4 after).
17. Body with 4 existing markers → skip with reason `at_marker_limit`. Verify the request body is unchanged.
18. Body with 5 existing markers → skip with reason `at_marker_limit` + warning emitted to stderr.

### Injection
19. Detected boundary block has no `cache_control` → inject `{ type: "ephemeral", ttl: "1h" }`. Verify other block fields preserved.
20. Detected boundary block already has `cache_control` (e.g., from a user-pasted image) → skip with reason `boundary_already_marked`. Don't overwrite.
21. Marker count post-injection equals existing_count + 1.

### Diagnostic dump (CACHE_FIX_DUMP_MESSAGES_HEAD)
22. `CACHE_FIX_DUMP_MESSAGES_HEAD=/tmp/dump.jsonl` set, valid request → JSONL line written with block-kind classifications, text first 200 chars per block, `cache_control` presence flag per block. No mutation.
23. `CACHE_FIX_DUMP_MESSAGES_HEAD` unset → no fs activity. Implementation only opens the file when the env var is set.

### Activation
24. `CACHE_FIX_INJECT_MESSAGES_BREAKPOINT` unset, no diagnostic gate either → extension fires but exits early; no telemetry, no mutation.
25. `CACHE_FIX_INJECT_MESSAGES_BREAKPOINT=1`, valid request → telemetry present, injection occurs per matrix above.

### Telemetry
26. After a successful injection: `injected=true`, `boundary_idx >= 0`, `boundary_block_kind` set, `existing_marker_count` set.
27. After a skip: `injected=false`, `skip_reason` set with one of the documented values (`boundary_not_found`, `boundary_already_marked`, `no_existing_markers`, `at_marker_limit`, `unexpected_role_or_shape`).
28. Stderr line emitted when extension was enabled — both injection and skip paths.

### Regression
29. All v3.3.0 tests still pass (extension is additive at order 410, doesn't touch any other extension's mutations).

## Reviewer checklist

- [ ] Activation uses `enabled: true` + runtime env-gate (prefix-diff pattern). `extensions.json` updated.
- [ ] Extension order is 410 (after `cache-control-normalize` at 400, before `ttl-management` at 500). Verify in `extensions.json`.
- [ ] `countAllCacheControlMarkers` counts BOTH `body.system[]` and `body.messages[].content[]` markers. Test 14–17 verifies the cap is respected.
- [ ] Boundary detection takes the LAST auto-injected block, not the first. Test 1 and 5 verify.
- [ ] Block classification fails open: unknown block kind → "user", under-detection only. Test 13 verifies.
- [ ] Injection preserves all other block fields (text, source, etc.). Test 18 verifies via `Object.keys` comparison.
- [ ] Already-marked boundary is NEVER overwritten. Test 19 verifies.
- [ ] Telemetry surface includes the full counter set on every onRequest invocation when enabled. Test 23–24 verify.
- [ ] Stderr summary line emitted when enabled, including skip cases (so users can verify the extension is firing).
- [ ] No new top-level dependencies.
- [ ] CI green on Node 18 / 20 / 22.
- [ ] README env-var table updated; brief "Cache breakpoints" section added explaining the breakpoint #3 gap.
- [ ] `docs/extension-impact-guide.md` extension #10 entry added.
- [ ] At least 5 fixture blocks in tests sourced from `CACHE_FIX_DUMP_MESSAGES_HEAD` output (the new diagnostic added by this directive — `CACHE_FIX_DUMP_BREAKPOINTS` cannot capture unmarked blocks, which is exactly what we need fixtures for). Synthetic supplements are OK; the 5 baselines must come from real CC traffic.
- [ ] All 5 documented `skip_reason` values (`boundary_not_found`, `boundary_already_marked`, `no_existing_markers`, `at_marker_limit`, `unexpected_role_or_shape`) appear in tests AND in telemetry verbatim — no drift between code, pseudocode, and test assertions.
- [ ] Hooks classification is exercised by at least one fixture (Test 11) AND one over-match guard (Test 11b). The hooks-taxonomy fix is the load-bearing correction from Codex review #1.

## Out of scope (explicit, deferred)

- Migration of skills/CLAUDE.md to `system[]`.
- VS Code-specific breakpoint #2 recovery (separate directive).
- Synthesizing breakpoint #3 on Agent SDK / non-CC request shapes.
- Per-tier TTL on the injected marker (always 1h; server downgrades to 5m if user is in overage).

— AI Team Lead
