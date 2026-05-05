#!/usr/bin/env bash
# cross-version-cache-test — replicable cache-behavior test across installed Claude Code versions.
#
# What it tests:
#   Phase A (always): per-version steady-state cache behavior via 5 sequential Haiku -p calls,
#                     fired within seconds of each other. Captures:
#                       - Turn 1 prefix size (cache_creation cold start)
#                       - Turns 2-5 cache hit stability (should be ~100% cache_read if TTL holds)
#                       - Per-turn q5h_pct delta
#                       - TTL tier granted by server
#   Phase B (optional, --include-idle): per-version idle-gap behavior via two calls 6 minutes apart.
#                     Captures whether the 1h TTL grant holds across a >5-minute idle, or whether
#                     the server flips to 5m tier and forces a rebuild.
#
# Safety:
#   - Uses Haiku exclusively (~$0.006/call at Haiku 4.5 rates; full test at ~30 calls = ~$0.20)
#   - No deliberate quota burn; exits gracefully if Q5h > 80% at start
#   - Runs against fixed seed prompt to keep per-call overhead minimal
#   - Does not trigger overage, does not pin quota state for the session
#
# Usage:
#   ./cross-version-cache-test.sh                       # Phase A only, quick
#   ./cross-version-cache-test.sh --include-idle        # Phase A + Phase B (takes ~25 minutes)
#   ./cross-version-cache-test.sh --output /some/path   # Custom output dir
#
# Output:
#   /tmp/cross-version-test-YYYYMMDD-HHMMSS/ (default) containing:
#     - <version>-phase-a.jsonl    # one usage.jsonl record per call
#     - <version>-phase-b.jsonl    # optional, only with --include-idle
#     - summary.md                 # tabulated comparison across versions
#     - raw-quota-status-*.json    # quota state snapshots
#
# Part of claude-code-cache-fix. Requires:
#   - ~/bin/cc-version launcher (see repo)
#   - Installed versions at ~/cc-versions/<version>/ (this script checks and warns)
#   - Interceptor active (the script verifies usage.jsonl grows per call)
#
# First created 2026-04-11 for the March 23 regression investigation follow-up.

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────

VERSIONS=(2.1.81 2.1.83 2.1.90 2.1.101)
STEADY_STATE_TURNS=5
IDLE_GAP_SECONDS=360  # 6 minutes, crosses the 5m TTL boundary
SEED_PROMPT='Reply with exactly: ok'
MODEL='haiku'

# ─── CLI parsing ────────────────────────────────────────────────────────────

INCLUDE_IDLE=0
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --include-idle) INCLUDE_IDLE=1; shift ;;
        --output)       OUTPUT_DIR="$2"; shift 2 ;;
        -h|--help)
            sed -n '3,34p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "unknown flag: $1" >&2
            exit 1
            ;;
    esac
done

# Default output dir
if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="/tmp/cross-version-test-$(date +%Y%m%d-%H%M%S)"
fi

mkdir -p "$OUTPUT_DIR"
SUMMARY="$OUTPUT_DIR/summary.md"
echo "# Cross-Version Cache Test — $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SUMMARY"
echo "" >> "$SUMMARY"
echo "Output directory: \`$OUTPUT_DIR\`" >> "$SUMMARY"
echo "" >> "$SUMMARY"

# ─── Preflight ──────────────────────────────────────────────────────────────

echo "=== Cross-version cache test ===" | tee -a "$SUMMARY"

# Check launcher
if [[ ! -x "$HOME/bin/cc-version" ]]; then
    echo "ERROR: $HOME/bin/cc-version not found or not executable" >&2
    exit 1
fi

# Check installed versions
for v in "${VERSIONS[@]}"; do
    if [[ ! -f "$HOME/cc-versions/$v/node_modules/@anthropic-ai/claude-code/cli.js" ]]; then
        echo "ERROR: v$v not installed at ~/cc-versions/$v — run the install snippet in docs/march-23-regression-investigation.md" >&2
        exit 1
    fi
done

# Quota safety check — abort if Q5h is already high
Q5H=$(python3 -c "
import json
try:
    q = json.load(open('$HOME/.claude/quota-status/account.json'))
    print(q['five_hour']['pct'])
except Exception:
    print(0)
" 2>/dev/null || echo 0)

if [[ "$Q5H" -gt 80 ]]; then
    echo "ABORT: Q5h is at ${Q5H}% — too close to cap. Test deferred." | tee -a "$SUMMARY"
    exit 2
fi

echo "Preflight OK: Q5h at ${Q5H}%, 4 versions installed, launcher present." | tee -a "$SUMMARY"
echo "" | tee -a "$SUMMARY"

# Snapshot quota state at start
cp "$HOME/.claude/quota-status/account.json" "$OUTPUT_DIR/raw-quota-status-start.json" 2>/dev/null || true

# ─── Phase A: steady-state per version ─────────────────────────────────────

echo "## Phase A — Steady-state" | tee -a "$SUMMARY"
echo "" | tee -a "$SUMMARY"
echo "5 sequential Haiku calls per version, fired in quick succession (<30s gap each)." | tee -a "$SUMMARY"
echo "" | tee -a "$SUMMARY"

for v in "${VERSIONS[@]}"; do
    echo "--- Phase A: v$v ---"
    OUTFILE="$OUTPUT_DIR/$v-phase-a.jsonl"
    : > "$OUTFILE"

    for i in $(seq 1 "$STEADY_STATE_TURNS"); do
        USAGE_LINES_BEFORE=$(wc -l < "$HOME/.claude/usage.jsonl" 2>/dev/null || echo 0)
        echo "$SEED_PROMPT" | "$HOME/bin/cc-version" "$v" -p --model "$MODEL" > /dev/null 2>&1 || {
            echo "WARNING: v$v turn $i failed" | tee -a "$SUMMARY"
            continue
        }
        USAGE_LINES_AFTER=$(wc -l < "$HOME/.claude/usage.jsonl" 2>/dev/null || echo 0)
        if [[ "$USAGE_LINES_AFTER" -gt "$USAGE_LINES_BEFORE" ]]; then
            # Capture the newly-added usage.jsonl line(s) for this version
            tail -n "$((USAGE_LINES_AFTER - USAGE_LINES_BEFORE))" "$HOME/.claude/usage.jsonl" >> "$OUTFILE"
        fi
        # Tiny sleep to let the interceptor finish writing the telemetry
        sleep 0.5
    done

    TURNS_CAPTURED=$(wc -l < "$OUTFILE")
    echo "  v$v: $TURNS_CAPTURED turns captured → $OUTFILE"
done

echo "" | tee -a "$SUMMARY"

# ─── Phase B: idle-gap (optional) ──────────────────────────────────────────

if [[ "$INCLUDE_IDLE" -eq 1 ]]; then
    echo "## Phase B — Idle-gap behavior" | tee -a "$SUMMARY"
    echo "" | tee -a "$SUMMARY"
    echo "Per version: turn 1, wait ${IDLE_GAP_SECONDS}s (crosses 5m TTL), turn 2." | tee -a "$SUMMARY"
    echo "" | tee -a "$SUMMARY"

    for v in "${VERSIONS[@]}"; do
        echo "--- Phase B: v$v ---"
        OUTFILE="$OUTPUT_DIR/$v-phase-b.jsonl"
        : > "$OUTFILE"

        # Turn 1
        USAGE_LINES_BEFORE=$(wc -l < "$HOME/.claude/usage.jsonl" 2>/dev/null || echo 0)
        echo "$SEED_PROMPT" | "$HOME/bin/cc-version" "$v" -p --model "$MODEL" > /dev/null 2>&1 || true
        USAGE_LINES_AFTER=$(wc -l < "$HOME/.claude/usage.jsonl" 2>/dev/null || echo 0)
        if [[ "$USAGE_LINES_AFTER" -gt "$USAGE_LINES_BEFORE" ]]; then
            tail -n "$((USAGE_LINES_AFTER - USAGE_LINES_BEFORE))" "$HOME/.claude/usage.jsonl" >> "$OUTFILE"
        fi
        echo "  v$v: turn 1 done, waiting ${IDLE_GAP_SECONDS}s..."

        sleep "$IDLE_GAP_SECONDS"

        # Turn 2
        USAGE_LINES_BEFORE=$(wc -l < "$HOME/.claude/usage.jsonl" 2>/dev/null || echo 0)
        echo "$SEED_PROMPT" | "$HOME/bin/cc-version" "$v" -p --model "$MODEL" > /dev/null 2>&1 || true
        USAGE_LINES_AFTER=$(wc -l < "$HOME/.claude/usage.jsonl" 2>/dev/null || echo 0)
        if [[ "$USAGE_LINES_AFTER" -gt "$USAGE_LINES_BEFORE" ]]; then
            tail -n "$((USAGE_LINES_AFTER - USAGE_LINES_BEFORE))" "$HOME/.claude/usage.jsonl" >> "$OUTFILE"
        fi
        echo "  v$v: turn 2 done"
    done

    echo "" | tee -a "$SUMMARY"
fi

# Snapshot quota state at end
cp "$HOME/.claude/quota-status/account.json" "$OUTPUT_DIR/raw-quota-status-end.json" 2>/dev/null || true

# ─── Analysis ──────────────────────────────────────────────────────────────

echo "## Phase A Results" >> "$SUMMARY"
echo "" >> "$SUMMARY"

python3 <<EOF >> "$SUMMARY"
import json, os

output_dir = "$OUTPUT_DIR"
versions = ["2.1.81", "2.1.83", "2.1.90", "2.1.101"]
include_idle = $INCLUDE_IDLE

def load_jsonl(path):
    if not os.path.exists(path):
        return []
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass
    return rows

# Phase A steady-state table
print("### Per-version per-turn usage (Phase A)")
print("")
print("| Version | Turn | cc (creation) | cr (read) | prefix | out | ttl | q5h% |")
print("|---|---:|---:|---:|---:|---:|---|---:|")

for v in versions:
    rows = load_jsonl(os.path.join(output_dir, f"{v}-phase-a.jsonl"))
    for i, r in enumerate(rows, 1):
        cc = r.get("cache_creation_input_tokens", 0)
        cr = r.get("cache_read_input_tokens", 0)
        prefix = cc + cr
        out = r.get("output_tokens", 0)
        ttl = r.get("ttl_tier", "?")
        q5h = r.get("q5h_pct", "?")
        print(f"| v{v} | {i} | {cc:>6,} | {cr:>6,} | {prefix:>6,} | {out:>3} | {ttl} | {q5h}% |")

print("")

# Steady-state summary: turn-2-onwards averages
print("### Steady-state averages (turns 2-5)")
print("")
print("| Version | avg prefix | avg cc | avg cr | cache hit rate | Turn 1 cold cc | q5h delta turn 1→5 |")
print("|---|---:|---:|---:|---:|---:|---:|")
for v in versions:
    rows = load_jsonl(os.path.join(output_dir, f"{v}-phase-a.jsonl"))
    if len(rows) < 2:
        print(f"| v{v} | (insufficient data) | | | | | |")
        continue
    turn1 = rows[0]
    tail = rows[1:]
    avg_prefix = sum((r.get("cache_creation_input_tokens",0) + r.get("cache_read_input_tokens",0)) for r in tail) / len(tail)
    avg_cc = sum(r.get("cache_creation_input_tokens",0) for r in tail) / len(tail)
    avg_cr = sum(r.get("cache_read_input_tokens",0) for r in tail) / len(tail)
    hit_rate = avg_cr / avg_prefix if avg_prefix > 0 else 0
    q5h_start = rows[0].get("q5h_pct", 0)
    q5h_end = rows[-1].get("q5h_pct", 0)
    q5h_delta = (q5h_end - q5h_start) if isinstance(q5h_start, (int, float)) and isinstance(q5h_end, (int, float)) else "?"
    print(f"| v{v} | {avg_prefix:>7,.0f} | {avg_cc:>6,.0f} | {avg_cr:>6,.0f} | {hit_rate*100:.1f}% | {turn1.get('cache_creation_input_tokens',0):>7,} | {q5h_delta}% |")

print("")

if include_idle:
    print("## Phase B Results (idle-gap behavior)")
    print("")
    print("| Version | Turn 1 prefix | Turn 1 ttl | idle (s) | Turn 2 cc | Turn 2 cr | Turn 2 ttl | rebuilt? |")
    print("|---|---:|---|---:|---:|---:|---|:---:|")
    for v in versions:
        rows = load_jsonl(os.path.join(output_dir, f"{v}-phase-b.jsonl"))
        if len(rows) < 2:
            print(f"| v{v} | (incomplete) | | | | | | |")
            continue
        t1, t2 = rows[0], rows[1]
        t1_prefix = t1.get("cache_creation_input_tokens",0) + t1.get("cache_read_input_tokens",0)
        t2_cc = t2.get("cache_creation_input_tokens",0)
        t2_cr = t2.get("cache_read_input_tokens",0)
        # Idle gap we configured
        idle_s = $IDLE_GAP_SECONDS
        # Rebuilt = turn 2 had substantial cache_creation relative to turn 1 prefix
        rebuilt = "✗ expired" if t2_cc > (t1_prefix * 0.5) else "✓ warm"
        print(f"| v{v} | {t1_prefix:>7,} | {t1.get('ttl_tier','?')} | {idle_s} | {t2_cc:>7,} | {t2_cr:>7,} | {t2.get('ttl_tier','?')} | {rebuilt} |")
    print("")

print("---")
print("")
print("*Generated by cross-version-cache-test.sh*")
EOF

echo ""
echo "=== Test complete ==="
echo "Summary written to: $SUMMARY"
echo ""
echo "Raw per-version JSONLs in: $OUTPUT_DIR"
echo ""
if [[ "$Q5H" -lt 50 ]]; then
    NEW_Q5H=$(python3 -c "
import json
try:
    print(json.load(open('$HOME/.claude/quota-status/account.json'))['five_hour']['pct'])
except Exception:
    print('?')
" 2>/dev/null)
    echo "Q5h at start: ${Q5H}%"
    echo "Q5h at end:   ${NEW_Q5H}%"
fi
