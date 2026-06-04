# Review: PR #191 thinking-block-sanitize v2 directive rereview 3

Date: 2026-06-04
Reviewed: PR #191 directive (`docs/directives/proxy-thinking-block-sanitize-v2.md`) at `a16243e` (targeted correction pass against `017616c`)
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- The rereview diff is tightly scoped. `git diff 017616c a16243e -- docs/directives/proxy-thinking-block-sanitize-v2.md` changes exactly two paragraphs and nothing else in the directive.
- The session-id note is now factually accurate against current HEAD: `resolveSessionId` is currently a module-private helper in `proxy/extensions/cache-telemetry.mjs:59-67`, it is not exported today, and exporting it for v2 is correctly described as a one-line implementation change.
- The hash-helper rationale is now factually accurate against current HEAD: `sort-stabilization` at order 200 does make `body.tools` array order deterministic before v2 sees it (`proxy/extensions/sort-stabilization.mjs:34-36,60-61`), while `tool-input-normalize` operates on assistant `tool_use.input` keys inside `body.messages` and does not normalize tool-definition objects in `body.tools` (`proxy/extensions/tool-input-normalize.mjs:1-55,60-68`).
- The corrected language preserves the directive's intended design split: preserving `tools[]` array order remains a forward-compatibility rule, while recursive key sorting on tool-definition internals remains load-bearing work for arbitrary upstream tool schema shapes.
- No earlier directive-stage issues were reintroduced. The NFR section, 2xx-only baseline advance rule, oscillation test pin, and load-bearing classification remain intact from the prior approved scope.

## Blockers

None

## What Needs Attention

None

## Bloat / Non-Functional

None. The correction reduces ambiguity without widening the directive or adding unnecessary design surface.

## Size Baseline

- `docs/directives/proxy-thinking-block-sanitize-v2.md` — 215 LOC — implementation-ready directive; this round only corrects two factual notes.
- `proxy/extensions/cache-telemetry.mjs` — 267 LOC — confirms the current module-private `resolveSessionId` state and the order-600 writer seam.
- `proxy/extensions/session-health.mjs` — 152 LOC — still the relevant ordering precedent for request-hook vs stream-hook session access.
- `proxy/extensions/sort-stabilization.mjs` — 64 LOC — confirms the current upstream `body.tools` ordering guarantee.
- `proxy/extensions/tool-input-normalize.mjs` — 73 LOC — confirms normalization applies to `tool_use.input`, not tool-definition schema objects.

## Recommendations

- Proceed to implementation. The implementation PR should export and reuse `resolveSessionId` exactly as the corrected directive now specifies.

## Bottom Line

The two factual errors from the prior rereview are closed at `a16243e`, and the directive is back to being accurate and implementation-ready. Directive-stage approval is justified again.

— Codex review
