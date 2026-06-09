# Review: PR #210 usage-log request_id directive

Date: 2026-06-09
Reviewed: PR #210 directive (`docs/directives/proxy-usage-log-request-id.md`) at `294808a`
Round: 1
Label applied: approved-by-codex-agent, plan-approved

## What Is Correct

- The schema-version decision is sound. `claude-code-meter`'s live consumer schema is still `MeterRowSchema = z.strictObject({...})` in `../claude-code-meter/src/log/schema.mjs:5-44`, and a direct parse check against Zod confirmed the relevant behavior: a declared optional key may be absent, while an undeclared extra key is rejected as `unrecognized_keys`. That means `request_id?: string` is an additive `v:1` change, but unpatched meter installs will reject rows that carry the new key until their schema update lands.
- The source choice is correct. Current repo precedent already treats the upstream request id as the canonical observability key: `proxy/extensions/rate-limit-log.mjs:155-178` records `upstream_request_id` from the response body `request_id` first, then the `request-id` response header as fallback. Local CC transcript samples under `~/.claude/projects/.../*.jsonl` do carry `requestId` values in the expected `req_...` shape, so the directive is aiming at the right cross-file join surface.
- The env-gate rationale is correct. Without a temporary default-off gate in cache-fix v4.1.0, every meter user on the old strict schema would ingest invalid rows as soon as the proxy starts emitting the new key. The repo already uses call-time env helpers for runtime gates where that behavior matters (`proxy/extensions/image-strip.mjs:32-58`), so the proposed gate shape is consistent with local patterns.
- The two-repo ordering is established and feasible. The original meter-compat directive already used the same producer-first / consumer-second coordination model around the strict `MeterRowSchema` contract (`docs/directives/proxy-claude-meter-compat.md:20-37,89-106`).
- Choosing `request_id` over direct CC-session-id is defensible for this one-field change. It recovers session attribution through the transcript join while also giving request-level correlation that a raw session-id field would not. If the project later needs transcript-independent grouping inside `usage.jsonl`, that is a separate field-addition question rather than a reason to block this directive.
- The NFR section is complete enough for directive stage. `Load-bearing? yes` is the right classification for a cross-repo wire-format change, the size budget is appropriately small, and the threat model is proportionate to an opaque server-generated identifier that is already persisted in local transcripts.

## Blockers

None.

## What Needs Attention

- `docs/directives/proxy-usage-log-request-id.md:51,96,129-140` overstates the current `usage-log` implementation surface. The shipped extension does not already parse quota headers in an `onResponseStart` hook; it currently reads `ctx.responseHeaders` inside `onStreamEvent` when the final row is assembled (`proxy/extensions/usage-log.mjs:230-270`, `proxy/stream.mjs:63-65`). Implementation can still add `onResponseStart`, but the directive should be read as "capture the response header before final row assembly", not as "follow an already-existing usage-log hook."
- `docs/directives/proxy-usage-log-request-id.md:86,111` says the README already has a `usage-log` / `MeterRowSchema` field table to extend. The current `README.md` does not expose that section today. This is not a contract blocker, but implementation should treat it as "add or restore a README usage-log schema subsection in the same table style used elsewhere" rather than looking for an existing table that is not there.
- The four-cell gate/header matrix is the right minimum, but I would also add one explicit negative writer-side case for an overlong or malformed `request-id` value. Upstream controls the header in normal operation, so this is not a directive blocker, but it is the one easy regression tripwire for the new `max(64)` constraint.

## Bloat / Non-Functional

None. The proposal stays within a one-field additive contract change and does not introduce unnecessary abstraction, new storage layers, or speculative migration machinery.

## Recommendations

- Approve the directive for implementation and apply `plan-approved`.
- Keep the v4.2.0 follow-up explicit about the meter minimum version when the gate flips default-on; the current note is directionally correct and should remain load-bearing in the follow-up directive.
- During implementation/docs polish, correct the README wording to create the needed schema subsection and correct the hook-surface wording so future readers are not told `usage-log` already has an `onResponseStart` quota parse path.

## Bottom Line

Approve. The contract reasoning holds up: `request_id` is an additive `v:1` field under the existing strict-object consumer, the temporary default-off gate is the right way to bridge old meter installs, and the release ordering follows an existing repo precedent. The remaining issues are wording and test-tightening notes, not directive-stage blockers.

— Codex review
