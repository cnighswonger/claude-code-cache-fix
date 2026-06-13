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
from datetime import datetime, timezone

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

SECS_PER_MIN = 60
MINS_PER_HR = 60
HRS_PER_DAY = 24
SECS_PER_HR = SECS_PER_MIN * MINS_PER_HR
SECS_PER_DAY = SECS_PER_HR * HRS_PER_DAY

# Minimum elapsed time in a window before we'll project an exhaust ETA from
# its burn rate. Below this the rate is dominated by a single early call and
# the projection is noise.
BURN_WARMUP_SEC = 5 * SECS_PER_MIN

BAR_WIDTH = 10

def draw_bar(consumed_pct, elapsed_pct, width=BAR_WIDTH):
    # Tick overlays a fill cell when consumed > elapsed, keeping bar width
    # constant — that's what makes the over-pace state legible (┃ inside the
    # filled run) rather than just pushing fill cells around.
    def to_cells(pct):
        return int(round(max(0, min(100, pct)) / 100 * width))
    fill = to_cells(consumed_pct)
    if elapsed_pct is None:
        tick = -1
    else:
        tick = min(to_cells(elapsed_pct), width - 1)
    cells = []
    remaining = fill
    for i in range(width):
        if i == tick:
            cells.append('┃')
        elif remaining > 0:
            cells.append('█')
            remaining -= 1
        else:
            cells.append('░')
    return '[' + ''.join(cells) + ']'

def fmt_time(secs):
    # Autoselect scale: `{D}d{H}h` for >=1 day, `{H}h{MM}m` below that.
    # One formatter so the Q5h (always h/m) and Q7d (h/m or d/h depending on
    # how close to reset) callers don't need to pick.
    if secs is None or secs <= 0:
        return ''
    if secs >= SECS_PER_DAY:
        return '{}d{}h'.format(int(secs // SECS_PER_DAY), int((secs % SECS_PER_DAY) // SECS_PER_HR))
    return '{}h{:02d}m'.format(int(secs // SECS_PER_HR), int((secs % SECS_PER_HR) // SECS_PER_MIN))

def window_view(reset_ts, window_secs):
    # Returns (elapsed_sec, secs_left). elapsed_sec may be negative (server
    # gave us a reset_at past the window head — invalid) or exceed window_secs
    # (stale reset_at not yet refreshed by the next API call). Callers handle
    # both; downstream rendering clamps the tick to the bar edges.
    if reset_ts <= 0:
        return None, None
    window_start = datetime.fromtimestamp(reset_ts - window_secs, tz=timezone.utc)
    return (now - window_start).total_seconds(), reset_ts - now.timestamp()

def time_to_exhaust_sec(pct, elapsed_sec, min_elapsed_sec):
    # (100 - pct) divided by current burn rate (pct / elapsed_sec). Gated on
    # min_elapsed_sec so very-fresh windows don't project off noise.
    if elapsed_sec is None or elapsed_sec <= min_elapsed_sec:
        return None
    if pct <= 0 or pct >= 100:
        return None
    return (100 - pct) * elapsed_sec / pct

def format_window(name, pct, elapsed_sec, window_secs, secs_left, min_elapsed_sec):
    ep = None if elapsed_sec is None or elapsed_sec < 0 else elapsed_sec / window_secs * 100
    extras = []
    stale = secs_left is not None and secs_left <= 0
    if not stale:
        exhaust = time_to_exhaust_sec(pct, elapsed_sec, min_elapsed_sec)
        if exhaust is not None:
            extras.append('exhaust ' + fmt_time(exhaust))
        if secs_left is not None and secs_left > 0:
            extras.append('reset ' + fmt_time(secs_left))
    tail = ' (' + ', '.join(extras) + ')' if extras else ''
    return '{} {} {}%{}'.format(name, draw_bar(pct, ep), pct, tail)

elapsed_5h, left_5h = window_view(q5h_reset, 5 * SECS_PER_HR)
elapsed_7d, left_7d = window_view(q7d_reset, 7 * SECS_PER_DAY)

label = format_window('Q5h', q5h, elapsed_5h, 5 * SECS_PER_HR, left_5h, BURN_WARMUP_SEC)
label += ' | ' + format_window('Q7d', q7d, elapsed_7d, 7 * SECS_PER_DAY, left_7d, BURN_WARMUP_SEC)
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

# Served-model divergence indicator (issue #223). Renders nothing on the
# default no-divergence path. Recent-only divergent renders red; sticky
# renders black-on-yellow for distinction from the red used elsewhere.
# [1m] suffix on requested side only — `auto_1m_detected` reflects the
# outbound request header, so the proxy cannot make a served-side claim.
recent = sess.get('model_divergence_recent', False)
sticky = sess.get('model_divergence_sticky', False)
if recent or sticky:
    one_m = sess.get('auto_1m_detected', False)
    SHORT_LABELS = (
        ('claude-opus-4-7', 'Opus 4.7'),
        ('claude-opus-4-8', 'Opus 4.8'),
        ('claude-sonnet-4-6', 'Sonnet 4.6'),
        ('claude-sonnet-4-7', 'Sonnet 4.7'),
        ('claude-haiku-4-5', 'Haiku 4.5'),
        ('fable', 'Fable'),
        ('mythos', 'Mythos'),
    )
    def short(model_id):
        if not model_id:
            return '?'
        m = model_id.lower()
        for substr, label_text in SHORT_LABELS:
            if substr in m:
                return label_text
        return model_id
    req = short(sess.get('requested_model', ''))
    serv = short(sess.get('served_model', ''))
    if one_m:
        req = req + '[1m]'
    pair = req + ' → ' + serv
    if sticky:
        label += ' | \033[30;43m' + pair + '\033[0m'
    else:
        label += ' | \033[31m' + pair + '\033[0m'

print(label)
PYEOF
)

[ -n "$result" ] && echo "$result"
