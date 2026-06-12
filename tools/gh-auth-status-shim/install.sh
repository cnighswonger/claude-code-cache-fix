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
        if cmp -s "$canonical_tmp" "$TARGET" 2>/dev/null; then
            rm -f "$canonical_tmp"
            printf '[install] same shim already installed at %s — no-op.\n' "$TARGET"
            # Still need to verify PATH and refresh lib (in case the user
            # nuked the lib dir manually).
        else
            rm -f "$canonical_tmp"
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

# Copy shim. The installed copy carries the marker as line 2 (right after
# the shebang) — added at install time so the source script doesn't get
# confused for "an installed copy" by an over-eager grep elsewhere.
{
    # shebang first
    head -1 "$SHIM_SOURCE"
    # marker line
    printf '# gh-auth-status-shim\n'
    # rest of file from line 2 onwards
    tail -n +2 "$SHIM_SOURCE"
} > "$TARGET" || { printf '[install] FATAL: could not write %s\n' "$TARGET" >&2; exit 1; }
chmod +x "$TARGET" || { printf '[install] FATAL: could not chmod +x %s\n' "$TARGET" >&2; exit 1; }

# Copy lib/ alongside, into a dot-prefixed subdirectory so it doesn't
# clutter ~/.local/bin/ listings. The shim resolves lib/ relative to
# itself, so we use a symlink/copy combo: the shim's `_self_dir/lib`
# must contain classify-auth-status.sh. Easiest: copy the lib/ dir
# alongside the shim but renamed; then symlink `lib` → that dir.
if [ -e "$LIB_TARGET_DIR" ]; then
    rm -rf "$LIB_TARGET_DIR" || true
fi
mkdir -p "$LIB_TARGET_DIR" || { printf '[install] FATAL: could not create lib dir\n' >&2; exit 1; }
cp "$LIB_SOURCE_DIR/classify-auth-status.sh" "$LIB_TARGET_DIR/" \
    || { printf '[install] FATAL: could not copy lib/classify-auth-status.sh\n' >&2; exit 1; }

# Create a `lib` symlink next to the shim that points at the hidden dir.
# The shim's `. "$_self_dir/lib/classify-auth-status.sh"` then resolves
# correctly.
LIB_SYMLINK="$TARGET_DIR/lib"
if [ -e "$LIB_SYMLINK" ] || [ -L "$LIB_SYMLINK" ]; then
    # If it's already pointing at our hidden dir, leave it alone.
    existing_target="$(readlink "$LIB_SYMLINK" 2>/dev/null || true)"
    if [ "$existing_target" = "$LIB_TARGET_DIR" ] || [ "$existing_target" = ".gh-auth-status-shim-lib" ]; then
        : # OK
    else
        printf '[install] WARNING: %s exists and points elsewhere. The shim needs %s/lib to point at %s — please reconcile.\n' \
            "$LIB_SYMLINK" "$TARGET_DIR" "$LIB_TARGET_DIR" >&2
    fi
else
    ln -s ".gh-auth-status-shim-lib" "$LIB_SYMLINK" 2>/dev/null \
        || cp -r "$LIB_TARGET_DIR" "$LIB_SYMLINK" \
        || { printf '[install] FATAL: could not link or copy lib/\n' >&2; exit 1; }
fi

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