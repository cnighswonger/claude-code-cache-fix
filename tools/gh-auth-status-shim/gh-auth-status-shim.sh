#!/usr/bin/env bash
# gh-auth-status-shim — PATH-resolved gh wrapper that suppresses CC Desktop's
# false "GitHub CLI authentication expired" toast (anthropics/claude-code#67055).
#
# When installed earlier on PATH than the real gh, this script:
#   1. Intercepts `gh auth status` invocations.
#   2. Classifies the outcome conservatively (real auth failure → propagate;
#      transient/timeout → return 0 to suppress the false toast).
#   3. Execs the real gh unchanged for every other subcommand.
#
# bash 3.2 compatible — runs on stock macOS. No GNU coreutils dependency.
# No jq dependency. No external runtime dependencies beyond `gh` itself.
#
# See tools/gh-auth-status-shim/README.md for the design rationale, the
# per-feeder-path coverage table, the macOS launchd-PATH caveat, and the
# sunset plan.

# Internal timeout: must be < CC Desktop's 5s spawn-abandonment window so
# the shim's verdict reaches CC before it walks away. The directive's
# load-bearing constraint: ~3.5–4s. The classifier itself runs in
# milliseconds after the gh call returns, so 4s for gh leaves a generous
# margin.
INTERNAL_TIMEOUT="${GH_AUTH_STATUS_SHIM_TIMEOUT:-4}"
SHIM_DEBUG_LOG="${GH_AUTH_STATUS_SHIM_DEBUG_LOG:-}"

# Source the classification helper relative to this script. Resolves any
# symlinks so it works whether the user installed via copy or via a
# symlink to the repo.
_self_path="$0"
# Avoid `readlink -f` (not on stock macOS); use a portable resolver.
while [ -L "$_self_path" ]; do
    _link_target="$(readlink "$_self_path")"
    case "$_link_target" in
        /*) _self_path="$_link_target" ;;
        *)  _self_path="$(cd "$(dirname "$_self_path")" && pwd)/$_link_target" ;;
    esac
done
_self_dir="$(cd "$(dirname "$_self_path")" && pwd)"
# shellcheck source=lib/classify-auth-status.sh
# shellcheck disable=SC1091  # runtime-resolved; CI lints the lib file separately
. "$_self_dir/lib/classify-auth-status.sh"

# Resolve the real gh binary. Walks PATH for entries named `gh` and skips
# this shim itself. Exits with a clear error if no other gh found.
detect_real_gh() {
    local self_abs IFS=':' dir candidate
    self_abs="$_self_path"
    for dir in $PATH; do
        # POSIX: empty PATH entry means current directory; skip for safety.
        [ -z "$dir" ] && continue
        candidate="$dir/gh"
        if [ -x "$candidate" ] && [ "$candidate" != "$self_abs" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

shim_debug() {
    [ -z "$SHIM_DEBUG_LOG" ] && return 0
    printf '[gh-auth-status-shim %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$SHIM_DEBUG_LOG" 2>/dev/null || true
}

# Portable timeout wrapper. Uses GNU `timeout` or Homebrew `gtimeout` if
# present; otherwise falls back to a bash-native watchdog. Returns the
# wrapped command's exit code, or 124 on timeout (matching GNU timeout's
# convention so the classifier is platform-agnostic).
portable_timeout() {
    local seconds="$1"; shift
    if command -v timeout >/dev/null 2>&1; then
        timeout "$seconds" "$@"
        return $?
    fi
    if command -v gtimeout >/dev/null 2>&1; then
        gtimeout "$seconds" "$@"
        return $?
    fi
    # bash-native watchdog. Total budget MUST stay under CC Desktop's 5s
    # spawn-abandonment window even when the child ignores SIGTERM. We
    # send TERM at $seconds, give the child a brief grace period (0.5s),
    # then send KILL. Both 143 (128+SIGTERM) and 137 (128+SIGKILL)
    # normalize to 124 so the classifier sees a timeout regardless of
    # which signal succeeded in stopping the child (closes Codex r1
    # blocker on the TERM-ignoring case).
    local grace_seconds="0.5"
    "$@" &
    local child=$!
    (
        sleep "$seconds"
        if kill -0 "$child" 2>/dev/null; then
            kill -TERM "$child" 2>/dev/null
            sleep "$grace_seconds"
            kill -KILL "$child" 2>/dev/null
        fi
    ) &
    local watchdog=$!
    local rc=0
    wait "$child" 2>/dev/null
    rc=$?
    # Normalize both TERM-cooperative (143) and KILL-forced (137) exit
    # codes to GNU timeout's 124 so downstream classification is
    # platform- and signal-handler-agnostic. Also catch any other
    # 128+sig signal in the typical kill-signal range as a timeout (we
    # only invoked the watchdog because the budget expired, so any
    # signal-induced exit here is by construction a timeout).
    case "$rc" in
        143|137|142|139|141|134) rc=124 ;;
    esac
    kill "$watchdog" 2>/dev/null
    wait "$watchdog" 2>/dev/null
    return "$rc"
}

# Run `gh auth status` and classify the outcome. Captures stdout and
# stderr separately to preserve stream semantics (gh has historically
# moved auth-status output between streams; re-merging would compound the
# drift).
intercept_auth_status() {
    local real_gh="$1"
    shift
    local stdout_file stderr_file stdout stderr exit_code
    stdout_file="$(mktemp -t gh-shim-stdout.XXXXXX)" || {
        printf '[gh-auth-status-shim] FATAL: mktemp failed (cannot create stdout buffer); aborting auth-status intercept and propagating original exit.\n' >&2
        return 1
    }
    stderr_file="$(mktemp -t gh-shim-stderr.XXXXXX)" || {
        printf '[gh-auth-status-shim] FATAL: mktemp failed (cannot create stderr buffer); aborting auth-status intercept and propagating original exit.\n' >&2
        rm -f "$stdout_file"
        return 1
    }

    shim_debug "auth status: invoking real gh at $real_gh (timeout ${INTERNAL_TIMEOUT}s)"
    portable_timeout "$INTERNAL_TIMEOUT" "$real_gh" auth status "$@" \
        > "$stdout_file" 2> "$stderr_file"
    exit_code=$?

    stdout="$(cat "$stdout_file")"
    stderr="$(cat "$stderr_file")"
    rm -f "$stdout_file" "$stderr_file"

    shim_debug "auth status: real gh exit=$exit_code stdout_len=${#stdout} stderr_len=${#stderr}"

    # Pass through stdout + stderr in their original streams BEFORE
    # adjusting the exit code, so direct-shell callers see the real
    # output. CC Desktop only cares about the exit code; suppressing the
    # output for it would be invisible-to-CC noise.
    [ -n "$stdout" ] && printf '%s\n' "$stdout"
    [ -n "$stderr" ] && printf '%s\n' "$stderr" >&2

    # Classify and decide the final exit code.
    local final_exit
    final_exit=$(classify_auth_status_exit_code "$exit_code" "$stdout" "$stderr")
    shim_debug "auth status: classified exit=$final_exit (real_exit=$exit_code)"

    if [ "$final_exit" = "0" ] && [ "$exit_code" != "0" ]; then
        # The classifier suppressed a real non-zero exit (timeout or
        # transient). Emit a brief diagnostic so direct-shell callers
        # understand what happened; CC Desktop has already abandoned
        # the shim at t=5s and won't read this.
        if [ "$exit_code" = "124" ]; then
            printf '[gh-auth-status-shim] gh auth status timed out within %ss; treating as transient (CC#67055 workaround).\n' "$INTERNAL_TIMEOUT" >&2
        else
            printf '[gh-auth-status-shim] gh auth status failed transiently; treating as transient (CC#67055 workaround).\n' >&2
        fi
    fi

    return "$final_exit"
}

main() {
    local real_gh
    if ! real_gh="$(detect_real_gh)"; then
        # shellcheck disable=SC2016  # literal backticks around `gh` for user output
        printf '[gh-auth-status-shim] FATAL: cannot find a real `gh` binary on PATH other than this shim.\n' >&2
        printf '[gh-auth-status-shim] Install gh from https://cli.github.com/ or fix PATH ordering.\n' >&2
        return 127
    fi

    # Only intercept `gh auth status`. Everything else passes through
    # unchanged via exec — no extra shim process in the chain, no
    # output rewriting.
    case "${1:-}" in
        auth)
            case "${2:-}" in
                status)
                    shift 2
                    intercept_auth_status "$real_gh" "$@"
                    return $?
                    ;;
                *)
                    exec "$real_gh" "$@"
                    ;;
            esac
            ;;
        *)
            exec "$real_gh" "$@"
            ;;
    esac
}

main "$@"
