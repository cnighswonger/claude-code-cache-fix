# Review: PR #233 pipeline cache-buster race fix

Date: 2026-06-15
Reviewed: PR #233 at `ef4c146cc435cf7eceb40b2ae4f70f5684a47254`
Round: 1
Label applied: approved-by-codex-agent

## What Is Correct

- The race fix is correctly scoped. `_loadCounter` is module-scope state in `proxy/pipeline.mjs`, and `loadExtensions()` increments it once before iterating extension files, so every reload gets a process-local unique import suffix without depending on wall-clock resolution (`proxy/pipeline.mjs:18`, `proxy/pipeline.mjs:33`, `proxy/pipeline.mjs:39`).
- Semantics are preserved for a single `loadExtensions()` invocation: all files loaded in one call share the same suffix because the counter is captured once before the loop, matching the prior coarse `Date.now()` grouping behavior (`proxy/pipeline.mjs:30-39`).
- The regression test is meaningful rather than tautological. It freezes `Date.now()`, imports v1, rewrites the same extension to v2, and asserts that the second `loadExtensions()` observes v2 (`test/proxy-pipeline.test.mjs:223-256`). Under the old `?t=Date.now()` implementation, both dynamic-import URLs would be identical while `Date.now()` is frozen, so Node's ESM cache returns the first module and the test fails.
- I verified the old failure mode directly with a temporary ESM import simulation: importing the same `file://.../ext.mjs?t=1700000000000` URL after rewriting the file still returned version 1 and `sameModule: true`.
- No code reads or exposes the buster value. The only production use is appended to the dynamic `import()` URL inside `loadExtensions()`; call sites in `proxy/server.mjs` and `proxy/watcher.mjs` only invoke `loadExtensions()` and do not observe the suffix.
- The counter has no practical wraparound concern. It is a JavaScript `Number`; even at 1000 reloads per second, reaching `Number.MAX_SAFE_INTEGER` is on the order of hundreds of thousands of years.

## Blockers

None.

## What Needs Attention

None.

## Bloat / Non-Functional

None.

## Recommendations

- Keep this as an internal helper-only fix. It does not affect the extension pipeline interface, telemetry format, config schema, wire behavior, or environment contract, so no load-bearing or schema-change treatment is needed.

## Verification

- `node --test test/proxy-pipeline.test.mjs` — 15/15 pass.
- `node --test test/proxy-pipeline.test.mjs test/proxy-server.test.mjs test/proxy-cache-telemetry.test.mjs` — 65/65 pass after installing the declared `hpagent` dependency in the isolated review worktree.

## Bottom Line

Verdict: APPROVE. The monotonic counter removes the same-millisecond dynamic-import cache collision while preserving the prior per-call grouping semantics, and the regression test would have failed against the old `Date.now()` implementation.

— Codex review
