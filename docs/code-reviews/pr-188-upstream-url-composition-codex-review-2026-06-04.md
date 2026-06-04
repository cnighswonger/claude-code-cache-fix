# Review: PR #188 upstream URL composition — Codex review

Date: 2026-06-04
Reviewed: `proxy/upstream.mjs`, `proxy/server.mjs`, `test/proxy-upstream.test.mjs`, `test/proxy-upstream-corp-proxy.test.mjs`, `README.md`
Label applied: `reviewed-by-codex-agent`

## What Is Correct

- `proxy/upstream.mjs:188-190` fixes a real bug: `new URL(clientReq.url, config.upstream)` was applying RFC 3986 relative resolution and dropping any path prefix on `CACHE_FIX_PROXY_UPSTREAM`. The new join preserves `/mirror`-style prefixes and produces the expected forwarded path.
- The fix preserves the authority portion of the upstream URL correctly in the cases I checked: IPv6 literals, explicit ports, and userinfo all continue to parse correctly after concatenation.
- Query strings on the incoming request path still flow through correctly because `options.path` is built from `upstreamUrl.pathname + upstreamUrl.search`.
- The absolute-URL behavior change is not a supported runtime regression for this proxy. `proxy/server.mjs:265-268` only routes origin-form paths such as `/v1/messages` and `/api/claude_cli/bootstrap`, so the live server path does not feed absolute-form request targets into `forwardRequest()`.
- `README.md:145` already documents `CACHE_FIX_PROXY_UPSTREAM` as an "Upstream URL", so accepting a path-prefixed upstream is aligned with the documented contract rather than adding a wholly new feature.

## Blockers

None.

## What Needs Attention

- `test/proxy-upstream.test.mjs:32-58` covers forwarding to an upstream at the host root, and `test/proxy-upstream-corp-proxy.test.mjs:15-84` covers proxy-env selection and module loading, but neither test file currently pins the path-prefix case this PR fixes. A focused regression test asserting `CACHE_FIX_PROXY_UPSTREAM=http://127.0.0.1:<port>/mirror` yields `req.url === "/mirror/v1/messages"` would be valuable. I do not consider that a merge blocker for a first-time community bugfix, but the gap is real.
- `proxy/upstream.mjs:188-190` does change direct-call behavior for absolute-form inputs like `https://api.anthropic.com/v1/messages` or other non-origin-form `clientReq.url` values. That is acceptable for the current server call path, but maintainers should keep it in mind if `forwardRequest()` is ever reused outside the local proxy router.

## Bloat / Non-Functional

None. The patch is minimal and proportionate to the bug.

## Size Baseline

- `proxy/upstream.mjs` — 248 LOC — compact transport/helper module; this PR touches a 3-line URL construction site.
- `proxy/server.mjs` — 355 LOC — route dispatch plus pipeline orchestration; reviewed here to confirm the shape of `req.url` reaching `forwardRequest()`.
- `proxy/config.mjs` — 39 LOC — env-backed config getters; reviewed to confirm `CACHE_FIX_PROXY_UPSTREAM` remains a plain URL string contract.
- `test/proxy-upstream.test.mjs` — 123 LOC — end-to-end-ish forwarding assertions, currently only root-upstream coverage.
- `test/proxy-upstream-corp-proxy.test.mjs` — 84 LOC — corp-proxy env selection coverage, no path-prefix forwarding case today.
- `README.md` — 824 LOC — configuration contract is present, but no explicit path-prefix example.

## Recommendations

- Merge the fix as correct.
- Backfill one regression test for path-prefixed upstreams, either in this PR if the contributor wants to add it or in a follow-up maintainer commit if we want to keep the first contribution lightweight.
- Optional future docs polish: add one example showing `CACHE_FIX_PROXY_UPSTREAM` with a path prefix so the supported shape is explicit to readers, not just implied by "URL".

## Bottom Line

This is a good, targeted fix for a real forwarding bug. I verified the path-prefix behavior, checked the edge cases most likely to matter operationally, and did not find a correctness issue that warrants blocking a first-time contributor here. The missing regression test is worth capturing, but not worth rejecting the patch over. — Codex review
