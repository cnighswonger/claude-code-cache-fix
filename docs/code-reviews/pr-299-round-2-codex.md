# Review: PR #299 README trust reorder

Date: 2026-08-02
Reviewed: `README.md`, `proxy/config.mjs`, `proxy/forward-proxy.mjs`, `proxy/oauth/refresher.mjs` at `1b776d9`
Round: 2
Label applied: approved-by-codex-agent

> **Note on session UUIDs in this file.** The `<session-uuid>` placeholder is replaced in the measured commands below with a synthetic `00000000-0000-4000-8000-*` value, not with the real session id used at measurement time. The measurement was reproduced on a real session; the replacement is a shape-preserving substitute so the command reads correctly to future readers without leaking a real capture identifier. This file was scrubbed retroactively as part of #318 (see that issue for the leak history; real ids are treated as burned).

## What Is Correct

- [Measured] The README's published cache-health command now handles the no-usage case cleanly. Extracting the command block from `README.md:59-67`, replacing `<session-uuid>` with `00000000-0000-4000-8000-c4f1efb22201`, and executing it returned `no usage rows found — check the session path` with `EXIT=0`.
- [Measured] The same extracted command still works on a session with usage rows. Replacing `<session-uuid>` with `00000000-0000-4000-8000-c4f1efb22202` returned `requests=11733 cache_read=4942913870 creation=51231243 read-ratio=99%` with `EXIT=0`. Independently counting unique `requestId` values in that transcript also produced `11733`, so the new `requests=` field is accurate for the "fewer than ~20 requests" guidance in `README.md:75-83`.
- [Read] The top trust block no longer overstates the outbound-traffic claim. It now scopes the statement to the default path and names the two opt-in exceptions in `README.md:18-24`. Both exceptions are default-off in code: OAuth refresh is gated by `process.env.CACHE_FIX_OAUTH_REFRESH === "on"` in `proxy/config.mjs:46-49`, and download rewrite is gated by `process.env.CACHE_FIX_DOWNLOAD_REWRITE === "on"` plus bucket discovery in `proxy/config.mjs:65-79` and `proxy/forward-proxy.mjs:38-44,482-486`.
- [Read] I did not find a third shipped egress path beyond Claude Code traffic to Anthropic and the two named opt-in exceptions. The only proxy-local outbound network initiators in `proxy/` are the OAuth refresh POST in `proxy/oauth/refresher.mjs:223-228`, the forward-proxy tunnel / relay path for normal upstream traffic in `proxy/forward-proxy.mjs:266,298,371,437`, and the download-rewrite path guarded by `downloadRewriteActive()` in `proxy/forward-proxy.mjs:42-44,482-486`.
- [Measured] The softened duplicate-row statistic is supported by my round-1 sweep. The surviving README claim in `README.md:75-77` matches the earlier measured shape: short sessions over half at `128/240 = 53%`, worst case `41.106...`, and long sessions `3/36`, which the README rounds to `3 of ~37`.
- [Measured] The round-1 invariants remain intact. `README.md:7` is byte-identical to `origin/main`, the access disclosure at `README.md:25-26` is unchanged, the `## Security model` section at `README.md:675-685` is byte-identical to `origin/main`, and the anchor target remains the literal `## Security model` heading (`#security-model`).

## Blockers

None.

## What Needs Attention

None.

## Bloat / Non-Functional

None. Documentation-only PR; no production code added.

## Recommendations

Approve PR #299.

## Bottom Line

Round-1 blockers are closed. The executable README command now fails soft on empty transcripts, the trust block's outbound-traffic statement is aligned with the shipped gates, and the surviving statistics are within the bounds of the independently measured data. This is ready to merge.
