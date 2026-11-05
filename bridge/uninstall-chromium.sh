#!/bin/bash
# Stops the Claude Code bridge for Chrome and Brave and removes its LaunchAgent.
# Leaves the other browser's bridge and its LaunchAgent alone. The state folder ~/.claude-chromium-bridge is kept.
set -uo pipefail

LABEL="com.armaan.claude-chromium-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Chrome / Brave bridge stopped and LaunchAgent removed. State folder ~/.claude-chromium-bridge was kept."
