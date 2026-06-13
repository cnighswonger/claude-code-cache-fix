# Review: PR #228 `model-id-sanitize`

Date: 2026-06-13
Reviewed: implementation at `f366edb` against `docs/directives/proxy-model-id-sanitize.md` at `d9a4b9f`
Round: 1
Verdict: REQUEST_CHANGES
Label applied: changes-requested

## What Is Correct

- The canonical validator is the directive's regex verbatim at `proxy/extensions/model-id-sanitize.mjs:36`, and the unit suite covers the required accepted/rejected examples at `test/proxy-model-id-sanitize.test.mjs:38`.
- Strip-mode recovery precedence is implemented in the correct order in `classify()` at `proxy/extensions/model-id-sanitize.mjs:225` and dispatched correctly in `onRequest()` at `proxy/extensions/model-id-sanitize.mjs:284`.
- The block-mode short-circuit shape matches the established `{ skip, status, headers, body }` contract at `proxy/extensions/model-id-sanitize.mjs:148`, and the server write site is the expected `proxy/server.mjs:88`.
- Registration/order and telemetry composition points are in the right places: `proxy/extensions.json:3` installs the extension at order 50, and `proxy/extensions/cache-telemetry.mjs:415` spreads `_modelIdSanitize` between `_auto1mGuard` and `_modelDivergence`.
- The rationale and operator caveat text were carried through to the helper comments and changelog with the directive's `fallbackTarget` / "oldest in-family" framing (`proxy/model-families.mjs:14`, `CHANGELOG.md:7`).

## Blockers

1. `hexEscape()` does not satisfy the directive's "every byte" requirement. The implementation iterates JavaScript code points and emits `\\x` plus the code point hex (`proxy/extensions/model-id-sanitize.mjs:47`), so non-ASCII malformed values collapse to single escapes like `\\x1f600` instead of byte-wise `\\x??` sequences. On the PR tip, `__testOnly.hexEscape("😀")` prints `\\x1f600`, which violates the reviewer-checklist requirement at `docs/directives/proxy-model-id-sanitize.md:228` that the persisted/logged form be `\\x??` for every byte. This needs UTF-8 byte-wise escaping plus a regression test beyond the ANSI-only cases in `test/proxy-model-id-sanitize.test.mjs:354`.

2. The new `model_id_*` fields are not actually session-scoped; they disappear on the next clean turn. `buildStashAndSpread()` only runs when the current request is malformed (`proxy/extensions/model-id-sanitize.mjs:170`), while clean requests return before any `_modelIdSanitize` spread is attached (`proxy/extensions/model-id-sanitize.mjs:267`). `cache-telemetry` then rewrites the per-session JSON entirely from current-turn `ctx.meta` on every response (`proxy/extensions/cache-telemetry.mjs:381`). Reproducing this on the PR tip with one malformed `warn` request followed by one clean request in the same session yields a first session file with `model_id_malformed=true` and a second file where every `model_id_*` field is gone. That violates the persisted contract at `docs/directives/proxy-model-id-sanitize.md:129`, which defines these as session-level fields once any malformed value has been observed.

3. The shared helper does not classify the Opus fallback target it introduces. `proxy/model-families.mjs:43` sets Opus fallback to `claude-opus-4-6`, but `MODEL_FAMILIES` has no substring entry that matches `claude-opus-4-6`, so `modelFamily("claude-opus-4-6")` returns `"unknown"` on the PR tip. That breaks the advertised "single source of truth" composition with `cache-telemetry` at `proxy/extensions/cache-telemetry.mjs:117` exactly on the strip-mode fallback path this PR adds. Directive § Composition expects one shared helper to serve both the sanitize fallback map and PR #225's family classifier (`docs/directives/proxy-model-id-sanitize.md:170`); the current helper is incomplete for that path.

## What Needs Attention

- The directive's sim-validation checklist item remains open. The PR correctly carries `needs-sim-validation`, but I do not see a PR-228 sim artifact in `docs/release-tests/` or an attached PR comment demonstrating the `stream: true` / `stream: false` block-mode behavior required by `docs/directives/proxy-model-id-sanitize.md:225`.
- The failure-isolation checklist asks for a synthetic exception test (`docs/directives/proxy-model-id-sanitize.md:230`). The current suite covers null/numeric hostile shapes at `test/proxy-model-id-sanitize.test.mjs:372`, but it does not force the detector path to throw and prove the catch block's stderr/message contract.

## Bloat / Non-Functional

None.

## Recommendations

- Rework `hexEscape()` to encode the string to bytes first, then emit one `\\x??` escape per byte. Add at least one multibyte regression case so the directive's "every byte" contract is pinned in CI.
- Persist `_modelIdSanitize` as session state rather than current-turn state. The simplest acceptable fix is to keep a per-session summary map in the extension and attach the spread on later clean turns; a stronger fix is to rehydrate the prior session file the way `_modelDivergence` does.
- Extend `proxy/model-families.mjs` and its tests so every fallback target is also classifiable by `modelFamily()`, starting with `claude-opus-4-6`.
- Add the missing checklist coverage for the synthetic detector-throw path, and attach the required sim-validation evidence before clearing `needs-sim-validation`.

## Bottom Line

The main directive surfaces are in place, but three load-bearing contracts are still wrong on the implementation branch: byte-wise hex escaping, session-persistent `model_id_*` fields, and shared-helper classification of the new Opus fallback target. Those are not cosmetic gaps; they affect the persisted schema and the composition with the already-shipped divergence detector. This should not be approved in its current state.

— Codex review
