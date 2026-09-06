# Monitoring & Diagnostics

The preload interceptor includes monitoring for several issues identified by the community. These features work in preload mode (CC ≤v2.1.112). The proxy mode provides cache telemetry via the `cache-telemetry` extension; other monitoring features below are preload-specific.

## Microcompact / budget enforcement

Claude Code silently replaces old tool results with `[Old tool result content cleared]` via server-controlled mechanisms (GrowthBook flags). A 200,000-character aggregate cap and per-tool caps (Bash: 30K, Grep: 20K) truncate older results without notification. There is no `DISABLE_MICROCOMPACT` environment variable.

The interceptor detects cleared tool results and logs counts. When total tool result characters approach the 200K threshold, a warning is logged.

## False rate limiter

The client can generate synthetic "Rate limit reached" errors without making an API call, identifiable by `"model": "<synthetic>"`. The interceptor logs these events.

## GrowthBook flag dump

On the first API call, the interceptor reads `~/.claude.json` and logs the current state of cost/cache-relevant server-controlled flags (hawthorn_window, pewter_kestrel, slate_heron, session_memory, etc.).

## Quota tracking

Response headers are parsed for `anthropic-ratelimit-unified-5h-utilization` and `7d-utilization`, saved for consumption by status line hooks or other tools. Proxy mode (v3.5.0+, via `cache-telemetry` extension) splits state into `~/.claude/quota-status/account.json` (account-global facts) plus `~/.claude/quota-status/sessions/<filename>.json` (per-session cache facts), so multi-agent users no longer see cross-session contamination. Preload mode keeps the legacy single-file `~/.claude/quota-status.json` (single-session by construction).

## Tier upgrade/downgrade advisor

`tools/tier-advisor.mjs` is a CLI tool that consumes the proxy-written `account.json` snapshot and the per-call `usage.jsonl` log, projects this week's Q7d burn forward to the weekly reset, and emits a tier-change recommendation (`tier:upgrade` / `tier:downgrade` / `tier:ok` / `tier:unknown`). Designed to be run on a cron / shell alias; the cache-fix statusline picks up the persisted recommendation and appends a single token to the user's prompt.

See [`docs/tier-advisor.md`](tier-advisor.md) for the full reference: exit codes, CLI flags, env vars (`CACHE_FIX_ADVISOR_*`), cron setup, state-file shape, and the calendar-week-scoped history semantics. Directive: [`docs/directives/proxy-tier-advisor.md`](directives/proxy-tier-advisor.md) (PR #93, issue #63).

## Peak hour detection

Anthropic applies elevated quota drain rates during weekday peak hours (13:00–19:00 UTC, Mon–Fri). The interceptor detects peak windows and writes `peak_hour: true/false` to the quota-status payload (`account.json` in proxy mode, `quota-status.json` in preload mode). See `docs/peak-hours-reference.md` for sources and details.

## Usage telemetry and cost reporting

The interceptor logs per-call usage data to `~/.claude/usage.jsonl` — one JSON line per API call with model, token counts, and cache breakdown. Use the bundled cost report tool to analyze costs:

```bash
node tools/cost-report.mjs                    # today's costs from interceptor log
node tools/cost-report.mjs --date 2026-04-08  # specific date
node tools/cost-report.mjs --since 2h         # last 2 hours
node tools/cost-report.mjs --admin-key <key>  # cross-reference with Admin API
```

Also works with any JSONL containing Anthropic usage fields (`--file`, stdin) — useful for SDK users and proxy setups. See `docs/cost-report.md` for full documentation.

## Quota analysis (5-hour quota counting)

The same `usage.jsonl` log can be analyzed to test how Anthropic's 5-hour quota is actually computed. Run the bundled tool:

```bash
node tools/quota-analysis.mjs              # analyze your default log
node tools/quota-analysis.mjs --since 24h  # last 24 hours only
node tools/quota-analysis.mjs --json       # machine-readable output
```

The tool answers three questions from your own data:

1. **Does `cache_read` count toward your 5-hour quota?** Tests three hypotheses (cache_read costs 0x / 0.1x / 1x of input rate) and reports which one best explains your `q5h_pct` trajectory across reset windows.
2. **Do peak hours cost more quota per token?** Splits windows into peak-dominant (≥80% peak calls) and off-peak-dominant (≤20%) and compares the implied 100% quota.
3. **What is your account's effective 5-hour quota in token-equivalents?** Reports a concrete number you can compare against your subscription tier.

Requires `q5h_pct`, `q7d_pct`, and `peak_hour` fields in usage.jsonl, which were added in v1.6.1 (2026-04-09).

**Help us validate across accounts:** if you run this on your own log, please open an issue or PR with your output. Cross-validating across multiple accounts is the only way to distinguish per-account variance from real findings. Reference: [anthropics/claude-code#45756](https://github.com/anthropics/claude-code/issues/45756).

## Debug mode

Enable debug logging to verify the fix is working:

```bash
CACHE_FIX_DEBUG=1 claude-fixed
```

Logs are written to `~/.claude/cache-fix-debug.log`. Look for:
- `APPLIED: resume message relocation` — block scatter was detected and fixed
- `APPLIED: tool order stabilization` — tools were reordered
- `APPLIED: fingerprint stabilized from XXX to YYY` — fingerprint was corrected
- `APPLIED: stripped N images from old tool results` — images were stripped
- `APPLIED: output efficiency section rewritten` — output-efficiency section was replaced
- `MICROCOMPACT: N/M tool results cleared` — microcompact degradation detected
- `BUDGET WARNING: tool result chars at N / 200,000 threshold` — approaching budget cap
- `FALSE RATE LIMIT: synthetic model detected` — client-side false rate limit
- `GROWTHBOOK FLAGS: {...}` — server-controlled feature flags on first call
- `PROMPT SIZE: system=N tools=N injected=N (skills=N mcp=N ...)` — per-call prompt size breakdown
- `CACHE TTL: tier=1h create=N read=N hit=N% (1h=N 5m=N)` — TTL tier and cache hit rate per call
- `PEAK HOUR: weekday 13:00-19:00 UTC` — Anthropic peak hour throttling active
- `SKIPPED: resume relocation (not a resume or already correct)` — no fix needed
- `SKIPPED: output efficiency rewrite (section not found)` — no matching output-efficiency section found

### Prefix diff mode

Enable cross-process prefix snapshot diffing to diagnose cache busts on restart:

```bash
CACHE_FIX_PREFIXDIFF=1 claude-fixed
```

Snapshots are saved to `~/.claude/cache-fix-snapshots/` and diff reports are generated on the first API call after a restart.

## Environment variables (preload mode)

Proxy mode uses extension configuration in `proxy/extensions.json`. These env vars apply to the preload interceptor.

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_FIX_DEBUG` | `0` | Enable debug logging to `~/.claude/cache-fix-debug.log` |
| `CACHE_FIX_PREFIXDIFF` | `0` | Enable prefix snapshot diffing |
| `CACHE_FIX_IMAGE_KEEP_LAST` | `0` | Keep images in last N user messages (0 = disabled) |
| `CACHE_FIX_IMAGE_MAX_DIM` | `0` | Legacy strip-only cap (px). v3.2.1 behavior; still works standalone |
| `CACHE_FIX_IMAGE_GUARD` | `0` | v3.3.0 image-guard pipeline gate. `=1` enables Pass 1 + Pass 2 + count cap |
| `CACHE_FIX_IMAGE_PRESERVE_DETAIL` | `0` | Adds Pass 3 Lanczos resize via `sharp`. Requires `IMAGE_GUARD=1` |
| `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX` | `31457280` | Pass 2 byte budget (30 MB; 2 MB headroom from Anthropic's 32 MB ceiling) |
| `CACHE_FIX_IMAGE_COUNT_MAX` | `100` | Hard image-count cap. Set `600` for legacy Claude 1/2.x/Instant if needed |
| `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT` | unset | Replace Claude Code's `# Output efficiency` system-prompt section |
| `CACHE_FIX_USAGE_LOG` | `~/.claude/usage.jsonl` | Path for per-call usage telemetry log |
| `CACHE_FIX_DISABLED` | `0` | Disable all bug fixes; keep monitoring + optimizations active |
| `CACHE_FIX_SKIP_RELOCATE` | `0` | Skip block relocation fix |
| `CACHE_FIX_SKIP_FINGERPRINT` | `0` | Skip fingerprint stabilization |
| `CACHE_FIX_SKIP_TOOL_SORT` | `0` | Skip tool ordering stabilization |
| `CACHE_FIX_SKIP_TTL` | `0` | Skip TTL injection |
| `CACHE_FIX_SKIP_IDENTITY` | `0` | Skip identity normalization |
| `CACHE_FIX_SKIP_GIT_STATUS` | `0` | Skip git-status stripping |
| `CACHE_FIX_STRIP_GIT_STATUS` | `0` | Strip volatile git-status from system prompt |
| `CACHE_FIX_TTL_MAIN` | `1h` | TTL for main-thread requests: `1h`, `5m`, or `none` |
| `CACHE_FIX_TTL_SUBAGENT` | `1h` | TTL for subagent requests: `1h`, `5m`, or `none` |
| `CACHE_FIX_DUMP_BREAKPOINTS` | unset | Path to dump cache breakpoint structure (diagnostic for #12) |
| `CACHE_FIX_DUMP_MICROCOMPACT` | unset | (proxy) Path for diagnostic JSONL dump of CC's `time_based_microcompact` sentinel. Read-only — no mutation. |
| `CACHE_FIX_NORMALIZE_MICROCOMPACT` | unset | (proxy) Enable sentinel normalization (`=1` opts in). Mutates Mode A matches to canonical byte-stable form. |
| `CACHE_FIX_MICROCOMPACT_NORMALIZED` | `[Old tool result content cleared]` | (proxy) Override the canonical replacement string. |
| `CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_<N>` | unset | (proxy) Add custom Mode A regex pattern(s); 1-indexed, sparse OK. |
| `CACHE_FIX_MICROCOMPACT_SENTINEL_PREFIX_<N>` | unset | (proxy) Custom Mode B literal prefix(es). Pair with a custom Mode A pattern from a non-default sentinel family so prefix-only variants get redacted capture too. |
| `CACHE_FIX_MICROCOMPACT_REDACT_LEN` | `64` | (proxy) Mode B prefix length in dump records. Set `0` to suppress prefix entirely. |
| `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED` | unset | (proxy) Add post-normalization text alongside raw `sentinel_text` in dump records (`=1` enables). |
