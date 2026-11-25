#!/bin/zsh
launchctl bootout "gui/$(id -u)/com.2ndbrain.app" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.2ndbrain.app.plist"
echo "2ndBrain no longer starts at login."
