# Directive: auto-1m-guard — proxy extension to warn/strip implicit 1M context selection

**Status:** directive draft for issue #179. Tracks [anthropics/claude-code#64919](https://github.com/anthropics/claude-code/issues/64919) (VS Code Extension v2.1.161 forces 1M context on Pro Plan without request, immediately throws usage-credits error).
**Author:** Proxy Builder. AITL's tracking-issue scope sketch was the starting point; this directive revises it after a binary-walk of CC's 1M-context plumbing.
**Surface:** proxy extension. Outbound request modification (`onRequest`).

## Pre-work — binary-walk of CC's 1M-context wire shape

Per the prior commitment when this issue was queued, before scoping the extension I walked the CC binary to confirm exactly what the proxy can see on the wire. **Verified against both v2.1.148 (the version installed at the time of the initial walk) and v2.1.161 (current at time of directive submission).** Mangled identifiers churn between minified releases — same code body, different short names — so this section cites both. Future re-verifications should look up the new short names by code-body signature, not by name.

| What | 2.1.148 name | 2.1.161 name | Body (unchanged across both) |
|---|---|---|---|
| Model `[1m]/[2m]` sanitizer | `sL(H)` | `kJ(H)` | `return H.replace(/\[(1\|2)m\]/gi, "")` |
| 1M-beta gate (decides whether to add `long_context` beta) | `W2(H)` | `bZ(H)` | `if (kill()) return !1; return /\[1m\]/i.test(H)` |
| Kill-switch helper | `xKH()` | `E9H()` | `return mH(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)` |

The header value (`context-1m-2025-08-07`) and behavior are unchanged across the 13 versions in between. Findings change the directive's scope from AITL's initial sketch:

### What the binary actually does

CC's binary represents 1M-context as a string suffix on the model identifier — `claude-opus-4-7[1m]`, `claude-sonnet-4-6[1m]`, etc. That suffix is the load-bearing signal **inside CC**, but the outbound API request body **does not carry it**.

The relevant code (offsets cited from CC v2.1.148 `claude.exe`; equivalent code present in v2.1.161 under the renamed identifiers in the table above):

1. **Beta-flag enablement** (offset ≈ 220545):
   ```js
   uF = kJ("long_context", "context-1m-2025-08-07")
   ```
   `uF` is the JS variable for the long-context beta. Its wire form is the `anthropic-beta` header value `context-1m-2025-08-07`.

2. **Decision: add `uF` to the betas list** (offset ≈ 221302):
   ```js
   i76 = T8((H) => {
     let $ = [];
     ...
     if (W2(H)) $.push(uF);     // ← 1M beta added when W2() returns true
     ...
   })
   ```

3. **`W2()`: the model→1M-beta decision** (offset ≈ 221296):
   ```js
   function W2(H) {
     if (xKH()) return !1;       // kill switch
     return /\[1m\]/i.test(H);   // model string contains [1m]
   }
   function xKH() {
     return mH(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT);
   }
   ```

4. **Model-string sanitizer applied to the outbound request** (offset ≈ 220563):
   ```js
   function sL(H) { return H.replace(/\[(1|2)m\]/gi, ""); }
   ```
   `sL` is then applied at every `messages.create` call site that sends the request to Anthropic. The non-streaming path (offset ≈ 231242):
   ```js
   beta.messages.create({...J, model: sL(J.model)}, ...)
   ```
   And the streaming path (offset ≈ 231250–231253): `R8 = NH(H8); ... R8.model = sL(...)` — same sanitizer.

### What this means for the proxy

- **The outbound `model` field never contains `[1m]`.** CC strips the suffix client-side before the request leaves. A proxy extension that looks for `[1m]` in `req.body.model` will find nothing — that signal is purely internal to CC, never on the wire.
- **The actual outbound signal is the `anthropic-beta` request header containing `context-1m-2025-08-07`.** That string is what the proxy can observe and modify.
- **CC's existing kill switch is `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`** (env var, binary-verified). AITL's tracking note flagged that this env var is **unreliable on the VS Code extension surface** — presumably the extension doesn't propagate the env var to the spawned CC process. The proxy intervention bypasses that gap by acting on the wire regardless of which CC launcher / extension produced the request.
- **There's also a `[2m]` suffix in the sanitizer regex** (`/\[(1|2)m\]/gi`). That implies a 2M-context tier somewhere in CC's plans, but I didn't find any current `W2`-equivalent gating for it. Not in scope here; flagging for awareness.

### Implication for AITL's "if Pro account" condition

AITL's tracking-issue scope conditioned the warn/strip behavior on "the account's Q5h cache-state shows `subscription_tier: pro`." Cache-fix does **not currently classify subscription tier** in its quota-status parser — there's no `subscription_tier` field today. We'd either need to (a) build tier-classification infrastructure first (separate scoped work), (b) drop the conditional and apply unconditionally (riskier on Max accounts where the user genuinely wants 1M), or (c) gate on user config alone (env var / settings.json) and not try to detect tier.

This directive picks **(c)**: gate purely on user opt-in. Warn-mode is on by default and is harmless on any tier (it's an annotation, not a request change); strip-mode is explicit opt-in and the user is responsible for knowing whether they want 1M or not. Tier-classification stays a separate future workstream if we decide it's worth building.

## Scope

A new proxy extension `auto-1m-guard` that operates on outbound requests:

| Mode | env var | Behavior |
|---|---|---|
| `off` | `CACHE_FIX_AUTO_1M_GUARD=off` | Extension no-op; request passes unchanged. |
| `warn` (default) | unset or `CACHE_FIX_AUTO_1M_GUARD=warn` | Detect `context-1m-2025-08-07` in the outbound `anthropic-beta` header. If present, stash `ctx.meta._auto1mGuard = { auto_1m_detected: true, auto_1m_action: "warn", auto_1m_advice: <text> }` and write a one-line stderr message visible in proxy logs. That line is latched to the first detection for the LIFE OF THE PROCESS — the advice never changes, so repeating it per request buries the log. The latch is registry-keyed on `globalThis`, so an extension reload does not re-arm it. Do not modify the request. |
| `strip` (opt-in) | `CACHE_FIX_AUTO_1M_GUARD=strip` | Detect AND remove `context-1m-2025-08-07` from the `anthropic-beta` header before the request goes out. Stash the same flat object with `auto_1m_action: "stripped"`. |

The session-JSON annotation lives at `ctx.meta._auto1mGuard`, written by the cache-telemetry extension's existing spread-into-JSON pattern (the same channel session-health and thinking-block-sanitize already use).

### Detection mechanism

The outbound `anthropic-beta` request header is a **comma-separated** list of beta tokens (e.g. `claude-code-20250219,oauth_auth,interleaved-thinking-2025-05-14,context-1m-2025-08-07,...`). Detection:

1. Read the `anthropic-beta` header value from the outbound request.
2. Split on `,`, trim whitespace per token.
3. Check whether `context-1m-2025-08-07` is present in the token set.
4. If present → emit signal per mode.

In `strip` mode: remove the token, rejoin the remaining tokens with `,`, and set the modified header on the outbound request. If the header becomes empty after removal, leave it as an empty string rather than deleting it (preserves the Anthropic SDK's idempotency over the request shape).

### Warning text and session-JSON handoff contract

**Handoff shape**: the extension stashes a **flat object** at `ctx.meta._auto1mGuard` whose keys get **spread top-level** into the session JSON by cache-telemetry. This matches the established selective-spread pattern in `proxy/extensions/cache-telemetry.mjs` lines 232-238 — same channel as `_sessionHealth` and `_thinkingSanitize`. The leading underscore on `_auto1mGuard` keeps it namespaced within `ctx.meta` for inter-extension safety; the **keys inside the stashed object should be the final session-JSON field names**, so prefix them with `auto_1m_` to keep them disambiguated at top level.

When `warn` mode fires, `ctx.meta._auto1mGuard` is set to:

```js
{
  auto_1m_detected: true,
  auto_1m_action: "warn",
  auto_1m_advice: "Outbound request carries the context-1m-2025-08-07 beta header, which enables 1M context. On Pro plans this consumes overage credits immediately. To prevent CC from auto-selecting 1M: set CLAUDE_CODE_DISABLE_1M_CONTEXT=1 in your env, or use /model with a non-[1m] model variant in-session. Strip mode (CACHE_FIX_AUTO_1M_GUARD=strip) intercepts the header at the proxy."
}
```

Which gets spread by cache-telemetry into the session JSON:

```json
{
  ...other top-level fields...,
  "auto_1m_detected": true,
  "auto_1m_action": "warn",
  "auto_1m_advice": "Outbound request carries..."
}
```

In `strip` mode the same shape applies with `auto_1m_action: "stripped"`. When the extension is `off` or no `context-1m-*` token is present, **do not stash anything** — the spread is `...(ctx.meta._auto1mGuard || {})`, so absent fields stay absent in the JSON.

Stderr message (single line):
```
[auto-1m-guard] context-1m-2025-08-07 detected in outbound betas — see CACHE_FIX_AUTO_1M_GUARD=strip to intercept. Set CLAUDE_CODE_DISABLE_1M_CONTEXT=1 to prevent CC from sending it.
```

### Strip-mode rewrite contract — whitespace policy

The `anthropic-beta` header is a comma-separated list. CC's outbound form uses `, ` (comma + space) as the separator. Real-world parsers tolerate either `,` or `, ` between tokens. For the strip operation, **the directive blesses whitespace normalization**: after removing the matched token, rejoin remaining tokens with `, ` (the CC-canonical separator), trim the result. Trailing/leading whitespace around the whole header value is collapsed.

Rationale: (a) `anthropic-beta` does not carry trailing-whitespace semantics — the API parses tokens, not whitespace. (b) Normalizing to `, ` matches what CC itself would have produced for the post-strip header, so the downstream wire shape is indistinguishable from "CC originally sent fewer betas." (c) Preserving the exact original whitespace would require remembering the original separator string per-position, which is fragile and adds complexity for no observable benefit. The threat-model line about "preserve surrounding whitespace shape that's load-bearing for the wire format" applies if a header has wire-significant whitespace; `anthropic-beta` does not, so normalization is the right default here.

## Out of scope

- **Tier-classification (Pro vs Max5 vs Max20).** Cache-fix has no subscription_tier field today. AITL's "if Pro" conditional is unimplementable without new infrastructure. Drop the conditional; users opt in to strip mode if they want it. Separate workstream if we decide tier classification is worth building.
- **Detecting `[1m]` in `req.body.model`.** That field is sanitized by CC's `sL()` before the request leaves; the suffix is never on the wire. The proxy must operate on the beta header.
- **Reaching into CC to set `CLAUDE_CODE_DISABLE_1M_CONTEXT`.** The proxy can't set env vars in the CC process. The advice text points the user at the CC-side lever.
- **`[2m]` / `context-2m-*` betas.** The sanitizer covers `[2m]` but I didn't find an active gate. Scope to `[1m]` here; revisit if 2M ships.
- **The session-startup model warning.** AITL noted yurukusa's `cowork-model-picker-advisor` warns when `$ANTHROPIC_MODEL` carries `[1m]` at session-start. That's a SessionStart hook, complementary to this proxy guard. Different surface, different directive; not bundled here.
- **Convincing CC to not auto-select 1M.** Upstream's job (CC#64919).

## Implementation notes

- New file: `proxy/extensions/auto-1m-guard.mjs`. Pattern matches existing extensions (e.g. `proxy/extensions/thinking-block-sanitize.mjs`): default-export the extension object with `enabled: true`, `order: <position>`, `onRequest` handler. Runtime gating via env var, not via `enabled` field — same as the established pattern (see `feedback_extension_activation_pattern` memory).
- **Order placement**: this runs `onRequest` before the request goes to upstream. Should fire before any other extension that depends on the final beta header. Look at the existing order numbers and pick a slot in the 400–500 range (between body-shape changes and the final outbound preparation). The cache-telemetry writer at order 600 spreads `ctx.meta` into the JSON write — auto-1m-guard's annotation needs to be set before that.
- **Header-name casing**: HTTP headers are case-insensitive but the proxy normalizes them; check whether the proxy gives extensions a case-canonicalized view of headers, and access accordingly. (The bootstrap-defense and rate-limit-log extensions already operate on outbound headers — use the same access pattern.) Specifically, `proxy/extensions/upstream-change-detection.mjs` already has a case-insensitive / whitespace-tolerant `anthropic-beta` extraction pattern (~lines 195-207); mirror it here so the header reader is robust without inventing a new abstraction.
- **Empty-list edge case**: if the request has only `context-1m-2025-08-07` in `anthropic-beta` (a one-element list), strip mode should leave the header as `""` (empty string), not delete the header entirely. Matches CC's request shape post-strip.
- **No body inspection needed.** The extension only reads/writes the `anthropic-beta` request header. No body parsing, no streaming pipeline involvement.

## Test plan

`test/proxy-auto-1m-guard.test.mjs`. Unit tests over a pure helper plus integration tests over the extension:

| Case | Mode | Expected |
|---|---|---|
| Header carries `context-1m-2025-08-07` among other tokens | `warn` | Header unchanged; `ctx.meta._auto1mGuard.auto_1m_detected = true`, `auto_1m_action = "warn"` |
| Header carries `context-1m-2025-08-07` among other tokens | `strip` | Token removed; remaining tokens rejoined with the canonical `, ` separator preserved in order; `auto_1m_action = "stripped"` |
| Header is exactly `context-1m-2025-08-07` (single-element) | `strip` | Header becomes empty string (not deleted); `auto_1m_action = "stripped"` |
| Header does not carry `context-1m-2025-08-07` | `warn` | No annotation; no log line |
| Header does not carry `context-1m-2025-08-07` | `strip` | No annotation; no header change |
| No `anthropic-beta` header at all | `warn` | No annotation (nothing to flag) |
| Mode `off` even with header present | `off` | No annotation; no change |
| Token with surrounding whitespace (e.g. `context-1m-2025-08-07 `) | `strip` | Detected and removed (whitespace-tolerant) |
| `context-1m-` substring in a different token (defensive — no other tokens currently match, but verify the check is exact-token not substring) | any | No false positive |
| `anthropic-beta` carries `context-1m-2025-08-07` repeated twice (defensive — pin strip semantics if upstream or an intermediary ever duplicates the token) | `strip` | All occurrences removed; `auto_1m_action = "stripped"`; remaining tokens preserved |

Plus a small unit test over the helper that builds the modified header value, to lock the comma-join behavior.

## Documentation

- New `docs/extensions/auto-1m-guard.md` (or update an extensions-index if one exists) — describe modes, env var, what gets detected and why, the binary-walk findings (or link to this directive).
- README.md mention under the appropriate section.
- CHANGELOG entry on release.

## Non-Functional Requirements

- **Size/complexity budget:** extension ≤ 80 LOC, test ≤ 200 LOC, docs page ≤ 100 LOC. Total ≤ ~400 LOC.
- **Threat model:** the extension reads and modifies an outbound HTTP request header. Mis-modification could break unrelated betas. The strip operation must (a) match `context-1m-2025-08-07` as a whole token, not substring, (b) preserve order of remaining tokens, (c) preserve any surrounding whitespace shape that's load-bearing for the wire format. False-positive class: stripping a token the user actually wants. False-negative class: failing to detect a malformed-but-CC-emitted variant of the token. The directive's detection is exact-token on the standard form, which is what CC's `kJ("long_context","context-1m-2025-08-07")` produces.
- **Maintainability constraints:** single-purpose extension. No new abstractions for header manipulation; inline the split/filter/join. If a second beta-header-aware extension ships later, refactor at that point.
- **Performance/reliability:** runs on every outbound request. Cost is one header read + one string split + one set lookup. Sub-millisecond. No I/O.
- **Load-bearing? Yes.** Modifying outbound request bytes is a wire/schema contract change per CLAUDE.md, and the change has billing implications (preventing or allowing 1M-context credit consumption). Per CLAUDE.md, load-bearing changes require Chris human review before merge in addition to Lead + Codex.

## Open questions for review

1. **`warn` as default — is the annotation-and-log signal enough, or should warn also be a no-op by default and require opt-in?** Argument for warn-by-default: the annotation is harmless (no request mutation), it gives users observability without surprise behavior, and the entire population on Pro plans currently has this problem invisibly. Argument against: more noise in session-JSON for users who don't care. Lean toward warn-by-default; documented mode env var lets users go full off.
2. **Should the directive add a `block` mode that short-circuits with a 400 the way bootstrap-defense's block mode does?** Argument against: it would prevent the user's session from working entirely, which is worse than the overage. Argument for: it'd be the absolutely deterministic "don't let this happen" lever. Lean against; strip mode is the right "intervene" lever, warn is the right "observe" lever.
3. **The `[2m]` futureproofing.** Code the strip-mode regex to handle either `\[(1|2)m\]` form anticipating the 2M beta, or scope to 1m and rely on a future directive to handle 2m? Lean scope-to-1m; we don't know what beta token the 2M tier will use (CC has the sanitizer regex but no enabled gate yet).

## References

- Upstream: [anthropics/claude-code#64919](https://github.com/anthropics/claude-code/issues/64919) — VS Code extension forcing 1M on Pro
- Tracking: cache-fix #179
- cc-triage record: [cc-triage#447](https://github.com/cnighswonger/cc-triage/issues/447)
- AITL community-validation comment on #179 — yurukusa's `/model` workaround proof, env-var unreliability note, `cowork-model-picker-advisor` complementary hook
- Related upstream: [anthropics/claude-code#62199](https://github.com/anthropics/claude-code/issues/62199#issuecomment-4596902132) — yurukusa's documented workaround
- Existing pattern: `proxy/extensions/bootstrap-defense.mjs` (header-reading + mode-gated request modification), `proxy/extensions/thinking-block-sanitize.mjs` (annotation via `ctx.meta`)
