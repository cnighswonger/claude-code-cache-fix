Verdict: REQUEST_CHANGES

# PR #214 round-1 review — `directive/jsonl-session-mirror` (HEAD `5cce318`)

Round 1 of max 2 (Fable). Scope: architectural sweep of `directive.md` for the v4.2.0 `jsonl-session-mirror.mjs` extension, motivated by CC#66734 / CC#66486 data-loss.

## What Is Correct

- **The motivation is sound and well-framed.** A proxy-side content mirror is exactly the right defensive posture against CC's stub-rewrite regression: the proxy genuinely sees every assistant message and tool result, and the mirror lives on a file path CC's transcript writer never touches. The "belt-and-suspenders backup, not transcript replacement" framing is correct and the directive holds that line consistently (no claim to fix the upstream bug).
- **`source: "cache-fix-proxy-mirror"` on every record** is the right provenance distinguisher and is correctly called load-bearing.
- **Image-as-reference (media_type + SHA-256, not bytes)** is the right call — full image bytes would dominate the mirror and serve no reconstruction purpose.
- **Opt-in default-off at first ship** is appropriate for a feature that persists plaintext conversation content, and the compliance-workload rationale is explicitly stated.
- **Order 720 placement** (after telemetry/log extensions, late in the pipeline) is correct for a pure observer.
- **The threat-model paragraph is honest**: same surface as CC's own transcript, inherits umask, no incremental risk class. Correct.
- **Out-of-scope list is disciplined** — no restore tooling, no GUI, no compression, no encryption, no cross-session index. Good scope hygiene for a v1.

## Blockers

### B1. The load-bearing hook `onResponseEnd` does not exist — and no end-of-stream hook exists at all for SSE traffic

`pipeline.mjs` exposes exactly four hooks: `onRequest`, `onResponseStart`, `onStreamEvent`, `onResponse` (pipeline.mjs:85–141, confirming the PR #213 verification). There is no `onResponseEnd` and no `onResponseChunk`.

Worse for option 2: `runOnResponse` fires **only on the non-streaming branch** of `handleMessages` (server.mjs:160–188) and on the bootstrap route. For SSE responses — i.e., essentially all real CC `/v1/messages` traffic — `streamResponse` (stream.mjs:84–110) runs `onStreamEvent` per event and then ends the client response. **The proxy never holds a complete parsed assistant-message envelope at any hook point for streaming traffic.** "Buffer-then-write at end of response" has no place to stand.

Two ways out, and the directive must pick one explicitly:

1. **Add a real end-of-stream hook** (`runOnResponseEnd` called from `streamResponse` after the read loop, with an accumulated envelope or at minimum the telemetry record + meta). This means modifying `pipeline.mjs`, `stream.mjs`, and possibly `server.mjs` — none of which appear in the directive's "Files modified" list.
2. **Accumulate per-message state inside `onStreamEvent`** (capture `message_start` → `content_block_start/delta/stop` → `message_delta` → `message_stop`, then write on `message_stop`). This is workable today with zero pipeline changes — but it **is** option 1 (the stream tee), which the directive explicitly defers.

Related internal contradiction: the **Scope** section lists "Stream tee that buffers SSE chunks per-message-id and emits a complete record on `message_stop`" as in-scope, while **Implementation choice** picks option 2 (no tee). These can't both be true. As written, the directive's chosen design is unimplementable against the actual hook surface, and the implementable design is the one it defers.

### B2. The CC-transcript-compatibility claim is false as specified

I verified against a real CC 2.1.148 transcript (`~/.claude/projects/<project>/<session-uuid>.jsonl`). CC's actual assistant record:

```json
{
  "type": "assistant",
  "parentUuid": "<uuid>", "uuid": "<uuid>", "isSidechain": false,
  "sessionId": "<uuid>", "requestId": "req_...",
  "timestamp": "...", "cwd": "...", "version": "2.1.148", "gitBranch": "...",
  "message": {
    "role": "assistant", "id": "msg_...", "model": "...",
    "content": [...], "stop_reason": "...", "stop_sequence": null,
    "stop_details": {...}, "usage": {...}
  }
}
```

The directive's proposed record puts `content`, `model`, `stop_reason`, `usage` at the **top level**, uses snake_case `session_id` / `request_id` (CC uses camelCase `sessionId` / `requestId`), and omits the `message` envelope entirely. Any reader built for CC's shape (including `restore-claude-history-linux`) dereferences `record.message.content` — it will find `undefined` on every mirror record. The claim "existing transcript readers can parse mirror files without modification" does not survive contact with the actual format.

Also missing: `uuid` / `parentUuid`. CC's transcript is a **linked tree**, not a flat log — recovery tools use the parentUuid chain to reconstruct conversation order and sidechains. A mirror without these fields is parseable at best as an ordered flat list; the directive should either thread synthetic uuid/parentUuid values (previous-record chaining is enough for a linear session) or explicitly state that mirror files reconstruct by file order only and verify the named recovery tool accepts that.

Tool results, for reference, appear in CC's transcript as `type: "user"` records with `message.content: [{type: "tool_result", ...}]` plus a top-level `toolUseResult` field — also nested, also camelCase. (One thing the directive gets right by accident: CC **does** write user records, so mirroring user messages is fidelity, not an enhancement.)

The fix is cheap — adopt CC's envelope shape (`message: {...}` nesting, camelCase ids, synthetic uuid chain) and keep `source: "cache-fix-proxy-mirror"` as the top-level addition. But it must be in the directive, because the record shape is the directive's central user-facing promise and the reviewer checklist's first item.

### B3. Mirroring `messages[*]` from request bodies duplicates the entire conversation every turn

CC re-sends the **full conversation history** in every request's `messages` array. "User text prompts are mirrored from request `messages[*]`" and "tool results from request bodies are also mirrored," applied per-request with no dedup, writes turn 1 once, turns 1–2 on request 2, turns 1–3 on request 3… — O(n²) disk growth, and the mirror becomes a pile of duplicates that no transcript reader expects. A 200-turn session would mirror ~20,000 redundant records and blow through the 100 MB cap on duplication alone.

The directive needs an explicit dedup strategy. The cheap correct one: in `onRequest`, mirror only the messages **after** the last assistant turn already mirrored for that session (in practice: the trailing user/tool_result block(s) of each request), tracked per-session in module-scope state — the same per-session in-memory map pattern thinking-block-sanitize v2 and session-health already use. Whatever the choice, it's real design work and real LOC that the directive currently doesn't acknowledge.

### B4. Header-derived session id is used as a filesystem path component without sanitization

`~/.cache-fix-proxy/session-mirrors/<session-id>/<timestamp>.jsonl` with `<session-id>` taken from the client-supplied `x-claude-code-session-id` header is a path-traversal surface (`../../...`) and an invalid-filename surface. The repo already solved exactly this: `cache-telemetry.mjs` `sessionFilename()` (safe-charset passthrough, `inv-<sha256[:16]>` otherwise, `unknown` for empty) exists for the same header on the same threat. The directive must mandate reuse of `sessionFilename` (or its rule) for the directory name. This is one sentence to fix but is a security blocker as written.

### B5. Disk growth is unbounded — rotation is not retention

`MAX_BYTES` rotation caps the **active** file but rotated files accumulate without limit: a long-lived session can produce unlimited `<rotation>.jsonl` files, and dead sessions' directories live forever. The LRU handle cap bounds open file handles, not bytes on disk. Compare the two house precedents the directive itself cites: `bootstrap-defense` deliberately uses single-tier rotation "to bound disk usage at 2×5MB" (bootstrap-defense.mjs:16–19), and `cache-telemetry` sweeps stale session files past a 7-day TTL (`sweepStaleSessions`). The mirror has neither a rotation-count cap nor an inactivity sweep. For a default-on-candidate feature writing full conversation content, "document the disk footprint" is not a substitute for bounding it. Minimum fix: a retention env-var (`CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS`, default e.g. 30) with a throttled sweep, plus a documented worst case (open sessions × cap × rotations).

## What Needs Attention

- **Session-id is not available at response time — the directive's step 1 is wrong as written.** "Extract `x-claude-code-session-id` from the request headers" inside a response-side hook can't work: stream-side ctx is `{ event, meta, telemetry, responseHeaders, drop }` (stream.mjs:63) — no request headers. The established pattern is to capture in `onRequest` and stash on `ctx.meta` (cache-telemetry.mjs:170–179 documents this exact reasoning). The directive should mandate `onRequest` capture via the exported `resolveSessionId()` (which also handles the `x-session-id` / `x-anthropic-session-id` fallbacks the directive's single-header extraction would miss).
- **The "proxy `sid`" fallback mixes sessions.** usage-log's `_sid` is per-boot sticky for the proxy lifetime. Falling back to it would funnel every session that lacks the header into one shared mirror file — corrupting the per-session promise precisely for the sessions that are hardest to attribute. Use the `sessionFilename(null) → "unknown"` bucket convention instead, and document that unknown-session records are best-effort.
- **Failure isolation is real but should be stated, and fire-and-forget has a trap.** The pipeline try/catches every hook (pipeline.mjs:91–96 etc.), so a throwing mirror writer cannot break the response — good, but the directive should say so and the test plan should prove it (it currently doesn't; see below). Note the tension in the NFR: "mirror writes must not block the response stream" implies not awaiting the write inside the hook — but un-awaited promises escape the pipeline's try/catch, so a rejection becomes an unhandledRejection (process-fatal on modern Node). The writer needs an internal `.catch()` on every async write plus the error-event emission. One awaited `appendFile` per response (the usage-log pattern, usage-log.mjs:315) is also acceptable — it adds single-digit-ms to final-chunk delivery, which is honest to state and simpler to reason about.
- **Thinking-block default-include is defensible — but say why.** I verified CC's own canonical transcript includes full `thinking` content blocks, so default-include is fidelity-parity with the thing being backed up, not a new disclosure. (`thinking-block-sanitize` is about the request-path desync wedge, not privacy — unrelated.) The directive should state the parity argument explicitly. Separately, this item sits under "**Out of scope (deferred)**" while describing a shipped default plus an env-var — it's in scope with an opt-out. Move it to the Scope list.
- **The default-on flip ("after one minor-version validation cycle") should be its own directive.** Flipping plaintext conversation persistence to on-by-default is a privacy-posture change for every user, not a maturity milestone. Don't pre-commit to it here.
- **Minor factual slip:** usage-log's order is 650 (its export); request-log is the one at 700. Order 720 still lands correctly after both, but fix the sentence.
- **`session-mirror-events.jsonl` needs its own rotation.** The event log records open/rotate/error per session; over months it grows unbounded too. The bootstrap-defense `rotateIfNeeded` 5 MB single-tier pattern is right-sized for it.
- **Test plan gaps (the two that matter most):**
  1. No test for the failure-isolation invariant — inject a writer that throws (and one that rejects async) mid-stream and assert the client still receives the complete SSE response. This is the critical invariant for a defensive extension and it is currently untested.
  2. No round-trip test for the format claim — feed a mirror file to `restore-claude-history-linux` (or a vendored fixture parser implementing CC's shape) and assert successful reconstruction. The reviewer checklist asks for compatibility but the test plan never proves it. Given B2, this test would have caught the envelope mismatch immediately.
  3. (After B3 is addressed) a dedup test: a 3-turn replay must produce each record exactly once.
- **Sim-validation gate: recommend declaring it.** This extension doesn't modify traffic, so the mutation-risk case is weak — but the format-compatibility promise is unverifiable without observing what CC actually writes for the same traffic the proxy sees. A short real-CC-traffic capture comparing mirror records to CC's transcript records for the same session is the only honest validation of B2's fix. Recommend `needs-sim-validation` (or an equivalent one-off capture task) before the default-off → default-on flip is even discussed.

## Bloat / Non-Functional

- **The LRU file-handle cache (default 32 handles) is unnecessary for the chosen design.** With option 2's write frequency — one record per response, plus a handful of request-side records — plain `appendFile` per write (the usage-log pattern) is entirely adequate; the OS open/close cost is noise at chat-traffic rates. The LRU earns its keep only under option 1's per-chunk writes, which the directive defers. Cutting it removes an entire test file's worth of surface (`session-mirror-writer` LRU eviction tests), an env var (`MAX_HANDLES`), and the handle-leak checklist item — and it removes the one component whose failure mode (handle exhaustion past the cap) the failure-isolation story has to defend against. Recommend deletion from v4.2.0 scope; reintroduce with option 1 if that ever ships.
- **LOC budget is not credible as scoped.** 200–300 LOC "including stream tee + write batching + per-session file rotation" — while also creating a separate `proxy/lib/session-mirror-writer.mjs` (already outside the count?) and, per B1, either a stream-event accumulator (content_block deltas, `input_json_delta` reassembly for tool_use, thinking + signature deltas — this alone is ~150 LOC done correctly) or new pipeline hooks. With B2's envelope shaping and B3's dedup added, this lands at 450–550 LOC across extension + lib. Either widen the budget honestly or cut scope (dropping the LRU, above, is the easiest 80 LOC back).
- The `image` content-block "reference" record needs a one-line shape definition (what does the SHA-256 reference record look like?) or readers can't be written against it. Cheap to add, currently undefined.

## Recommendations

1. **Resolve B1 by choosing the stream-event accumulator** (option 1 mechanics, option 2 write cadence: accumulate via `onStreamEvent`, write once on `message_stop`). It requires zero pipeline changes, fires exactly once per response, and as a bonus delivers the partial-message recovery the directive defers — buffer contents at stream interruption can be flushed with `stop_reason: "interrupted"` cheaply. Alternatively add `runOnResponseEnd` to the pipeline, but then list `pipeline.mjs`/`stream.mjs`/`server.mjs` under Files Modified and accept the bigger blast radius.
2. **Resolve B2 by adopting CC's actual envelope**: top-level `type`/`uuid`/`parentUuid`/`sessionId`/`requestId`/`timestamp` + nested `message: {...}`, camelCase throughout, synthetic linear uuid chain, `source: "cache-fix-proxy-mirror"` as the additive marker. Pin the shape in the directive with a verified example captured from a real CC transcript, and add the round-trip test.
3. **Resolve B3 with per-session last-mirrored tracking** in module-scope state (house pattern: thinking-block-sanitize v2's per-session map), mirroring only the request-side delta.
4. **Resolve B4 with one sentence**: directory name is `sessionFilename(resolveSessionId(headers))`, imported from cache-telemetry.
5. **Resolve B5 with a retention env-var + throttled sweep** (cache-telemetry's `sweepStaleSessions` pattern) and a rotation-count cap; document worst-case bytes as sessions × cap × (rotations+1).
6. Drop the LRU handle cache from v4.2.0; capture session id in `onRequest` via `resolveSessionId`; add the failure-isolation and round-trip tests; move the thinking bullet into Scope; split the default-on flip into a future directive; declare the sim-validation capture.

## Bottom Line

The idea is right and worth shipping: a proxy-side mirror is a genuinely useful hedge against CC#66734/CC#66486, the defensive framing is honest, and the scope discipline is mostly good. But the directive as written specifies an implementation against a hook that doesn't exist, promises a file format that demonstrably isn't CC's (verified against a live 2.1.148 transcript), and has three unbounded-growth/safety gaps (history duplication, path sanitization, retention) that are each cheap to fix once named. All five blockers have concrete, low-cost resolutions spelled out above — this should be a one-trip round-2 fix. REQUEST_CHANGES.

— Fable 5 Review Agent
