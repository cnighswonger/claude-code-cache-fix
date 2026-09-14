# Benchmarking the cache-fix proxy

*A methodology for external evaluators.*

The proxy's job is to reduce token cost on **resumed and long-running** Claude Code sessions. That's a specific effect on specific traffic. If you measure the wrong traffic — or measure it without controlling the variables that dominate the signal — you get a wrong-and-unflattering number that isn't really about the proxy.

This doc is here so a careful person can measure honestly and reach a number that means what it looks like it means. It says what to measure, what to control, and — the section that matters — **what the proxy does not improve.**

## What to measure, and why

The metric that's easy to reach for is *cache hit rate* (`cache_read / (cache_read + cache_creation)`). It's useful as a leading indicator, but it's not the outcome — **cost per unit of work** is.

Anthropic's prompt-cache billing weights (as of Claude 4.x):

| Token class | Weight vs input |
|---|---|
| `input` (uncached) | 1.0× |
| `cache_read` | 0.1× |
| `cache_creation` (5m tier) | 1.25× |
| `cache_creation` (1h tier) | 2.0× (conservative — see below) |

The 2.0× figure is what our own `tools/quota-analysis.mjs:57` uses (`W_CACHE_CREATION = 2.0; // 1h tier conservative; 5m would be 1.25`); the true 1h weight is not published verbatim by Anthropic and we've held the conservative side of the range. An evaluator computing headline cost from these numbers is inheriting that assumption — worth stating rather than borrowing silently.

Two implications:

1. **A hit-rate improvement from 82% → 95% is not "13% cheaper" — it's much more** than that, because the bytes that move are moving from `cache_creation` (1.25× or 2×) down to `cache_read` (0.1×), a 12.5–20× reduction on those bytes.
2. **Cost per turn is the honest bottom line.** Compute it from the per-request usage numbers CC records in its own transcripts; do not eyeball hit rate alone.

The proxy already emits this. `proxy/extensions/cache-telemetry.mjs:230` writes a per-session JSON file to `~/.claude/quota-status/sessions/<session-id>.json` on every response, with the shape:

```json
{
  "cache": {
    "ttl_tier": "1h",
    "cache_creation": 811,
    "cache_read": 50670,
    "ephemeral_1h": 811,
    "ephemeral_5m": 0,
    "hit_rate": "98.4",
    "timestamp": "2026-08-04T20:54:45.996Z"
  },
  "context_tokens": 51575,
  "request_count": 12,
  "first_seen": "2026-08-04T20:45:35.896Z",
  "session_id": "00000000-0000-4000-8000-c4f1efb22203"
}
```

Read the running numbers there rather than reconstructing them from stdout. When the proxy is off, CC still records the same usage counts in its own transcript at `~/.claude/projects/<project-slug>/<session-id>.jsonl` — you get an A/B on the same fields either way.

For deeper cache-key attribution (what changed between two turns that busted the cache), `proxy/extensions/prefix-diff.mjs` snapshots the request prefix and diffs consecutive turns. That is diagnosis, not headline measurement — mention it in a report only when you want to explain *why* one variant lost to the other.

## The two preconditions that dominate every measurement

**Every A/B without these controlled is a coin flip against noise.**

### 1. Warm turn, not cold turn

The proxy's value is on sessions that reuse a prefix. A fresh session with no prior turns has no prefix to reuse, so both variants pay `cache_creation` for the whole system prompt on turn 1 and there is nothing to differentiate.

Operationally, **"warm turn"** means: at least one prior request in the same session has completed successfully, its response is written to the transcript, and the next request is going out into a session whose base URL hasn't changed. The first request that meets those conditions is the first warm turn. Turn 2 of a straight-through session, or turn N+1 of a `--resume`d session, both qualify.

Measure the same turn on both variants — turn 2 direct vs turn 2 proxy, resume-turn-1 direct vs resume-turn-1 proxy. **Don't compare turn 1 of one to turn 5 of the other.** They measure different things.

### 2. TTL tier

The Anthropic API assigns a cache TTL tier — currently either 5 minutes or 1 hour — to a given prefix based on server-side heuristics that aren't fully documented. The two tiers bill `cache_creation` at 1.25× and 2× respectively (see table above), and eligibility for the 1h tier changes what stays cached across a real user's pauses (bathroom break, coffee, lunch).

If one variant lands on 1h and the other on 5m, you are not comparing the proxy against direct — you are comparing 1h against 5m and the proxy signal is inside the noise. Check `cache.ttl_tier` in the per-session JSON on both sides before believing any delta.

The proxy's `ttl-management` extension attempts to keep sessions on the 1h tier. Directly-connected sessions will sometimes land on 5m. **A comparison across mismatched tiers is invalid**; either re-run until both variants land on the same tier, or report the tier alongside the number and let the reader account for it.

## A concrete A/B protocol

The minimum a comparison needs to mean something:

**Workload definition** — pick something representative and pin it. A worked example: "one Codex-review session on a mid-sized PR (~500 lines diff), 20 turns of prompting from a fixed script, no `/clear`, no `/compact`." Whatever you pick, write it down so the same workload can be reproduced.

**Pairing** — run each variant N times, alternating (`proxy, direct, proxy, direct, …`). Don't run all proxy first then all direct — server-side state (rate limits, tier assignments, model warmth) drifts.

**Preconditions per run**, in this order:
1. Fresh CC session (`claude` cold, no `--resume`).
2. Discard turn 1's measurement — it's the cold turn.
3. Record from turn 2 onward.
4. Confirm `cache.ttl_tier` is the same in both variants' per-session JSON. If it isn't, discard that pair.

**What to record per turn**:
- `cache_read`
- `cache_creation`
- `input` (uncached prompt tokens)
- `output`
- `ttl_tier`
- turn number
- wall-clock time (rate-limit correlation, not the headline number)

**How many runs** — a single pair is anecdote. Ten pairs is enough for a directional signal on a moderately-varying workload. If the delta is small (single-digit percent), you need more runs than the delta looks like it deserves, because per-turn variance from server-side prompt-cache assignments is not small.

**What to report**:
- Median cost per turn, both variants, computed with the weights above.
- The tier both variants ran on.
- CC version.
- Number of paired runs.
- Workload description terse enough to reproduce.

## What the proxy does NOT improve

An honest report includes this section. The proxy's value has real boundaries:

- **Cold, single-turn sessions.** No prior prefix, nothing to reuse. Whichever variant caches first "wins" for the wrong reason. Cost per turn is dominated by initial system-prompt tokens, and the proxy has no room to help here.
- **Sessions that avoid resume.** If your workload is a pattern of many short fresh sessions rather than fewer long ones, the proxy carries overhead (a local network hop, an extension pipeline) against a small ceiling of improvement.
- **Small system prompts.** The wins scale with the size of the prefix that would otherwise be re-billed. A minimal system-prompt session has little to save.
- **Tool-call-heavy turns on non-deferred tools.** The extension pipeline touches tool ordering, not tool execution; a workload dominated by tool latency won't see time-per-turn move at all, even if cost-per-turn does.
- **Sessions on 5m tier throughout.** The `ttl-management` extension is the largest-lever component on the cost side; without a 1h assignment, its arithmetic is smaller.

If your evaluation is on any of these workloads, the honest number is close to "no significant difference." That's the correct result, and the proxy is not the right tool for that workload.

## Reproducing the README's headline number

The README currently reads:

> A/B baseline (v3.0.0 on v2.1.117): **95.5% cache hit rate through proxy vs 82.3% direct** on first warm turn.

Provenance: this measurement is from **v3.0.0** (released 2026-04-22), A/B tested on Claude Code **v2.1.117**, comparing all-extensions-enabled proxy against a direct-to-Anthropic connection, sampling the first warm turn. Documented at the time in `docs/extension-impact-guide.md:80` (added 2026-04-23 in commit `573fd42`) and in the [v3.0.0 release notes](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.0.0).

**What we can reproduce:** the shape of the measurement — first warm turn, hit-rate reported, on CC v2.1.117.

**What we cannot fully reproduce** from the record on disk:
- The exact workload (session length, prompt content, tool set) was not captured with the number.
- The number of paired runs behind "95.5% vs 82.3%" was not recorded.
- The `ttl_tier` on each variant at the moment of measurement is not in the record.

The current release is `v4.x`, three major-version pipelines ahead of the measurement. Extensions added to `proxy/extensions/` since v3.0.0 (verified against `git log --diff-filter=A -- proxy/extensions/*.mjs`, first-added date shown): `thinking-display.mjs` (2026-05-17), `bootstrap-defense.mjs` (2026-05-25), `session-health.mjs` (2026-05-28), `thinking-block-sanitize.mjs` (2026-05-29), `auto-1m-guard.mjs` (2026-06-03), `image-retry-circuit-breaker.mjs` (2026-06-12), `read-dedupe.mjs` (2026-06-24), `session-budget-breaker.mjs` (2026-07-27), `insertion-normalization.mjs` (2026-08-06), and several others; plus pipeline reorderings. We have not re-measured on v4.x under a controlled A/B, so the headline is **directional guidance** for the current release, not a claim of current-release provenance.

If you're evaluating v4.x specifically, treat the headline as "the improvement is real and non-trivial on the workloads it targets" — not as a number to test the current release against. Then apply this doc's protocol to derive a number on your own workload.

## When we ship a new headline number

The next headline measurement in `README.md` will be from a controlled A/B on current `main` that follows this document's protocol, with the workload, tier, run count, and CC version pinned in a companion note in `docs/`. Until then, the released number stays with its v3.0.0 attribution and this caveat.

## Related instrumentation

- `proxy/extensions/cache-telemetry.mjs` — per-session JSON writer. Source of `cache.ttl_tier`, `cache.cache_read`, `cache.cache_creation`, `cache.hit_rate`, `context_tokens`, `request_count`, `first_seen`. Files at `~/.claude/quota-status/sessions/`.
- `proxy/extensions/prefix-diff.mjs` — cache-key attribution. Snapshots the request prefix and diffs consecutive turns; useful for explaining a delta, not for measuring it.
- `tools/cost-report.mjs` — cost roll-up from the local usage log across a time window; a sanity check against the per-session JSON aggregation.
- `tools/quota-analysis.mjs` — models the `cache_read` billing weight under three hypotheses (0×, 0.1×, 1×); the code at `tools/quota-analysis.mjs:57` and `:241` documents the weights used above.
- `tools/cache-test.sh` — a shell harness for exercising fresh/resume/continue modes end-to-end.
- `docs/extension-impact-guide.md` — per-extension impact narrative with the original 2026-04 measurement context.
