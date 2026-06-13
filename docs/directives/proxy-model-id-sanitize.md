# Directive: `model-id-sanitize` extension. Detect (and optionally strip) malformed model IDs in outbound `body.model`

**Issue:** TBD (will be filed alongside this directive, referencing CC#68285 and CC#68279)
**Upstream:**
- [anthropics/claude-code#68285](https://github.com/anthropics/claude-code/issues/68285) — *`/model` picker silently causes ~$1000 in excess charges via malformed model ID* (billing impact, deterministic repro)
- [anthropics/claude-code#68279](https://github.com/anthropics/claude-code/issues/68279) — *`/model` picker writes malformed model ID to `settings.json`* (root-cause repro from the same author)
- [anthropics/claude-code#68287](https://github.com/anthropics/claude-code/issues/68287) — *Opus 4.8 1M missing from picker* (adjacent surface; likely the same picker reading the same corrupt state)
- Adjacent prior cluster (the broader `[1m]`-suffix-handling family): [#67650](https://github.com/anthropics/claude-code/issues/67650), [#50083](https://github.com/anthropics/claude-code/issues/50083), [#60240](https://github.com/anthropics/claude-code/issues/60240), [#65805](https://github.com/anthropics/claude-code/issues/65805).
- AITL synthesis comment on #68285 names the family: https://github.com/anthropics/claude-code/issues/68285#issuecomment-4699806154

**Priority:** P1
**Branch (implementation):** `feature/model-id-sanitize`
**Stage:** directive — round 1
**Labels:** `directive-stage`, `P1`, `schema-change` (new persisted per-session fields), `safety` (billing-event mitigation)
**Milestone:** v4.3.0 (next minor after v4.2.0 ships)

## Goal

Detect outbound requests whose `body.model` field contains ANSI escape sequences (or any character outside the canonical model-id alphabet), surface the detection through the per-session JSON, and optionally rewrite the body to a safe target before forwarding. Closes the proxy-side hole that turns a CC client bug into a $998 billing event (#68285).

This is a layered defense, not a replacement for Anthropic fixing the picker and adding server-side validation. The structural fix is server-side `400 model_not_found` on malformed values; this directive is the operator-side guard until that ships.

## Why

CC's `/model` picker on v2.1.177 (#68285, #68279) deterministically writes ANSI SGR bold escape sequences (`\e[1m`) into `~/.claude/settings.json` as part of the `model` field. The malformed value is then sent on every outbound request's `body.model`. Anthropic's API, instead of returning `model_not_found`, prefix-matches the substring (`opus`, `fable-5`) and resolves it to the current premium variant in that family. On 2026-06-11 this caused a 700+ subagent workflow on Fable 5 instead of the intended Sonnet, producing ~$998 in card charges before the operator noticed.

The proxy already inspects `body.model` on every outbound request (we read it for `requestedModel`, the served-model divergence detection on PR #225 / #224, etc.). Adding validation is one regex match per request, gated behind an opt-in env var, with no behavior change in the default-off path.

This directive is the natural sibling of:

- [#225](https://github.com/cnighswonger/claude-code-cache-fix/pull/225) (served-model divergence observability). #225 sees the swap after it happens; this extension prevents the swap by catching the malformed request before it goes out.
- `auto-1m-guard`, same shape: detect a problematic outbound pattern in the request body, log it, optionally mutate before forward.

## Non-Functional Requirements

- **Size/complexity budget:** ~120-180 LOC core implementation + ~30 LOC for the optional strip mode, schema-spread one-liner in `cache-telemetry.mjs`, plus tests (~100 LOC including the byte-fixture cases from #68285). Reviewers should flag implementations materially larger than ~2× the budget.
- **Threat model:** the new persisted fields are short string scalars plus a boolean. No user-provided content goes anywhere new. The validator runs against the model-id field that already flows; rewrite is a pure-string transform with no I/O. The block-mode synthetic 400 reuses the existing `pre.handled` short-circuit plumbing (precedent: `image-retry-circuit-breaker.mjs:236-265`); no new wire surface, no new pipeline hook.
- **Maintainability constraints:** reuses the existing `meta` plumbing and the per-session JSON spread pattern, same as `_thinkingSanitize`, `_auto1mGuard`, `_sessionHealth`. No new CI/config. The family→canonical-target map is one named constant in the extension — the **only** piece of business logic that updates when Anthropic ships new models or rotates the "cheapest current variant" within a family.
- **Performance/reliability:** trivial. One regex match per outbound request. Failure isolation: the detector runs inside the existing pipeline try/catch (`pipeline.mjs:91-96`); rewrite is gated by env var and only fires on detected-malformed values. The default-`off` path is a no-op return at the top of `onRequest`.
- **Load-bearing? Yes.** Adds a new persisted contract on the per-session JSON (`model_id_malformed`, `model_id_malformed_first_seen`, `model_id_corrections_count`, `model_id_malformed_last_value_hex`) AND a new opt-in body-mutation path AND a new opt-in synthetic-400 short-circuit. By CLAUDE.md NFR rubric (wire/schema contract + new mutate path on the request body + new synthetic-response shape), this requires Chris human review before merge in addition to the Lead + Codex review path.

## Functional requirements

### 1. Detect (default behavior when extension is active)

On every outbound request, run the body's `model` field against the canonical model-id regex:

```
^[a-z][a-z0-9-]+(\[1m\])?$
```

Hyphen-separated lowercase alphanumeric prefix, optional literal `[1m]` suffix. The optional `[1m]` allowance preserves CC's documented 1M-context-window suffix (per `auto-1m-guard.mjs:11-12`, CC strips `[(1|2)m]` from `body.model` before the wire on the 1M-context path, but the user-facing convention is the bracketed suffix; canonical model IDs without 1M are bare).

If the field doesn't match, the value is malformed. The most common malformation we know about is the ANSI SGR bold escape `\e[1m...\e[0m` wrapping the model name, but the detector treats anything outside the regex as malformed; the family is generative (per the #68285 synthesis comment) and we don't want to scope to one byte pattern.

When a malformed value is detected, the extension:

- Emits a stderr line: `[model-id-sanitize] malformed model_id detected: <hex-escaped representation> (mode=<warn|strip|block>)`.
- Stashes detection state on `ctx.meta._modelIdSanitize` for the per-session JSON spread.
- In `warn` mode: forwards the request unchanged.

### 2. Strip (opt-in via env var)

When `CACHE_FIX_MODEL_ID_SANITIZE=strip` and the detector fires:

- Attempt recovery: extract the largest substring matching the canonical alphabet from inside the malformed value. If that substring is a known model family root (`opus`, `sonnet`, `haiku`, `fable`, `mythos`), rewrite `body.model` to the **cheapest** current variant of that family. The rewrite is deliberately conservative: wrong-but-cheap is strictly better than the bug's current wrong-but-most-expensive behavior.
- Family → cheapest-current-target map, hardcoded in the extension:

  ```
  opus     → claude-opus-4-6
  sonnet   → claude-sonnet-4-6
  haiku    → claude-haiku-4-5-20251001
  fable    → claude-sonnet-4-6   (Fable currently suspended; fall through to Sonnet)
  mythos   → claude-sonnet-4-6   (Mythos currently suspended; fall through to Sonnet)
  ```

- The original malformed value is preserved on `ctx.meta._modelIdSanitize.original` for telemetry.
- If recovery cannot identify a family root with confidence (no recognizable substring, OR multiple family-root substrings present), fall through to `block` mode behavior for that request (see §3).

### 3. Block (opt-in via env var)

When `CACHE_FIX_MODEL_ID_SANITIZE=block` and the detector fires, **or** when `strip` mode cannot recover with confidence:

- Return a synthetic `400` response to CC with body:

  ```json
  {
    "error": {
      "type": "model_not_found",
      "message": "[model-id-sanitize] malformed model_id rejected by cache-fix proxy: <hex-escaped representation>. Inspect ~/.claude/settings.json and re-run /model to clean up; see anthropics/claude-code#68285 and #68279."
    }
  }
  ```

- The synthetic response is delivered via the existing `pre.handled = true` short-circuit shape from `onRequest`, mirroring `image-retry-circuit-breaker.mjs:236-265` (which returns `{skip: true, status, headers, body}`). For non-streaming requests the body is the JSON envelope above; for `stream: true` requests, the response is an SSE-formatted equivalent (same pattern image-retry uses) so CC's parser doesn't choke. No new pipeline plumbing required.

This converts a billing event into a stuck session, which CC handles badly (see #59843 / #68284) but is strictly safer than letting the malformed call go through.

### 4. Modes summary

| Mode    | v1 default | Behavior                                                          |
|---------|------------|-------------------------------------------------------------------|
| `off`   | yes        | Extension early-returns from `onRequest`. Pipeline unchanged.     |
| `warn`  | —          | Detect + log + stash, forward unchanged.                          |
| `strip` | —          | Detect + rewrite to cheapest safe variant.                        |
| `block` | —          | Detect + reject with synthetic 400.                               |

The four modes form a ladder of intervention strength. We ship `off` as the v1 default, gather prevalence data via dogfooding `warn` on dev hosts, and decide whether to flip the v2 default to `warn` (same playbook as `_thinkingSanitize` v1 → v2). The `strip` and `block` modes stay opt-in indefinitely; flipping their default requires a separate directive after live-data review of false-positive rate.

### 5. Persisted schema additions

On the per-session JSON, spread idiom mirrors `_thinkingSanitize`, `_auto1mGuard`, `_sessionHealth`:

- `model_id_malformed` (boolean) — true if any request in this session had a malformed `model_id`.
- `model_id_malformed_first_seen` (ISO timestamp) — when the first malformed value was observed in this session.
- `model_id_corrections_count` (integer) — number of requests rewritten in `strip` mode; `0` in `warn`/`off`.
- `model_id_malformed_last_value_hex` (string) — hex-escaped representation of the most recent malformed value, for operator triage. **Never** log the raw bytes; they may contain control sequences that mess up the operator's terminal.

When no malformed value has been observed for this session, the spread is undefined (no-op).

## Implementation surface (file-anchored)

### Writer side — new file `proxy/extensions/model-id-sanitize.mjs`

- **Extension order: 50** (between `bootstrap-defense:45` and `ttl-tier-detect:75`). Detection must run before any other extension that reads or mutates `body.model` so that a `strip`-mode rewrite is visible to all downstream consumers (in particular: `usage-log`'s `requestedModel`, `cache-telemetry`'s served-model divergence detection, `auto-1m-guard`'s `body.model` check). Verified slot 50 is free against current `extensions.json` HEAD.
- `enabled: true` in `extensions.json` (always loaded). Internal env-var gate `CACHE_FIX_MODEL_ID_SANITIZE` controls behavior: `off` (default) / `warn` / `strip` / `block`. Unknown values fall back to `off` with a one-time stderr warning.
- Reads `ctx.body.model`, runs the canonical regex, emits `ctx.meta._modelIdSanitize = { malformed, original?, rewritten?, mode, spread }` where `.spread` is the pre-shaped object that `cache-telemetry` spreads into the per-session JSON (so `cache-telemetry` doesn't need to know the field-name schema).
- In `strip` mode, mutates `ctx.body.model` in place. Mutation is the only request-body write in this extension; same idiom as `auto-1m-guard`.
- In `block` mode (or `strip`-mode no-confidence fallback), the extension returns `{ skip: true, status: 400, headers, body }` from `onRequest`. The server short-circuits via `pre.handled` (`server.mjs:118` checks this, then writes the synthesized response to the client). Mechanism precedent: `image-retry-circuit-breaker.mjs:236-265`.

### Writer side — `proxy/extensions/cache-telemetry.mjs`

One-line spread addition to the per-session JSON build at `cache-telemetry.mjs:225-261`, between the `_auto1mGuard` spread and the model-divergence spread:

```js
...(ctx.meta._modelIdSanitize?.spread || {}),
```

`.spread` is the normalized object the `model-id-sanitize` extension prepares, so `cache-telemetry` doesn't need to know the schema shape — same indirection idiom as the other `_*` spreads.

### Reader side

No reader change in v1. The persisted fields are visible via:

- `jq` against the per-session JSON for operators triaging an incident.
- Eventually a statusline render block (out of scope for this directive; future work, sequenced after PR #225's served-model divergence indicator).

## Composition with PR #225 (served-model divergence) — family-map ownership

PR #225 already shipped a family map at `proxy/extensions/cache-telemetry.mjs:48` (current `main`) that maps **canonical model IDs to family roots** (`claude-opus-4-7 → opus` etc.). This directive needs the **inverse** mapping (`opus → claude-opus-4-6` for the cheapest-fallback target). Same domain, different direction.

Three options for handling the shared concept:

1. **Each extension keeps its own copy** of the map. Simplest; risks drift when a new model ships.
2. **Shared helper module** `proxy/model-families.mjs` (new flat file, ~30 LOC) exports a single family-roots table (`[{ root: "opus", cheapestTarget: "claude-opus-4-6", knownVariants: [...] }, ...]`). Both extensions import from it. Cleaner; one location updates when Anthropic ships a new model.
3. **Each keeps its own copy this round, refactor later.** Defer the consolidation to a separate cleanup PR.

**Recommendation: #2.** Add the shared helper as part of this directive's implementation PR; `cache-telemetry.mjs`'s existing inline family map (introduced in PR #225) is refactored on the way in to import the same source of truth. This is a small refactor (~10 LOC delta in `cache-telemetry.mjs`) and the load-bearing maintenance benefit — one place to update on every model-roster change — is worth it.

If the implementation review surfaces friction with #2 (e.g. circular-import concerns we don't anticipate), the impl PR may fall back to #1 with a tracking issue for the consolidation. Reviewer judgment.

## Test plan

- `test/proxy-model-id-sanitize.test.mjs` (new file):
  - **Mode `off` default:** any body shape (clean OR malformed) → no `_modelIdSanitize` stash, no body mutation, no log, no spread.
  - **Mode `warn`, clean model id** (`claude-opus-4-7`, `claude-opus-4-7[1m]`, `claude-sonnet-4-6`, etc.) → no `_modelIdSanitize.malformed`, no spread.
  - **Mode `warn`, `opus\e[1m]\e[22m` (the exact byte sequence from #68285)** → `malformed: true`, original preserved, `body.model` UNCHANGED, stderr line emitted (capture via stream redirect), spread populated.
  - **Mode `warn`, `fable-5\e[1m]\e[22m`** → same; original preserved on meta.
  - **Mode `strip`, `opus\e[1m]\e[22m`** → `body.model` rewritten to `claude-opus-4-6`, `original` preserved on meta, `model_id_corrections_count` incremented in the spread.
  - **Mode `strip`, `fable-5\e[1m]\e[22m`** → rewritten to `claude-sonnet-4-6` (Fable suspended fallback).
  - **Mode `strip`, unrecoverable malformation** (random bytes, no family-root substring) → falls through to `block` behavior (synthetic 400).
  - **Mode `strip`, multi-root substring conflict** (e.g. a string containing both `opus` and `sonnet` as substrings) → falls through to `block` (no-confidence path).
  - **Mode `block`, any malformed input** → `{ skip: true, status: 400, body }` returned from `onRequest`; body shape matches the schema in §3; SSE variant produced for `stream: true` requests.
  - **Mode `block`, clean input** → no short-circuit; pipeline continues normally.
  - **Hex-escape format** in persisted JSON matches `\\x1b\\x5b\\x31\\x6d` shape (NOT raw `\e[1m`).
  - **Failure isolation**: detector wrapped in try/catch; thrown exceptions don't break the pipeline (the regex shouldn't throw, but the catch is mandatory per directive's NFR section).
  - **Unknown mode** (e.g. `CACHE_FIX_MODEL_ID_SANITIZE=lol`) → falls back to `off` behavior, one stderr warning on first invocation.
- Integration test (extend `test/proxy-cache-telemetry.test.mjs`): synthesize a request with `body.model: "opus\e[1m]"` and the env var set to `warn`, drive through the pipeline, assert the per-session JSON carries the spread fields.
- Family-map source-of-truth test (`test/model-families.test.mjs`, new file): every family root in the map has a non-empty `cheapestTarget`; targets are well-formed canonical model IDs.

## Verification

- `node --test test/proxy-model-id-sanitize.test.mjs` — all green.
- `node --test test/proxy-cache-telemetry.test.mjs` — still green (no regression).
- `node --test test/model-families.test.mjs` — all green.
- Manual smoke: with `CACHE_FIX_MODEL_ID_SANITIZE=warn` on a dev host (see internal deployment notes), deliberately edit the dev host's `~/.claude/settings.json` to have `"model": "opus\e[1m]"`, start CC, observe the stderr log line and the per-session JSON spread populated. **Do not** ship `strip` or `block` to prod without separate sign-off — the modes that mutate the wire are gated behind a follow-up validation cycle in the impl PR.
- Pair test against #68285's exact byte sequences if the upstream reporter shares the literal bytes (request via comment on the upstream issue if needed; the hex shape is publicly documented in the issue body, so the test file can hard-code it without further input).

## Review chain

Per project workflow:

1. Codex review (Fable is currently unavailable per recent operator decision; skipping that round)
2. AITL plan-approval (`plan-approved` label on the directive PR)
3. Owner merges (load-bearing: also requires Chris human review before merge of both this directive PR AND the implementation PR)

## Out of scope (explicit)

- **Fixing CC's picker.** That's the upstream root cause; structural fix lives there (#68279).
- **Statusline render of malformed-id state.** Future work; sequence as a follow-up after PR #225's served-model divergence indicator surfaces in the statusline, using the same conditional render block pattern.
- **Auto-cleanup of `~/.claude/settings.json`.** The proxy does not touch the user's filesystem outside its own dirs. Operator hand-cleans, per the synthetic-400 error message text.
- **Detection on non-`model` fields.** Only the body `model` field is in scope; other fields might also have similar UI-leak risks but those need their own surveys.
- **Detection on response-side `model` field.** That's PR #225's territory (the served-model divergence detector compares request body `model` to `event.message.model`).
- **Default flip of `CACHE_FIX_MODEL_ID_SANITIZE` to `warn` or `strip`.** Out of scope for this directive's first ship; the v2 default flip is a separate directive after live-data review of the prevalence rate.

— AI Team Lead
