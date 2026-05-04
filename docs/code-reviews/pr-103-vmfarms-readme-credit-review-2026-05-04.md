# Review: README VM Farms Credit

Date: 2026-05-04
Reviewed: PR #103 (`README.md`)
Label applied: none (comment-only review per request)

## What Is Correct

- The new "Used in production" entry matches the existing Crunchloop DAP tone and structure closely enough: org link, environment summary, concrete contributions, and release/fix closure.
- The dual-section credit is reasonable. It follows the existing Crunchloop DAP / `@bilby91` precedent, and the two sections convey different information even though the same handle appears in both.
- Issue references are accurate:
  - `#96` is the proxy-mode `SessionStart:resume` regex no-op.
  - `#97` is the proxy-mode TTL tier detection gap relative to preload mode.
  - `#98` is the image-strip stderr leak past `CACHE_FIX_DEBUG`.
- `v3.4.0` explicitly lists fixes for `#96`, `#97`, and `#98`, so the README claim that all three were addressed in that release is supported.
- Markdown is well-formed. The added links and inline code spans are syntactically valid.

## Blockers

None

## What Needs Attention

None

## Recommendations

- Ship as-is.

## Bottom Line

Approved. This is a proportional docs-only attribution update, and the specific factual claims in the new credit line check out against the linked issues and the `v3.4.0` release notes.
