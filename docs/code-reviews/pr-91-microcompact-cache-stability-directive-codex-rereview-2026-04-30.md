# Review: Directive: microcompact cache stability rereview

Date: 2026-04-30
Reviewed: `docs/directives/proxy-microcompact-cache-stability.md` at `7bb559a`
Label applied: `changes-requested`

## What Is Correct

- The directive now defines the right high-level contract for Phase 1: diagnostic capture is raw-before-normalize, and optional normalized output is additive via `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED=1`.
- Privacy framing is materially improved. Broad default patterns were removed, Mode B is explicitly diagnostic-only, and `CACHE_FIX_MICROCOMPACT_REDACT_LEN` provides a clear stricter-deployment escape hatch.
- The exact-match vs partial-match split is now explicit, which is the right boundary for safe normalization.
- The ISO-8601 timestamp pattern is tightened in the detection section, `bytes_saved` is framed correctly as secondary to byte-stability, and the Phase 2 deferral list now names the missing persistence constraints.
- The new tests and reviewer checklist generally point at the right risks, especially around Mode B redaction and non-normalization.

## Blockers

1. The directive still contains stale dump-shape and dump-timing text that contradicts the revised contract. The pipeline sketch still writes `matched_sentinels` instead of separate `exact_matches` / `partial_matches` ([docs/directives/proxy-microcompact-cache-stability.md](docs/directives/proxy-microcompact-cache-stability.md#L269)), Test 11 still expects `matched_sentinels` ([docs/directives/proxy-microcompact-cache-stability.md](docs/directives/proxy-microcompact-cache-stability.md#L317)), and Test 19 still says the diagnostic captures post-normalization state ([docs/directives/proxy-microcompact-cache-stability.md](docs/directives/proxy-microcompact-cache-stability.md#L329)). Those are not cosmetic leftovers; they reintroduce the same ambiguity the earlier review blocked on.
2. The diagnostic schema example still advertises the old permissive timestamp matcher `^\\[Old tool result content cleared at .+?\\]$` instead of the constrained ISO-8601 form promised by the detection contract ([docs/directives/proxy-microcompact-cache-stability.md](docs/directives/proxy-microcompact-cache-stability.md#L143)). As written, the spec still presents two different accepted timestamp forms to implementers.

## What Needs Attention

- None beyond the blockers above. Once the stale schema, pseudocode, and test-plan references are aligned with the revised contract, the directive should be in approvable shape.

## Recommendations

- Update every downstream artifact section to use the two-mode record shape consistently: schema example, pipeline sketch, and test plan should all refer to `exact_matches` and `partial_matches`, not `matched_sentinels`.
- Fix the activation test language so the “both enabled” case explicitly says the dump captures raw pre-normalization text and only includes `normalized_text` when `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED=1` is set.
- Replace the stale `.+?` example pattern with the exact ISO-8601-constrained regex already documented in the detection section.

## Bottom Line

Revise once more before `plan-approved`. The core contract changes requested in the first review are now directionally correct, but the directive still has internal contradictions in its schema example, pipeline sketch, and test plan. Those contradictions are concrete enough to mis-specify the implementation, so the directive is not yet clean enough to serve as the implementation source of truth.
