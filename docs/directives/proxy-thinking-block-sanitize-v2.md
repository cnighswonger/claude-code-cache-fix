# Directive: proxy-thinking-block-sanitize v2 (drop signed thinking on tools-hash mismatch)

**Status:** DRAFT — Proxy Builder, 2026-06-04. Pre-vetted by Codex via consultative design review (`docs/code-reviews/issue-171-v2-predicate-design-consult-2026-06-04.md` on branch `consult/issue-171-design`). Approved spec from AI Team Lead. Pending formal Codex directive-stage review + implementation.

**References:** [#171](https://github.com/cnighswonger/claude-code-cache-fix/issues/171) (this directive's tracking issue, AITL-authored). [#63147](https://github.com/anthropics/claude-code/issues/63147) (canonical upstream cluster — yurukusa's "13E" sub-pattern, ToolSearch surface). [#63792](https://github.com/anthropics/claude-code/issues/63792) (cited 13E repro: Opus 4.8 + ToolSearch, 400 strip-and-retry storm on every turn). v1 directive at `docs/directives/proxy-thinking-block-sanitize.md`. v1 source at `proxy/extensions/thinking-block-sanitize.mjs:29-130`. Codex consult artifact at `docs/code-reviews/issue-171-v2-predicate-design-consult-2026-06-04.md` (branch `consult/issue-171-design`, commit `a39f812`). AITL sign-off recorded in the Proxy Builder ↔ AITL handoff loop (`~/drafts/aitl-reply-issue-171-spec-signoff.md` on Chris's working tree — not a public-repo artifact; the integrated spec from that sign-off is reproduced in the design choices below).

## Goal

Extend the existing `thinking-block-sanitize` extension to also drop **signed non-empty thinking blocks** from prior assistant turns when the request's tools surface has changed since the prior request on the same session. v1's predicate (drop omitted `thinking:""` blocks) leaves these intact by design — `isOmittedThinking` returns false on any block with non-empty thinking text. The signed non-empty case is yurukusa's "13E" pattern: when `ToolSearch` dynamically loads a tool mid-conversation, the prior assistant turn's thinking signature is invalidated because it was computed over the now-stale tools surface; the API rejects the request, and CC's harness strips-and-retries — every turn pays a 400 + retry tax in tokens and latency.

**Cost class for v2 (different from v1).** v1 was about preventing **session death** (permanent 400 on history replay). v2 is about preventing **a per-turn tax** (extra round-trip, doubled token-on-the-wire counts, latency hit) on sessions using dynamic-tool-loading features. The mitigation lives on the same extension and on the same opt-in env var because the implementation is structurally adjacent.

**Why this matters (value prop).** Without proxy-side intervention, the user-side mitigations for 13E are: don't use dynamic tool loading (loses the feature), or run extended thinking off entirely (lossy). Neither is acceptable for an operator who actively uses both. v2 strips the prior-turn signed thinking *before* the request leaves the machine, so the API accepts the first attempt — no harness retry, no double-billed tokens.

## v1 vs v2 — scoping discipline

v1 scope rule was **empirical**: "drop what we observed in worst-case wedged transcripts" — that observation set was all `thinking:""` omitted blocks, zero `redacted_thinking` blocks. The exclusion of `redacted_thinking` was an observation, not a structural argument.

v2 scope rule is **structural**: "drop what's structurally invalid by the change-of-input signal." The signature is computed over the inputs present at thinking time, including the tools surface. If the current request's tools surface differs from the surface that produced any prior signed-thinking turn, those signatures are invalid for the current request — regardless of whether the block is a `thinking` block or a `redacted_thinking` block, because both carry signatures computed against the same inputs. **v2 therefore drops both types on hash mismatch**, where v1 only dropped `thinking` blocks (its empirical exclusion of `redacted_thinking` doesn't carry over).

This shift — empirical scope in v1, structural scope in v2 — is documented here so a future reviewer doesn't read the wider scope as inconsistency.

## What the proxy can see (and what it can't)

The proxy can see the outbound request body: `tools` array, `system` block, `messages` array (including all prior assistant turns' thinking blocks with their signatures intact), `model` field (already-sanitized — see `auto-1m-guard` directive), `anthropic-beta` request header.

The proxy **cannot** validate signatures — no public-key access to Anthropic's signing scheme. The mitigation is therefore based on **detecting structural change** that's known to invalidate signatures, not on directly verifying signatures are still valid.

## Predicate design — Option C (single tools-hash, strip-all-on-mismatch)

Three candidate predicates were considered. Codex's consult artifact and AITL's design instinct converged on **Option C**:

- **Option A** (per-turn tools-hash memo with strip-only-mismatched-turns) — correct, no false positives, but per-turn state pushes the per-session JSON toward an append-log shape that cache-fix's existing summary-shaped state doesn't accommodate cleanly. Codex's read: "overcounting precision and undercounting implementation risk" for this bug class.
- **Option B** (reactive — strip on 400 retry) — non-starter. Replicates what CC's harness already does, so it doesn't move the needle. The whole point of v2 is avoiding the harness's retry, not duplicating it.
- **Option C** (one current-hash baseline per session, strip ALL prior signed thinking on cross-request mismatch, update baseline after successful response) — minimal state, mirrors `session-health`'s existing in-memory-seeded-from-disk pattern, fits cache-fix's summary-shaped state cleanly. **Chosen.**

### False-positive shape

C's false-positive class is **hash oscillation / reversion** — a tools surface that's been seen before reappears (e.g., `A → B → A`, or any shrink/re-expand cycle). When the hash flips back to a previously-seen value, prior-turn signed thinking signed against that earlier value would in principle still validate, but we'd strip it anyway.

In practice ToolSearch is **monotonic-additive** within a session (the public #63147 discussion thread is consistent on this point). For monotonic-additive workloads, strip-all-on-change is **effectively exact**, not approximate. The directive accepts the residual false-positive class as a deliberate precision-for-simplicity trade.

Cost of a false-positive strip: lose the reasoning text from a prior assistant turn that the API would have re-validated. No wedge, no user-facing breakage — the agent is mid-conversation and has already replayed that turn's content in current context. Acceptable.

### Predicate, formally

For each request:

1. Compute `current_tools_hash = computeSignatureSurfaceHash({ tools: req.body.tools })`.
2. Read `baseline_tools_hash` from the per-session in-memory map (seeded from `sessions/<sid>.json` on first request that session).
3. If `baseline_tools_hash` is unset (first request that session) → no strip. Forward intact.
4. If `baseline_tools_hash === current_tools_hash` → no strip. Forward intact.
5. If `baseline_tools_hash !== current_tools_hash` → strip all signed thinking (`thinking` blocks where `thinking.trim() !== ""` AND `signature` is present) AND all `redacted_thinking` blocks from prior assistant turns. Same latest-turn-active-tool-continuation protection as v1 (do not strip from a latest turn that is an active tool-continuation — the API needs the signed thinking for the pending tool call). Count drops into `thinking_blocks_dropped_v2`.
6. Update `baseline_tools_hash` to `current_tools_hash` **only on response success (HTTP 200)**, via the same `cache-telemetry` write path used by all other per-session state. On 4xx/5xx response, baseline is *not* advanced (the request the API rejected may have been malformed; we don't want a failed-request's hash to become the new ground truth for the next strip decision).

### `unknown`-session no-op

`cache-telemetry.sessionFilename` canonicalizes null/empty/whitespace session IDs to `"unknown"` (`cache-telemetry.mjs:44-47`). The resulting `sessions/unknown.json` is shared across all "no session id" requests on the host — fine for the existing additive monitoring fields, but **cross-contaminating for a mutator baseline** (two unrelated agents would both read/write the same baseline, triggering spurious strips and corrupting each other's state).

v2 therefore **disables when the canonical session id is `"unknown"`**: extension no-ops, no strip attempted, no baseline read or write. Acceptable miss class — requests without a session id are typically warmup probes / health checks / test scaffolds that don't carry signed thinking anyway.

## Hash helper

```
computeSignatureSurfaceHash({ tools, system?, anthropic_beta? }) -> 16-char sha256 hex
```

**v2 only passes `{ tools }`.** The function signature accommodates additional inputs (`system`, `anthropic_beta`) without an API-shape break, so a future v3 can extend coverage without renaming.

**Canonicalization rules:**

- `tools` input: an array of tool definition objects.
- Each tool object: **recursive stable JSON stringify** with **recursive key sorting** at every nesting level. Nested JSON-schema objects (in `input_schema`, `parameters`, etc.) have their own keys, which must also sort stably or we'd false-positive on benign key-order differences.
- **Preserve `tools[]` array order.** Reordering tools in the request changes which slot which tool occupies in the API's view, which could affect signing. The hash MUST reflect array order.
- **Sentinel for empty/absent:** if `tools` is undefined, null, or `[]`, the hash input is the literal string `"none"` (not the canonical-stringify of `[]`, which would be `"[]"` and could collide with other empty-shaped inputs in a future extension). One-line sentinel rules out ambiguity.
- Output: `sha256(canonical_input).slice(0, 16)` — 16 hex chars matches the existing `_sessionHealth` / `_thinkingSanitize` precedent.

The hash is a stability identifier, not a security primitive. SHA-256 is overkill but uniform with the repo's existing hashing pattern (`createHash("sha256")` in `cache-telemetry.mjs:48`).

## State pattern (mirror session-health)

Per Codex's consult and AITL's sign-off: **do not add a second on-request file writer.** Reuse the existing single-writer pattern from `session-health`:

- **In-memory per-session map** keyed by canonical session filename. Lives in module scope of the v2 extension (`Map<string, { tools_hash, ...}>`).
- **First-request seed from disk.** On the first request that session, the extension reads `sessions/<sid>.json` (using `cache-telemetry.sessionFilePath()`) and seeds the in-memory state from any existing `tools_hash_baseline` field. If the file is absent or the field is missing, the in-memory state stays unseeded (which the predicate treats as "no baseline yet, no strip").
- **Persistence via cache-telemetry.** When the response succeeds (200), the v2 extension stashes the new baseline at `ctx.meta._thinkingSanitizeV2 = { tools_hash_baseline, thinking_blocks_dropped_v2 }`. The existing `cache-telemetry` writer at order 600 spreads `ctx.meta._thinkingSanitizeV2` top-level into the per-session JSON, same channel as `_sessionHealth` / `_thinkingSanitize` / `_auto1mGuard`.
- **Proxy restart recovers state.** Because the persisted baseline lives in `sessions/<sid>.json`, a proxy restart re-seeds in-memory state from disk on the next request. No state loss across restarts.

## Env var (single var, versioned value)

`CACHE_FIX_THINKING_SANITIZE` — extended to accept versioned values:

| Value | Behavior |
|---|---|
| `off` / unset / any other | extension no-ops (default — same as v3.8.0) |
| `on` | v1 only — drop omitted `thinking:""` blocks per the v1 directive |
| `v2` | v1 + v2 — v1's omitted drop AND v2's tools-hash-mismatch drop both fire |

`v2` is strict superset of `on` — there is no use case for "v2 without v1", since v1's empty-text drop is independently correct on any request. Unknown values no-op (fail-open).

## Telemetry

Two separate counters, both via `ctx.meta` spread into the per-session JSON by `cache-telemetry`:

- `thinking_blocks_dropped` — v1 counter, unchanged. Counts omitted-thinking blocks dropped this request.
- `thinking_blocks_dropped_v2` — new v2 counter. Counts signed non-empty thinking + redacted_thinking blocks dropped this request due to tools-hash mismatch.

Plus the persisted baseline field:

- `tools_hash_baseline` — 16-char hex. Updated on response success. Absent until the first successful response that session.

A/B coverage is measurable post-flip by querying both counters across `sessions/*.json`.

## Out of scope (explicit non-coverage)

- **`system`-mediated invalidation.** `/compact` rewrites the system summary block, model switch (Opus 4.7 ↔ 4.8 — yurukusa's 13G) changes the signing scheme, heron_brook server-driven prompt injection (`CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE`) replaces the system prompt entirely. All structurally similar — signed thinking invalidated by an input change — but the input is `system`, not `tools`. The hash-helper signature is forward-compatible to add `system` (and `anthropic_beta`) without an API break, but **v2 does not pass those inputs.** Future v3 directive territory. Documented here so a future reviewer has a roadmap.
- **`anthropic-beta` header-mediated invalidation.** Same forward-compatibility framing as `system`.
- **Signature validation.** Proxy has no public-key access. v2 detects structural change, not signature validity.
- **Reactive strip-on-400-retry.** Considered as Option B; rejected because it replicates harness behavior without removing the cost.
- **Tools-list oscillation false-positive suppression.** The directive accepts the residual false-positive class (strip on `A → B → A` reversion) as a deliberate precision-for-simplicity trade. If empirical telemetry shows oscillation is more common than expected, future work can refine.

## Acceptance criteria

- v1 behavior at `CACHE_FIX_THINKING_SANITIZE=on` unchanged (existing 14 tests stay green).
- v2 fires on `CACHE_FIX_THINKING_SANITIZE=v2`, dropping signed `thinking` + `redacted_thinking` blocks from all prior assistant turns when `current_tools_hash !== baseline_tools_hash`.
- Latest-turn active-tool-continuation protection preserved (same `isActiveToolContinuation` logic as v1).
- First request in a session establishes the baseline (on response success) without stripping.
- 4xx AND 5xx responses leave the baseline unchanged (any non-2xx response means the request was not successfully processed; baseline only advances on confirmed success).
- `"unknown"` canonical session id triggers no-op.
- Per-session JSON gains `tools_hash_baseline` and `thinking_blocks_dropped_v2` fields, additive (existing consumers unaffected).
- Hash helper handles nested JSON-schema key ordering; preserves array order; uses `"none"` sentinel for empty.

## Test plan

Per Codex's consult + AITL's sign-off additions. All unit-testable against the pure-helper exports (no live API):

### Hash helper

- Stable canonical hash for tools array with shuffled top-level keys (within each tool object) → same hash
- Stable canonical hash for tools array with shuffled nested-schema keys → same hash
- Different hash when `tools[]` array order changes (preserving order matters)
- `"none"` sentinel for `undefined`, `null`, `[]`
- 16 hex chars output

### Predicate planner

- First request, no baseline → no strip, observe-only
- Same hash on consecutive requests → no strip
- Cross-request hash change → strip all signed `thinking` + `redacted_thinking` from prior assistant turns
- Active-tool-continuation latest turn protected even on hash mismatch (same as v1)
- v2 telemetry counter populated correctly

### Race / failure-mode cases (AITL's additions)

- **First-request-no-baseline-no-strip:** fresh session, turn 1 with signed thinking present, no baseline → forward intact. Turn 2 with the same hash and same signed thinking → still forward intact (baseline established correctly on turn 1's response).
- **4xx-leaves-baseline-untouched:** request gets a 400 response, verify baseline was NOT updated to that request's hash (next request's compare is against the prior baseline, not the failed request's).
- **5xx-leaves-baseline-untouched:** same shape, but with a 500/502/503 response. Pins that the response-success gate is "HTTP 2xx", not "not-4xx", so transient upstream failures don't silently advance the baseline either.
- **Oscillation over-strip is deliberate:** session with tools hash `A → B → A` sequence; verify the predicate strips signed thinking on each transition (the `B → A` transition is a false-positive strip by design — A's prior-turn signatures would have re-validated against A's current tools surface, but C's single-baseline contract treats any hash change as invalidating). Test name should include "deliberate-overstrip" so the trade is locked in test history, not implicit.
- **Two-pipelined-requests-same-new-hash:** request A and request B in flight back-to-back, both carrying the same new tools hash; both should strip (acceptable over-strip), final baseline = new hash after both responses complete.
- **First-strip-success-then-stable:** baseline H0 → strip on H1 → response 200 → baseline now H1. Next request at H1 → no strip (baseline matches).
- **Concurrent unknown-session requests don't cross-contaminate:** two simultaneous requests with empty session id both hit the no-op path; neither leaks state into the other.

### Integration (matches v1 directive's test plan)

- v2 extension at order 550 (same as v1, since v2 is the same extension extended).
- `cache-telemetry` at order 600 spreads `ctx.meta._thinkingSanitizeV2` into the session JSON top level.
- `session-health` at order 590 counts the **post-strip forwarded body**'s thinking block count, not the pre-strip count.
- Proxy restart re-seeds in-memory baseline state from disk on the next request.

## Implementation notes

- Reuse the existing `proxy/extensions/thinking-block-sanitize.mjs` file — do not create a new extension. v2 is the same extension with an extended predicate; sharing the file keeps the ordering and import surface stable.
- Add the in-memory map and seed-from-disk function at module scope. Mirror `session-health.mjs:23-26 + 72-113` structurally.
- The hash helper goes into a small helper module that can be exported separately for unit testing.
- Telemetry merge into the session JSON: the existing `cache-telemetry.mjs:232-245` spread block already handles `_sessionHealth` and `_thinkingSanitize`. Add `_thinkingSanitizeV2` to that list.
- Field names in the per-session JSON: `tools_hash_baseline`, `thinking_blocks_dropped_v2`. Lowercase-snake-case to match the existing convention.

## Labels (per Codex consult prediction)

- `load-bearing: yes` — request-body mutator on the shared proxy path + per-session persisted state.
- `schema-change` — `sessions/<sid>.json` gains new fields.
- `needs-sim-validation` — unit tests cover the predicate; the motivating win (no harness retry) requires live ToolSearch traffic to confirm empirically.

## Non-functional requirements

Per the CLAUDE.md NFR rubric for directives, addressing each required topic:

- **Size/complexity budget.** v2 extends the existing `proxy/extensions/thinking-block-sanitize.mjs` in place (no new extension file). Expected delta: ~80-120 LOC added to the extension file (hash helper, in-memory state map, seed-from-disk function, predicate extension, telemetry stash). Plus ~150-200 LOC of new test cases in `test/proxy-thinking-block-sanitize.test.mjs`. Plus ~10 LOC in `cache-telemetry.mjs` for the new `_thinkingSanitizeV2` spread. Total directive size: under ~350 LOC of net code change. If implementation lands materially larger (>2x), the directive should be revisited.
- **Threat model.** v2 modifies the outbound request body (strips thinking blocks) and persists per-session state to disk. **Privacy invariant: never log or persist thinking content — only counts, signatures of structural identifiers (the 16-hex tools-hash), and the boolean drop event.** The hash helper's input is the `tools` array, which contains tool definitions (names, descriptions, schemas) but no user content; hashing it is not a content leak. The persisted `tools_hash_baseline` is a structural fingerprint, not request content. The new in-memory map keyed by canonical session filename does not retain message content. Failure mode for the strip itself: stripping a block we shouldn't is lossy (loses prior reasoning context) but not a security violation; the strip path never modifies destinations other than the outbound request body.
- **Maintainability constraints.** Reuse over duplication: extension in place (no new file), telemetry channel reuses the existing `ctx.meta` spread pattern (`_sessionHealth` / `_thinkingSanitize` / `_auto1mGuard`), state pattern mirrors `session-health` rather than inventing a new state shape, single-writer-via-cache-telemetry contract preserved. The hash helper is a new exported function but justified by its 3+ call sites (predicate fire, baseline seed, baseline update) and clear single-purpose contract. No new dependencies; uses Node's existing `crypto.createHash` already imported by `cache-telemetry`.
- **Performance/reliability.** The hash compute runs on every request. Tools arrays are small (typically <100 tools × small schemas); a recursive canonical stringify + sha256 over the result is sub-millisecond. No measurable hot-path impact. In-memory map is bounded by the number of distinct active sessions in proxy memory — trivial. Persisted baseline adds ~30 bytes per session JSON file — negligible. **Failure mode is fail-open throughout**: if the hash helper throws, the extension fails open (no strip). If the session-state read/write throws, the extension fails open (no strip, log warning to stderr). If the session id canonicalizes to `unknown`, the extension no-ops entirely. Errors in v2 never escalate into a request-blocking failure.
- **Load-bearing? Yes.** This is a request-body mutator on the shared proxy path AND adds new fields to per-session persisted state (`sessions/<sid>.json`). Per CLAUDE.md, load-bearing changes require **Chris human review** on the implementation PR in addition to Lead + Codex. (Directive-stage review remains Lead + Codex.) The directive also classifies as a `schema-change` (additive fields to the per-session JSON schema) and `needs-sim-validation` (the motivating win — eliminating CC's harness retry on every ToolSearch turn — needs live traffic to confirm; unit tests can validate the predicate but not the end-to-end retry elimination).

## What I'm NOT building

- Per-turn hash memo (Option A) — Codex + AITL aligned that single-baseline is the right trade.
- Reactive strip-on-400 (Option B) — non-starter; harness already does this.
- Hashing of `system` block, `anthropic-beta` header, or other inputs — explicitly deferred to a future directive.
- Removal of v1's `redacted_thinking` exclusion in v1 mode (v1 stays as-is — empirical scope unchanged; v2's wider scope is the new behavior on the v2 flag).

## Open questions for review

None of these block the directive — all are confirmed by the consult / sign-off cycle. Recording here for the formal review round so reviewers don't re-litigate:

- A vs C predicate choice: **C** (Codex + AITL aligned).
- `redacted_thinking` scope: **extend on hash mismatch** (structural scope; v1's empirical exclusion doesn't carry).
- Helper signature: **`computeSignatureSurfaceHash({ tools, system?, anthropic_beta? })`** for forward-compat.
- Baseline update timing: **on response success (200), not on send**.
- Env var: **single var, versioned values** (`off` / `on` / `v2`).
- First request: **observe, don't strip**.
- 4xx/5xx response: **baseline unchanged** (any non-2xx; baseline advances only on confirmed HTTP 2xx success).
- `unknown` session: **no-op**.

— Proxy Builder
