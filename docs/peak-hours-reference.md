# Anthropic Peak Hour Throttling — Reference

## Policy

Since March 27, 2026, Anthropic applies elevated quota drain rates during weekday peak hours.
The 5-hour session window depletes faster during these periods. Weekly limits are unchanged.

## Peak Hours

**13:00 – 19:00 UTC, Monday through Friday**

| Time Zone | Peak Window |
|-----------|-------------|
| UTC | 13:00 – 19:00 |
| US Eastern (EDT) | 9:00 AM – 3:00 PM |
| US Pacific (PDT) | 6:00 AM – 12:00 PM |
| UK (BST) | 2:00 PM – 8:00 PM |
| Japan/Korea (JST/KST) | 10:00 PM – 4:00 AM |

Weekends are entirely unaffected.

## What is known

- No specific multiplier or drain rate has been disclosed by Anthropic
- ~7% of all users are affected; ~2% of Max 20x users notice a difference
- Pro subscribers are most affected
- The mechanism adjusts consumption rates without changing total weekly limits
- Peak hour status was announced informally via an Anthropic engineer's X (Twitter) post, not through official documentation

## What is NOT known

- The exact multiplier applied to token consumption during peak hours
- Whether the multiplier varies by plan tier
- Whether the multiplier has changed since initial deployment
- Whether cache read vs cache creation tokens are weighted differently during peak hours

## Sources

1. **Thariq (Anthropic engineer) via X** — Original announcement, March 26, 2026. Stated that 5-hour limits drain faster during weekday peak hours (5am-11am PT). Attributed extreme cases to "expensive prompt cache misses."

2. **[The Register — "Anthropic tweaks usage limits"](https://www.theregister.com/2026/03/26/anthropic_tweaks_usage_limits/)** — March 26, 2026. First press coverage of the peak-hour adjustment.

3. **[PCWorld — "Anthropic confirms it's been adjusting Claude usage limits"](https://www.pcworld.com/article/3100787/anthropic-confirms-its-been-adjusting-claude-usage-limits.html)** — Confirmed through direct outreach to Anthropic.

4. **[Piunikaweb — "Anthropic explains Claude usage limits peak hours"](https://piunikaweb.com/2026/03/27/anthropic-explains-claude-usage-limits-peak-hours/)** — March 27, 2026. Details on ~7% user impact figure.

5. **[TokenCalculator — "Claude Peak Hours 2026"](https://tokencalculator.com/blog/claude-peak-time-throttle-quota-drains-faster-weekdays-2026)** — Analysis with time zone conversions.

## Interceptor integration

The interceptor detects peak hours and:
- Sets `peak_hour: true/false` in the quota-status payload (proxy mode v3.5.0+: `~/.claude/quota-status/account.json`; preload mode: `~/.claude/quota-status.json`)
- Logs `PEAK HOUR: weekday 13:00-19:00 UTC` in the debug log when `CACHE_FIX_DEBUG=1`
- Enables the status line to display `PEAK` (yellow) during peak windows

This allows burn rate analysis to separate peak vs off-peak data.
