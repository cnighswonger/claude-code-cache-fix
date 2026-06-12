#!/usr/bin/env bash
# gh-mock.sh — mock real-gh binary for bats tests.
#
# Behavior controlled by GH_MOCK_SCENARIO env var:
#
#   GH_MOCK_SCENARIO=success         → exit 0, "Logged in to github.com as user" on stdout
#   GH_MOCK_SCENARIO=expired         → exit 1, "You are not logged in to any GitHub hosts." on stdout
#   GH_MOCK_SCENARIO=anon_401        → exit 1, "HTTP 401: Bad credentials" on stderr
#   GH_MOCK_SCENARIO=network         → exit 1, "could not resolve host: api.github.com" on stderr
#   GH_MOCK_SCENARIO=timeout_short   → sleep 0.1, then would exit 0 — used to test shim doesn't fire
#                                       its watchdog on fast calls
#   GH_MOCK_SCENARIO=timeout_long    → sleep 8 (longer than shim's INTERNAL_TIMEOUT default)
#   GH_MOCK_SCENARIO=ambiguous       → exit 1, no recognized text in either stream
#   GH_MOCK_SCENARIO=empty           → exit 1, no output at all
#
# For non-`auth status` subcommands, the mock always exits 0 with stdout
# "mock gh subcommand: <args>" so the shim's pass-through behavior is
# testable.

set -u

if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then
    case "${GH_MOCK_SCENARIO:-}" in
        success)
            printf 'Logged in to github.com as testuser (oauth_token)\n'
            exit 0
            ;;
        expired)
            printf 'You are not logged in to any GitHub hosts. Run gh auth login to authenticate.\n'
            exit 1
            ;;
        anon_401)
            printf 'HTTP 401: Bad credentials (https://api.github.com/)\n' >&2
            exit 1
            ;;
        network)
            printf 'error connecting to api.github.com: could not resolve host\n' >&2
            exit 1
            ;;
        timeout_short)
            sleep 0.1
            printf 'Logged in to github.com as testuser (oauth_token)\n'
            exit 0
            ;;
        timeout_long)
            sleep 8
            exit 0
            ;;
        ambiguous)
            printf 'some surprising stderr\n' >&2
            exit 1
            ;;
        empty)
            exit 1
            ;;
        *)
            printf 'gh-mock: GH_MOCK_SCENARIO not set or unknown: %s\n' "${GH_MOCK_SCENARIO:-}" >&2
            exit 2
            ;;
    esac
fi

# Non-auth-status subcommand pass-through marker.
printf 'mock gh subcommand: %s\n' "$*"
exit 0
