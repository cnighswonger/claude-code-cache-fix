#!/usr/bin/env bash
# uninstall.sh — remove gh-auth-status-shim and any shim backups.
#
# Default target: $HOME/.local/bin/gh
# Override:       uninstall.sh --target /path/to/dir
#
# Refuses to remove a non-shim file at the target. Removes any
# <target>.bak.<timestamp> files that are also shim copies. NO
# restore-from-backup step — every .bak is by construction an older shim
# (install refuses to overwrite non-shim files), so restoring would
# silently reinstate an outdated shim.
#
# Idempotent: running twice is benign (second run prints "nothing to do").
# bash 3.2 compatible.

set -u

usage() {
    cat <<'EOF'
Usage: uninstall.sh [--target DIR] [--help]

  --target DIR   Uninstall from DIR/gh (default: $HOME/.local/bin)
  --help         Print this message and exit
EOF
}

TARGET_DIR="$HOME/.local/bin"

while [ $# -gt 0 ]; do
    case "$1" in
        --target)
            shift
            [ $# -gt 0 ] || { printf '[uninstall] --target requires a directory argument\n' >&2; exit 2; }
            TARGET_DIR="$1"
            ;;
        --help|-h)
            usage; exit 0 ;;
        *)
            printf '[uninstall] unknown argument: %s\n' "$1" >&2
            usage
            exit 2
            ;;
    esac
    shift
done

TARGET="$TARGET_DIR/gh"
LIB_TARGET_DIR="$TARGET_DIR/.gh-auth-status-shim-lib"
LIB_SYMLINK="$TARGET_DIR/lib"

is_a_shim() {
    head -5 "$1" 2>/dev/null | grep -q '^# gh-auth-status-shim$'
}

removed_anything=0

# Remove the main shim if it's actually our shim.
if [ -e "$TARGET" ]; then
    if is_a_shim "$TARGET"; then
        rm -f "$TARGET" && removed_anything=1
        printf '[uninstall] removed shim at %s\n' "$TARGET"
    else
        printf '[uninstall] FATAL: %s exists but is NOT a gh-auth-status-shim file. Refusing to remove.\n' "$TARGET" >&2
        exit 1
    fi
else
    printf '[uninstall] no shim found at %s\n' "$TARGET"
fi

# Remove any .bak.* shim backups. Verify each is a shim before removing.
# Using a glob carefully — set -u + nullglob unavailable on bash 3.2, so
# we use a portable loop with a `[ -e "$f" ]` guard.
for f in "$TARGET".bak.*; do
    [ -e "$f" ] || continue
    if is_a_shim "$f"; then
        rm -f "$f" && removed_anything=1
        printf '[uninstall] removed shim backup at %s\n' "$f"
    else
        printf '[uninstall] WARNING: %s exists but is not a shim — leaving in place.\n' "$f" >&2
    fi
done

# Remove the lib directory and symlink if present.
if [ -L "$LIB_SYMLINK" ] || [ -e "$LIB_SYMLINK" ]; then
    existing_target="$(readlink "$LIB_SYMLINK" 2>/dev/null || true)"
    case "$existing_target" in
        .gh-auth-status-shim-lib|"$LIB_TARGET_DIR")
            rm -rf "$LIB_SYMLINK" && removed_anything=1
            printf '[uninstall] removed lib symlink at %s\n' "$LIB_SYMLINK" ;;
        *)
            printf '[uninstall] WARNING: %s points elsewhere (%s); leaving in place.\n' \
                "$LIB_SYMLINK" "${existing_target:-(non-symlink)}" >&2 ;;
    esac
fi
if [ -d "$LIB_TARGET_DIR" ]; then
    rm -rf "$LIB_TARGET_DIR" && removed_anything=1
    printf '[uninstall] removed lib dir at %s\n' "$LIB_TARGET_DIR"
fi

if [ "$removed_anything" = "0" ]; then
    printf '[uninstall] nothing to do.\n'
fi

cat <<HOWTO

[uninstall] If you added an export line to your shell rc for this shim:
[uninstall]
[uninstall]     export PATH="$TARGET_DIR:\$PATH"
[uninstall]
[uninstall] you can remove it now. \`which gh\` should now resolve to the
[uninstall] real gh binary.

HOWTO
