#!/bin/sh
# The macOS counterpart of the Windows setup.exe: a disk image holding
# sessionhub.app beside a link to /Applications, so installing is one drag.
#
# NSIS only makes Windows installers; on a Mac the native form is a .dmg, and
# `hdiutil` that makes one ships with macOS. Run it on the Mac, after
# `cargo build --release`:
#
#     sh installer/macos/make-dmg.sh <binary> <icns> <version> <output dir>
#
# The bundle itself comes from `assets/make-app.sh`, unchanged, so the .app in
# the image is the same one the release's .app.zip carries — and the zip is
# still built as a side effect.
#
# The name must NOT end in `macos-arm64`: that suffix is how the updater picks
# the plain binary out of a release.
#
# Like the .app, the image is unsigned. The first launch after copying is
# right-click → Open, or `xattr -dr com.apple.quarantine /Applications/sessionhub.app`.
# Signing and notarising need a paid developer account; when there is one,
# `codesign` the .app before this runs and `xcrun notarytool submit` the .dmg
# after.

set -e

BIN="$1"
ICNS="$2"
VERSION="$3"
OUT="$4"

if [ -z "$BIN" ] || [ -z "$ICNS" ] || [ -z "$VERSION" ] || [ -z "$OUT" ]; then
    echo "usage: make-dmg.sh <binary> <icns> <version> <output dir>" >&2
    exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
sh "$HERE/../../assets/make-app.sh" "$BIN" "$ICNS" "$VERSION" "$OUT"

# The image is made from a folder, and whatever is in the folder is what the
# window shows: the app, and a link to drop it on.
STAGE="$OUT/dmg-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$OUT/sessionhub.app" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

DMG="$OUT/sessionhub-$VERSION-macos-arm64.dmg"
rm -f "$DMG"
# UDZO: compressed and read-only — the format every downloaded .dmg uses.
hdiutil create -volname "sessionhub $VERSION" -srcfolder "$STAGE" \
    -fs HFS+ -format UDZO -ov "$DMG"
rm -rf "$STAGE"

echo "built $DMG ($(wc -c < "$DMG" | tr -d ' ') bytes)"
