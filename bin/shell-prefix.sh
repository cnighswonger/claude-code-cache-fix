#!/bin/sh
# A CLAUDE_CODE_SHELL_PREFIX program: for what Claude Code starts (Bash tool, hooks, stdio MCP
# servers, statusLine) it points the six proxy variables at the proxy cache-fix itself forwards
# to, not at cache-fix, and unsets them when cache-fix has none. cache-fix-proxy writes that
# URL (an empty line when it has none) to ${CLAUDE_CONFIG_DIR:-~/.claude}/cache-fix-state/
# upstream-<its port>; the port is the one in HTTPS_PROXY (https_proxy when that is empty),
# taken only when that names this machine. No file for that port (HTTPS_PROXY is not
# cache-fix's, e.g. a pin's hop or your own proxy): the variables are left as they are.
# The URL travels in SHELL_PREFIX_UPSTREAM, so it is never spliced into a command string. The
# script reads only those and the variables Claude Code sets per child kind (CLAUDE_PROJECT_DIR,
# CLAUDE_PID, SHELL), never the command.
h=${HTTPS_PROXY:-${https_proxy-}}; h=${h#*://}; h=${h##*@}; h=${h%%/*}
case $h in 127.0.0.1:*|localhost:*|'[::1]:'*) port=${h##*:} ;; *) port= ;; esac
url=; have=; f=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cache-fix-state/upstream-$port
case $port in ''|*[!0-9]*) ;; *) if [ -r "$f" ]; then have=1; read -r url < "$f"; fi ;; esac
h=${url#*://}; h=${h##*@}; h=${h%%/*}
case $h in "127.0.0.1:$port"|"localhost:$port"|"[::1]:$port") url= ;; esac
if [ -n "$url" ]; then
  export SHELL_PREFIX_UPSTREAM="$url"
  u='export HTTPS_PROXY="$SHELL_PREFIX_UPSTREAM" https_proxy="$SHELL_PREFIX_UPSTREAM" HTTP_PROXY="$SHELL_PREFIX_UPSTREAM" http_proxy="$SHELL_PREFIX_UPSTREAM" ALL_PROXY="$SHELL_PREFIX_UPSTREAM" all_proxy="$SHELL_PREFIX_UPSTREAM"'
elif [ -n "$have" ]; then
  u='unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy'
else
  u=:
fi
eval "$u"
# Bash tool (Claude puts no CLAUDE_PROJECT_DIR there): remember which Claude this is
[ -z "${CLAUDE_PROJECT_DIR+x}" ] && export SHELL_PREFIX_CLAUDE_PID="${CLAUDE_PID-}"
# the user's own earlier prefix gets the command exactly as Claude gave it; the variable is
# dropped first, so a chain that comes back to this file ends here; a missing file or a relative name is skipped
p=${CACHE_FIX_PREV_SHELL_PREFIX-}; unset CACHE_FIX_PREV_SHELL_PREFIX
case $p in /*) [ -f "$p" ] && [ -x "$p" ] && exec "$p" "$1" ;; esac
# Bash tool: the shell Claude chose (it sets SHELL); set them again after its startup files
[ -z "${CLAUDE_PROJECT_DIR+x}" ] && exec "${SHELL:-/bin/sh}" -c "$u; $1"
# hook or statusLine: Claude stamped its own pid on it; run it under /bin/sh, as without a prefix
[ -n "${CLAUDE_PID+x}" ] && [ "$CLAUDE_PID" != "${SHELL_PREFIX_CLAUDE_PID-}" ] && exec /bin/sh -c "$u; $1"
# stdio MCP server: one quoted command; become it, so Claude's signals reach the server
eval "exec $1"
