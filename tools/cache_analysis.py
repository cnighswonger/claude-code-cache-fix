"""Shared cache analysis helpers for hooks and MCP tools.

Reference Python helper for consumers that want to read cache-fix's
``quota-status`` output and reason about cache-state from a Claude Code
transcript. Used by host-side hooks (e.g. ``~/.claude/hooks/
context-advisor-analyze.py``) and MCP tools that need quota-aware
behavior.

Consumer pattern: copy or symlink this file into ``~/.claude/mcp/`` (or
wherever your hook / tool expects to import from) and ``from cache_analysis
import read_quota_status, analyze_transcript`` etc. The file ships in the
cache-fix npm package's ``tools/`` directory; npm consumers can reference
``node_modules/claude-code-cache-fix/tools/cache_analysis.py`` directly or
copy it out for non-npm installs.

The ``read_quota_status()`` helper handles both cache-fix v3.5.0+ (proxy
mode, per-session split at ``~/.claude/quota-status/account.json``) and
v3.4.x and earlier / preload mode (single global
``~/.claude/quota-status.json``). See the README's "Migration:
v3.4.x → v3.5.0+" section.
"""

import json
import subprocess
from datetime import datetime, timezone

CACHE_TTL_5M = 300                # 5-minute ephemeral TTL
CACHE_TTL_1H = 3600              # 1-hour extended TTL
CONTEXT_THRESHOLD = 50_000        # Minimum tokens to recommend compact
COMPACT_RESULT_ESTIMATE = 12_000  # Estimated tokens after compaction
CACHE_CREATE_RATE_5M = 3.75       # Opus $/MTok for 5min cache writes
CACHE_CREATE_RATE_1H = 7.50       # Opus $/MTok for 1h cache writes


def read_tail_lines(filepath, n=300):
    """Read last N lines efficiently using tail."""
    try:
        result = subprocess.run(
            ["tail", "-n", str(n), filepath],
            capture_output=True, text=True, timeout=5,
        )
        return result.stdout.splitlines()
    except Exception:
        return []


def parse_assistant_usage(lines):
    """Extract assistant messages with usage data from transcript lines."""
    messages = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") != "assistant":
            continue
        msg = obj.get("message", {})
        usage = msg.get("usage")
        ts = obj.get("timestamp")
        if not usage or not ts:
            continue
        cr = usage.get("cache_creation_input_tokens", 0)
        rd = usage.get("cache_read_input_tokens", 0)
        inp = usage.get("input_tokens", 0)
        out = usage.get("output_tokens", 0)
        if cr == 0 and rd == 0 and inp == 0:
            continue
        # Extract TTL tier breakdown if available
        cr_detail = usage.get("cache_creation", {})
        cr_1h = cr_detail.get("ephemeral_1h_input_tokens", 0) if isinstance(cr_detail, dict) else 0
        cr_5m = cr_detail.get("ephemeral_5m_input_tokens", 0) if isinstance(cr_detail, dict) else 0
        messages.append({
            "timestamp": ts,
            "input_tokens": inp,
            "cache_creation": cr,
            "cache_read": rd,
            "output_tokens": out,
            "total_in": cr + rd + inp,
            "cr_1h": cr_1h,
            "cr_5m": cr_5m,
        })
    return messages


def detect_cache_ttl(messages):
    """Detect the effective cache TTL from recent API call usage data.

    If any recent calls show ephemeral_1h_input_tokens > 0, the account
    is on the 1-hour tier. Otherwise, assume 5-minute ephemeral.
    Returns (ttl_seconds, tier_name).
    """
    recent = messages[-10:] if len(messages) >= 10 else messages
    has_1h = any(m.get("cr_1h", 0) > 0 for m in recent)
    has_5m = any(m.get("cr_5m", 0) > 0 for m in recent)

    if has_1h:
        return CACHE_TTL_1H, "1h"
    if has_5m:
        return CACHE_TTL_5M, "5m"
    # No cache_creation breakdown available — conservative default
    return CACHE_TTL_5M, "5m (default)"


def estimate_thinking_overhead(messages):
    """Estimate thinking block replay overhead.

    Thinking blocks from prior turns replay as input tokens. Heuristic:
    cumulative output_tokens approximates thinking content that gets replayed.
    """
    if len(messages) < 2:
        return 0
    return sum(m["output_tokens"] for m in messages[:-1])


def format_tokens(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}k"
    return str(n)


def format_duration(seconds):
    if seconds >= 3600:
        return f"{seconds / 3600:.1f}h"
    return f"{int(seconds / 60)}m"


def estimate_savings(total_context, ttl_tier="5m"):
    """Estimate $ savings from compacting before a cold start.

    Rate depends on the active cache TTL tier — 1h cache writes are 2x the
    5m rate. Caller should pass the tier returned by detect_cache_ttl().
    Default is the conservative 5m rate for backward compatibility.
    """
    rate = CACHE_CREATE_RATE_1H if ttl_tier.startswith("1h") else CACHE_CREATE_RATE_5M
    cold_cost = (total_context / 1_000_000) * rate
    compact_cost = (COMPACT_RESULT_ESTIMATE / 1_000_000) * rate
    return cold_cost - compact_cost


def read_quota_status():
    """Read current quota utilization from cache-fix's quota-status file.

    Written by the cache-fix interceptor from API response headers. Path
    depends on cache-fix version:
      - v3.5.0+ (proxy mode, per-session split): ~/.claude/quota-status/account.json
      - v3.4.x and earlier (or preload mode): ~/.claude/quota-status.json (flat)

    Tries the v3.5.0+ path first, falls back to the legacy flat path.
    Returns dict with five_hour/seven_day pct, or None if unavailable.
    """
    import os
    for quota_file in (
        os.path.expanduser("~/.claude/quota-status/account.json"),
        os.path.expanduser("~/.claude/quota-status.json"),
    ):
        try:
            with open(quota_file) as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
    return None


def analyze_transcript(transcript_path):
    """Full analysis of a transcript. Returns a dict with all cache state info.

    Returns None if analysis can't be performed (no data, etc).
    """
    lines = read_tail_lines(transcript_path, 300)
    if not lines:
        return None

    messages = parse_assistant_usage(lines)
    if not messages:
        return None

    last = messages[-1]
    try:
        last_ts = datetime.fromisoformat(last["timestamp"].replace("Z", "+00:00"))
    except (ValueError, KeyError):
        return None

    now = datetime.now(timezone.utc)
    gap_seconds = (now - last_ts).total_seconds()

    context_tokens = last["total_in"]
    thinking_overhead = estimate_thinking_overhead(messages)
    total_with_thinking = context_tokens + thinking_overhead

    ttl_seconds, ttl_tier = detect_cache_ttl(messages)
    cache_expired = gap_seconds > ttl_seconds

    # Last few turns' cache efficiency
    recent = messages[-5:] if len(messages) >= 5 else messages
    recent_cr = sum(m["cache_creation"] for m in recent)
    recent_total = sum(m["total_in"] for m in recent)
    cr_pct = (recent_cr / recent_total * 100) if recent_total else 0

    quota = read_quota_status()

    return {
        "context_tokens": context_tokens,
        "thinking_overhead": thinking_overhead,
        "total_with_thinking": total_with_thinking,
        "gap_seconds": gap_seconds,
        "cache_expired": cache_expired,
        "ttl_seconds": ttl_seconds,
        "ttl_tier": ttl_tier,
        "last_timestamp": last["timestamp"],
        "num_messages": len(messages),
        "recent_cr_pct": cr_pct,
        "savings": estimate_savings(total_with_thinking, ttl_tier) if cache_expired else 0,
        "quota": quota,
    }
