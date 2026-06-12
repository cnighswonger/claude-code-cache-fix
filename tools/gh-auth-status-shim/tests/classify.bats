#!/usr/bin/env bats
# Unit tests for the classification table in lib/classify-auth-status.sh.

setup() {
    # bash 3.2 floor assertion: the actual interpreter running this test
    # must be 3.2 on the macOS CI runner (where the directive requires
    # the floor to be verified). On the Linux runner BASH_VERSION will
    # typically be 5.x; assert ≥ 3.2.
    case "$BASH_VERSION" in
        3.2*|4.*|5.*) ;;
        *) printf 'unexpected BASH_VERSION: %s\n' "$BASH_VERSION" >&2; return 1 ;;
    esac

    HERE="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
    # shellcheck disable=SC1091
    . "$HERE/../lib/classify-auth-status.sh"
}

# --- Text classification ---

@test "classify: success text" {
    run classify_auth_status_output_text "Logged in to github.com as testuser (oauth_token)"
    [ "$status" = 0 ]
    [ "$output" = "success" ]
}

@test "classify: not-logged-in expiry text" {
    run classify_auth_status_output_text "You are not logged in to any GitHub hosts."
    [ "$status" = 0 ]
    [ "$output" = "expiry" ]
}

@test "classify: HTTP 401 expiry text" {
    run classify_auth_status_output_text "HTTP 401: Bad credentials"
    [ "$status" = 0 ]
    [ "$output" = "expiry" ]
}

@test "classify: network-transient text" {
    run classify_auth_status_output_text "error: could not resolve host: api.github.com"
    [ "$status" = 0 ]
    [ "$output" = "network_transient" ]
}

@test "classify: ambiguous text → unknown" {
    run classify_auth_status_output_text "something unexpected happened"
    [ "$status" = 0 ]
    [ "$output" = "unknown" ]
}

@test "classify: empty text → unknown" {
    run classify_auth_status_output_text ""
    [ "$status" = 0 ]
    [ "$output" = "unknown" ]
}

# --- Exit-code classification ---

@test "exit code: real exit 0 → shim exit 0" {
    run classify_auth_status_exit_code 0 "Logged in to github.com as testuser" ""
    [ "$output" = "0" ]
}

@test "exit code: real exit 124 (timeout) → shim exit 0 regardless of text" {
    run classify_auth_status_exit_code 124 "" ""
    [ "$output" = "0" ]
}

@test "exit code: expiry on stdout → propagate real exit" {
    run classify_auth_status_exit_code 1 "You are not logged in to any GitHub hosts." ""
    [ "$output" = "1" ]
}

@test "exit code: expiry on stderr (HTTP 401) → propagate real exit" {
    run classify_auth_status_exit_code 1 "" "HTTP 401: Bad credentials"
    [ "$output" = "1" ]
}

@test "exit code: network transient on stderr → suppress (return 0)" {
    run classify_auth_status_exit_code 1 "" "could not resolve host"
    [ "$output" = "0" ]
}

@test "exit code: conservative default → propagate when ambiguous" {
    run classify_auth_status_exit_code 1 "" "weird unparseable text"
    [ "$output" = "1" ]
}

@test "exit code: empty output → propagate" {
    run classify_auth_status_exit_code 1 "" ""
    [ "$output" = "1" ]
}

@test "exit code: expiry signal wins over transient when both present" {
    # If a "HTTP 401" line is present, we must classify as expiry even
    # if a "timeout" word appears elsewhere — load-bearing per spec.
    run classify_auth_status_exit_code 1 "HTTP 401: Bad credentials" "operation timed out somewhere else"
    [ "$output" = "1" ]
}

@test "exit code: non-zero with happy stdout (anomalous) → propagate conservatively" {
    # Pathological: real gh exited non-zero but stdout says "logged in".
    # Conservative path: propagate the real exit.
    run classify_auth_status_exit_code 1 "Logged in to github.com as testuser" ""
    [ "$output" = "1" ]
}
