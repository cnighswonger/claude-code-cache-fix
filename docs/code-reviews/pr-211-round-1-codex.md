# Review: PR #211 — usage-log request_id field

Date: 2026-06-09
Reviewed: `proxy/extensions/usage-log.mjs`, `test/proxy-usage-log.test.mjs`, `README.md`, `CHANGELOG.md` at `10bc196aeeb9f0938b0b2b76fd481ba04a5e325a`
Round: 1
Label applied: approved-by-codex-agent

## What Is Correct

- `proxy/extensions/usage-log.mjs:109` adds `extractRequestId(headers)` with the directive's exact defensive contract: missing or null headers, non-string input, empty strings, and values longer than 64 are all omitted; the 64-character boundary passes.
- `proxy/extensions/usage-log.mjs:159` threads `requestId` through `assembleRecord(...)`, and `proxy/extensions/usage-log.mjs:231` re-enforces the full belt-and-braces emission predicate: `CACHE_FIX_USAGE_LOG_REQID === "on"`, string type, non-empty, and `<= 64`.
- `proxy/extensions/usage-log.mjs:293` captures `ctx.responseHeaders?.["request-id"]` inside `onStreamEvent` at the same final-assembly surface where quota headers are parsed, matching the directive correction and avoiding a new hook.
- `proxy/extensions/usage-log.mjs:7` updates the schema docstring in place, including the gated `request_id?: string ≤64` row and the v4.1.0 default-off / v4.2.0 default-on release note.
- `test/proxy-usage-log.test.mjs:537` gives independent extractor coverage across 7 cases. `test/proxy-usage-log.test.mjs:572` covers the gate/header matrix plus the empty-string, 65-character, non-string negatives and the 64-character positive boundary. `test/proxy-usage-log.test.mjs:642` proves the field reaches the on-disk JSONL row only when the async gate wrapper is awaited and the header is present.
- `README.md:858` adds the missing usage-log / `MeterRowSchema v:1` section from scratch with a complete field table, the `request_id` row documented in-family, the gate and meter coordination called out, and the transcript join recipe included.
- `CHANGELOG.md:3` documents the default-off gate, the `claude-code-meter >= v0.5.0` release-ordering contract, and the planned v4.2.0 default flip.
- Verification is clean: `node --test test/proxy-usage-log.test.mjs` passed `40/40`, and `npm test` passed `1048/1048`.

## Blockers

None.

## What Needs Attention

None.

## Bloat / Non-Functional

None.

## Recommendations

- Human review is still required before merge because this remains a load-bearing schema change even though the cache-fix-side implementation is correct and the child-PR gate strategy is documented.

## Bottom Line

This implementation matches the approved directive at `10bc196` and stays inside scope. The request-id capture happens at the correct surface, the wire-format gate is defensive in both capture and emission paths, the docs reflect the release-ordering contract, and the tests prove the field reaches the JSONL row only when intended. Approve for the cache-fix side; hold merge until the required human schema review and cross-repo meter coordination complete.

— Codex review
