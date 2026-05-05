#!/bin/bash
# cache-test.sh — Test Claude Code cache behavior with and without interceptor.
#
# Runs four scenarios and captures cache stats for each:
#   1. One-shot WITHOUT interceptor (baseline)
#   2. One-shot WITH interceptor
#   3. Multi-turn WITHOUT interceptor (conversation + resume)
#   4. Multi-turn WITH interceptor (conversation + resume)
#
# Outputs a summary report comparing TTL tier, cache hit rates, and
# whether the interceptor's fixes fired.
#
# Usage:
#   ./cache-test.sh [--skip-resume]   # --skip-resume skips the resume tests
#
# Requires: Claude Code installed via npm, claude-code-cache-fix installed.

set -euo pipefail

CLAUDE_CLI="$HOME/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js"
PRELOAD="$HOME/.claude/cache-fix-preload.mjs"
QUOTA_DIR="$HOME/.claude/quota-status"
ACCOUNT_FILE="$QUOTA_DIR/account.json"
SESSIONS_DIR="$QUOTA_DIR/sessions"
USAGE_LOG="$HOME/.claude/usage.jsonl"
DEBUG_LOG="$HOME/.claude/cache-fix-debug.log"
REPORT_DIR="/tmp/cache-test-$(date +%Y%m%d_%H%M%S)"
SKIP_RESUME=false

for arg in "$@"; do
  case "$arg" in
    --skip-resume) SKIP_RESUME=true ;;
  esac
done

# Verify prerequisites
if [ ! -f "$CLAUDE_CLI" ]; then
  echo "ERROR: Claude Code not found at $CLAUDE_CLI" >&2
  echo "Install with: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

if [ ! -f "$PRELOAD" ]; then
  echo "ERROR: cache-fix preload not found at $PRELOAD" >&2
  echo "Install with: npm install -g claude-code-cache-fix" >&2
  exit 1
fi

CC_VERSION=$(node "$CLAUDE_CLI" --version 2>/dev/null | head -1)
echo "=========================================="
echo "  CACHE BEHAVIOR TEST"
echo "  Claude Code: $CC_VERSION"
echo "  Report dir:  $REPORT_DIR"
echo "=========================================="
echo ""

mkdir -p "$REPORT_DIR"

# Helper: snapshot cache state from the most-recent per-session quota-status
# file. Each one-shot CC invocation generates its own session, so the latest
# sessions/<filename>.json corresponds to the call we just made.
snapshot_cache() {
  local label="$1"
  local outfile="$REPORT_DIR/${label}.json"
  local sess_file=""
  if [ -d "$SESSIONS_DIR" ]; then
    sess_file=$(ls -t "$SESSIONS_DIR"/*.json 2>/dev/null | head -1)
  fi
  if [ -n "$sess_file" ] && [ -f "$sess_file" ]; then
    cp "$sess_file" "$outfile"
    local tier=$(python3 -c "import json; d=json.load(open('$sess_file')); print(d.get('cache',{}).get('ttl_tier','?'))" 2>/dev/null || echo "?")
    local create=$(python3 -c "import json; d=json.load(open('$sess_file')); print(d.get('cache',{}).get('cache_creation',0))" 2>/dev/null || echo "?")
    local read=$(python3 -c "import json; d=json.load(open('$sess_file')); print(d.get('cache',{}).get('cache_read',0))" 2>/dev/null || echo "?")
    local e1h=$(python3 -c "import json; d=json.load(open('$sess_file')); print(d.get('cache',{}).get('ephemeral_1h',0))" 2>/dev/null || echo "?")
    local e5m=$(python3 -c "import json; d=json.load(open('$sess_file')); print(d.get('cache',{}).get('ephemeral_5m',0))" 2>/dev/null || echo "?")
    local hit=$(python3 -c "import json; d=json.load(open('$sess_file')); print(d.get('cache',{}).get('hit_rate','?'))" 2>/dev/null || echo "?")
    echo "  [$label] TTL=$tier  create=$create  read=$read  1h=$e1h  5m=$e5m  hit=$hit%"
  else
    echo "  [$label] No per-session quota-status file found in $SESSIONS_DIR"
  fi
}

# Helper: count usage.jsonl entries
count_usage() {
  if [ -f "$USAGE_LOG" ]; then
    wc -l < "$USAGE_LOG" | tr -d ' '
  else
    echo "0"
  fi
}

# Helper: capture debug log entries
snapshot_debug() {
  local label="$1"
  if [ -f "$DEBUG_LOG" ]; then
    cp "$DEBUG_LOG" "$REPORT_DIR/${label}-debug.log"
  fi
}

# ─── Test 1: One-shot WITHOUT interceptor ────────────────────────────────────

echo "--- Test 1: One-shot WITHOUT interceptor ---"
rm -f "$DEBUG_LOG"
usage_before=$(count_usage)

# Call 1: cold start
node "$CLAUDE_CLI" -p "respond with exactly: cache-test-1a" --dangerously-skip-permissions > "$REPORT_DIR/test1a-output.txt" 2>&1
snapshot_cache "test1a-no-interceptor"

# Wait 2 seconds for any async writes
sleep 2

# Call 2: should get cache hit
node "$CLAUDE_CLI" -p "respond with exactly: cache-test-1b" --dangerously-skip-permissions > "$REPORT_DIR/test1b-output.txt" 2>&1
snapshot_cache "test1b-no-interceptor"

usage_after=$(count_usage)
echo "  Usage entries added: $((usage_after - usage_before))"
echo ""

# ─── Test 2: One-shot WITH interceptor ───────────────────────────────────────

echo "--- Test 2: One-shot WITH interceptor ---"
rm -f "$DEBUG_LOG"
usage_before=$(count_usage)

# Call 1: cold start with interceptor
CACHE_FIX_DEBUG=1 NODE_OPTIONS="--import $PRELOAD" \
  node "$CLAUDE_CLI" -p "respond with exactly: cache-test-2a" --dangerously-skip-permissions > "$REPORT_DIR/test2a-output.txt" 2>&1
snapshot_cache "test2a-with-interceptor"
snapshot_debug "test2a"

sleep 2

# Call 2: should get cache hit
CACHE_FIX_DEBUG=1 NODE_OPTIONS="--import $PRELOAD" \
  node "$CLAUDE_CLI" -p "respond with exactly: cache-test-2b" --dangerously-skip-permissions > "$REPORT_DIR/test2b-output.txt" 2>&1
snapshot_cache "test2b-with-interceptor"
snapshot_debug "test2b"

usage_after=$(count_usage)
echo "  Usage entries added: $((usage_after - usage_before))"
echo ""

# ─── Test 3 & 4: Multi-turn + Resume ────────────────────────────────────────

if [ "$SKIP_RESUME" = true ]; then
  echo "--- Tests 3 & 4: SKIPPED (--skip-resume) ---"
  echo ""
else
  # Test 3: Multi-turn WITHOUT interceptor
  echo "--- Test 3: Multi-turn + Resume WITHOUT interceptor ---"
  rm -f "$DEBUG_LOG"
  usage_before=$(count_usage)

  # Start a session with a named session, do 2 turns, exit, then resume
  SESSION_NAME="cache-test-no-fix-$$"

  # Turn 1
  node "$CLAUDE_CLI" -p "respond with exactly: turn1-done" \
    --dangerously-skip-permissions -n "$SESSION_NAME" \
    > "$REPORT_DIR/test3-turn1-output.txt" 2>&1
  snapshot_cache "test3-turn1-no-interceptor"

  sleep 2

  # Turn 2 (resume)
  node "$CLAUDE_CLI" -p "respond with exactly: turn2-done" \
    --dangerously-skip-permissions -c \
    > "$REPORT_DIR/test3-turn2-output.txt" 2>&1
  snapshot_cache "test3-turn2-no-interceptor"

  sleep 2

  # Turn 3 (second resume — this is where scatter typically shows)
  node "$CLAUDE_CLI" -p "respond with exactly: turn3-done" \
    --dangerously-skip-permissions -c \
    > "$REPORT_DIR/test3-turn3-output.txt" 2>&1
  snapshot_cache "test3-turn3-no-interceptor"

  usage_after=$(count_usage)
  echo "  Usage entries added: $((usage_after - usage_before))"
  echo ""

  # Test 4: Multi-turn WITH interceptor
  echo "--- Test 4: Multi-turn + Resume WITH interceptor ---"
  rm -f "$DEBUG_LOG"
  usage_before=$(count_usage)

  SESSION_NAME="cache-test-with-fix-$$"

  # Turn 1
  CACHE_FIX_DEBUG=1 CACHE_FIX_PREFIXDIFF=1 NODE_OPTIONS="--import $PRELOAD" \
    node "$CLAUDE_CLI" -p "respond with exactly: turn1-done" \
    --dangerously-skip-permissions -n "$SESSION_NAME" \
    > "$REPORT_DIR/test4-turn1-output.txt" 2>&1
  snapshot_cache "test4-turn1-with-interceptor"
  snapshot_debug "test4-turn1"

  sleep 2

  # Turn 2 (resume)
  CACHE_FIX_DEBUG=1 CACHE_FIX_PREFIXDIFF=1 NODE_OPTIONS="--import $PRELOAD" \
    node "$CLAUDE_CLI" -p "respond with exactly: turn2-done" \
    --dangerously-skip-permissions -c \
    > "$REPORT_DIR/test4-turn2-output.txt" 2>&1
  snapshot_cache "test4-turn2-with-interceptor"
  snapshot_debug "test4-turn2"

  sleep 2

  # Turn 3 (second resume)
  CACHE_FIX_DEBUG=1 CACHE_FIX_PREFIXDIFF=1 NODE_OPTIONS="--import $PRELOAD" \
    node "$CLAUDE_CLI" -p "respond with exactly: turn3-done" \
    --dangerously-skip-permissions -c \
    > "$REPORT_DIR/test4-turn3-output.txt" 2>&1
  snapshot_cache "test4-turn3-with-interceptor"
  snapshot_debug "test4-turn3"

  usage_after=$(count_usage)
  echo "  Usage entries added: $((usage_after - usage_before))"
  echo ""
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo "=========================================="
echo "  SUMMARY"
echo "=========================================="
echo ""
echo "All snapshots saved to: $REPORT_DIR"
echo ""
echo "Cache snapshots:"
for f in "$REPORT_DIR"/*.json; do
  label=$(basename "$f" .json)
  tier=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('cache',{}).get('ttl_tier','?'))" 2>/dev/null || echo "?")
  create=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('cache',{}).get('cache_creation',0))" 2>/dev/null || echo "?")
  read=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('cache',{}).get('cache_read',0))" 2>/dev/null || echo "?")
  e1h=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('cache',{}).get('ephemeral_1h',0))" 2>/dev/null || echo "?")
  e5m=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('cache',{}).get('ephemeral_5m',0))" 2>/dev/null || echo "?")
  printf "  %-40s TTL=%-4s create=%-6s read=%-6s 1h=%-6s 5m=%-6s\n" "$label" "$tier" "$create" "$read" "$e1h" "$e5m"
done

# Check for interceptor actions in debug logs
echo ""
echo "Interceptor actions:"
for f in "$REPORT_DIR"/*-debug.log; do
  [ -f "$f" ] || continue
  label=$(basename "$f" -debug.log)
  applied=$(grep -c "APPLIED:" "$f" 2>/dev/null || echo 0)
  skipped=$(grep -c "SKIPPED:" "$f" 2>/dev/null || echo 0)
  pins=$(grep -c "CONTENT PIN:" "$f" 2>/dev/null || echo 0)
  echo "  $label: $applied applied, $skipped skipped, $pins content pins"
done

echo ""
echo "Done. Review $REPORT_DIR for full details."
