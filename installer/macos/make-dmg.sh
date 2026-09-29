#!/bin/sh
# The macOS counterpart of the Windows setup.exe: a disk image that opens on a
# window laid out the way Mac installers are — sessionhub on the left, an arrow,
# Applications on the right — so installing is one drag.
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
# The window's look (background, icon places, no toolbar) lives in the image's
# .DS_Store, and the one thing that writes a .DS_Store is Finder: so the image
# is made writable, Finder is asked through AppleScript to arrange it, and the
# result is compressed. That needs a logged-in session on the Mac — Finder
# briefly opens the window on its screen — which works over ssh as long as
# someone is logged in there.
#
# The background is background.svg, rendered to background.png and
# background@2x.png; both are merged into one Retina-aware .tiff here.
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

# Whatever is in this folder is what the window shows: the app, a link to drop
# it on, and (hidden, being a dot-folder) the background.
STAGE="$OUT/dmg-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/.background"
cp -R "$OUT/sessionhub.app" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
tiffutil -cathidpicheck "$HERE/background.png" "$HERE/background@2x.png" \
    -out "$STAGE/.background/background.tiff" >/dev/null 2>&1

RW="$OUT/sessionhub-rw.dmg"
DMG="$OUT/sessionhub-$VERSION-macos-arm64.dmg"
rm -f "$RW" "$DMG"
hdiutil create -volname "sessionhub $VERSION" -srcfolder "$STAGE" \
    -fs HFS+ -format UDRW -ov "$RW" >/dev/null
rm -rf "$STAGE"

# Attached where Finder sees it. Its name has to come back exactly as given:
# with one of that name already mounted (an older copy left open) it lands as
# "… 1", and the background — which Finder records by volume name — would be
# missing from every later mount under the real one.
MOUNT="$(hdiutil attach -readwrite -noverify -noautoopen "$RW" |
    sed -n 's|^/dev/[^[:space:]]*[[:space:]]*Apple_HFS[[:space:]]*||p' | head -n 1)"
DISK="$(basename "$MOUNT")"
if [ "$DISK" != "sessionhub $VERSION" ]; then
    hdiutil detach "$MOUNT" >/dev/null
    rm -f "$RW"
    echo "another \"sessionhub $VERSION\" volume is mounted — eject it and run this again" >&2
    exit 1
fi

# 660×400 of content, matching the background; bounds count the title bar too.
osascript <<EOF
tell application "Finder"
    tell disk "$DISK"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {200, 120, 860, 548}
        set opts to the icon view options of container window
        set arrangement of opts to not arranged
        set icon size of opts to 128
        set text size of opts to 13
        set background picture of opts to file ".background:background.tiff"
        set position of item "sessionhub.app" of container window to {165, 185}
        set position of item "Applications" of container window to {495, 185}
        close
        open
        update without registering applications
        delay 2
        close
    end tell
end tell
EOF

# Finder writes .DS_Store on its own schedule; detaching before it lands would
# ship the plain window this whole step exists to replace.
i=0
while [ ! -f "$MOUNT/.DS_Store" ] && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
sync
hdiutil detach "$MOUNT" >/dev/null

# UDZO: compressed and read-only — the format every downloaded .dmg uses.
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$DMG" >/dev/null
rm -f "$RW"

echo "built $DMG ($(wc -c < "$DMG" | tr -d ' ') bytes)"
