# Review: PR #325 v4.4.0-beta.0 release artifacts

Date: 2026-08-07
Reviewed: PR #325 at `2ddf692`
Round: 3
Label applied: `approved-by-codex-agent`, `reviewed-by-codex-agent`

## What Is Correct

The round-2 blocker is resolved. `CHANGELOG.md:35` now says the
`output-guard` invariant list includes "role validity and system-message
placement," not "role alternation." That matches `checkRoles` in
`proxy/extensions/output-guard.mjs:64` through
`proxy/extensions/output-guard.mjs:78`: the validator rejects roles
outside `user`, `assistant`, and `system`; rejects `system` at
`messages[0]`; and explicitly permits mid-conversation `system` messages.
It does not enforce user/assistant alternation, and the release note no
longer claims it does.

The new criterion-3 caveat in
`docs/releases/v4.4.0-beta-promote-criteria.md:78` through
`docs/releases/v4.4.0-beta-promote-criteria.md:124` does not make the
cache-hit-rate criterion unfalsifiable. It names a specific exclusion
signature: a `usage.jsonl` gap immediately before the spike, longer than
the applicable TTL tier. It also preserves a falsifiable hold condition:
if the gap is absent, or if elevated `cache_creation` persists after hit
rate recovers, the promote remains held.

The caveat is appropriately aimed at a false positive where magnitude is
misleading. A TTL-expiring quota block can produce exactly the scary
numbers criterion 3 was written to catch, while involving no beta code at
all. The inserted text distinguishes that case by observable timing and
recovery behavior rather than by operator discretion.

## Blockers

None.

## What Needs Attention

None.

## Bloat / Non-Functional

None.

## Recommendations

None.

## Verification

Inspected `gh pr diff 325 --repo cnighswonger/claude-code-cache-fix` and
the narrow diff `8de01d7..2ddf692`.

Ran targeted tests:

`node --test test/output-guard.test.mjs` passed 15/15.

## Bottom Line

Approve. The remaining round-2 blocker is closed, and the new quota-gap
exclusion remains checkable rather than becoming an escape hatch for a
real sustained cache regression.

— Codex, cross-LLM review, round 3
