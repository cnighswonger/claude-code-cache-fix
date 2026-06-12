#!/usr/bin/env bash
# install.sh — install gh-auth-status-shim as a PATH-resolved gh wrapper.
#
# Default target: $HOME/.local/bin/gh
# Override:       install.sh --target /path/to/dir
#
# Refuses to overwrite a non-shim file. Backs up an existing shim to
# <target>.bak.<timestamp> before overwriting (uninstall cleans these up).
# Verifies PATH ordering: target dir must resolve `gh` to the shim AFTER
# install. Does NOT modify the user's shell rc files — prints the export
# line they should add.
#
# bash 3.2 compatible. No GNU coreutils. No jq.

set -u

usage() {
    cat <<'EOF'
Usage: install.sh [--target DIR] [--help]

  --target DIR   Install the shim at DIR/gh (default: $HOME/.local/bin)
  --help         Print this message and exit

The shim addresses anthropics/claude-code#67055. See
tools/gh-auth-status-shim/README.md for the full design and limitations
(macOS launchd-PATH caveat, behavioral-change disclosure, sunset plan).
EOF
}

TARGET_DIR="$HOME/.local/bin"

while [ $# -gt 0 ]; do
    case "$1" in
        --target)
            shift
            [ $# -gt 0 ] || { printf '[install] --target requires a directory argument\n' >&2; exit 2; }
            TARGET_DIR="$1"
            ;;
        --help|-h)
            usage; exit 0 ;;
        *)
            printf '[install] unknown argument: %s\n' "$1" >&2
            usage
            exit 2
            ;;
    esac
    shift
done

# Resolve script directory portably (no readlink -f on macOS).
script_path="$0"
while [ -L "$script_path" ]; do
    link_target="$(readlink "$script_path")"
    case "$link_target" in
        /*) script_path="$link_target" ;;
        *)  script_path="$(cd "$(dirname "$script_path")" && pwd)/$link_target" ;;
    esac
done
SCRIPT_DIR="$(cd "$(dirname "$script_path")" && pwd)"

SHIM_SOURCE="$SCRIPT_DIR/gh-auth-status-shim.sh"
LIB_SOURCE_DIR="$SCRIPT_DIR/lib"

if [ ! -r "$SHIM_SOURCE" ]; then
    printf '[install] FATAL: source shim not found at %s\n' "$SHIM_SOURCE" >&2
    exit 1
fi
if [ ! -d "$LIB_SOURCE_DIR" ]; then
    printf '[install] FATAL: lib/ directory not found at %s\n' "$LIB_SOURCE_DIR" >&2
    exit 1
fi

TARGET="$TARGET_DIR/gh"
LIB_TARGET_DIR="$TARGET_DIR/.gh-auth-status-shim-lib"

# Ensure the target directory exists.
if [ ! -d "$TARGET_DIR" ]; then
    printf '[install] creating %s\n' "$TARGET_DIR"
    mkdir -p "$TARGET_DIR" || { printf '[install] FATAL: could not create %s\n' "$TARGET_DIR" >&2; exit 1; }
fi

# Identify the shim by a marker the install script writes into the
# installed copy. Used to (a) refuse to overwrite a non-shim file and
# (b) confirm `.bak.*` files are shim backups before uninstall removes
# them. The marker is `# gh-auth-status-shim` on a line by itself in
# the installed copy.
is_a_shim() {
    # Read the first 5 lines (cheap; matches even if the shebang is the
    # very first line) and grep for the exact marker line.
    head -5 "$1" 2>/dev/null | grep -q '^# gh-auth-status-shim$'
}

# If a file exists at the target:
# IS_SAME_SHIM=1 means the on-disk shim and lib are byte-identical to the
# source — skip the rewrite to honor the directive's no-op contract.
IS_SAME_SHIM=0
if [ -e "$TARGET" ]; then
    if is_a_shim "$TARGET"; then
        # Same version? Build what the install would produce and compare
        # against the installed file. The installed copy has the marker
        # at line 2, so cmp'ing against the source directly would never
        # match; build the canonical installed shape into a tmp first.
        canonical_tmp="$(mktemp -t gh-shim-canonical.XXXXXX)"
        {
            head -1 "$SHIM_SOURCE"
            printf '# gh-auth-status-shim\n'
            tail -n +2 "$SHIM_SOURCE"
        } > "$canonical_tmp"
        # Also compare the lib file; both must match for a true no-op.
        # (Lib content drift between source and installed is a directive-
        # violation no-op-claim per Codex r1 attention.)
        lib_installed="$LIB_TARGET_DIR/classify-auth-status.sh"
        if cmp -s "$canonical_tmp" "$TARGET" 2>/dev/null \
            && cmp -s "$LIB_SOURCE_DIR/classify-auth-status.sh" "$lib_installed" 2>/dev/null; then
            IS_SAME_SHIM=1
        fi
        rm -f "$canonical_tmp"
        if [ "$IS_SAME_SHIM" = "1" ]; then
            printf '[install] same shim already installed at %s — no-op.\n' "$TARGET"
            # Skip rewrite. Still verify PATH below.
        else
            ts="$(date -u +%Y%m%dT%H%M%SZ)"
            backup="$TARGET.bak.$ts"
            printf '[install] existing shim differs; backing up to %s\n' "$backup"
            cp "$TARGET" "$backup" || { printf '[install] FATAL: could not back up existing shim\n' >&2; exit 1; }
        fi
    else
        printf '[install] FATAL: %s exists and is NOT a gh-auth-status-shim file.\n' "$TARGET" >&2
        printf '[install] Refusing to overwrite. Move or remove this file first.\n' >&2
        exit 1
    fi
fi

if [ "$IS_SAME_SHIM" = "0" ]; then
    # Copy shim. The installed copy carries the marker as line 2 (right
    # after the shebang) — added at install time so the source script
    # doesn't get confused for "an installed copy" by an over-eager
    # grep elsewhere.
    {
        # shebang first
        head -1 "$SHIM_SOURCE"
        # marker line
        printf '# gh-auth-status-shim\n'
        # rest of file from line 2 onwards
        tail -n +2 "$SHIM_SOURCE"
    } > "$TARGET" || { printf '[install] FATAL: could not write %s\n' "$TARGET" >&2; exit 1; }
    chmod +x "$TARGET" || { printf '[install] FATAL: could not chmod +x %s\n' "$TARGET" >&2; exit 1; }

    # Copy lib/ alongside, into a dot-prefixed subdirectory so it
    # doesn't clutter ~/.local/bin/ listings.
    if [ -e "$LIB_TARGET_DIR" ]; then
        rm -rf "$LIB_TARGET_DIR" || true
    fi
    mkdir -p "$LIB_TARGET_DIR" || { printf '[install] FATAL: could not create lib dir\n' >&2; exit 1; }
    cp "$LIB_SOURCE_DIR/classify-auth-status.sh" "$LIB_TARGET_DIR/" \
        || { printf '[install] FATAL: could not copy lib/classify-auth-status.sh\n' >&2; exit 1; }
fi

if [ "$IS_SAME_SHIM" = "1" ]; then
    # Same-shim no-op — also skip lib-link recreation; assume the
    # existing setup is correct (the lib-content cmp above confirmed it).
    :
else
# Create a `lib` symlink next to the shim that points at the hidden dir.
# The shim's `. "$_self_dir/lib/classify-auth-status.sh"` then resolves
# correctly.
#
# This must be all-or-nothing per Codex r1 blocker: a pre-existing
# TARGET_DIR/lib pointing elsewhere will break the shim's source line
# at runtime, so silently warning + claiming success leaves a broken
# shim on PATH. We refuse the install in that case.
LIB_SYMLINK="$TARGET_DIR/lib"
if [ -e "$LIB_SYMLINK" ] || [ -L "$LIB_SYMLINK" ]; then
    existing_target="$(readlink "$LIB_SYMLINK" 2>/dev/null || true)"
    case "$existing_target" in
        "$LIB_TARGET_DIR"|".gh-auth-status-shim-lib")
            : # Already correct — no-op.
            ;;
        *)
            printf '[install] FATAL: %s exists and is not our managed lib link.\n' "$LIB_SYMLINK" >&2
            if [ -n "$existing_target" ]; then
                printf '[install] It currently points at: %s\n' "$existing_target" >&2
            fi
            printf '[install] The shim needs %s/lib to resolve to its classification helper. Move or remove this entry first.\n' "$TARGET_DIR" >&2
            # Roll back the shim install so we never leave a broken
            # shim on PATH.
            rm -f "$TARGET"
            rm -rf "$LIB_TARGET_DIR"
            exit 1
            ;;
    esac
else
    if ln -s ".gh-auth-status-shim-lib" "$LIB_SYMLINK" 2>/dev/null; then
        :
    elif cp -r "$LIB_TARGET_DIR" "$LIB_SYMLINK" 2>/dev/null; then
        # Mark this so uninstall knows it's a managed copy (not a user
        # directory of the same name). We use a sentinel file inside.
        printf 'gh-auth-status-shim managed copy\n' > "$LIB_SYMLINK/.managed"
    else
        printf '[install] FATAL: could not link or copy lib/\n' >&2
        rm -f "$TARGET"
        rm -rf "$LIB_TARGET_DIR"
        exit 1
    fi
fi
fi  # end: IS_SAME_SHIM gate for lib link creation

# PATH-ordering check. We resolve `gh` using PATH AFTER install and
# verify it points at our target. If not, the shim is installed but
# inert — print the export line the user should add.
resolved_gh="$(command -v gh 2>/dev/null || true)"
if [ "$resolved_gh" = "$TARGET" ]; then
    printf '[install] PATH ordering OK: `which gh` resolves to the shim.\n'
else
    printf '[install] WARNING: `which gh` resolves to %s, NOT the shim at %s.\n' "${resolved_gh:-(none)}" "$TARGET" >&2
    printf '[install] Add this to your shell rc (e.g. ~/.bashrc, ~/.zshrc) and reopen your shell:\n' >&2
    printf '\n    export PATH="%s:$PATH"\n\n' "$TARGET_DIR" >&2
    printf '[install] The shim file is in place but will not run until PATH ordering is corrected.\n' >&2
fi

# Sunset notice.
cat <<SUNSET

[install] Installed gh-auth-status-shim. This is a workaround for
[install] anthropics/claude-code#67055; it intercepts \`gh auth status\`
[install] outcomes only, and exec's the real gh for every other subcommand.
[install]
[install] Limitations to review in README.md:
[install]  - The shim rewrites \`gh auth status\` exit-code semantics for
[install]    every caller in this PATH scope, including non-CC tools.
[install]  - On macOS, GUI apps (including CC Desktop launched from
[install]    Finder/Dock) inherit launchd's PATH, not your shell PATH.
[install]    The shim may be invisible to CC Desktop on macOS even if
[install]    \`which gh\` shows it in your shell.
[install]  - Native Windows CC Desktop is not covered by a bash shim.
[install]
[install] Uninstall when CC#67055 closes with an upstream fix:
[install]   tools/gh-auth-status-shim/uninstall.sh --target $TARGET_DIR

SUNSET