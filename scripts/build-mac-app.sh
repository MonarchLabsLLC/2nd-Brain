#!/bin/zsh
# Build 2ndBrain.app (native window with its own Dock icon) into ~/Applications.
# Needs Xcode Command Line Tools (swiftc) and rsvg-convert (brew install librsvg).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HOME/Applications}"
APP="$OUT/2ndBrain.app"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

# Icon: SVG -> iconset -> icns
ICONSET="$BUILD/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  rsvg-convert -w $s -h $s "$DIR/mac/icon.svg" -o "$ICONSET/icon_${s}x${s}.png"
  rsvg-convert -w $((s*2)) -h $((s*2)) "$DIR/mac/icon.svg" -o "$ICONSET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$BUILD/AppIcon.icns"

# Binary
swiftc -O -o "$BUILD/2ndBrain" "$DIR/mac/main.swift" -framework Cocoa -framework WebKit

# Bundle
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/2ndBrain" "$APP/Contents/MacOS/2ndBrain"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>2ndBrain</string>
  <key>CFBundleDisplayName</key><string>2ndBrain</string>
  <key>CFBundleIdentifier</key><string>local.2ndbrain.viewer</string>
  <key>CFBundleExecutable</key><string>2ndBrain</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PL
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"
echo "Built $APP"
