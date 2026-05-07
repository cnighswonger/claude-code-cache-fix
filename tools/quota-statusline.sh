#!/bin/bash
# Status line: show quota % and burn rate from per-session quota-status files.
# Written by cache-fix proxy's cache-telemetry extension on every API call.
#
# Layout (post-v3.5.0):
#   ~/.claude/quota-status/account.json            — global quota fields (5h/7d, status, overage)
#   ~/.claude/quota-status/sessions/<filename>.json — per-session cache fields (ttl_tier, hit_rate)
#
# CC pipes hook input as JSON on stdin including `session_id`, which we map to
# the per-session filename via the canonical rule (matches the writer in
# proxy/extensions/cache-telemetry.mjs:sessionFilename).
#
# Security (v3.5.2, #108): the previous version interpolated stdin into a
# Python triple-quoted literal via "''$input''", which lets a `'''` byte
# sequence in the payload close the literal early and execute arbitrary
# Python. CC's hook payload reflects user-controlled paths (cwd,
# workspace.current_dir, transcript_path), and apostrophes are legal in
# filenames, so a hostile directory name on disk could trigger code
# execution on every CC statusline redraw. We capture stdin in bash, export
# it to the env, and pass the python source through a single-quoted heredoc
# (`<<'PYEOF'`) which disables ALL bash interpolation in the body. Python
# reads the JSON via os.environ.get('CC_INPUT'), where the bytes are inert.

# Capture stdin in bash before the python heredoc consumes the stdin slot,
# then export so the python child sees it.
CC_INPUT=$(cat)
export CC_INPUT

ACCOUNT="$HOME/.claude/quota-status/account.json"

# Show quota even if no per-session file exists yet (fresh session, first
# request hasn't fired). Per-session block just gets blank.
if [ ! -f "$ACCOUNT" ]; then
  exit 0
fi

# IMPORTANT: the heredoc tag is single-quoted (`<<'PYEOF'`). This disables
# all bash interpolation inside the heredoc body. Do NOT change to `<<PYEOF`
# without a matching audit — that would re-introduce the injection vector
# the v3.5.2 hotfix closed. The python source must reference CC_INPUT only
# through os.environ, never via a shell-substituted string.
result=$(python3 <<'PYEOF' 2>/dev/null
import sys, json, os, re, hashlib
from datetime import datetime, timezone, timedelta

home = os.path.expanduser('~')
account_path = os.path.join(home, '.claude', 'quota-status', 'account.json')
sessions_dir = os.path.join(home, '.claude', 'quota-status', 'sessions')

# Parse stdin JSON (CC hook input) for session_id. Pass the raw value
# (including null / "" / whitespace) through session_filename so the
# canonical rule decides — the writer maps all those to 'unknown',
# the reader must do the same to keep the contract identical.
try:
    stdin_data = json.loads(os.environ.get('CC_INPUT') or '{}')
except Exception:
    stdin_data = {}
sess_id_raw = stdin_data.get('session_id')

# Canonical filename derivation — must match cache-telemetry.mjs:sessionFilename.
# Allowlist: [A-Za-z0-9_-]{1,128}; else inv-<sha256(s)[:16]>; null/empty/whitespace -> 'unknown'.
SAFE = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
def session_filename(raw):
    if raw is None:
        return 'unknown'
    s = str(raw).strip()
    if not s:
        return 'unknown'
    if SAFE.match(s):
        return s
    return 'inv-' + hashlib.sha256(s.encode('utf-8')).hexdigest()[:16]

# Read account.json (account-global fields).
try:
    acc = json.load(open(account_path))
except Exception:
    sys.exit(0)

# Read this session's per-session file (cache fields). Apply the rule
# unconditionally — null/empty/whitespace land at sessions/unknown.json,
# matching where the writer would have placed them. If the file doesn't
# exist (e.g. unknown.json never written, or this is a fresh session
# whose first request hasn't fired), statusline still shows quota % —
# just no TTL/hit-rate block.
sess_filename = session_filename(sess_id_raw)
try:
    sess = json.load(open(os.path.join(sessions_dir, sess_filename + '.json')))
except Exception:
    sess = {}

q5h = acc.get('five_hour', {}).get('pct', 0)
q7d = acc.get('seven_day', {}).get('pct', 0)
q5h_reset = acc.get('five_hour', {}).get('resets_at', 0)
q7d_reset = acc.get('seven_day', {}).get('resets_at', 0)
status = acc.get('status', '')
overage = acc.get('overage_status', '')
ts = sess.get('timestamp') or acc.get('timestamp', '')

now = datetime.fromisoformat(ts.replace('Z', '+00:00')) if ts else datetime.now(timezone.utc)

# Q5h burn rate
rate5 = ''
if q5h_reset > 0 and q5h > 0:
    window_start = datetime.fromtimestamp(q5h_reset, tz=timezone.utc) - timedelta(hours=5)
    elapsed_min = (now - window_start).total_seconds() / 60
    if elapsed_min > 1:
        rate5 = '{:+.1f}'.format(q5h / elapsed_min)

# Q7d burn rate
rate7 = ''
if q7d_reset > 0 and q7d > 0:
    window_start_7d = datetime.fromtimestamp(q7d_reset, tz=timezone.utc) - timedelta(days=7)
    elapsed_hr = (now - window_start_7d).total_seconds() / 3600
    if elapsed_hr > 0.1:
        rate7 = '{:+.1f}'.format(q7d / elapsed_hr)

label = 'Q5h: {}%'.format(q5h)
if rate5:
    label += ' ({}%/m)'.format(rate5)
label += ' | Q7d: {}%'.format(q7d)
if rate7:
    label += ' ({}%/hr)'.format(rate7)
if overage == 'active':
    label += ' | OVERAGE'

# Per-session TTL and cache stats
ttl = sess.get('cache', {}).get('ttl_tier', '')
hit = sess.get('cache', {}).get('hit_rate', '')
if ttl:
    if ttl == '5m':
        label += ' | \033[31mTTL:5m\033[0m'
    else:
        label += ' | TTL:' + ttl
if hit and hit != 'N/A':
    label += ' ' + hit + '%'

peak = acc.get('peak_hour', False)
if peak:
    label += ' | \033[33mPEAK\033[0m'

print(label)
PYEOF
)

[ -n "$result" ] && echo "$result"
