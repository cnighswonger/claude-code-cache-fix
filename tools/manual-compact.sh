#!/bin/bash
# manual-compact.sh — Generate a compaction summary for a CC session
#
# Usage:
#   manual-compact.sh <project-dir-or-session-jsonl> [user-context-file]
#
# Accepts either:
#   - A project working directory (e.g. ~/git_repos/myproject)
#     → auto-finds the most recent session JSONL
#   - A direct path to a session JSONL file
#
# Produces a summary at /tmp/<session-id>-compact-summary.txt
# that can be pasted or referenced after /clear.
#
# The optional user-context-file is additional context the user wants
# preserved in the summary (equivalent to /compact <instructions>).
#
# WARNING: Using the wrong session JSONL will produce a summary from
# a DIFFERENT conversation. Loading that into your session after /clear
# will inject completely wrong context. Always verify the output before
# feeding it to an agent.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <project-dir-or-session-jsonl> [user-context-file]"
  echo ""
  echo "Generates a compaction summary from a CC session JSONL transcript."
  echo "After /clear, reference the output file to restore context."
  echo ""
  echo "Arguments:"
  echo "  <project-dir>   Working directory of the CC session (e.g. ~/git_repos/myproject)"
  echo "                  Auto-detects the most recent session JSONL."
  echo "  <session-jsonl>  Direct path to a session JSONL file."
  echo "  [user-context]   Optional file with additional context to preserve."
  echo ""
  echo "WARNING: Verify the output summary before loading it after /clear."
  echo "         A wrong session JSONL = wrong context = confused agent."
  exit 1
fi

INPUT="$1"
USER_CONTEXT_FILE="${2:-}"

# Determine if input is a directory or a JSONL file
if [ -d "$INPUT" ]; then
  # Convert project directory to CC's project path format
  REAL_PATH=$(realpath "$INPUT")
  # CC replaces / with - and underscores with - , then prepends -
  PROJECT_KEY=$(echo "$REAL_PATH" | sed 's|/|-|g' | sed 's|_|-|g')
  PROJECT_DIR="$HOME/.claude/projects/${PROJECT_KEY}"

  if [ ! -d "$PROJECT_DIR" ]; then
    echo "ERROR: No CC project found for directory: $INPUT"
    echo "       Expected: $PROJECT_DIR"
    echo ""
    echo "Available projects:"
    ls -d ~/.claude/projects/*/ 2>/dev/null | head -10
    exit 1
  fi

  # Find the most recent JSONL (exclude subdirectories like subagents/)
  JSONL=$(find "$PROJECT_DIR" -maxdepth 1 -name "*.jsonl" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)

  if [ -z "$JSONL" ]; then
    echo "ERROR: No session JSONL found in: $PROJECT_DIR"
    exit 1
  fi

  echo "Project directory: $INPUT"
  echo "Auto-detected session: $(basename "$JSONL")"
  echo "  Modified: $(stat -c '%y' "$JSONL" | cut -d'.' -f1)"
  echo "  Size: $(du -h "$JSONL" | cut -f1)"
  echo ""
  read -p "Is this the correct session? [Y/n] " CONFIRM
  if [[ "${CONFIRM:-Y}" =~ ^[Nn] ]]; then
    echo ""
    echo "Available sessions in $PROJECT_DIR:"
    ls -lt "$PROJECT_DIR"/*.jsonl 2>/dev/null | awk '{print "  " $6, $7, $8, $NF}'
    echo ""
    echo "Re-run with the specific JSONL path."
    exit 1
  fi
elif [ -f "$INPUT" ]; then
  JSONL="$INPUT"
else
  echo "ERROR: $INPUT is not a directory or file."
  exit 1
fi

SESSION_ID=$(basename "$JSONL" .jsonl)
OUTPUT="/tmp/${SESSION_ID}-compact-summary.txt"
EXTRACT="/tmp/${SESSION_ID}-conv-extract.txt"

echo ""
echo "Extracting conversation from: $JSONL"

# Extract conversation turns, keeping more detail for recent turns
python3 << PYEOF
import json, sys

conversation = []
with open("$JSONL") as f:
    for line in f:
        try:
            d = json.loads(line.strip())
            if d.get('type') == 'user':
                msg = d.get('message', {})
                content = msg.get('content', '')
                if isinstance(content, str) and len(content.strip()) > 0:
                    if content.startswith('<local-command') or content.startswith('<command-name>'):
                        continue
                    conversation.append(('user', content))
                elif isinstance(content, list):
                    texts = []
                    for b in content:
                        if isinstance(b, dict):
                            if b.get('type') == 'text' and b.get('text'):
                                t = b['text']
                                if not t.startswith('<local-command') and not t.startswith('<command-name>'):
                                    texts.append(t)
                            elif b.get('type') == 'tool_result' and b.get('content'):
                                c = b['content']
                                if isinstance(c, str):
                                    texts.append(c)
                                elif isinstance(c, list):
                                    for tb in c:
                                        if isinstance(tb, dict) and tb.get('text'):
                                            texts.append(tb['text'])
                    if texts:
                        conversation.append(('user', ' '.join(texts)))
            elif d.get('type') == 'assistant':
                msg = d.get('message', {})
                content = msg.get('content', [])
                if isinstance(content, list):
                    texts = [b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text' and b.get('text')]
                    if texts:
                        conversation.append(('assistant', ' '.join(texts)))
        except:
            pass

total = len(conversation)
if total == 0:
    print("No conversation found.", file=sys.stderr)
    sys.exit(1)

# Split into three segments with different detail levels:
# - First 20%: truncate to 300 chars each (foundational context)
# - Middle 40%: truncate to 1500 chars each (working context)
# - Last 40%: full text up to 8000 chars each (active work — most important)
# Recent-turn caps were relaxed (was 200/400/2000) so the summarizer sees the
# active work in near-full detail; the stronger model (Opus, below) handles it.
seg1_end = int(total * 0.2)
seg2_end = int(total * 0.6)

with open("$EXTRACT", 'w') as f:
    f.write("=== FOUNDATIONAL CONTEXT (early session) ===\n\n")
    for role, text in conversation[:seg1_end]:
        f.write(f"[{role}]: {text[:300]}\n\n")

    f.write("\n=== WORKING CONTEXT (mid session) ===\n\n")
    for role, text in conversation[seg1_end:seg2_end]:
        f.write(f"[{role}]: {text[:1500]}\n\n")

    f.write("\n=== ACTIVE WORK (recent — preserve in full detail) ===\n\n")
    for role, text in conversation[seg2_end:]:
        f.write(f"[{role}]: {text[:8000]}\n\n")

import os
size = os.path.getsize("$EXTRACT")
print(f"Extracted {total} turns ({size:,} bytes, ~{size//4:,} est. tokens)")
print(f"  Foundational: {seg1_end} turns (truncated to 300 chars)")
print(f"  Working: {seg2_end - seg1_end} turns (truncated to 1500 chars)")
print(f"  Active: {total - seg2_end} turns (up to 8000 chars)")
PYEOF

# Build the summarization prompt
USER_CONTEXT=""
if [ -n "$USER_CONTEXT_FILE" ] && [ -f "$USER_CONTEXT_FILE" ]; then
  USER_CONTEXT=$(cat "$USER_CONTEXT_FILE")
  echo "User context loaded from: $USER_CONTEXT_FILE"
fi

PROMPT="Summarize this conversation for context continuity after a /clear.

CRITICAL PRIORITIES (in order):
1. ACTIVE WORK STATE — What is the agent doing RIGHT NOW? What branch, what uncommitted changes, what task is in progress, what was the last action taken? This is the most important section. Be precise about exactly where things stand — do not understate progress.
2. RECENT DECISIONS — Key decisions made in the last ~20% of the conversation and their rationale.
3. PENDING NEXT STEPS — What was about to happen next? What was queued?
4. COMPLETED WORK — PRs merged, issues closed, features shipped. Brief — the git history has the details.
5. FOUNDATIONAL CONTEXT — Agent identity, repo location, key collaborators, infrastructure. Brief.

FORMAT: Use headers and bullet points. Be specific about file paths, branch names, commit SHAs, function names. The agent reading this will have zero prior context — every detail that matters must be explicit.

DO NOT understate progress on in-flight work. If the last 20% of the conversation shows implementation was done, say it was done — do not say 'investigation started'."

if [ -n "$USER_CONTEXT" ]; then
  PROMPT="$PROMPT

ADDITIONAL USER CONTEXT TO PRESERVE:
$USER_CONTEXT"
fi

# Summarizer model. Defaults to Opus for highest-fidelity summaries; override
# with MANUAL_COMPACT_MODEL (e.g. when Opus is rate-limited or retired).
COMPACT_MODEL="${MANUAL_COMPACT_MODEL:-claude-opus-4-7}"

echo ""
echo "Sending to Claude ($COMPACT_MODEL) for summarization..."

cat "$EXTRACT" | claude --print --model "$COMPACT_MODEL" "$PROMPT" > "$OUTPUT" 2>/dev/null

SIZE=$(wc -c < "$OUTPUT")
echo ""
echo "Summary generated: $OUTPUT ($SIZE bytes)"
echo ""
echo "To restore context after /clear, use this as your first message:"
echo ""
echo "  Read $OUTPUT for context on where we left off."
echo ""
