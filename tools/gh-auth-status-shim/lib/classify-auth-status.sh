# lib/classify-auth-status.sh — classification helper for gh-auth-status-shim.
#
# Sourced by gh-auth-status-shim.sh and by bats unit tests. Public functions:
#
#   classify_auth_status_exit_code REAL_EXIT STDOUT STDERR
#     Echoes the SHIM's exit code (0 to suppress CC's false toast; original
#     REAL_EXIT to propagate a genuine auth failure). Conservative default:
#     ambiguous → return REAL_EXIT (let CC see).
#
#   classify_auth_status_output_text TEXT
#     Echoes one of: success | expiry | network_transient | unknown.
#     Pure text classifier; consumed by classify_auth_status_exit_code.
#     Exported so tests can pin coverage on each text class.
#
# bash 3.2 compatible. No `mapfile`, no `[[ -v ]]`, no associative arrays,
# no `${var,,}`.

# Regex anchors. These match against the lowercased combined output. The
# `gh` version range these strings have been validated against is named
# in the README; refresh on upstream wording change.
_GHASS_SUCCESS_RE='logged in to github\.com'
_GHASS_EXPIRY_RE='not logged in|no.*credentials.*configured|http 401'
_GHASS_TRANSIENT_RE='timeout|connection refused|could not resolve host|temporary failure|network unreachable|service unavailable|operation timed out'

# Lowercase the input portably (bash 3.2 has no ${var,,}). Uses `tr`.
_ghass_to_lower() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# Classify a chunk of text. Public so tests can pin per-class coverage.
# Order matters: expiry beats transient (a server-returned 401 + a
# "timeout" word in some other line should still be classified as expiry,
# because the 401 is the load-bearing signal).
classify_auth_status_output_text() {
    local text lower
    text="$1"
    lower="$(_ghass_to_lower "$text")"
    case "$lower" in
        *)
            if printf '%s' "$lower" | grep -qE "$_GHASS_SUCCESS_RE"; then
                printf 'success\n'
                return 0
            fi
            if printf '%s' "$lower" | grep -qE "$_GHASS_EXPIRY_RE"; then
                printf 'expiry\n'
                return 0
            fi
            if printf '%s' "$lower" | grep -qE "$_GHASS_TRANSIENT_RE"; then
                printf 'network_transient\n'
                return 0
            fi
            ;;
    esac
    printf 'unknown\n'
}

# Decide the shim's final exit code. The directive's classification table:
#
#   exit 0  + happy stdout                          → 0  (genuine success)
#   exit nz + "not logged in"/HTTP 401              → REAL (genuine expiry)
#   exit nz + timeout (124)                         → 0  (transient timeout)
#   exit nz + network-transient stderr signal       → 0  (transient network)
#   exit nz + no clear signal (empty/ambiguous)     → REAL (conservative default)
classify_auth_status_exit_code() {
    local real_exit stdout stderr combined cls
    real_exit="$1"
    stdout="$2"
    stderr="$3"

    # Real success: just pass through.
    if [ "$real_exit" = "0" ]; then
        printf '0\n'
        return 0
    fi

    # Timeout from portable_timeout (or GNU timeout, or our bash-native
    # watchdog) is always transient — return 0 regardless of output.
    if [ "$real_exit" = "124" ]; then
        printf '0\n'
        return 0
    fi

    # Real exit non-zero, non-timeout. Inspect outputs.
    # Concatenate so signal in either stream wins.
    combined="$stdout
$stderr"
    cls="$(classify_auth_status_output_text "$combined")"

    case "$cls" in
        expiry)
            # Genuine expiry — let CC's toast fire.
            printf '%s\n' "$real_exit"
            ;;
        network_transient)
            # Suppress the false toast.
            printf '0\n'
            ;;
        success)
            # Real exit non-zero but output says "logged in" — anomalous.
            # Conservative: propagate.
            printf '%s\n' "$real_exit"
            ;;
        unknown|*)
            # Conservative default — let CC see.
            printf '%s\n' "$real_exit"
            ;;
    esac
}
