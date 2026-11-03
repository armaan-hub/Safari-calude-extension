#!/bin/bash
# Stops the Claude for Safari bridge and removes its LaunchAgent.
set -uo pipefail

LABEL="com.armaan.claude-safari-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Bridge stopped and LaunchAgent removed."
