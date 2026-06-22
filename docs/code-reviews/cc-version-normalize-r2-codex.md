# Review: cc-version-normalize

Date: 2026-06-22
Reviewed: PR #239 (`feature/cc-version-normalize`) at `a6c82d3d33ac61de591017dc09caecb68cda5548`
Round: 2
Label applied: reviewed-by-codex-agent; approved-by-codex-agent

## What Is Correct

The r1 field-boundary blocker is resolved. `proxy/extensions/cc-version-normalize.mjs` now uses `/(^|[;\s:])cc_version=([^;\s]+)/g`, captures the leader, and re-emits it in the replacement. That keeps real `cc_version` assignments matched at the start of the string, after semicolons, after whitespace, and after the `x-anthropic-billing-header:` leader while preserving the delimiter byte.

I also checked the no-space delimiter case called out for r2: `;cc_version=2.1.185.hash` rewrites to `;cc_version=2.1.185`, so the captured `;` is not stripped. A terminal assignment with no trailing semicolon also rewrites correctly because the value group is not dependent on a following delimiter.

The r1 embedded-field regression is covered by tests. `test/proxy-cc-version-normalize.test.mjs` includes strip and pin cases where `other=prefix_cc_version=...` remains byte-identical while the real field-boundary `cc_version` assignment is rewritten.

The r1 atomic fail-open blocker is resolved. `proxy/extensions/cc-version-normalize.mjs` stages `{ index, newBlock }` entries in a `replacements` array inside the scan loop and applies them only after the scan completes. There is no in-loop body mutation before the possible throwing accesses finish.

The atomicity test is meaningful: the new Proxy block throws on later `.text` access after an earlier rewrite candidate, and the test asserts the first billing block's text is exactly unchanged after the failure.

The multiple-billing-header attention item is covered. The r2 test exercises `body.system` with two billing-header blocks separated by a non-billing text block and asserts both billing blocks are rewritten while the middle block is untouched.

The whitespace divergence attention item is documented accurately in the source comment. The implementation deliberately terminates at `;` or whitespace; the comment calls out the difference from `fingerprint-strip` and explains why stopping at malformed whitespace is acceptable for this field.

## Blockers

None.

## What Needs Attention

None blocking. The current tests do not separately name every boundary character in the regex, but existing coverage plus direct inspection of the implementation is enough for this round: the regex and replacement preserve start-of-string, semicolon, whitespace, and colon boundaries, including `;cc_version=` without a space.

## Bloat / Non-Functional

None. The `replacements` array is bounded by `body.system.length`, which is small for this request shape, and it buys the fail-open atomicity required by r1. I do not see a hot-path concern.

## Recommendations

Keep the existing `needs-sim-validation` label until live Claude Code traffic confirms the extension behaves as expected under real billing-header payloads. Unit coverage is good for the folded blockers, but the feature still intentionally changes cache-prefix text in production traffic.

## Bottom Line

Approve. Proxy Builder folded both r1 blockers and both attention items without introducing a new regression in the reviewed surface. `node --test test/proxy-cc-version-normalize.test.mjs` passes from a clean archive of `a6c82d3` with all 40 tests passing.

— Codex review
