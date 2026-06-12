Verdict: REQUEST_CHANGES

# Review: PR #221 JSONL Session-Content Mirror

Date: 2026-06-12
Reviewed: `feature/jsonl-session-mirror` at `0a59247eb1e7a940bbc267d707e7be77494edb4c`
Round: 2
Label applied: `changes-requested`

## What Is Correct

- The round-1 runtime blockers are materially fixed in code: the extension no longer carries the unreachable interrupted-flush gate/helper, and `CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS` is now enforced at session creation rather than only after successful flushes (`proxy/extensions/jsonl-session-mirror.mjs:34-37`, `proxy/extensions/jsonl-session-mirror.mjs:55-83`, `proxy/extensions/jsonl-session-mirror.mjs:256-318`).
- The event-log contract is now constrained to the intended scalar surface. `open` is emitted on first writer open, rotation drops file paths in favor of scalar `rotation`/`bytes`, and the sanitizer allow-list strips undeclared/object fields (`proxy/session-mirror-writer.mjs:45-123`).
- Envelope provenance is correctly version-qualified from `package.json` at module load, with fallback to bare `cache-fix-proxy` if the read fails (`proxy/session-mirror-envelope.mjs:28-43`, `proxy/session-mirror-envelope.mjs:103-117`). A direct runtime probe produced `cache-fix-proxy/4.1.0`.
- Targeted tests pass at the reviewed HEAD: `node --test test/proxy-jsonl-session-mirror.test.mjs test/proxy-session-mirror-envelope.test.mjs`.

## Status Table

| Item | Status | Evidence |
| --- | --- | --- |
| B1 — `FLUSH_INTERRUPTED` unreachable | PARTIALLY ADDRESSED | The env var, gate, and helper are gone from the extension, but the merged directive still documents `CACHE_FIX_SESSION_MIRROR_FLUSH_INTERRUPTED` as in-scope/default-true behavior and still lists interrupted-flush acceptance criteria (`proxy/extensions/jsonl-session-mirror.mjs:34-37`, `docs/directives/proxy-jsonl-session-mirror.md:100`, `docs/directives/proxy-jsonl-session-mirror.md:217`, `docs/directives/proxy-jsonl-session-mirror.md:260`). |
| B2 — `MAX_SESSIONS` cap only enforced on success path | ADDRESSED | `getSession()` now evicts immediately on creation and preserves LRU by re-inserting on access; the new regression test stages 5 aborted sessions under cap 3 and proves the oldest state was evicted (`proxy/extensions/jsonl-session-mirror.mjs:55-83`, `test/proxy-jsonl-session-mirror.test.mjs:382-405`). |
| A1 — `open` event missing | ADDRESSED | First writer open now emits `{ event: "open", session_id }`, and the new test asserts it reaches the event log (`proxy/session-mirror-writer.mjs:55-64`, `test/proxy-jsonl-session-mirror.test.mjs:411-424`). |
| A2 — event-log scalar surface drift | ADDRESSED | `EVENT_LOG_ALLOWED_FIELDS` and `sanitizeEventRecord()` enforce scalar-only output; extension error events now log `error_class` instead of raw messages (`proxy/session-mirror-writer.mjs:91-123`, `proxy/extensions/jsonl-session-mirror.mjs:300-309`, `proxy/extensions/jsonl-session-mirror.mjs:340-358`). |
| A3 — user envelope parity test | ADDRESSED | The user parity test now iterates the fixture-driven top-level and nested message keys, excluding only the directive-caveated tool-result-only fields (`test/proxy-session-mirror-envelope.test.mjs:109-140`). |
| A4a — stream-abort partial-flush wiring deferral | DEFERRAL APPROPRIATE | Deferring the `server.mjs`/stream hook is reasonable once the feature is cut from this PR; the remaining problem is that the directive was not updated to match that deferral (`proxy/server.mjs:101-109`, `proxy/stream.mjs:76-98`, `docs/directives/proxy-jsonl-session-mirror.md:100`, `docs/directives/proxy-jsonl-session-mirror.md:217`, `docs/directives/proxy-jsonl-session-mirror.md:260`). |
| A4b — 200-turn replay deferral | DEFERRAL APPROPRIATE | Given the existing 3-turn replay, failed-request retry, repeated-text, and the new over-cap aborted-session test, there is already direct coverage on the load-bearing dedup semantics (`test/proxy-jsonl-session-mirror.test.mjs:123-264`, `test/proxy-jsonl-session-mirror.test.mjs:382-405`). |
| A4c — async-rejected writer-path deferral | DEFERRAL APPROPRIATE | The writer path under review is synchronous (`appendFileSync`, `mkdirSync`, `renameSync`, `statSync`), so an async-rejection regression test would not exercise the implementation that actually shipped (`proxy/session-mirror-writer.mjs:115-138`). |
| P1 — version pinning | ADDRESSED | Version now resolves from `package.json` into `cache-fix-proxy/<version>` at module load and is used as the default envelope value (`proxy/session-mirror-envelope.mjs:28-43`, `proxy/session-mirror-envelope.mjs:103-117`). |

## Blockers

1. The code correctly removes the unreachable interrupted-flush feature, but the merged directive still claims that feature exists, is default-true, and is covered by acceptance criteria/tests (`docs/directives/proxy-jsonl-session-mirror.md:100`, `docs/directives/proxy-jsonl-session-mirror.md:217`, `docs/directives/proxy-jsonl-session-mirror.md:260`). That leaves the repo's spec inconsistent with the shipped behavior at the exact point round 1 asked to clean up. This PR should either update the directive to reflect the deferral/cut or restore the feature; as-is, it does neither.

## What Needs Attention

- The new scalar-surface regression test is weaker than its name suggests. `test/proxy-jsonl-session-mirror.test.mjs:426-443` intentionally points the mirror root at an invalid path, so it never reads an emitted event-log line and therefore does not actually assert that disallowed fields are dropped. The implementation itself looks correct, but the test currently acts as smoke coverage rather than contract coverage.

## Bloat / Non-Functional

- None.

## Recommendations

- Update `docs/directives/proxy-jsonl-session-mirror.md` so the accepted scope matches the implementation now under review: remove the `CACHE_FIX_SESSION_MIRROR_FLUSH_INTERRUPTED` contract, the interrupted-flush acceptance bullet, and the checklist item, or explicitly mark them deferred to a follow-up issue.
- Tighten the scalar-surface test by forcing a successful event-log write and asserting that path-like/raw-message fields are absent from the serialized JSONL line. The sanitizer already appears to do the right thing; the test should prove it.

## Bottom Line

The round-1 runtime blockers are fixed, the event-log surface is materially better, and the version pinning/provenance cleanup is correct. I am still requesting changes because the repo's merged directive continues to advertise the removed interrupted-flush feature and its associated acceptance criteria, so the implementation and the committed spec remain out of sync.

— Codex review
