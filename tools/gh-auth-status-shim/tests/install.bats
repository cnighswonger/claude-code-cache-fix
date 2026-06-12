#!/usr/bin/env bats
# install / uninstall integration tests.

setup() {
    HERE="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
    SHIM_DIR="$(cd "$HERE/.." && pwd)"
    TEST_TMP="$(mktemp -d -t gh-shim-install.XXXXXX)"
    TARGET_DIR="$TEST_TMP/bin"
    mkdir -p "$TARGET_DIR"
    # Add target to PATH for the PATH-ordering check inside install.sh.
    export PATH="$TARGET_DIR:$PATH"
}

teardown() {
    if [ -n "${TEST_TMP:-}" ] && [ -d "$TEST_TMP" ]; then
        rm -rf "$TEST_TMP"
    fi
}

@test "install: writes shim + lib to target dir" {
    run "$SHIM_DIR/install.sh" --target "$TARGET_DIR"
    [ "$status" = 0 ]
    [ -x "$TARGET_DIR/gh" ]
    [ -f "$TARGET_DIR/.gh-auth-status-shim-lib/classify-auth-status.sh" ]
    # Installed copy carries the marker.
    head -5 "$TARGET_DIR/gh" | grep -q '^# gh-auth-status-shim$'
}

@test "install: refuses to overwrite a non-shim file" {
    printf '#!/bin/bash\necho not a shim\n' > "$TARGET_DIR/gh"
    chmod +x "$TARGET_DIR/gh"
    run "$SHIM_DIR/install.sh" --target "$TARGET_DIR"
    [ "$status" = 1 ]
    [[ "$output" == *"NOT a gh-auth-status-shim"* ]]
    # Original file unchanged.
    grep -q "not a shim" "$TARGET_DIR/gh"
}

@test "install: backs up existing shim with different content" {
    # First install.
    run "$SHIM_DIR/install.sh" --target "$TARGET_DIR"
    [ "$status" = 0 ]
    # Mutate the installed file to simulate a different version.
    printf '\n# changed\n' >> "$TARGET_DIR/gh"
    # Reinstall — should create a backup.
    run "$SHIM_DIR/install.sh" --target "$TARGET_DIR"
    [ "$status" = 0 ]
    # Backup exists with the .bak.<timestamp> pattern.
    found_backup=0
    for f in "$TARGET_DIR"/gh.bak.*; do
        [ -e "$f" ] || continue
        # Backup must itself be a shim (has the marker).
        head -5 "$f" | grep -q '^# gh-auth-status-shim$' && found_backup=1
    done
    [ "$found_backup" = "1" ]
}

@test "install: same shim → no-op, no backup created" {
    run "$SHIM_DIR/install.sh" --target "$TARGET_DIR"
    [ "$status" = 0 ]
    # Reinstall without changes.
    run "$SHIM_DIR/install.sh" --target "$TARGET_DIR"
    [ "$status" = 0 ]
    [[ "$output" == *"already installed"* ]]
    # No backups present.
    backups=$(ls "$TARGET_DIR"/gh.bak.* 2>/dev/null | wc -l | tr -d ' ')
    [ "$backups" = "0" ]
}

@test "uninstall: removes shim + lib" {
    "$SHIM_DIR/install.sh" --target "$TARGET_DIR" >/dev/null
    [ -x "$TARGET_DIR/gh" ]
    run "$SHIM_DIR/uninstall.sh" --target "$TARGET_DIR"
    [ "$status" = 0 ]
    [ ! -e "$TARGET_DIR/gh" ]
    [ ! -e "$TARGET_DIR/.gh-auth-status-shim-lib" ]
    [ ! -e "$TARGET_DIR/lib" ]
}

@test "uninstall: removes shim backups too" {
    "$SHIM_DIR/install.sh" --target "$TARGET_DIR" >/dev/null
    # Force a backup.
    printf '\n# changed\n' >> "$TARGET_DIR/gh"
    "$SHIM_DIR/install.sh" --target "$TARGET_DIR" >/dev/null
    # At least one .bak should exist.
    bk_count_before=$(ls "$TARGET_DIR"/gh.bak.* 2>/dev/null | wc -l | tr -d ' ')
    [ "$bk_count_before" -ge 1 ]
    run "$SHIM_DIR/uninstall.sh" --target "$TARGET_DIR"
    [ "$status" = 0 ]
    bk_count_after=$(ls "$TARGET_DIR"/gh.bak.* 2>/dev/null | wc -l | tr -d ' ')
    [ "$bk_count_after" = "0" ]
}

@test "uninstall: refuses to remove a non-shim file at target" {
    printf '#!/bin/bash\necho not a shim\n' > "$TARGET_DIR/gh"
    chmod +x "$TARGET_DIR/gh"
    run "$SHIM_DIR/uninstall.sh" --target "$TARGET_DIR"
    [ "$status" = 1 ]
    [[ "$output" == *"NOT a gh-auth-status-shim"* ]]
    # File unchanged.
    [ -e "$TARGET_DIR/gh" ]
    grep -q "not a shim" "$TARGET_DIR/gh"
}

@test "uninstall: idempotent — second run is benign" {
    "$SHIM_DIR/install.sh" --target "$TARGET_DIR" >/dev/null
    "$SHIM_DIR/uninstall.sh" --target "$TARGET_DIR" >/dev/null
    run "$SHIM_DIR/uninstall.sh" --target "$TARGET_DIR"
    [ "$status" = 0 ]
    [[ "$output" == *"nothing to do"* ]]
}
