# Review: PR #299 README trust reorder

Date: 2026-08-02
Reviewed: `README.md` at `9ef96c6a33bf2424030b8dad15e6107bd92bfafc`
Round: 1
Label applied: changes-requested

> **Note on session UUIDs in this file.** The `<session-uuid>` placeholder is replaced in the measured commands below with a synthetic `00000000-0000-4000-8000-*` value, not with the real session id used at measurement time. The measurement was reproduced on a real session; the replacement is a shape-preserving substitute so the command reads correctly to future readers without leaking a real capture identifier. This file was scrubbed retroactively as part of #318 (see that issue for the leak history; real ids are treated as burned).

## What Is Correct
- [Measured] Line 7 is byte-identical to `origin/main`. Command: `node ... compare README line 7` → `"equal": true`.
- [Read] The access disclosure remains verbatim and `## Security model` still exists later in the file at `README.md:667-677`; the new summary links to `#security-model` from `README.md:15`.
- [Read] The default bind claim is supported by code: `proxy/config.mjs:27-29` defaults `bind` to `127.0.0.1`, and `proxy/server.mjs:531-599` listens on that bind.
- [Read] The "`POST /v1/messages` can be read and rewritten" claim is supported by `proxy/server.mjs:466` routing that path into `handleMessages`, whose pre-forward pipeline mutates `ctx.body` / `ctx.headers` before forwarding (`proxy/server.mjs:82-119`, `148-157`).
- [Read] The "stock Claude Code already writes the transcript fields" premise holds up. In the extension tree, the only `projects/` reference is a comment in `proxy/extensions/usage-log.mjs:47-49`; no extension writes under `~/.claude/projects/`. Writes go to other `~/.claude/*` paths such as `usage.jsonl`, `quota-status`, and session mirrors (`proxy/extensions/usage-log.mjs:279-287`, `proxy/extensions/cache-telemetry.mjs:292-333`, `proxy/session-mirror-writer.mjs:6-23`).

## Blockers
- [Measured] `README.md:54-60` says the one-liner can be run before installing anything, but the exact command as written exits non-zero on a real transcript that has no usage rows. Command run verbatim from the fenced block with only `<session-uuid>` replaced: `jq ... ~/.claude/projects/*/00000000-0000-4000-8000-c4f1efb22201.jsonl | sort -u -k1,1 | cut -f2 | awk ...` → `status=2`, `awk: cmd. line:1: fatal: division by zero attempted`. This was the highest-risk item called out for the review, and in the new trust-earning section it needs to fail safe.
- [Read] `README.md:18-19` overstates the code with “makes no other outbound calls.” That is not true across the shipped code paths. Opt-in OAuth refresh does a direct `fetch(..., { method: "POST" })` in `proxy/oauth/refresher.mjs:223-228`, and forward-proxy download rewrite re-issues requests to `storage.googleapis.com` / `downloads.claude.ai` in `proxy/forward-proxy.mjs:337-375` and `437-463`. The existing late security section already says “No network calls,” but this PR duplicates that claim into the prominent top trust block where readers are asked to rely on it. It needs a qualifier such as “by default” or a narrower statement about unsolicited/self-initiated calls.

## What Needs Attention
- [Measured] I did not reproduce the README’s exact “183 local sessions / 90% of short sessions” statistic with an independent sweep over the current top-level local transcripts. Command: a line-by-line Node pass over `~/.claude/projects/*/*.jsonl`, top-level sessions only, valid JSONL only, dedup by `requestId` per file. Result: `total=276`, `short(<20)=240`, `short |delta|>=1pt = 128 (53%)`, `long(>=20)=36`, `long |delta|>=1pt = 3 (8%)`, `worst=41.106...`. The worst-case and long-session shape line up, but the population size and short-session percentage do not. That does not prove the README number is wrong; it does show the sample boundary is underspecified enough that an independent measurement on the same host later the same day lands elsewhere.
- [Measured] The executable command does work on a real session with usage rows, and the placeholder is clearly a placeholder. Command extracted from `README.md:54-60` with only `<session-uuid>` replaced by `00000000-0000-4000-8000-c4f1efb22202` ran successfully and returned `cache_read=4942913870 creation=51231243 read-ratio=99%`. The placeholder clarity comes from the literal angle-bracket token in `README.md:55,58`; the problem is the zero-row case above, not placeholder ambiguity.

## Bloat / Non-Functional
- [Measured] Proportionate. Diff size is `+75/-0` in `README.md` only. Production LOC: `0`. Test:prod ratio: not applicable. New files / exports / env vars / on-disk paths: `0`. Comment:code ratio: not applicable for a docs-only PR.

## Recommendations
- Guard the `awk` denominator so a transcript with zero matching rows prints an explanatory message and exits cleanly instead of failing. This needs to be fixed in the exact command readers are told to run first.
- Soften the outbound-call bullet to match code reality. The safest version is to scope it to the default reverse-proxy path and explicitly exclude opt-in features that perform their own egress.
- If the short-session dedup statistic stays in the README, state the sample boundary precisely enough that another reviewer can reproduce the same population.

## Bottom Line
The reordering itself is directionally right and the acceptance criteria about line 7, the access disclosure, and the retained security section are met. I am not approving this pass because the new “measure before install” command still breaks on a real no-usage transcript, and the new top-level trust summary currently makes a stronger outbound-traffic claim than the code supports. Fix those two items and this should be ready for a quick re-review.

— Codex review
