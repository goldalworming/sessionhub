#!/bin/sh
# Build the Windows setup.exe around a release binary.
#
#     sh installer/windows/build-installer.sh <sessionhubd.exe> <version> [output dir]
#
# Needs NSIS 3 (`makensis`): `apt install nsis` on Linux, `brew install
# makensis` on a Mac, or the installer from nsis.sourceforge.io on Windows
# (run this under Git Bash there). It cross-builds: the setup.exe made on
# Linux is the same one Windows would make.

set -e

BIN="$1"
VERSION="$2"
OUT="${3:-.}"

if [ -z "$BIN" ] || [ -z "$VERSION" ]; then
    echo "usage: build-installer.sh <sessionhubd.exe> <version> [output dir]" >&2
    exit 2
fi

# makensis changes into the script's folder, so every path it is handed has
# to be absolute — and, under Git Bash, a Windows path (`pwd -W`), since
# makensis.exe does not know what /c/Users means.
here() { pwd -W 2>/dev/null || pwd; }
abs() { (cd "$(dirname "$1")" && printf '%s/%s' "$(here)" "$(basename "$1")"); }

mkdir -p "$OUT"
BIN="$(abs "$BIN")"
OUT="$(cd "$OUT" && here)"
SETUP="$OUT/sessionhub-$VERSION-windows-x86_64-setup.exe"
HERE="$(cd "$(dirname "$0")" && here)"

# And with backslashes: makensis.exe's `File` finds nothing at a path written
# with forward slashes. Elsewhere (no `pwd -W`) they are left as they are.
win() { if pwd -W >/dev/null 2>&1; then printf '%s' "$1" | tr / '\\'; else printf '%s' "$1"; fi; }

makensis -V2 -DVERSION="$VERSION" -DBINARY="$(win "$BIN")" -DOUTFILE="$(win "$SETUP")" "$HERE/sessionhub.nsi"

echo "built $SETUP ($(wc -c < "$SETUP" | tr -d ' ') bytes)"
