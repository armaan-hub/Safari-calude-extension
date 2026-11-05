#!/bin/bash
# Stops the Claude for Safari bridge and removes its LaunchAgent.
set -uo pipefail

LABEL="com.armaan.claude-safari-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Bridge stopped and LaunchAgent removed."

# Job watcher LaunchAgent (installed by install-jobwatch.sh), if present.
JOBWATCH_LABEL="com.armaan.claude-safari-jobwatch"
JOBWATCH_PLIST="$HOME/Library/LaunchAgents/$JOBWATCH_LABEL.plist"
launchctl bootout "gui/$(id -u)/$JOBWATCH_LABEL" 2>/dev/null || true
if [ -f "$JOBWATCH_PLIST" ]; then
  rm -f "$JOBWATCH_PLIST"
  echo "Job watcher LaunchAgent removed."
fi

# Chrome / Brave bridge, unless SKIP_CHROMIUM=1. Non-fatal.
UNINSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "${SKIP_CHROMIUM:-}" != "1" ] && [ -f "$UNINSTALL_DIR/uninstall-chromium.sh" ]; then
  bash "$UNINSTALL_DIR/uninstall-chromium.sh" || true
fi
