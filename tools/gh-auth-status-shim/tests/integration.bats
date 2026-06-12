#!/usr/bin/env bats
# End-to-end integration tests for gh-auth-status-shim.

setup() {
    case "$BASH_VERSION" in
        3.2*|4.*|5.*) ;;
        *) printf 'unexpected BASH_VERSION: %s\n' "$BASH_VERSION" >&2; return 1 ;;
    esac

    HERE="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
    SHIM_DIR="$(cd "$HERE/.." && pwd)"

    # Sandbox PATH: a tmp dir where we install the mock gh AS the "real" gh
    # binary, then prepend the shim's directory ahead of it.
    TEST_TMP="$(mktemp -d -t gh-shim-test.XXXXXX)"
    REAL_GH_DIR="$TEST_TMP/real-gh"
    SHIM_TARGET_DIR="$TEST_TMP/shim"
    mkdir -p "$REAL_GH_DIR" "$SHIM_TARGET_DIR"

    # Install the mock as the "real" gh.
    cp "$HERE/mocks/gh-mock.sh" "$REAL_GH_DIR/gh"
    chmod +x "$REAL_GH_DIR/gh"

    # Stage the shim. We do this manually (not via install.sh) so this
    # test stays focused on shim behavior — install.sh has its own tests.
    cp "$SHIM_DIR/gh-auth-status-shim.sh" "$SHIM_TARGET_DIR/gh"
    chmod +x "$SHIM_TARGET_DIR/gh"
    mkdir -p "$SHIM_TARGET_DIR/lib"
    cp "$SHIM_DIR/lib/classify-auth-status.sh" "$SHIM_TARGET_DIR/lib/"

    # Shim ahead of real-gh on PATH.
    export PATH="$SHIM_TARGET_DIR:$REAL_GH_DIR:$PATH"
    # Short timeout for faster tests.
    export GH_AUTH_STATUS_SHIM_TIMEOUT="2"
}

teardown() {
    if [ -n "${TEST_TMP:-}" ] && [ -d "$TEST_TMP" ]; then
        rm -rf "$TEST_TMP"
    fi
}

# --- Pass-through behavior ---

@test "integration: non-auth-status subcommand passes through to real gh" {
    run gh pr list --state open
    [ "$status" = 0 ]
    [[ "$output" == *"mock gh subcommand: pr list --state open"* ]]
}

@test "integration: gh auth login passes through to real gh" {
    run gh auth login --hostname github.com
    [ "$status" = 0 ]
    [[ "$output" == *"mock gh subcommand: auth login --hostname github.com"* ]]
}

# --- Intercept behavior ---

@test "integration: auth status success → shim returns 0 + stdout preserved" {
    export GH_MOCK_SCENARIO=success
    run gh auth status
    [ "$status" = 0 ]
    [[ "$output" == *"Logged in to github.com"* ]]
}

@test "integration: auth status expired → shim propagates non-zero" {
    export GH_MOCK_SCENARIO=expired
    run gh auth status
    [ "$status" = 1 ]
    [[ "$output" == *"not logged in"* ]]
}

@test "integration: auth status HTTP 401 on stderr → shim propagates non-zero" {
    export GH_MOCK_SCENARIO=anon_401
    run gh auth status
    [ "$status" = 1 ]
    [[ "$output" == *"HTTP 401"* ]]
}

@test "integration: auth status network transient → shim returns 0 (toast suppressed)" {
    export GH_MOCK_SCENARIO=network
    run gh auth status
    [ "$status" = 0 ]
    [[ "$output" == *"could not resolve host"* ]]
    [[ "$output" == *"transient"* ]]
}

@test "integration: auth status timeout (mock sleeps 8s, shim times out at 2s) → exit 0" {
    export GH_MOCK_SCENARIO=timeout_long
    start=$(date +%s)
    run gh auth status
    end=$(date +%s)
    elapsed=$((end - start))
    [ "$status" = 0 ]
    [ "$elapsed" -lt 5 ]
    [[ "$output" == *"timed out"* ]]
}

@test "integration: auth status ambiguous failure → shim propagates real exit (conservative)" {
    export GH_MOCK_SCENARIO=ambiguous
    run gh auth status
    [ "$status" = 1 ]
}

@test "integration: auth status with --hostname argument passes args to real gh" {
    export GH_MOCK_SCENARIO=success
    run gh auth status --hostname github.com
    [ "$status" = 0 ]
    [[ "$output" == *"Logged in to github.com"* ]]
}

# --- Error path: no real gh found ---

@test "integration: shim aborts with clear error if no real gh on PATH" {
    # Build a minimal PATH where no `gh` exists except the shim. Capture
    # commands we need (rm) into a tmp dir so teardown still works.
    NO_GH_DIR="$TEST_TMP/no-gh-bin"
    mkdir -p "$NO_GH_DIR"
    # Provide rm and other minimal utilities via symlinks (incl. bash
    # itself for the shim's shebang resolution via env).
    for cmd in bash env rm cat head grep readlink dirname basename mktemp date kill sleep tr; do
        if command -v "$cmd" >/dev/null 2>&1; then
            ln -s "$(command -v "$cmd")" "$NO_GH_DIR/$cmd" 2>/dev/null || true
        fi
    done
    export PATH="$SHIM_TARGET_DIR:$NO_GH_DIR"
    run gh auth status
    [ "$status" = 127 ]
    [[ "$output" == *"cannot find a real"* ]]
}

# --- Debug log surface ---

@test "integration: TERM-ignoring child still normalizes to 124 within 5s window (Codex r1 blocker fix)" {
    # Replace the mock with one that ignores SIGTERM. The shim's
    # bash-native watchdog must escalate to SIGKILL and normalize 137
    # back to 124, AND the whole operation must complete inside CC's 5s
    # spawn-abandonment window.
    cat > "$REAL_GH_DIR/gh" <<'TERMIGNORE'
#!/usr/bin/env bash
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
    trap '' TERM
    sleep 30
    exit 0
fi
printf 'mock gh: %s\n' "$*"
TERMIGNORE
    chmod +x "$REAL_GH_DIR/gh"

    # Disable GNU `timeout` if present so we exercise the bash-native path.
    NO_TIMEOUT_DIR="$TEST_TMP/no-timeout"
    mkdir -p "$NO_TIMEOUT_DIR"
    for cmd in bash env rm cat head grep readlink dirname basename mktemp date kill sleep tr cmp cp chmod printf; do
        if command -v "$cmd" >/dev/null 2>&1; then
            ln -s "$(command -v "$cmd")" "$NO_TIMEOUT_DIR/$cmd" 2>/dev/null || true
        fi
    done
    export PATH="$SHIM_TARGET_DIR:$REAL_GH_DIR:$NO_TIMEOUT_DIR"

    start=$(date +%s)
    run gh auth status
    end=$(date +%s)
    elapsed=$((end - start))

    [ "$status" = 0 ]
    # Must complete under 5s — CC Desktop's spawn-abandonment window.
    [ "$elapsed" -lt 5 ]
    [[ "$output" == *"timed out"* ]]
}

@test "integration: GH_AUTH_STATUS_SHIM_DEBUG_LOG records each call when set" {
    export GH_MOCK_SCENARIO=success
    export GH_AUTH_STATUS_SHIM_DEBUG_LOG="$TEST_TMP/debug.log"
    run gh auth status
    [ "$status" = 0 ]
    [ -s "$GH_AUTH_STATUS_SHIM_DEBUG_LOG" ]
    grep -q "auth status: invoking real gh" "$GH_AUTH_STATUS_SHIM_DEBUG_LOG"
    grep -q "auth status: classified exit=0" "$GH_AUTH_STATUS_SHIM_DEBUG_LOG"
}
