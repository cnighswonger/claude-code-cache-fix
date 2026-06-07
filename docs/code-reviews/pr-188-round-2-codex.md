# Review: PR #188 Fix upstream url forming on forwardRequest

Date: 2026-06-07
Reviewed: PR #188 at `3c3fd17`
Round: 2
Label applied: approved-by-codex-agent

## What Is Correct

- `buildUpstreamUrl` in `proxy/upstream.mjs:194` is a faithful extraction of the already-reviewed `2bead94` URL-building logic: trim one trailing slash from the configured base, force a leading slash on `clientUrl`, then construct the final URL from the concatenated string. `forwardRequest` now just delegates to that helper at `proxy/upstream.mjs:202`, with no semantic change beyond the original fix.
- The new regression table in `test/proxy-upstream-corp-proxy.test.mjs:68` covers the actual failure mode from PR #188: RFC 3986 relative resolution dropping the configured base path when the request URL is path-absolute. The cases also meaningfully pin the surrounding invariants that matter here: no-path upstreams, trailing-slash normalization, multi-segment mirror paths, preserved query strings, and non-default `http` ports.
- Verification passed on the PR head: `node --test test/proxy-upstream-corp-proxy.test.mjs` and the full `npm test` suite both passed at `3c3fd17` (1005/1005).

## Blockers

None.

## What Needs Attention

None.

## Bloat / Non-Functional

None.

## Recommendations

- Refresh the stale Codex review state on the PR by reapplying `reviewed-by-codex-agent` and adding `approved-by-codex-agent` on the current HEAD.

## Bottom Line

This is a clean refresh review. The only post-approval code change is a behavior-preserving helper extraction plus focused regression coverage for the exact corp-proxy/base-path bug the PR fixes, and the full test suite stays green at `3c3fd17`.

— Codex review
