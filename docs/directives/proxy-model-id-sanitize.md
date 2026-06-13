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
**Stage:** directive — round 2 (Codex r1 REQUEST_CHANGES at `bf20dc7` flagged 4 blockers; r2 tightens the validator + recovery order, corrects the family-target rationale, drops the wrong block-mode citations in favor of an explicit `needs-sim-validation` gate, and fixes two file:line anchors).
**Labels:** `directive-stage`, `P1`, `schema-change` (new persisted per-session fields), `safety` (billing-event mitigation), `needs-sim-validation` (block-mode synthetic-400 path against streaming + non-streaming CC clients).
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

On every outbound request, run the body's `model` field against the canonical model-id regex.

**The canonical outbound `body.model` shape per `auto-1m-guard.mjs:11-12` is `claude-{family}-{version}[-{date}]`** — `claude-` prefix, hyphen-separated family + version (and an optional date suffix on pinned point releases like `claude-haiku-4-5-20251001`). `auto-1m-guard.mjs:11-12` documents that CC strips `[(1|2)m]` from `body.model` before the wire on the 1M-context path, so **a healthy outbound `body.model` never carries the `[1m]` suffix.** The user-facing convention `Opus 4.7[1m]` is a UI label that gets stripped before the request goes out.

The validator regex therefore is:

```
^claude-[a-z][a-z0-9]*(-[a-z0-9]+)+$
```

This requires the `claude-` prefix, a family token, and at least one additional hyphen-separated segment (the version, e.g. `4-7` which the regex parses as two segments `4` then `7`). It accepts `claude-opus-4-7`, `claude-opus-4-7-1m` if Anthropic ever ships that wire shape, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `claude-fable-5`, `claude-mythos-2`. It rejects bare family names (`opus`, `claude-`), double-hyphen artifacts (`claude--oops`), uppercase, and any non-`[a-z0-9-]` byte (which catches the ANSI-escape malformation from #68285 / #68279).

If the field doesn't match, the value is malformed. The most common malformation we know about is the ANSI SGR bold escape `\e[1m...\e[22m` wrapping the model name (e.g. `claude-fable-5\e[1m` from #68285, `claude-opus-4-8\e[1m` from #68279), but the detector treats anything outside the canonical regex as malformed; the family is generative (per the #68285 synthesis comment) and we don't want to scope to one byte pattern.

When a malformed value is detected, the extension:

- Emits a stderr line: `[model-id-sanitize] malformed model_id detected: <hex-escaped representation> (mode=<warn|strip|block>)`.
- Stashes detection state on `ctx.meta._modelIdSanitize` for the per-session JSON spread.
- In `warn` mode: forwards the request unchanged.

### 2. Strip (opt-in via env var)

When `CACHE_FIX_MODEL_ID_SANITIZE=strip` and the detector fires, attempt recovery in **strict precedence order**. The original malformed value is preserved on `ctx.meta._modelIdSanitize.original` for telemetry in every recovery branch.

**Recovery order (closes Codex r1 B1):**

1. **Exact canonical full-ID recovery.** Extract the longest substring of `body.model` that matches the canonical regex from §1. If a complete canonical ID is recoverable from inside the malformed value (e.g. `claude-fable-5\e[1m` → `claude-fable-5`, `claude-opus-4-8\e[1m\e[22m` → `claude-opus-4-8`), rewrite `body.model` to that recovered ID. This is the load-bearing path because it preserves the operator's actual intent. Set `ctx.meta._modelIdSanitize.recovery = "exact-canonical"`.

2. **Family-root fallback.** If exact canonical recovery fails AND a single recognizable family root substring (`opus`, `sonnet`, `haiku`, `fable`, `mythos`) appears in the value, rewrite `body.model` to a pinned safe target per the family-fallback map below. Set `ctx.meta._modelIdSanitize.recovery = "family-fallback"`.

3. **No-confidence fallthrough.** If exact canonical recovery fails AND the family-root substring is missing OR multiple family-root substrings are present, fall through to `block` mode behavior for that request (see §3). Set `ctx.meta._modelIdSanitize.recovery = "no-confidence-blocked"`.

**Family-fallback target map** (used only when exact canonical recovery fails). **Selection rationale: oldest in-family wire ID** — not "cheapest" (Codex r1 B2 correctly noted Anthropic's current pricing puts Opus 4.6/4.7/4.8 at the same `$5/$25` MTok point, so picking 4.6 over 4.8 is a *capability downgrade at the same price*, not a cost saving). The "oldest in-family" rationale is "minimize accidental upgrade from the operator's intent" — if the operator's config got corrupted, they almost certainly intended what they'd been using, which was the variant available before the latest in-family release. Fable / Mythos targets are an **availability** fallback (both currently suspended per Anthropic's 2026-06-12 notice), not cost-driven.

  ```
  opus     → claude-opus-4-6        (oldest current Opus; same price as 4.7/4.8)
  sonnet   → claude-sonnet-4-6      (oldest current Sonnet; same price as 4.7)
  haiku    → claude-haiku-4-5-20251001
  fable    → claude-sonnet-4-6      (Fable suspended 2026-06-12; cross-family availability fallback)
  mythos   → claude-sonnet-4-6      (Mythos suspended 2026-06-12; cross-family availability fallback)
  ```

The wire-format rewrite is deliberately conservative: when the operator's intent is unrecoverable, the family-fallback target prefers staying in the operator's intended family at the oldest available wire ID over guessing the latest. Cross-family availability fallback (Fable/Mythos → Sonnet) is the only path where this directive crosses families; it's a forced choice when the requested family isn't available at all.

**Operator-tradeoff caveat (closes Codex r1 attention).** In `strip` mode, when exact-canonical recovery fails and the family-fallback path fires, the operator may get a materially different model than they intended. This is acceptable only as an explicit opt-in: `strip` mode is not the v1 default precisely because the family-fallback path can choose wrong. Operators flipping `CACHE_FIX_MODEL_ID_SANITIZE=strip` are attesting they prefer wrong-but-bounded over wrong-and-most-expensive. The CHANGELOG must call this out so the attestation contract is explicit.

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

- The synthetic response is delivered via the existing `pre.handled = true` short-circuit shape from `onRequest`. **Precedent: `image-retry-circuit-breaker.mjs:249-268`** returns `{skip: true, status, headers, body}` and the server short-circuits via `proxy/server.mjs:88-95` (the actual client write site; `:118` is the outer `if (pre.handled)` guard). For non-streaming requests the body is the JSON envelope above; for `stream: true` requests, the response is an SSE-formatted equivalent (same pattern image-retry uses) so CC's parser doesn't choke. No new pipeline plumbing required.

**Block-mode honest safety statement (closes Codex r1 B3).** The existing `image-retry-circuit-breaker` precedent at `:249-268` proves the **skip-result plumbing and SSE string passthrough** work, but it synthesizes `200` success envelopes, not HTTP `400`s. We do not have an existing messages-route precedent for a proxy-synthesized streaming `400`. CC's handling of an unexpected proxy-generated 4xx on a streaming request is **untested**, and the prior directive's citation of #59843 / #68284 as evidence was wrong (#59843 is a plan-approval permission bug, #68284 is quota/rate-limit resume — neither documents proxy-synthesized-error behavior).

The block-mode value proposition is "convert a deterministic billing event into a stuck session," which is safer than the bug's current behavior **only if** the stuck session is the strictly-worse outcome (which we believe but have not measured). The implementation PR MUST add `needs-sim-validation` as a merge gate and demonstrate, against real CC traffic on both `stream: true` and `stream: false` paths, that:

1. CC surfaces the `400 model_not_found` to the operator (not silently retry-loop).
2. The session can be recovered by the operator running `/model <valid-id>` (the path the error message instructs).
3. The synthetic SSE 400 doesn't trigger a worse failure mode than the underlying billing event (e.g. infinite retry storm, crashed harness).

If sim-validation surfaces a worse failure mode, `block` mode is gated until upstream picker behavior is fixed.

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
- In `block` mode (or `strip`-mode no-confidence fallback), the extension returns `{ skip: true, status: 400, headers, body }` from `onRequest`. The actual client write happens in `proxy/server.mjs:88-95` (the `if (skipResult && skipResult.skip)` branch in `preForward`); `server.mjs:118` is the outer `if (pre.handled)` guard the server checks after `preForward` returns. Mechanism precedent: `image-retry-circuit-breaker.mjs:249-268` (note: that precedent returns `200` success envelopes, not `400`s — the 400 streaming path is gated on `needs-sim-validation` per §3).

### Writer side — `proxy/extensions/cache-telemetry.mjs`

One-line spread addition to the per-session JSON build at `cache-telemetry.mjs:392-427` (corrected from r1's wrong `:225-261` anchor per Codex r1 B4; `:225-261` on current `main` is inside header parsing), between the `_auto1mGuard` spread and the model-divergence spread:

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

**Recommendation: #2.** Add the shared helper as part of this directive's implementation PR; `cache-telemetry.mjs`'s existing inline family map (introduced in PR #225) is refactored on the way in to import the same source of truth. This is a small refactor (~10 LOC delta in `cache-telemetry.mjs`) and the load-bearing maintenance benefit — one place to update on every model-roster change — is worth it. **Preserve the substring-match behavior** of the post-#225 inline map at `cache-telemetry.mjs:48-65`: the current implementation intentionally catches dated variants (e.g. `claude-haiku-4-5-20251001` matched via the shorter `haiku` family token), and the shared helper must keep that semantics so #225's served-model divergence detector continues to classify dated point-release IDs correctly.

If the implementation review surfaces friction with #2 (e.g. circular-import concerns we don't anticipate), the impl PR may fall back to #1 with a tracking issue for the consolidation. Reviewer judgment.

## Test plan

- `test/proxy-model-id-sanitize.test.mjs` (new file):
  - **Mode `off` default:** any body shape (clean OR malformed) → no `_modelIdSanitize` stash, no body mutation, no log, no spread.
  - **Mode `warn`, clean model id** (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `claude-fable-5`, `claude-mythos-2`) → no `_modelIdSanitize.malformed`, no spread. Per §1 the validator REJECTS the trailing-`[1m]` form (`auto-1m-guard:11-12` documents CC strips it before the wire), so `claude-opus-4-7[1m]` MUST be treated as malformed if it ever appears on outbound `body.model`.
  - **Validator boundary cases**: bare family token (`opus`), double-hyphen (`claude--oops`), no `claude-` prefix (`opus-4-7`), uppercase byte (`Claude-Opus-4-7`) all REJECTED.
  - **Mode `warn`, `claude-fable-5\e[1m\e[22m` (the exact byte sequence from #68285)** → `malformed: true`, original preserved, `body.model` UNCHANGED, stderr line emitted (capture via stream redirect), spread populated.
  - **Mode `warn`, `claude-opus-4-8\e[1m\e[22m` (from #68279)** → same.
  - **Mode `strip`, `claude-fable-5\e[1m\e[22m`** → exact-canonical recovery extracts `claude-fable-5`; `body.model` rewritten to `claude-fable-5` (operator intent preserved); `model_id_corrections_count` incremented; `recovery: "exact-canonical"`.
  - **Mode `strip`, `claude-opus-4-8\e[1m\e[22m`** → recovered to `claude-opus-4-8`; same shape.
  - **Mode `strip`, recoverable-but-no-canonical** (e.g. `opus\e[1m]` where there is no full canonical ID inside) → family-fallback rewrites to `claude-opus-4-6`; `recovery: "family-fallback"`.
  - **Mode `strip`, no-confidence multi-root** (string containing both `opus` and `sonnet` substrings, no exact canonical) → falls through to `block` (synthetic 400 short-circuit).
  - **Mode `strip`, fable family-fallback** (`fable\e[1m]` with no full canonical inside) → rewritten to `claude-sonnet-4-6` (suspended cross-family availability fallback).
  - **Mode `strip`, unrecoverable malformation** (random bytes, no recognizable substring) → falls through to `block`.
  - **Mode `block`, any malformed input** → `{ skip: true, status: 400, body }` returned from `onRequest`; body shape matches the schema in §3; SSE variant produced for `stream: true` requests.
  - **Mode `block`, clean input** → no short-circuit; pipeline continues normally.
  - **Hex-escape format** in persisted JSON matches `\\x1b\\x5b\\x31\\x6d` shape (NOT raw `\e[1m`).
  - **Failure isolation**: detector wrapped in try/catch; thrown exceptions don't break the pipeline (the regex shouldn't throw, but the catch is mandatory per directive's NFR section).
  - **Unknown mode** (e.g. `CACHE_FIX_MODEL_ID_SANITIZE=lol`) → falls back to `off` behavior, one stderr warning on first invocation.
- Integration test (extend `test/proxy-cache-telemetry.test.mjs`): synthesize a request with `body.model: "claude-fable-5\e[1m"` and the env var set to `warn`, drive through the pipeline, assert the per-session JSON carries the spread fields at the corrected `:392-427` site.
- Family-map source-of-truth test (`test/model-families.test.mjs`, new file): every family root in the map has a non-empty `cheapestTarget`; targets are well-formed canonical model IDs matching the §1 validator regex.

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

## Reviewer checklist (cache-fix side)

- [ ] **Validator regex** matches the canonical wire shape `^claude-[a-z][a-z0-9]*(-[a-z0-9]+)+$` — accepts every current canonical ID, rejects bare family tokens, double-hyphens, uppercase, and the `[1m]` suffix (which `auto-1m-guard:11-12` documents CC strips before the wire).
- [ ] **Strip recovery precedence** is strictly: (1) exact canonical full-ID recovery, (2) family-root fallback, (3) no-confidence → `block`. Tests pin each branch via `recovery: "exact-canonical" | "family-fallback" | "no-confidence-blocked"` discriminator on `ctx.meta._modelIdSanitize`.
- [ ] **Family-fallback rationale** in CHANGELOG + code comments calls out **"oldest in-family"** (not "cheapest"), with the Anthropic-pricing-table reality cited so a future reader doesn't re-litigate.
- [ ] **Block-mode safety**: implementation PR carries `needs-sim-validation` label and demonstrates against real CC traffic on both `stream: true` and `stream: false` paths that (a) CC surfaces the 400 to the operator, (b) the session is recoverable via `/model <valid-id>`, (c) no worse failure mode than the billing event (no retry storm, no harness crash).
- [ ] **File:line anchors** correct against current `main` HEAD at commit time: `cache-telemetry.mjs:392-427` (per-session JSON build), `server.mjs:88-95` (synthetic-response write site, NOT `:118`), `image-retry-circuit-breaker.mjs:249-268` (200-shape precedent, with the explicit caveat that this directive's 400 path is the first proxy-synthesized streaming 4xx and needs validation).
- [ ] **Shared family helper** `proxy/model-families.mjs` exists, exports both the canonical-id→family map (consumed by `cache-telemetry.mjs`'s served-model divergence detector, replacing the inline map at the post-#225 site) AND the family-root→fallback-target map (consumed by this extension). One source of truth on every model roster change.
- [ ] **Hex-escape format** for `model_id_malformed_last_value_hex` is `\\x1b\\x5b\\x31\\x6d` shape; never raw `\e[1m` bytes (terminal-safety hygiene).
- [ ] **Operator-attestation caveat** for `strip` mode is in the CHANGELOG: family-fallback path can choose wrong; flipping `=strip` is an explicit attestation of preference for wrong-but-bounded over wrong-and-most-expensive.
- [ ] **Failure isolation** test: regex thrown exception (synthetic) → pipeline continues; `ctx.body.model` unchanged; no `_modelIdSanitize` stash; `[model-id-sanitize] detector error: <msg>` stderr.
- [ ] **Unknown mode** test: `CACHE_FIX_MODEL_ID_SANITIZE=lol` → falls back to `off`; one stderr warning on first invocation; no per-request warning spam.
- [ ] **Load-bearing? Yes** — Chris human review required on both this directive PR AND the implementation PR.

## Out of scope (explicit)

- **Fixing CC's picker.** That's the upstream root cause; structural fix lives there (#68279).
- **Statusline render of malformed-id state.** Future work; sequence as a follow-up after PR #225's served-model divergence indicator surfaces in the statusline, using the same conditional render block pattern.
- **Auto-cleanup of `~/.claude/settings.json`.** The proxy does not touch the user's filesystem outside its own dirs. Operator hand-cleans, per the synthetic-400 error message text.
- **Detection on non-`model` fields.** Only the body `model` field is in scope; other fields might also have similar UI-leak risks but those need their own surveys.
- **Detection on response-side `model` field.** That's PR #225's territory (the served-model divergence detector compares request body `model` to `event.message.model`).
- **Default flip of `CACHE_FIX_MODEL_ID_SANITIZE` to `warn` or `strip`.** Out of scope for this directive's first ship; the v2 default flip is a separate directive after live-data review of the prevalence rate.

— AI Team Lead
