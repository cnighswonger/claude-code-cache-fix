# Review: claude-meter compat directive

Date: 2026-04-25
Reviewed: `docs/directives/proxy-claude-meter-compat.md`
Label applied: `changes-requested`

## What Is Correct
- The high-level direction is sound: moving claude-meter off the broken `NODE_OPTIONS` preload and onto proxy-produced telemetry is the right fix for CC v2.1.113+.
- Reusing the existing `usage-log` extension pattern is the right activation model for this feature. Keeping the extension opt-in via extension config, rather than introducing a second env-var gate inside the extension, is consistent with the repo’s extension loader and with the current `usage-log` design in `proxy/extensions/usage-log.mjs`.
- Most of the raw data needed by claude-meter is available on the proxy side. The request model is already captured in `proxy/server.mjs`, rate-limit headers are available in `responseHeaders`, and the SSE stream includes the usage payloads that carry `speed`, `service_tier`, `cache_creation.ephemeral_*`, and `server_tool_use.web_search_requests`.
- Splitting the work across the two repos is directionally correct: this repo should produce the canonical per-call log row, and claude-meter should switch ingestion sources without changing its upload/share protocol.

## Blockers
- The directive’s “canonical superset” schema is not actually compatible with claude-meter’s current strict validator. `MeterRowSchema` is a `z.strictObject` with `v: 1` and does not allow extra keys such as `total_input` or `peak_hour`, while the directive says the proxy will emit `v: 2` plus those extra fields and that claude-meter will “reuse existing `src/log/schema.mjs` validation.” Those statements cannot all be true at once. The directive needs one coherent contract: either the shared wire schema is updated in claude-meter to accept the new fields/version, or the proxy output must stay within the strict row shape that claude-meter validates today.
- The activation/config story is wrong in two places. The directive tells users to enable the integration with `CACHE_FIX_USAGE_LOG=1`, but in this repo `CACHE_FIX_USAGE_LOG` is the path override, not an enable flag, and `usage-log` is supposed to remain a config-toggle opt-in. It also says to add a comment to `extensions.json`, but this repo parses that file with `JSON.parse`, so comments are not valid there. The directive needs to describe the real activation path: extension config enables the module; `CACHE_FIX_USAGE_LOG` only overrides the destination path.
- The org ID privacy requirement is not specified precisely enough for a cross-repo contract. The directive says “hashed sha256 prefix” and has a test that asserts “not the original,” but it never states the exact encoding and truncation rule. claude-meter’s existing writer uses `sha256(...).digest("hex").slice(0, 16)`. If the proxy side is supposed to preserve compatibility and privacy guarantees, the directive needs to pin that exact algorithm and output length.
- The proxy-side test seam is underspecified for several required fields. The proposed `buildRecord(meta, telemetry, responseHeaders, ...)` signature assumes all needed inputs are already present in `meta`/`telemetry`, but the current proxy telemetry object only carries `model`, `requestedModel`, token counters, and `stopReason`, and `cache-telemetry` currently does not populate `speed`, `service_tier`, `cache_creation.ephemeral_*`, or `web_search_requests`. Those values are available from the SSE stream, but the directive does not specify where that state will be captured before the final `message_delta` write. As written, the pure-function contract does not line up with the actual data flow.
- The migration/versioning story is incomplete. The directive says claude-meter will handle “old `v: 1` (preload-era) rows” during a transition window, but the old preload data lives in `~/.claude/claude-meter.jsonl`, while the existing proxy `usage-log` file uses a different 9-field shape with no `v` field at all. The directive needs to say exactly which historical formats the new claude-meter ingest path must tolerate, whether existing `usage.jsonl` content is supported or intentionally ignored, and what the release ordering is between the proxy change and the claude-meter release.
- The file/test path list is incorrect for this repo. The directive names `tests/usage-log.test.mjs`, but this repo uses `test/`, and there is already a `test/proxy-usage-log.test.mjs`. That should be corrected before implementation starts so the PR target is unambiguous.

## What Needs Attention
- The schema reconciliation section says `MeterRowSchema` has “derived: `total_input`,” but the actual schema does not include `total_input`; only `cache_hit_rate`, `q5h_delta`, and `q7d_delta` are derived fields today. That mismatch is another sign that the shared row contract needs to be restated from the real schema, not from a paraphrase.
- The directive does not spell out release sequencing across repos. Practically, claude-meter cannot rely on this ingestion path until the proxy side is released with the expanded row shape. That ordering is manageable, but it should be stated explicitly so the two PRs do not appear independently shippable.
- The cache-fix test plan should explicitly cover the message-start state capture needed for `speed`, `service_tier`, ephemeral split, and `web_search_requests`, not just the final record object. Otherwise the hardest part of the refactor can regress while the pure `buildRecord()` tests still pass.

## Recommendations
- Rewrite the shared-schema section around the exact claude-meter validator contract. List the authoritative field set, mark which fields remain optional, and say plainly whether `peak_hour` is part of the shared wire row or a separate proxy-only artifact.
- Replace the activation text with the actual `usage-log` pattern: `enabled: false` by default, opt-in through `proxy/extensions.json` (or whatever documented extension-config flow the repo standardizes on), optional `CACHE_FIX_USAGE_LOG=<path>` override for destination path only.
- Pin the org ID rule to the existing claude-meter implementation: SHA-256, hex digest, first 16 characters, never raw.
- Add an explicit state-capture plan on the proxy side for fields only available on `message_start`, and ensure the test seam reflects that state model instead of pretending everything already exists in `meta` and `telemetry`.
- Clarify migration scope and ordering: whether old `usage.jsonl` rows are supported, whether old preload rows are out of scope for the new ingest path, and that the proxy release must land before claude-meter can ship the new default ingestion mode.
- Correct the file references to `test/` and point the work at `test/proxy-usage-log.test.mjs` unless there is a strong reason to create a second test file.

## Bottom Line
Revise before implementation. The architectural direction is right, and the `usage-log` opt-in pattern is the correct one to build on, but the directive still has blocking contract errors around schema compatibility, activation semantics, org ID hashing, and migration/versioning. Those need to be fixed in the directive first so the two repos do not implement different interpretations of the same wire format.

Verdict: REQUEST CHANGES
