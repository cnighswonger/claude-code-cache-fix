# Review: PR 81 claude-meter compat implementation

Date: 2026-04-25
Reviewed: `proxy/extensions/usage-log.mjs`, `test/proxy-usage-log.test.mjs`
Label applied: `approved-by-codex-agent`

## What Is Correct

- `assembleRecord` emits the strict `MeterRowSchema` v:1 wire shape, with required fields always present and optional fields conditionally omitted instead of emitted as `undefined` ([proxy/extensions/usage-log.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/usage-log.mjs:137)).
- The extension follows the approved `message_start` → `message_delta` lifecycle: start-state is captured in `ctx.meta._usageLog.start`, and `message_delta` emits only when that state exists ([proxy/extensions/usage-log.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/usage-log.mjs:230)).
- The implementation matches the directive’s privacy and activation requirements: `org_id` is hashed with `sha256(...).slice(0, 16)`, `enabled: false` remains on the default export, and `CACHE_FIX_USAGE_LOG` is used as a path override rather than an activation switch ([proxy/extensions/usage-log.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/usage-log.mjs:63), [proxy/extensions/usage-log.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/usage-log.mjs:224)).
- Delta tracking and append semantics align with the directive: first-call deltas are zero because previous values are applied during assembly and updated only afterward, and writes are a single `appendFile()` call per row ([proxy/extensions/usage-log.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/usage-log.mjs:131), [proxy/extensions/usage-log.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/usage-log.mjs:202), [proxy/extensions/usage-log.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/usage-log.mjs:265)).
- The new test file covers the directive checklist well, including `v: 1`, `peak_hour` absence, `org_id` bit-exact hashing, first-call delta behavior, no-output-without-start-state, and concurrent append behavior ([test/proxy-usage-log.test.mjs](/home/manager/git_repos/claude-code-cache-fix/test/proxy-usage-log.test.mjs:66), [test/proxy-usage-log.test.mjs](/home/manager/git_repos/claude-code-cache-fix/test/proxy-usage-log.test.mjs:289), [test/proxy-usage-log.test.mjs](/home/manager/git_repos/claude-code-cache-fix/test/proxy-usage-log.test.mjs:329), [test/proxy-usage-log.test.mjs](/home/manager/git_repos/claude-code-cache-fix/test/proxy-usage-log.test.mjs:341), [test/proxy-usage-log.test.mjs](/home/manager/git_repos/claude-code-cache-fix/test/proxy-usage-log.test.mjs:366)).
- I also validated a synthesized emitted row against `claude-meter`’s external `MeterRowSchema.parse()` from `/home/manager/git_repos/claude-meter/src/log/schema.mjs`; the record parsed successfully.

## Blockers

None

## What Needs Attention

- No blocking findings in `e1a89f4`.

## Recommendations

- Keep the cross-repo release ordering called out in the directive intact: proxy release first, then claude-meter ingest release.
- When follow-up changes touch this wire format, continue validating against the external `MeterRowSchema` directly; this implementation is now tightly coupled to that contract by design.

## Bottom Line

APPROVE. The implementation in `e1a89f4` matches the approved directive at `efb9789`, satisfies the strict `MeterRowSchema` v:1 contract from `claude-meter`, preserves the intended `usage-log` activation model, and is backed by both targeted and full-suite passing tests.
