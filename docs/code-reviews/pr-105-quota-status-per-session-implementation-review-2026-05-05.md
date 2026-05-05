# Review: quota-status per-session implementation

Date: 2026-05-05
Reviewed: PR #105 implementation (`a57bc4c`, `e191690`, `8c60d59`)
Label applied: changes-requested

## What Is Correct

- `proxy/extensions/cache-telemetry.mjs` implements the core split correctly: `account.json` at the root, per-session files under `sessions/`, atomic temp-write + rename, one-shot legacy-file cleanup, throttled TTL sweep, and the canonical `sessionFilename(rawId)` rule exported for tests.
- `proxy/extensions/microcompact-stability.mjs` now checks `x-claude-code-session-id` in the correct precedence order: `meta.session_id` first, then the canonical header, then legacy fallbacks.
- The implementation-specific tests substantially improve coverage. The new cache-telemetry, pipeline, and statusline smoke tests all passed in my rerun (`npm test`: 732/732).
- The `tools/cache-test.sh` deviation from the directive is justified. The script inspects per-session `cache.*` fields, which do not exist in `account.json`, so reading the newest `sessions/*.json` is the only way to preserve the script's current purpose.

## Blockers

- `tools/quota-statusline.sh:37,61-64` does not actually apply the canonical writer/reader contract for all inputs the directive and JS tests cover. The JS writer maps `null`, `undefined`, `""`, and whitespace-only values to `unknown` via `sessionFilename(rawId)` (`proxy/extensions/cache-telemetry.mjs:44-49`), but the shell reader sets `sess_id = stdin_data.get('session_id') or ''` and then skips the per-session read entirely unless `if sess_id:` is truthy. Result: `session_id: null` and `session_id: ""` do **not** read `sessions/unknown.json`, while the writer does write that file for equivalent cases. I verified this directly by comparing the JS helper against the shell script under a tmpdir-rooted `HOME`: whitespace-only input reads `unknown.json`, but `null` and `""` fall back to account-only output. That breaks the explicit "implement identically" requirement for the filename rule and leaves the `11c` input class untested on the reader side.

## What Needs Attention

- The new statusline smoke coverage is useful, but it stops short of the bug above. `test/quota-statusline-smoke.test.mjs` covers UUID, missing `session_id`, missing per-session file, all-files-missing, and malformed `session_id`, but not `null`/empty-string/whitespace boundary cases from `11c`.
- `test/proxy-cache-telemetry.test.mjs:447-467` labels itself as "sweep failure isolation" but does not actually induce an `unlinkSync` or `statSync` failure, so the relevant catch-and-continue path remains unverified.
- The directive called for a broader present-behavior doc sweep than landed here. Stale path guidance remains in `docs/guia-pt-br.md:81` (`cat ~/.claude/quota-status.json`) and `docs/monitoring.md:21-25` (states proxy mode writes the old path). The touched README/zh/ko/CHANGELOG content is broadly correct, but the repo-wide migration is not yet complete.
- Blind spots remain around hostile filesystem layouts that the current tests do not exercise: `sessions/` as a symlink, permission-denied / ENOSPC during write or sweep, and multi-process writer races. None of these are immediate correctness regressions in today's single-process proxy, but they are still untested operational edges.
- The directive mentioned a debug-gated warning when all session headers are absent. `proxy/extensions/cache-telemetry.mjs` currently resolves to `null` silently. That is not a functional blocker for the file layout, but it is still a spec drift worth either implementing or explicitly dropping.

## Recommendations

- Make `tools/quota-statusline.sh` distinguish "field missing" from "field present but empty/null", then always run the canonical filename mapping for the latter so `null`/`""` resolve to `unknown` exactly like the JS writer.
- Add statusline smoke cases for `session_id: null`, `session_id: ""`, and `session_id: "   "` to lock the reader/writer contract together across the full `11c` space.
- Either complete the remaining doc-path sweep now (`docs/guia-pt-br.md`, `docs/monitoring.md`, and any other present-tense references) or narrow the acceptance language so it matches what the PR actually updates.
- If you want the "sweep failure isolation" claim to be meaningful, inject or monkey-patch `unlinkSync`/`statSync` in that test and assert the response still writes its fresh session file.

## Bottom Line

Revise before approval. The core proxy implementation is good and the main file-layout change is landed correctly, but the shipped reader in `tools/quota-statusline.sh` is not yet bit-for-bit consistent with the canonical `sessionFilename` contract across the input space the directive explicitly locked in. There is also some leftover stale path guidance in untranslated docs. Once the reader mismatch is fixed and the remaining docs/tests are tightened, I would expect this to be approvable.
