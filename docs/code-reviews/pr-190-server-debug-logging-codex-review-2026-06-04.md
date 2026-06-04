# Review: PR #190 server.mjs debug logging

Date: 2026-06-04
Reviewed: PR #190 (`proxy/server.mjs`) at `2b7375911afcc2c4d60fce1a46173bf1693dce99`
Label applied: changes-requested

## What Is Correct
- The contribution targets the right surface: if server-side diagnostics belong anywhere, `proxy/server.mjs` is the natural place to add them.
- `debugLog()` itself is correctly gated on `config.debug`, so the intended opt-in control exists.
- `git diff origin/main -- proxy/server.mjs` shows the `/api/claude_cli/bootstrap` route is not a duplicate addition versus current `main`; the route already exists on `main`, and this PR only moves that existing branch inside the new wrapper.
- The existing server/bootstrap/embeddable tests still pass on the PR head, which means the patch does not break the established routing surfaces outright. The gap is that the new logging paths themselves are untested.

## Blockers
- `proxy/server.mjs:321-323` writes raw request headers to `~/.claude/cache-fix-debug.log`. On this proxy surface those headers can include `Authorization` / `x-api-key`, and the repo architecture docs explicitly say auth headers must never appear in logs. Redact or remove header dumps before merge.
- `proxy/server.mjs:29-37` emits nine `console.log` lines at module load, and `proxy/server.mjs:132,347,352-353` adds new ungated stderr logging. This changes import-time and production behavior even when `CACHE_FIX_DEBUG` is off; for an embeddable module, all debug surfaces need to stay gated.
- `proxy/server.mjs:317-359` does not actually provide the broad "catch unhandled request errors" behavior the new comment implies. `handleMessages()` and `handleBootstrap()` are `async`, but the server callback returns their promises without `await`, so rejections from those functions bypass this `try/catch` entirely. If unhandled-error containment is desired, it needs a promise-aware implementation and separate review.
- Much of the new diagnostic output is semantically wrong or misleading: `clientRes.url` / `clientRes.method` are not response fields (`proxy/server.mjs:111-112`), `upstreamRes.url` is the empty-string placeholder and `upstreamRes.method` is `null` on client-side `IncomingMessage` objects (`proxy/server.mjs:148-149`), and the `bytesWritten` values at `proxy/server.mjs:115,153` are socket-lifetime write counters, not per-response payload sizes. A debug feature whose output misstates the request/response shape is not ready to merge.

## What Needs Attention
- `proxy/server.mjs:328-335` monkey-patches `res.write`/`res.end` for every response even when debug is off. That is more than logging, and it adds overhead on the streaming hot path for no benefit in the default mode.
- `proxy/server.mjs:329` labels `chunk.length` as "bytes", but string chunks report code units, not byte length. Use `Buffer.byteLength()` or log chunk type plus length separately if this stays.
- `proxy/server.mjs:358-359` returns `error.message` in the 500 body. For a local loopback proxy the exposure is narrower than an internet-facing service, but standard practice is still to return a generic client message and keep internals in server-side logs only.
- The PR body is empty. For a contributor-facing process point I would not block merge on description alone, but a one-paragraph rationale would help reviewers distinguish "temporary diagnostic for reproducing X" from "new supported debug surface."
- The import block at `proxy/server.mjs:14-17` includes unused `node:fs` names and copies `util` in a style inconsistent with the rest of the file. That is minor, but it reinforces that the logging chunk was pasted in whole rather than tightened to the actual need.

## Bloat / Non-Functional
- `proxy/server.mjs:14-37` adds 24 lines of top-level logging/import boilerplate, but only `appendFileSync` is used. The unused `readFileSync` / `writeFileSync` / `mkdirSync` / `renameSync` names are removable immediately.
- `proxy/server.mjs:317-359` adds a whole-response wrapper and error-handling block to implement a logging feature. That is more surface area than the change requires, and most of it is unrelated to the core "write debug traces when opted in" goal.

## Size Baseline
- `proxy/server.mjs` — 355 LOC — central proxy request path; PR adds about 100 LOC concentrated at module init, `handleMessages()`, and `createProxyServer()`.
- `bin/claude-via-proxy.mjs` — 159 LOC — not changed by the PR, but relevant because proxy stdout/stderr semantics affect wrapper startup behavior.
- `test/proxy-server.test.mjs` — 64 LOC — current routing smoke tests; no coverage for the new logging behavior.
- `test/proxy-server-bootstrap.test.mjs` — 283 LOC — current bootstrap routing coverage; likewise does not exercise the new logging surfaces.
- `test/proxy-server-embeddable.test.mjs` — 67 LOC — confirms embeddable import/start behavior, which the new top-level logs now perturb.

## Recommendations
- Narrow this PR back to opt-in diagnostics: gate every log surface on `config.debug`, avoid top-level stdout/stderr, and remove any behavior changes not required for logging.
- If request/response metadata logging stays, redact `authorization`, `x-api-key`, cookies, and any other auth-bearing headers before writing anything to disk.
- Either drop the request-handler catch entirely from this PR or rework it into a promise-aware pattern such as `void handleMessages(req, res).catch(...)`, with a generic client-facing 500 body and its own targeted tests.
- Replace the current response-field logging with values that are actually meaningful on the relevant objects: request method/url from `clientReq`, response status/statusMessage from the response objects, and byte counts derived from the chunks actually written/read rather than socket lifetime counters.
- Add minimal regression tests for the new surface:
  1. Importing `proxy/server.mjs` with `CACHE_FIX_DEBUG` unset must produce no stdout/stderr.
  2. With debug on, the written log must redact auth-bearing request headers.
  3. If write/end wrapping remains, debug-off mode must leave the default response path untouched, and debug-on mode must log chunk activity without misreporting byte counts.
  4. If a top-level request-handler catch remains, a forced rejected promise from the route path must take the intended generic failure path; otherwise the test should be removed because the wrapper is not load-bearing.

## Bottom Line
Revise before merge. The contribution's goal is useful and the bootstrap route is not duplicated, but the current patch mixes ungated I/O, secret-bearing header logging, misleading diagnostics, and a request-handler catch that does not actually catch the async failures it advertises. I would welcome a narrowed follow-up that keeps the good diagnostic intent while staying opt-in, redacted, and behavior-preserving. — Codex review
