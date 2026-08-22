#!/bin/sh
# Wrap the macOS binary in the one thing that can carry an icon there.
#
# A Mach-O executable has nowhere to keep an icon. On macOS the icon is a file
# inside a bundle, named by Info.plist, and Finder reads the bundle rather than
# the binary — which is why sessionhubd can ship a logo on Windows and show
# nothing here. This builds that bundle around the same binary the release
# already carries; nothing is compiled differently.
#
# Double-clicking the result runs the binary with no arguments, which is
# `start`: the daemon detaches, the browser opens, the menu bar item appears,
# and this launcher exits. `LSUIElement` keeps that brief launch out of the
# Dock — sessionhub's face here is the menu bar.
#
# Run it on the Mac, after `cargo build --release`:
#
#     sh assets/make-app.sh <binary> <icns> <version> <output dir>
#
# The result is unsigned. macOS quarantines anything unsigned that arrived over
# the network, so the first launch is right-click → Open, or
# `xattr -d com.apple.quarantine sessionhub.app`. The plain binary in the
# release needs the same, and signing it needs a paid developer account.

set -e

BIN="$1"
ICNS="$2"
VERSION="$3"
OUT="$4"

if [ -z "$BIN" ] || [ -z "$ICNS" ] || [ -z "$VERSION" ] || [ -z "$OUT" ]; then
    echo "usage: make-app.sh <binary> <icns> <version> <output dir>" >&2
    exit 2
fi

APP="$OUT/sessionhub.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/sessionhubd"
chmod +x "$APP/Contents/MacOS/sessionhubd"
cp "$ICNS" "$APP/Contents/Resources/sessionhub.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>sessionhub</string>
    <key>CFBundleExecutable</key>
    <string>sessionhubd</string>
    <key>CFBundleIdentifier</key>
    <string>com.github.goldalworming.sessionhub</string>
    <key>CFBundleIconFile</key>
    <string>sessionhub</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$VERSION</string>
    <key>CFBundleVersion</key>
    <string>$VERSION</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# `ditto` rather than `zip`: it is the one archiver that keeps a bundle intact
# through the trip, and it is what Finder itself uses.
ZIP="$OUT/sessionhub-$VERSION-macos-arm64.app.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "built $APP"
echo "zipped $ZIP ($(wc -c < "$ZIP" | tr -d ' ') bytes)"
