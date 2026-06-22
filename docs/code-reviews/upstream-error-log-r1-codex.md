# Review: upstream-error-log extension

Date: 2026-06-22
Reviewed: PR #240 (`feature/upstream-error-log`) at `00e85d50ea8b6ebca20a464a1e1abad2812fd084`
Round: 1
Label applied: approved-by-codex-agent

## What Is Correct

The implementation satisfies issue #235's main contract. `proxy/extensions/upstream-error-log.mjs:54` treats every numeric `status >= 400` as in scope, so it is not limited to the canonical `rate_limit_error` body envelope already covered by `rate-limit-log`.

The default-off posture is correct for a disk-writing diagnostic: `proxy/extensions.json:21` loads the extension, but the hook bodies no-op unless `CACHE_FIX_UPSTREAM_ERROR_LOG=on` is set (`proxy/extensions/upstream-error-log.mjs:152`, `proxy/extensions/upstream-error-log.mjs:171`). The stream is independent and writes to `~/.claude/usage-log/upstream-errors.jsonl`, with a path override only for tests (`proxy/extensions/upstream-error-log.mjs:44`).

The hook choice is correct. `proxy/server.mjs:156` calls `runOnResponseStart` before response body buffering/parsing, while `proxy/server.mjs:168` through `proxy/server.mjs:183` only calls `runOnResponse` after successful JSON parse. HTML, empty, or otherwise non-JSON 5xx/429 responses would be skipped by an `onResponse`-only implementation.

The `has_ratelimit_headers` discriminator is implemented as the load-bearing field (`proxy/extensions/upstream-error-log.mjs:73`). The `startsWith("anthropic-ratelimit-")` predicate correctly excludes unrelated Anthropic headers; the captured `test/fixtures/burst-limit-429.json` contains `anthropic-organization-id` but no `anthropic-ratelimit-*` keys, so the known burst fixture classifies as `has_ratelimit_headers: false`.

The overlap with `rate-limit-log` is intentional and non-corrupting. `rate-limit-log` writes only canonical 429 `rate_limit_error` bodies via `onResponse` to `rate-limit-events.jsonl` (`proxy/extensions/rate-limit-log.mjs:242`), while this extension writes all upstream errors via `onResponseStart` to `upstream-errors.jsonl` (`proxy/extensions/upstream-error-log.mjs:171`). They share only request metadata keys and do not mutate each other's output state.

The `_requestedModel` path is safe. `upstream-error-log` captures it only when gated on and does not clobber a pre-existing value (`proxy/extensions/upstream-error-log.mjs:160` through `proxy/extensions/upstream-error-log.mjs:164`). If both loggers are configured with their intended order, `rate-limit-log`'s order `660` precedes `upstream-error-log`'s order `670`; if a future config reverses them, `rate-limit-log`'s unconditional assignment remains pre-existing behavior (`proxy/extensions/rate-limit-log.mjs:231`).

Fail-open behavior is adequate. `onRequest` and `onResponseStart` wrap all extension-owned work in `try/catch`; failures from header enumeration, record construction, directory creation, append, or stringify do not escape the extension (`proxy/extensions/upstream-error-log.mjs:152` through `proxy/extensions/upstream-error-log.mjs:178`). The pipeline also catches hook failures at the extension boundary (`proxy/pipeline.mjs:118` through `proxy/pipeline.mjs:129`).

## Blockers

None.

## What Needs Attention

One small coverage gap remains: the predicate test covers 400/401/403/404, but the integration write-path tests cover 429 and 503 rather than a non-429 4xx. Given `isUpstreamError()` is deliberately simple and directly tested, I do not consider this blocking; adding one `onResponseStart` case for 401 or 403 would make the issue #235 "every non-200" promise even harder to regress.

The committed PR blob has `upstream-error-log` at order 670, but it does not add `usage-log` or `rate-limit-log` entries to `proxy/extensions.json`; those entries are local/operator configuration in this checkout. This is not a blocker because `upstream-error-log` captures its own requested model and the numeric order still sits after `rate-limit-log`'s module default order 660 if both are enabled.

## Bloat / Non-Functional

None. The extension is leaf-code, the helper seams are test-driven, and no shared abstraction was introduced where a local predicate was enough.

## Recommendations

Add a future low-cost test for an env-gated 401/403 write path if this file is touched again.

Keep `retry_after` as the raw header value. That preserves both integer-second and HTTP-date forms, which is more robust than coercing it to a number.

## Bottom Line

Approve. The implementation closes #235 with the intended independent JSONL stream, uses the correct response-start hook to avoid body-parse blind spots, correctly distinguishes usage-limit versus capacity-class 429s, and remains fail-open. Local verification passed: `node --test test/proxy-upstream-error-log.test.mjs` (`32/32`).

— Codex review
