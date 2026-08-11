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
  (`test/proxy-anthropic-beta-stabilize.test.mjs`). No new abstractions. The
  header parse/join idiom mirrors `deferred-tool-rewrite`'s existing
  `parseBetaTokens`/`addBetaToken` (which are also the closest thing to prior
  art in this repo); if the shape converges further during review, factor to
  a shared helper — otherwise inline is fine (see [[feedback-inline-comment-
  guidelines-post-release]]).
- **Performance/reliability** — header parse + Set-difference + join per
  request. O(n) where n is the token count (typically < 5). Negligible.
- **Load-bearing? YES.** The extension modifies what we send upstream on every
  request when active. Failure to canonicalize output correctly could itself
  become a cache-key input (see "Design", point 3). Chris human-review
  required per CLAUDE.md § Non-Functional Requirements & Anti-Bloat.

## Design

### Algorithm

Per-request `onRequest(ctx)`:

1. Parse the incoming `anthropic-beta` header into a Set of trimmed
   non-empty tokens. Accept BOTH `,` and ` ` as separators (CC has been
   observed emitting both within the same run — see design note in #326).
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
     (adds and removes vs the pinned Set), log both, and emit the canonical
     form of the **pinned** Set. Telemetry: `action=pinned, adds=[...],
     removes=[...]`.
4. Emit the canonical form: sort the pinned Set ASCII-ascending, join with
   `", "` (comma+space), write to whichever header key the incoming request
   used (case-preserving), or default to `"anthropic-beta"` if incoming had no
   such header at all. If the pinned Set is empty (rare — first-seen session
   with no beta header), emit no header at all.

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

- `deferred-tool-rewrite` itself writes `mid-conversation-tool-changes-2026-07-01`
  to `anthropic-beta` via its `addBetaToken()` helper on turns where it
  injects a `tool_addition` block. That write must be visible to
  `anthropic-beta-stabilize` so the token gets picked up on first-seen and
  survives into the pinned set — otherwise the stabilizer would strip it on
  the very next turn and the tool-rewrite extension's cache-continuity
  guarantee would break.
- Must run BEFORE the TTL-management pass which reads header state for
  cache-key computations.
- Slot 450 is currently unused (nothing else in the 426-499 range).

## Open questions for AITL R0

Two design choices where the issue body is compatible with more than one
reading; naming them so R0 can pin the direction.

### Q1. Strict-pin vs monotonic-union

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

**Directive default is strict-pin.** Argument: (a) the observed harm is
toggle-thrash, not "we needed a new beta and got blocked"; (b) telemetry on
delta-adds makes silent-block detectable within one prefix-diff scan; (c)
future betas can be added to the strict-pin baseline explicitly, which is a
safer default than "trust CC's mid-session decisions". Overrule if the
2026-08-08 evidence hints at genuinely new betas appearing (not just
toggling among an established set) that we shouldn't block.

### Q2. Sub-key granularity

Directive proposes the same three-part key `deferred-tool-rewrite` uses
(session-id + system-prompt hash + conversation sub-key). The
system-prompt-sub-key was added to `deferred-tool-rewrite` after 2026-07-28
capture s-35d72503 measured 6 tenants colliding on 1 baseline.

For `anthropic-beta` specifically, the collision question is: **do subagents
and sidecars ever carry different beta sets from their parent session?** If
no, we could bare-session-key and skip the sub-keying overhead. If yes, we
need the sub-keying.

I don't have measurement here. Direction I'll take without a signal: match
`deferred-tool-rewrite`'s key exactly (over-key, not under-key — the cost of
sub-keying is one hash per request, the cost of under-keying is one silently
wrong pin per multi-tenant session). Overrule if you have data.

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
- **Hook:** `onRequest(ctx)` — reads and rewrites `ctx.headers`
- **Exports for tests:**
  - `parseBetaHeader(rawHeaderValue) → Set<string>`
  - `canonicalizeBetaTokens(Set<string>) → string`
  - `resolveBetaSessionKey(headers, body) → string`
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
8. Case-preserving header key: incoming used `Anthropic-Beta`; outgoing uses
   the same case
9. Missing header first-seen: incoming has no `anthropic-beta`; pinned Set is
   empty; outgoing has no `anthropic-beta`
10. Missing header on a session with a non-empty pinned Set: incoming has no
    `anthropic-beta`; outgoing DOES have `anthropic-beta` populated with the
    pinned Set (the "pin over the client removing it" case)
11. Session-key sub-keying: two subagents with different system prompts on the
    same session-id header do NOT share pinned state (mirrors the deferred-
    tool-rewrite tenant-isolation test)
12. Deferred-tool-rewrite composition: when `deferred-tool-rewrite`'s
    `addBetaToken()` runs earlier in the chain and adds
    `mid-conversation-tool-changes-2026-07-01` on turn 1, the stabilizer's
    first-seen Set includes that token and preserves it on turn 2 even if
    the deferred-tool-rewrite gate has since flipped off. (Integration-style
    test — verify by running both extensions in sequence against a mocked
    ctx.)
13. Ordering canonicalization: pinned Set `{b, a, c}` always emits
    `"a, b, c"` regardless of insertion order (reproducibility across
    process restarts is a property test)
14. Empty-token skip: incoming `"beta1, ,beta2"` parses to `{beta1, beta2}`
    (trim and filter-Boolean); empty strings never enter the pinned Set
15. Idempotence: two calls to `onRequest` with the same `ctx` produce
    identical `ctx.headers['anthropic-beta']` (a guard against accidental
    mutation via passed-by-reference on the pinned Set)
16. `ctx.meta.betaStabilizeStats` populated with `{ action, adds, removes }`
    on every action

## Acceptance

- All 16 new tests pass; full proxy test suite green
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
- Header comment in the extension names both design choices explicitly:
  strict-pin vs monotonic-union, and the in-memory state lifetime

## Out of scope

- No `deferred-tool-rewrite` changes (its `addBetaToken()` continues to
  operate; the stabilizer reads what it wrote and pins it)
- No `prefix-diff` changes (its `cause=header:anthropic-beta[±...]` output
  becomes the primary observability signal for whether this extension is
  working — no telemetry additions needed there)
- No CHANGELOG changes
- No cross-session or cross-restart persistence (see "State lifetime")

— Proxy Builder
