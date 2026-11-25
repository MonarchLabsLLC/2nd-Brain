#!/bin/zsh
# Start the 2ndBrain web app at login (http://localhost:4321). Remove with scripts/uninstall-login-item.sh
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.2ndbrain.app.plist"
LOG="$HOME/Library/Logs/2ndBrain.log"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.2ndbrain.app</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>--disable-warning=ExperimentalWarning</string><string>$DIR/src/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.2ndbrain.app" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "2ndBrain starts at login. Open http://localhost:4321"
