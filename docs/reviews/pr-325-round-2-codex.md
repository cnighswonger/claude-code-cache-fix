# Review: PR #325 v4.4.0-beta.0 release artifacts

Date: 2026-08-07
Reviewed: PR #325 at `d9bf822` against `origin/main` `8d6fa93`
Round: 2
Label applied: `changes-requested`

## What Is Correct

The PR remains release-artifact scoped. The current head adds review artifacts after the release-note fixes; I found no source-code change in this PR.

Round-1 blocker 1 is resolved on traffic direction and restore semantics. `CHANGELOG.md:35` now describes `output-guard` as an outgoing-request guard behind `CACHE_FIX_OUTPUT_GUARD=1`, default off, restoring the pre-mutation body Claude Code originally sent. That matches `proxy/extensions/output-guard-stash.mjs:20` through `proxy/extensions/output-guard-stash.mjs:25`, which clones the request body before mutators, and `proxy/extensions/output-guard.mjs:147` through `proxy/extensions/output-guard.mjs:189`, which validates on `onRequest`, restores the stash when available, passes through on validator crash, and passes through loudly when the stash is missing.

Round-1 blocker 2 is resolved. The "first 243 live firings" claim is gone from the PR diff, and I found no equivalent replacement provenance claim. The changelog still deliberately states that the dogfood host ran v4.3.0 for the development window and that none of the beta features executed against live traffic; I did not treat that absence of production evidence as a defect.

Round-1 blocker 3 is resolved. The new PR #257 entry in `CHANGELOG.md:55` matches `bin/claude-via-proxy.mjs:609` through `bin/claude-via-proxy.mjs:625`: forward-proxy mode sets `HTTPS_PROXY`, merges `127.0.0.1,localhost,::1` into an existing `NO_PROXY` or `no_proxy`, and writes both cases so clients reading either variable bypass the cache-fix proxy for localhost.

The promoted PR #259 entry is materially accurate. `tools/rates.json:90` through `tools/rates.json:138` adds pricing for `claude-fable-5`, `claude-mythos-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5`, `claude-haiku-4-5`, and `claude-opus-5`; `tools/update-rates.mjs:44` through `tools/update-rates.mjs:85` maps those models and requires the live-traffic set. The fetcher fails closed on missing required models, ambiguous/effective-date uncertainty, sane-band violations, and cache-multiplier contradictions at `tools/update-rates.mjs:18` through `tools/update-rates.mjs:25`, `tools/update-rates.mjs:194` through `tools/update-rates.mjs:209`, and `tools/update-rates.mjs:276` through `tools/update-rates.mjs:317`.

The fourth item is fixed. `docs/releases/v4.4.0-beta-promote-criteria.md:44` through `docs/releases/v4.4.0-beta-promote-criteria.md:47` now says the guard catches a broken outgoing request body produced by our mutating extensions and forwards Claude Code's original bytes. That matches the implementation.

The two deliberately unaddressed non-blocking items can remain non-blocking. I still think the `deferred-tool-rewrite` entry could be more precise about unsupported models passing changed `tools[]` through, but the cost of adding that caveat to a release-note paragraph is plausibly higher than the precision gained. I also do not object to leaving the CA-trust entries under `[Unreleased]` until the final v4.4.0 tag commit, given the beta-cut workflow stated in the PR discussion.

## Blockers

1. `CHANGELOG.md:35` still overstates the `output-guard` validators by saying the guard validates "role alternation." The five intended validators do exist in `findViolation`: tool adjacency, marker budget, roles, content presence, and assistant-terminal (`proxy/extensions/output-guard.mjs:40`, `proxy/extensions/output-guard.mjs:59`, `proxy/extensions/output-guard.mjs:67`, `proxy/extensions/output-guard.mjs:80`, `proxy/extensions/output-guard.mjs:105`, `proxy/extensions/output-guard.mjs:116` through `proxy/extensions/output-guard.mjs:124`). But the implementation's `checkRoles` rejects invalid roles and a system message at `messages[0]`; it explicitly permits mid-conversation `system` messages and does not enforce strict user/assistant alternation (`proxy/extensions/output-guard.mjs:64` through `proxy/extensions/output-guard.mjs:78`). The changelog should say `roles` or `role validity / placement`, not `role alternation`.

## What Needs Attention

None beyond the blocker above.

## Bloat / Non-Functional

None.

## Recommendations

Change the `output-guard` bullet's invariant list from "role alternation" to "roles" or "role validity / placement." That would align the release note with the implementation without changing the broader paragraph.

## Verification

Inspected `gh pr diff 325 --repo cnighswonger/claude-code-cache-fix`.

Ran targeted tests:

`node --test test/output-guard.test.mjs test/tools-update-rates.test.mjs test/proxy-session-budget-breaker.test.mjs` passed 68/68.

`node --test --test-name-pattern="--remote-control (excludes localhost|merges localhost|honors lowercase no_proxy|does not duplicate)" test/proxy-wrapper.test.mjs` passed 3/3 after installing npm dependencies with a writable `/tmp` npm cache.

## Bottom Line

Request changes. The requested round-2 fixes are correct except for one narrow documentation accuracy issue: the release note still says `output-guard` validates role alternation, while the implementation validates roles / placement.

— Codex, cross-LLM review, round 2
