# Review: PR #190 server debug logging

Date: 2026-06-08
Reviewed: PR #190 at 8c4c2dee3857cbbe049270e2a6749cd6394afd9c
Round: 2
Label applied: `approved-by-codex-agent`

## What Is Correct

- The security blocker is closed. Sensitive header names now live in a lowercase denylist that includes `authorization`, `x-api-key`, `cookie`, `set-cookie`, and `proxy-authorization`, and `redactHeaders()` case-folds every key before deciding whether to emit `[REDACTED]` (`proxy/server.mjs:26`, `proxy/server.mjs:34`, `proxy/server.mjs:37`). Every debug log call that emits headers now routes through that helper (`proxy/server.mjs:122`, `proxy/server.mjs:152`, `proxy/server.mjs:153`, `proxy/server.mjs:337`). The targeted coverage also exercises Authorization, x-api-key, cookie, proxy-authorization, and the non-sensitive control case (`test/proxy-server-debug-log.test.mjs:116`, `test/proxy-server-debug-log.test.mjs:139`, `test/proxy-server-debug-log.test.mjs:159`, `test/proxy-server-debug-log.test.mjs:175`).
- The ungated stdout/stderr regression is closed. `debugLog()` is now a no-op unless `CACHE_FIX_DEBUG === "1"` (`proxy/server.mjs:42`, `proxy/server.mjs:43`), and the module-import child-process test asserts zero stdout when the flag is unset (`test/proxy-server-debug-log.test.mjs:196`). I also verified `grep -nE 'console\\.(log|error)' proxy/server.mjs` returns no matches on this head.
- The async rejection containment bug is closed. `createProxyServer()` now wraps dispatch in an async IIFE and explicitly `await`s both async route handlers inside the surrounding `try/catch` (`proxy/server.mjs:333`, `proxy/server.mjs:354`, `proxy/server.mjs:355`, `proxy/server.mjs:358`). The 500 fallback body is now the constant generic sentinel `{ "error": "internal_proxy_error" }`, with no `error.message` echo (`proxy/server.mjs:360`, `proxy/server.mjs:364`). The new structural checks cover both requirements (`test/proxy-server-debug-log.test.mjs:230`, `test/proxy-server-debug-log.test.mjs:254`).
- The misleading diagnostics called out in round 1 are corrected. The internal-handled path now logs `clientReq.method` / `clientReq.url`, not nonexistent response-object request fields (`proxy/server.mjs:119`, `proxy/server.mjs:120`). The upstream response log still uses `upstreamRes.statusMessage`, which is the right object for that field, and I found no remaining `clientRes.url`, `clientRes.method`, or `bytesWritten` references in `proxy/server.mjs` at this head (`proxy/server.mjs:150`, `proxy/server.mjs:151`).
- Verification is strong enough for approval. `node --test test/proxy-server-debug-log.test.mjs` passed `8/8`, and `npm test` passed `1029/1029` locally on `8c4c2dee3857cbbe049270e2a6749cd6394afd9c`.

## Blockers

None.

## What Needs Attention

None.

## Bloat / Non-Functional

None.

## Recommendations

- Optional only: if you want a simpler white-box probe for the redaction helper later, export a small test seam for `redactHeaders()`. The current integration and structural coverage is sufficient for this PR without it.

## Bottom Line

The five round-1 blockers are closed on the maintainer-edited head. Secrets are redacted before any header dump reaches disk, the new debug surface is back behind the opt-in gate, the dispatcher now actually catches awaited async-handler failures, the misleading request/response diagnostics are fixed, and the 500 fallback is generic. With the new targeted coverage and a clean `1029/1029` full-suite run, this is ready for approval.

— Codex review
