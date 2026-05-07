# Review: PR 109 consumer migration docs

Date: 2026-05-07
Reviewed: PR #109 doc-only migration guidance
Label applied: changes-requested

## What Is Correct

- The README layout table is consistent with the shipped implementation in `proxy/extensions/cache-telemetry.mjs`: proxy mode writes account-global quota data to `~/.claude/quota-status/account.json`, per-session cache data to `~/.claude/quota-status/sessions/<filename>.json`, and preload mode keeps the legacy single-file path.
- The prose describing the canonical filename rule matches the implementation and directive: safe ids matching `[A-Za-z0-9_-]{1,128}` pass through, null/empty/whitespace map to `unknown`, and all other ids map to `inv-<sha256-prefix>`.
- The CHANGELOG / README anchor `README.md#migration-v34x--v350` is correct on rendered GitHub output for the heading `## Migration: v3.4.x → v3.5.0+`.
- The `README.ko.md` and `docs/guia-pt-br.md` translation-needed markers are clear enough: they explain who should read the English section and explicitly invite a translation PR.
- `docs/peak-hours-reference.md` now describes both storage modes accurately; in proxy mode `peak_hour` lives in `account.json`.

## Blockers

- `README.md:347-397` publishes bash and Node snippets that read `sessions/${sessionId}.json` directly instead of applying the canonical `sessionFilename()` rule used by the writer and the shipped `tools/quota-statusline.sh`. That means the documented "consumer-side migration pattern" silently fails for valid real-world cases the implementation explicitly supports:
  - malformed ids such as `../foo` are written to `sessions/inv-<sha256-prefix>.json`, but the snippets look for `sessions/../foo.json`;
  - whitespace-only ids are written to `sessions/unknown.json`, but the bash snippet treats them as empty and the Node snippet treats them as a literal whitespace filename.
  Because this section is the substantive deliverable of the PR, and it claims to be the migration reference for downstream consumers, publishing a non-canonical reader pattern is a blocking accuracy issue.

## What Needs Attention

- The same incorrect direct-path pattern is duplicated in `README.zh.md`, so fixing only the English README would still leave a stale technical translation behind.

## Recommendations

- Update both snippets to derive the per-session filename with the exact canonical rule before reading from `~/.claude/quota-status/sessions/`.
- Keep the direct pointer to `tools/quota-statusline.sh` as the bash reference, but make the README snippet itself correct so downstream readers do not cargo-cult the broken raw-session-id path.
- Mirror the snippet fix into `README.zh.md` before merge.

## Bottom Line

Revise before merge. The new migration section is well-targeted and the surrounding docs are accurate, but the core bash/Node examples currently contradict the canonical writer/reader contract and can mislead consumers into silently missing their per-session cache file.
