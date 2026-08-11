# Directive: `anthropic-beta` header stabilization per session

**Issue:** #326
**Branch:** `feature/anthropic-beta-stabilize`
**Stage:** directive (author: Proxy Builder; awaiting AI Team Lead R0)
**Milestone:** v4.4.1

## Goal

Add a request-path extension that pins the outbound `anthropic-beta` header per
session so client-side toggles between turns stop invalidating the cache
prefix. The extension is the direct sibling of `deferred-tool-rewrite`
(#273/order 425) — same shape, same discipline (opt-in gate, first-seen truth,
per-session state), applied to a different cache-key input.

## Why

Measured on the dogfood host during the 2026-08-08 burn investigation, one session
emitted four distinct `anthropic-beta` states in a ~5-minute window (per issue
#326 body):

```
anthropic-beta[+cache-diagnosis-2026-04-07 -mid-conversation-system-2026-04-07]
anthropic-beta[-cache-diagnosis-2026-04-07,redact-thinking-2026-02-12]
anthropic-beta[+cache-diagnosis-2026-04-07]
anthropic-beta[-cache-diagnosis-2026-04-07]
```

`cache-diagnosis-2026-04-07` flipped four times in 33 seconds across turns
821→822→823→825 of one session. Each toggle registers in `prefix-diff` output
as `cause=header:anthropic-beta[±...]`, i.e. the cache key Anthropic computes
for that turn differs from the previous turn's; the entire prefix re-cache-
creates.

Same failure class as the `Workflow` tool oscillation that `deferred-tool-rewrite`
absorbs (#273): the client is not in a position to recognize what it just cost.

## Non-Functional Requirements

- **Size/complexity budget** — ~150 production LOC (one extension file). One
  per-session state Map, one header parse/canonicalize/emit path, one telemetry
  line per action. No new IPC, no new persistent store, no schema addition to
  `extensions.json` beyond the one-line registration.
- **Threat model** — reads and rewrites the `anthropic-beta` request header.
  Does not touch bodies, does not touch responses, does not persist to disk.
  In-memory only; state resets on proxy restart (which also resets the upstream
  cache prefix, so the correspondence is intentional). Failure mode is
  fail-open: any exception in the hook leaves the header untouched and
  passes through.
- **Maintainability constraints** — one new file (`proxy/extensions/anthropic-
  beta-stabilize.mjs`), one line in `proxy/extensions.json`, one test file
  (`test/proxy-anthropic-beta-stabilize.test.mjs`), and a two-line change to
  `proxy/server.mjs` (add `{ path: clientReq.url }` as the sixth argument to
  the two `preForward()` call sites — `handleMessages` line 155 and
  `handleBootstrap` line 275). The server.mjs addition is in scope per Codex
  R2: it fixes the subpath discrimination the pipeline route filter can't
  provide. No new abstractions. The header parse/join idiom mirrors
  `deferred-tool-rewrite`'s existing `parseBetaTokens`/`addBetaToken`
  (which are also the closest thing to prior art in this repo); if the shape
  converges further during review, factor to a shared helper — otherwise
  inline is fine (see [[feedback-inline-comment-guidelines-post-release]]).
- **Performance/reliability** — header parse + Set-difference + join per
  request. O(n) where n is the token count (typically < 5). Negligible.
- **Load-bearing? YES.** The extension modifies what we send upstream on every
  request when active. Failure to canonicalize output correctly could itself
  become a cache-key input (see "Design", point 3). Chris human-review
  required per CLAUDE.md § Non-Functional Requirements & Anti-Bloat.

## Design

### Algorithm

Per-request `onRequest(ctx)`:

Route filtering at the pipeline layer (`proxy/pipeline.mjs:96-99`, default
`routes: ["messages"]`) narrows to the `messages` route but does NOT
distinguish `/v1/messages` from `/v1/messages/count_tokens` or
`/v1/messages/batches`: `proxy/server.mjs:514` dispatches ANY
`POST /v1/messages*` (subpath included) to `handleMessages()`, which calls
`preForward(..., "messages")` at `server.mjs:155`. All subpaths get
`ctx.meta.route === "messages"`. Codex R2 caught this on 2026-08-11
(review: `pullrequestreview-4910070912`).

Fix (this directive): a minimal pipeline contract addition — pass
`{ path: clientReq.url }` as `baseMeta` to `preForward()` at both call
sites (`handleMessages` line 155, `handleBootstrap` line 275 for
symmetry — bootstrap route already only serves one path but the
add-both-sites approach keeps future symmetric routes trivial). Extension
reads `ctx.meta.path`, computes pathname (strip `?query`, `#fragment`),
no-ops when pathname is not exactly `/v1/messages`.

0. **Pathname guard** — let `p = (ctx.meta.path || "").split("?")[0].split("#")[0]`;
   if `p !== "/v1/messages"`, no-op. Guards against `/v1/messages/count_tokens`,
   `/v1/messages/batches`, and any future subpath sharing the same dispatcher
   entry.

1. Parse the incoming `anthropic-beta` header (Node.js normalizes HTTP
   header keys to lowercase before the pipeline sees them; the parse reads
   `ctx.headers["anthropic-beta"]` directly) into a Set of trimmed non-empty
   tokens. Accept BOTH `,` and ` ` as separators (CC has been observed
   emitting both within the same run — see design note in #326).
2. Resolve session key via the same `resolveSessionId(headers)` idiom used by
   `deferred-tool-rewrite` and `insertion-normalization`. Sub-key by system-
   prompt hash and conversation-sub-key (see "Session key" below).
3. Look up the stabilized token set for that session key in the in-memory
   state Map. Branch:
   - **First-seen** — no prior state. Store the incoming Set as the pinned
     set. Emit the canonical form (see step 4). Telemetry: `action=first-seen`.
   - **Unchanged** — incoming Set equals the pinned Set. Emit the canonical
     form (still required — see below). Telemetry: `action=unchanged`.
   - **Delta** — incoming Set differs from the pinned Set. Compute the diff
     (adds and removes vs the pinned Set). The emitted set is the **pinned
     Set unioned with any always-passthrough tokens** present in incoming
     (see "Always-passthrough whitelist" below). Non-whitelist adds and all
     removes are logged but not forwarded. Telemetry: `action=pinned,
     adds=[...], removes=[...], passthrough=[...]`.
4. Emit the canonical form: sort the emitted Set ASCII-ascending, join with
   `", "` (comma+space), write to `ctx.headers["anthropic-beta"]`. If the
   emitted Set is empty (rare — first-seen session with no beta header),
   emit no header at all. (Node's HTTP layer lowercases header keys before
   the pipeline runs, so there is no case-preservation concern to solve.)

### Always-passthrough whitelist

A small set of tokens are **always forwarded to upstream when incoming
contains them**, regardless of whether they're in the pinned Set. Currently
one entry:

- `mid-conversation-tool-changes-2026-07-01` — required by
  `deferred-tool-rewrite` (#273/order 425) to make `tool_addition` blocks
  legible to Anthropic. DTR writes this token onto the header via
  `addBetaToken()` on any turn where it injects a `tool_addition` message —
  which can be turn N > 1, not just turn 1. Without the whitelist, strict-
  pin from turn 1 would strip this token before the request went upstream:
  the `tool_addition` block would arrive but Anthropic wouldn't honor it
  without the beta, and the newly-added tool would go dark. DTR's tools[]
  byte-stability would hold but its whole point (delivering the new tool
  schema) would be silently defeated.

Whitelist entries live as a hardcoded constant array in the extension file
next to the token they whitelist. New entries require a code change, not a
config change, and land with the extension that needs them (same discipline
as `TOOL_ADDITION_MODELS` in `deferred-tool-rewrite`).

### Session key

Same idiom as `deferred-tool-rewrite`'s `resolveToolRewriteSessionKey`:

```
s-<session_id>-<systemPromptSubKey>-<conversationSubKey>
```

Rationale (mirroring deferred-tool-rewrite's header comment, ~line 218): the
session-id header is shared by the main thread, every subagent it dispatches,
and CC's sidecar calls. Different tenants can carry different beta sets
legitimately; keyed on bare session id, they collide onto one pinned set.

### Why canonicalize output even on "unchanged"

CC has been observed emitting both `,` and ` ` as separators in the same run
(#326 design note). If we forward the incoming header as-is on the "unchanged"
branch, a separator flip is itself a byte change and itself a cache-key input
— the fix would defeat itself. Canonical output on every branch closes that
gap.

### State lifetime

In-memory Map, indexed by session key. No persistence. On proxy restart, the
Map resets and every session re-runs the first-seen path. That is correct: a
proxy restart also resets the upstream cache prefix (nothing survives across
process boundaries on Anthropic's side either), so the two lifetimes align.

Consequence to document in the extension header comment: the fix targets
within-session drift, not across-restart drift.

### Order

Slot 450, between `deferred-tool-rewrite` (425) and `ttl-management` (500).
Rationale:

- `deferred-tool-rewrite` runs first so any beta it writes via
  `addBetaToken()` is visible to `anthropic-beta-stabilize`. The stabilizer's
  whitelist (see above) recognizes DTR's token as always-passthrough, so DTR
  can add it on any turn (including turn N > 1 as the tool_addition block is
  emitted) and the stabilizer forwards it upstream.
- Must run BEFORE the TTL-management pass which reads header state for
  cache-key computations.
- Slot 450 is currently unused (nothing else in the 426-499 range).

## Design decisions (R0-resolved)

Original three open questions plus AITL R0 refinements folded 2026-08-11.

### Q1. Strict-pin vs monotonic-union — STRICT-PIN + whitelist

The issue says "snapshot the union at first-seen ... emit that stable set on
every subsequent turn regardless of what CC sends." Two readings:

- **Strict-pin** (this directive's default): turn 1's Set is truth; all
  subsequent adds and removes are logged but never forwarded. Zero busts
  after turn 1 in exchange for zero mid-session capability additions.
- **Monotonic union**: pinned Set grows to include any beta CC introduces
  mid-session (one honest bust on the turn it appears, stable thereafter);
  never shrinks. Preserves capability additions at a bounded cost.

The distinguishing case: CC starts sending `<new-beta>` on turn 10 for a
feature that requires it upstream. Strict-pin silently disables the feature
(telemetry-only). Monotonic-union pays one bust and preserves it.

**Resolved: strict-pin, augmented by an always-passthrough whitelist for
`mid-conversation-tool-changes-2026-07-01`.** Argument for strict-pin
stands: (a) observed harm is toggle-thrash; (b) telemetry on delta-adds
makes silent-block detectable within one prefix-diff scan; (c) future betas
added to the strict-pin baseline explicitly is safer than trusting CC's
mid-session decisions.

R0 refinement: without the whitelist, DTR's turn-N tool_addition
announcements would go through with the block but WITHOUT the beta,
silently defeating the tool_addition contract. Whitelist is scoped to
tokens whose absence upstream would break another extension's guarantee —
one entry today; new entries land with the extension that requires them.
See "Always-passthrough whitelist" above.

### Q2. Sub-key granularity — THREE-PART KEY

Directive proposes the same three-part key `deferred-tool-rewrite` uses
(session-id + system-prompt hash + conversation sub-key). The
system-prompt-sub-key was added to `deferred-tool-rewrite` after 2026-07-28
capture s-35d72503 measured 6 tenants colliding on 1 baseline.

For `anthropic-beta` specifically, the collision question is: **do subagents
and sidecars ever carry different beta sets from their parent session?**

R0 confirmed: cross-tenant prefix-diff events prove subagents carry
distinct system prompts on the same session-id header. Over-key cheap,
under-key silently wrong. Match `deferred-tool-rewrite`'s three-part key
(session-id + system-prompt hash + conversation sub-key).

### Q3. Endpoint scope — pipeline route filter + `ctx.meta.path` guard

Third-time-revised. The progression is worth preserving so the next
reviewer knows what was tried and why the current shape is the answer:

- **R0 (AITL)**: "check `ctx.url === '/v1/messages'`" — reasoned from
  HTTP analogy without reading pipeline context shape.
- **R1 (Codex)**: caught `ctx.url` doesn't exist (`proxy/server.mjs:103,106`
  build reqCtx with `body`, `headers`, `meta` only). Proposed either
  `ctx.meta.route === "messages"` or adding `url`/`pathname` to the pipeline
  contract.
- **R1 fold (Proxy Builder)**: went one layer deeper into the pipeline
  and found `proxy/pipeline.mjs:96-99`'s default `routes: ["messages"]`.
  Removed the guard entirely, relied on the pipeline default. Claimed
  count_tokens/batches "fall out" as never touched.
- **R2 (Codex)**: caught that the pipeline default DOESN'T distinguish
  subpaths. `server.mjs:514` dispatches any `POST /v1/messages*` to
  `handleMessages`, which calls `preForward(..., "messages")` at line 155.
  All subpaths ride `ctx.meta.route === "messages"`. Route filter alone
  is not enough.
- **R2 fold (this revision)**: add `{ path: clientReq.url }` as `baseMeta`
  to the two `preForward()` call sites in `server.mjs` (handleMessages line
  155 + handleBootstrap line 275 for symmetry). Extension does exact-
  pathname guard in algorithm step 0 above. This is Codex R1's option 2
  (`add url/pathname to context`) — the option R1-fold prematurely
  rejected as unnecessary because the pipeline default appeared sufficient.
  It wasn't; option 2 is now the right answer.

**Resolved:** pipeline route filter narrows to `messages` dispatcher;
extension step 0 narrows to exact `/v1/messages` pathname via
`ctx.meta.path`. `count_tokens`, `batches`, admin routes: no-op.
Explicitly tested — see Tests 20a, 20b, 20c below.

**Discipline banked:** three layers of the same-file miss in one PR
cycle. Memory `feedback-read-further-than-the-immediate-question` added
2026-08-11 — "read further than the immediate question requires" is the
rule that would have collapsed this into a single R0 pass.

## Extension contract

- **File:** `proxy/extensions/anthropic-beta-stabilize.mjs`
- **Name:** `"anthropic-beta-stabilize"`
- **Description:** `"Pin the outbound anthropic-beta header per session so
  client-side toggles between turns stop invalidating the cache prefix"`
- **Enabled:** `true` in `extensions.json` (extension always loads)
- **Runtime gate:** `CACHE_FIX_BETA_STABILIZE=on`, default off (matches the
  `deferred-tool-rewrite`/`insertion-normalization`/`output-guard` opt-in
  pattern for anything that changes what we send upstream)
- **Order:** 450 (between `deferred-tool-rewrite`/425 and
  `ttl-management`/500 — see "Order" above)
- **Routes:** default (`["messages"]`) — do NOT declare a `routes:` field.
  See "Q3. Endpoint scope" below for why (spoiler: pipeline route filter
  narrows to the `messages` dispatcher; extension body then narrows to the
  exact `/v1/messages` pathname via `ctx.meta.path`).
- **Hook:** `onRequest(ctx)` — reads `ctx.meta.path` for pathname
  discrimination; reads and rewrites `ctx.headers`
- **In-PR telemetry surface:** DTR-style per-session-key event log at
  `${cache-fix-snapshots}/${sessionKey}-anthropic-beta-events.jsonl`,
  one JSONL row per invocation with `{ ts, key, sid, action, adds,
  removes, passthrough, pinned }`. Same directory and file-naming idiom
  as `deferred-tool-rewrite`'s `<sessionKey>-deferred-tool-events.jsonl`
  (deferred-tool-rewrite.mjs:177). This satisfies Codex R1's requirement
  for durable per-request telemetry in-PR; the `usage.jsonl` integration
  remains a follow-on.
- **Exports for tests:**
  - `parseBetaHeader(rawHeaderValue) → Set<string>`
  - `canonicalizeBetaTokens(Set<string>) → string`
  - `resolveBetaSessionKey(headers, body) → string`
  - `extractPathname(rawPath) → string | null` — strips `?query` and
    `#fragment`; returns `null` for undefined/empty input
  - `ALWAYS_PASSTHROUGH_TOKENS: readonly string[]` — the whitelist constant
  - `default.onRequest(ctx)` — the composed extension

## Tests (in `test/proxy-anthropic-beta-stabilize.test.mjs`)

The `deferred-tool-rewrite` and `insertion-normalization` test files are the
closest prior art for the shape and idiom expected here.

1. No-op when `CACHE_FIX_BETA_STABILIZE` is unset
2. First-seen: incoming `beta1, beta2` becomes pinned `[beta1, beta2]`, header
   canonicalized to `"beta1, beta2"` (sorted, comma-space)
3. First-seen with mixed separators: incoming `"beta1,beta2 beta3"` parses to
   `{beta1, beta2, beta3}`; header emitted as `"beta1, beta2, beta3"`
4. Unchanged: turn 2's incoming Set equals pinned; header still re-emitted as
   canonical (test the case where turn 2 uses `" "` and turn 1 used `","` —
   both should produce identical output header bytes)
5. Delta-add: turn 2 adds `beta3`; pinned Set unchanged; emitted header
   matches turn 1's; telemetry entry has `adds=["beta3"]`
6. Delta-remove: turn 2 drops `beta2`; pinned Set unchanged; emitted header
   still contains `beta2`; telemetry entry has `removes=["beta2"]`
7. Delta-both: turn 2 both adds and removes; both diffs telemetried; pinned
   set forwarded
8. Header key is always lowercase `anthropic-beta` on the outgoing
   `ctx.headers` (Node lowercases incoming headers; no case-preservation
   needed — this test just guards against a regression that re-introduces
   case-sensitive key handling)
9. Missing header first-seen: incoming has no `anthropic-beta`; pinned Set is
   empty; outgoing has no `anthropic-beta`
10. Missing header on a session with a non-empty pinned Set: incoming has no
    `anthropic-beta`; outgoing DOES have `anthropic-beta` populated with the
    pinned Set (the "pin over the client removing it" case)
11. Session-key sub-keying: two subagents with different system prompts on the
    same session-id header do NOT share pinned state (mirrors the deferred-
    tool-rewrite tenant-isolation test)
12. Deferred-tool-rewrite composition — **turn N > 1 scenario (the
    scenario the whitelist exists for)**: turn 1 arrives with no
    `mid-conversation-tool-changes-2026-07-01` and gets pinned. Turn N
    (N > 1) DTR adds the token to the header via `addBetaToken()`.
    Stabilizer must observe the incoming Set, recognize the whitelist
    entry, and emit the pinned Set unioned with the whitelist token — NOT
    the pinned Set alone. Verify the outgoing header contains the token
    on turn N, and that telemetry records `passthrough=[mid-conversation-
    tool-changes-2026-07-01]`. Also cover the turn-1 case where DTR added
    it (pinned from turn 1, no passthrough entry needed on turn 2).
13. Ordering canonicalization: pinned Set `{b, a, c}` always emits
    `"a, b, c"` regardless of insertion order (reproducibility across
    process restarts is a property test)
14. Empty-token skip: incoming `"beta1, ,beta2"` parses to `{beta1, beta2}`
    (trim and filter-Boolean); empty strings never enter the pinned Set
15. Idempotence: two calls to `onRequest` with the same `ctx` produce
    identical `ctx.headers['anthropic-beta']` (a guard against accidental
    mutation via passed-by-reference on the pinned Set)
16. `ctx.meta.betaStabilizeStats` populated with
    `{ action, adds, removes, passthrough }` on every action
17. **Whitelist token isolation**: pinned Set is `{a, b}`; incoming has
    `{a, b, mid-conversation-tool-changes-2026-07-01}`. Outgoing header
    contains `{a, b, mid-conversation-tool-changes-2026-07-01}` and
    telemetry has `passthrough=["mid-conversation-tool-changes-2026-07-01"]`,
    `adds=[]`, `removes=[]`. Whitelist token was recognized as
    passthrough, not counted as a delta-add.
18. **Empty-pin + non-whitelist add**: first-seen session had no
    `anthropic-beta` header (pinned Set is empty). Turn 2 adds a
    non-whitelist token like `beta-x`. Outgoing has NO `anthropic-beta`
    header (pinned Set stays empty, `beta-x` is a delta-add and stripped);
    telemetry records `adds=["beta-x"]`, `removes=[]`, `passthrough=[]`.
    Covers the edge case where the "emit nothing if empty" clause
    interacts with delta-add accounting.
19. **Per-session event-log file**: onRequest invocations append one JSONL
    row per call to `${snapshotDir}/${sessionKey}-anthropic-beta-events.jsonl`
    with `{ ts, key, sid, action, adds, removes, passthrough, pinned }`.
    Verify: file exists after first invocation; two invocations produce
    two rows; each row is valid JSON parseable back to the emitted shape.
    Test uses tmpdir-injected snapshot dir via the same pattern
    deferred-tool-rewrite's tests use.
20. **Route filter contract (extension body)**: the extension's default
    export does NOT declare a `routes` field. Verified by
    `assert.equal(defaultExport.routes, undefined)` — pipeline behavior is
    exercised in `test/proxy-pipeline.test.mjs`.

21. **Pathname guard: `/v1/messages/count_tokens` no-op**. `ctx` has
    `meta.path = "/v1/messages/count_tokens"` and a valid `body` +
    `anthropic-beta` header. Assert: no state written to the in-memory Map,
    no telemetry row appended to the per-session event log, `ctx.headers`
    unchanged, `ctx.meta.betaStabilizeStats` not set.

22. **Pathname guard: `/v1/messages/batches` no-op**. Same shape as 21
    with path `/v1/messages/batches`.

23. **Pathname guard: exact `/v1/messages` DOES run**. Same shape but
    path `/v1/messages` — assert extension executed normally (state
    written, event row appended, header rewritten if non-empty pinned
    Set, stats populated).

24. **Pathname guard: `/v1/messages?trace=1` DOES run**. Query strings
    are stripped before comparison; `?trace=1` is a valid /v1/messages
    request with a query param. Assert extension executed.

25. **Pathname guard: missing `ctx.meta.path`**. If preForward hasn't been
    updated (regression scenario), the extension MUST no-op (fail-safe).
    Assert no-op on `ctx.meta.path === undefined`.

## Acceptance

- All 25 new tests pass; full proxy test suite green
- Extension registered in `proxy/extensions.json` at order 450, `enabled:
  true`
- Live A/B verification on the beta soak host: enable the gate and confirm
  `prefix-diff` no longer surfaces `cause=header:anthropic-beta[±...]` on any
  session (before-gate baseline: at least one flip observed per hour on
  active sessions per 2026-08-08 measurement)
- Codex implementation-stage R0+ review with no blockers
- Chris human review before merge (load-bearing per NFR § above)
- CHANGELOG update deferred to release-PR (matches `deferred-tool-rewrite`
  precedent)
- Header comment in the extension names three design choices explicitly:
  strict-pin vs monotonic-union, the in-memory state lifetime, and the
  reliance on the pipeline's default route filter (why no `routes:` field
  and no `ctx.url` check)

## Out of scope

- No `deferred-tool-rewrite` changes (its `addBetaToken()` continues to
  operate; the stabilizer's whitelist forwards its token upstream)
- No `prefix-diff` changes (its `cause=header:anthropic-beta[±...]` output
  becomes the primary observability signal for whether this extension is
  working — no telemetry additions needed there)
- No CHANGELOG changes
- No cross-session or cross-restart persistence (see "State lifetime")

## Follow-on work (not in this PR)

- **`usage.jsonl` integration** — surface
  `ctx.meta.betaStabilizeStats` as a `beta_stabilize_stats` field in
  `usage.jsonl` behind the `CACHE_FIX_USAGE_LOG_EXTENDED` gate, matching
  the pattern already established for `deferred_tool_rewrite_stats` and
  `insertion_normalization_stats`. Enables 6-month-later debugging without
  a proxy-side event-log scan. Track in a follow-on issue after this ships.
- **Pipeline-level regression test for default-routed extensions**
  (Codex R2 recommendation) — `test/proxy-pipeline.test.mjs` currently
  covers load order, enabled/config, hook execution, error isolation,
  stream hooks, snapshots, and failed-extension bookkeeping, but does not
  have an explicit case for the `ext.routes || ["messages"]` default. Add
  a small test in that file (1-2 assertions) covering the case a
  default-routed extension is called under `ctx.meta.route = "messages"`
  and skipped under any other route. Not in-scope for this PR (this PR's
  test file is the extension's own, and its Test 20 already covers the
  `defaultExport.routes === undefined` extension-side contract), but the
  pipeline-side counterpart is worth having as a hygiene item — Codex R2
  flagged it as absent and it wouldn't cost much to add.

— Proxy Builder
