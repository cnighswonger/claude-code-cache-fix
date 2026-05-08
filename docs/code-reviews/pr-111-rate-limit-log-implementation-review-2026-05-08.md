# Review: rate-limit log implementation

Date: 2026-05-08
Reviewed: `3f416d6` (`proxy/extensions/rate-limit-log.mjs`, `test/proxy-rate-limit-log.test.mjs`, `docs/directives/proxy-rate-limit-logging.md`)
Label applied: changes-requested

## What Is Correct
- The extension is isolated and fail-open. `onResponse()` wraps record construction and append I/O in a top-level `try/catch`, so `mkdir`/`appendFile` failures do not break the proxy pipeline.
- Default-off activation is the right privacy posture for a disk-writing diagnostic. `enabled: false` plus explicit `extensions.json` opt-in matches the repo’s existing diagnostic pattern.
- Hook placement is coherent with the current proxy lifecycle. `proxy/server.mjs` only runs `onResponse` for buffered non-streamed JSON bodies, and the captured 88-event sample was entirely `application/json`, so there is no immediate need to add speculative SSE handling in this PR.
- The filesystem helpers are generally sound. Per-call `homedir()` resolution mirrors `cache-telemetry`, missing `sessions/` cleanly returns `0`, stale session files are excluded by mtime, and the seeded `account.json` integration test proves the Q5h read path works on a tmpdir-rooted `HOME`.
- Coverage is materially better than scaffold level. I reran the new suite and the full repo suite locally: `node --test test/proxy-rate-limit-log.test.mjs` passed 27/27, and `npm test` passed 764/764.

## Blockers
- `proxy/extensions/rate-limit-log.mjs:40-55` and `docs/directives/proxy-rate-limit-logging.md:87-100` claim that `status === 429 && body.error.type === "rate_limit_error"` distinguishes the burst/concurrency limiter from classic API rate limits. Anthropic’s public API docs do not support that assumption: the official errors page documents `429 -> rate_limit_error` generically, and the official rate-limits page says ordinary RPM/ITPM/OTPM limit hits also return `429` with a descriptive body and `Retry-After`. In other words, the current predicate is broad enough to match non-burst 429s too, so the JSONL this PR emits cannot be trusted as “burst-limit only” data. That is a data-quality blocker because this PR is explicitly the prerequisite logging substrate for the larger burst-handling design discussion. At minimum, the implementation and tests need to either: 1. narrow the predicate with an additional validated discriminator, or 2. explicitly redefine the feature as logging all `rate_limit_error` 429s and update the directive/schema/comments/tests to stop claiming burst-only semantics.

## What Needs Attention
- `proxy/extensions/rate-limit-log.mjs:83-91` bounds the persisted excerpt length, but it still materializes the full `JSON.stringify(body)` result before slicing. That protects disk growth, not peak memory, so `test/proxy-rate-limit-log.test.mjs:102-107` only proves truncation of the output string, not protection from a hostile multi-megabyte body allocation. I do not consider this release-blocking for a tiny 429 error body path, but the current wording overstates what is actually protected.
- `docs/directives/proxy-rate-limit-logging.md:51-54` says `q5h_pct_at_event` is fresh because `account.json` was “just written by cache-telemetry on the prior response.” That is directionally right but stronger than the real contract. On a failed non-streaming 429, the field is simply the most recent successfully persisted quota snapshot, which may be seconds or minutes old depending on traffic.
- A row-level format version would be cheap insurance. This file is meant for later operational analysis and already has feature-specific fields (`upstream_request_id`, `x_should_retry`); adding `schema_version: 1` would make future migration safer.

## Recommendations
- Resolve the predicate ambiguity before approval. If the team wants burst-only telemetry, validate and encode a discriminator that ordinary API 429s do not share, then add a regression test that models the documented non-burst 429 shape. If that discriminator does not exist today, change the contract text to “all upstream 429 rate_limit_error responses” and defer burst-vs-quota classification to later analysis.
- Tighten the directive and comments so they match the real guarantees: excerpt truncation bounds log size, not stringify allocation; `q5h_pct_at_event` is the latest cached quota snapshot, not necessarily a same-request reading.
- Consider adding `schema_version: 1` to each JSONL row before consumers begin depending on this format.

## Bottom Line
Revise before approval. The extension is otherwise well-contained, well-tested, and aligned with the proxy’s current hook model, but the central detection claim is not defensible against Anthropic’s documented 429 contract. Until the implementation either narrows that predicate or explicitly broadens the feature scope, the output file is too ambiguous to serve as reliable burst-limit evidence.
