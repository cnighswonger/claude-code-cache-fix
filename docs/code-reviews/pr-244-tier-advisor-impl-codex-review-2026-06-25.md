# Review: PR #244 tier-advisor implementation

Date: 2026-06-25
Reviewed: PR #244 (`feature/tier-advisor-impl`) at `22a8175cbc67a4ec696c512c7560f790169c5d78`
Round: 1
Label applied: changes-requested

## What Is Correct

The implementation lands in the requested shape: `tools/tier-advisor.mjs` is a standalone CLI with no proxy extension, and `tools/quota-statusline.sh` only reads the persisted advisor state and appends a single `tier:` token. The statusline change preserves the existing heredoc security model: hook input is still read from `CC_INPUT` via `os.environ`, and the new tier-advisor state read is a fixed path with no shell interpolation.

The modern quota path pin is correct. The advisor defaults to `~/.claude/quota-status/account.json` and does not read the preload-era `~/.claude/quota-status.json`; tests override the path with `CACHE_FIX_ADVISOR_QUOTA_STATUS`.

The focused tests cover the prior directive blockers at the helper/API level: single exit-code mapping across default / `--json` / `--quiet`, bounded newest-first `weeks[]`, no duplicate same-week records, projection cap at 200%, additive overage-warning enrichment, and statusline omission for `tier:ok`. Test 30's structural comparison that ignores sub-millisecond float drift is acceptable because those fields are intentionally `now`-dependent.

## Blockers

1. `usage.jsonl` fallback does not produce a valid projection and can silently return `tier:ok` on high burn.

   In `tools/tier-advisor.mjs:425-442`, the fallback branch computes a log-derived `burnRate` and sets `burnRateSource = "log"`, but `tools/tier-advisor.mjs:456-459` only projects when `q7dPct` came from `account.json`. If `account.json` is missing, projection becomes `0`; if `account.json` is stale, the projection combines stale header Q7d percent with log-derived burn. Both cases violate the directive's binary source rule: primary = fresh header, fallback = usage log, never blend.

   Reproduction against this PR:

   ```bash
   tmp=$(mktemp -d)
   node -e 'console.log(JSON.stringify({ts: new Date().toISOString(), usage:{input_tokens:200000000, cache_creation_input_tokens:0, cache_read_input_tokens:0}}))' > "$tmp/usage.jsonl"
   CACHE_FIX_ADVISOR_QUOTA_STATUS="$tmp/missing-account.json" \
   CACHE_FIX_ADVISOR_USAGE_LOG="$tmp/usage.jsonl" \
   CACHE_FIX_ADVISOR_STATE="$tmp/state.json" \
   CACHE_FIX_ADVISOR_PLAN=max-5x \
   node tools/tier-advisor.mjs --json
   ```

   The output records `burn_rate_source: "log"` and `burn_rate_per_hour: 0.92...`, but `current_q7d_pct: null`, `projected_q7d_at_reset: 0`, `recommendation: "ok"`, and exit `0`. A 200M weighted-token current-week log on a 204M plan is not a hold signal. The fallback path needs to derive the current-week consumed percent from the same log token sum used for burn rate, then project from that value and persist week observations from that same source. Add a test where `account.json` is absent or stale, `usage.jsonl` alone implies an upgrade, and the recommendation/exit code are `upgrade`/`1`.

## What Needs Attention

- `--week` is documented as historical analysis (`tools/tier-advisor.mjs:628`) and parsed (`tools/tier-advisor.mjs:72-73`), but the parsed value is not used by `runAdvisor`. The current test only asserts parse acceptance, despite the test name saying it affects analysis. If historical analysis is still in scope, implement it; otherwise remove the behavior claim from help/docs and make the test name honest.

- Runtime heuristic plan detection is currently a stub: `recentQ5hBudgetTokens()` always returns `null`, so the CLI's actual plan order is CLI override, env override, fallback unknown. That can be acceptable only if the fallback is intentionally the v1 behavior, but it does not match the directive checklist's stated heuristic step. Either wire a real heuristic from available quota/usage data or document the limitation consistently in the PR docs and tests.

- `docs/monitoring.md:27` mentions a "FIRST-keeper byte-stability guarantee" that belongs to read-dedupe, not the tier-advisor state history. This is a docs copy/paste artifact and should be corrected while the PR is already open.

## Bloat / Non-Functional

None. The CLI is intentionally self-contained and uses Node built-ins only; the size is mostly tests and explicit formatting/state helpers, not unnecessary abstraction.

## Recommendations

Keep the fallback math single-source: have the usage-log path return both `currentPct` and `burnRate`, set `current_q7d_pct` from the log-derived percent, and avoid carrying stale/missing header utilization into projection or state. That will also make the `burn_rate_source` field auditably true.

After the fallback fix, add a regression test for stale `account.json` plus high `usage.jsonl` to prove the stale header percent is not blended with log burn. The existing missing-both-inputs test does not exercise the fallback recommendation path.

## Bottom Line

REQUEST_CHANGES. The implementation is close and the statusline/security pieces look sound, but the fallback burn-rate path currently violates the load-bearing single-source contract and can suppress an upgrade recommendation exactly when `account.json` is unavailable or stale.

— Codex review
