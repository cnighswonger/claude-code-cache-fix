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

@test "install: refuses when TARGET_DIR/lib already exists pointing elsewhere (Codex r1 blocker fix)" {
    # Pre-create a `lib` symlink at the target dir pointing somewhere
    # else. The installer must REFUSE rather than silently leave a
    # broken shim on PATH.
    OTHER_DIR="$TEST_TMP/other-lib-target"
    mkdir -p "$OTHER_DIR"
    ln -s "$OTHER_DIR" "$TARGET_DIR/lib"

    run "$SHIM_DIR/install.sh" --target "$TARGET_DIR"
    [ "$status" = 1 ]
    [[ "$output" == *"not our managed lib link"* ]]
    # Rollback verified: the shim file must not be left in place.
    [ ! -e "$TARGET_DIR/gh" ]
}

@test "install: same shim → truly no-op (does not rewrite target file mtime)" {
    "$SHIM_DIR/install.sh" --target "$TARGET_DIR" >/dev/null
    # Capture the mtime of the installed shim.
    original_mtime=$(stat -c %Y "$TARGET_DIR/gh" 2>/dev/null || stat -f %m "$TARGET_DIR/gh" 2>/dev/null)
    # Sleep so the next mtime check is observably different IF a rewrite happened.
    sleep 1.1
    run "$SHIM_DIR/install.sh" --target "$TARGET_DIR"
    [ "$status" = 0 ]
    [[ "$output" == *"already installed"* ]]
    new_mtime=$(stat -c %Y "$TARGET_DIR/gh" 2>/dev/null || stat -f %m "$TARGET_DIR/gh" 2>/dev/null)
    # If the install correctly no-op'd, mtime should be unchanged.
    [ "$original_mtime" = "$new_mtime" ]
}

@test "uninstall: handles managed copy-fallback dir (sentinel-marked) cleanly" {
    # Simulate the copy-fallback path: install normally, then convert
    # the symlink to a copied directory marked as managed.
    "$SHIM_DIR/install.sh" --target "$TARGET_DIR" >/dev/null
    # Replace symlink with a copied directory + sentinel.
    rm -rf "$TARGET_DIR/lib"
    mkdir -p "$TARGET_DIR/lib"
    cp "$TARGET_DIR/.gh-auth-status-shim-lib/classify-auth-status.sh" "$TARGET_DIR/lib/"
    printf 'gh-auth-status-shim managed copy\n' > "$TARGET_DIR/lib/.managed"

    run "$SHIM_DIR/uninstall.sh" --target "$TARGET_DIR"
    [ "$status" = 0 ]
    # The managed lib dir should be gone.
    [ ! -e "$TARGET_DIR/lib" ]
}

@test "install: same-shim reinstall on drifted lib symlink → no longer a no-op, refuses or repairs (Codex r2 blocker fix)" {
    # Install once cleanly.
    "$SHIM_DIR/install.sh" --target "$TARGET_DIR" >/dev/null
    [ -L "$TARGET_DIR/lib" ]
    # Drift: repoint TARGET_DIR/lib at a different directory. This is
    # exactly the scenario Codex reproduced in round 2: shim+helper match
    # but the live lib link is broken, so a "no-op" would leave a shim
    # that fails sourcing at runtime.
    OTHER_DIR="$TEST_TMP/drifted-lib-target"
    mkdir -p "$OTHER_DIR"
    rm "$TARGET_DIR/lib"
    ln -s "$OTHER_DIR" "$TARGET_DIR/lib"

    run "$SHIM_DIR/install.sh" --target "$TARGET_DIR"
    # The fixed installer must NOT report "no-op" with a drifted lib.
    # Either it repairs the lib (exit 0, but it DID work — verify by
    # checking the link is now correct) OR it refuses (exit 1 with the
    # foreign-lib FATAL).
    if [ "$status" = 0 ]; then
        # If it claimed success, it must have repaired the link OR
        # refused with FATAL (mutex of the if-branch). Confirm the link
        # is actually correct now AND no "no-op" claim.
        [[ "$output" != *"no-op"* ]]
        # Lib should resolve correctly now.
        existing="$(readlink "$TARGET_DIR/lib")"
        [ "$existing" = ".gh-auth-status-shim-lib" ] || [ "$existing" = "$TARGET_DIR/.gh-auth-status-shim-lib" ]
    else
        # Refused — verify FATAL message named the foreign-lib problem.
        [[ "$output" == *"not our managed lib link"* ]]
    fi
}

@test "uninstall: leaves un-managed lib directory in place" {
    # User has their own lib/ dir that isn't ours.
    "$SHIM_DIR/install.sh" --target "$TARGET_DIR" >/dev/null
    rm -rf "$TARGET_DIR/lib"
    mkdir -p "$TARGET_DIR/lib"
    printf 'user content\n' > "$TARGET_DIR/lib/some-other-file.sh"

    run "$SHIM_DIR/uninstall.sh" --target "$TARGET_DIR"
    [ "$status" = 0 ]
    # User's lib dir should be intact (no .managed sentinel).
    [ -f "$TARGET_DIR/lib/some-other-file.sh" ]
    [[ "$output" == *"not marked managed"* ]]
}
