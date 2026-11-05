#!/bin/bash
# Installs the job watcher as a LaunchAgent: runs `jobwatch.mjs run-once` every 5 minutes.
# Does not touch the bridge LaunchAgent (com.armaan.claude-safari-bridge).
# Usage: install-jobwatch.sh [--dry-run]   (--dry-run prints the plist and changes nothing)
set -euo pipefail

LABEL="com.armaan.claude-safari-jobwatch"
BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
JOBWATCH="$BRIDGE_DIR/jobwatch.mjs"
NODE="$(command -v node || true)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/claude-safari-jobwatch.log"

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "Usage: install-jobwatch.sh [--dry-run]"; exit 2 ;;
esac

[ -n "$NODE" ] || { echo "node not found on PATH. Install Node 20+ first (brew install node)."; exit 1; }
[ -f "$JOBWATCH" ] || { echo "Missing $JOBWATCH"; exit 1; }

PLIST_XML="$(cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$JOBWATCH</string>
    <string>run-once</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST_EOF
)"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' "$PLIST_XML"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
printf '%s\n' "$PLIST_XML" > "$PLIST"

plutil -lint "$PLIST" >/dev/null

# Replace any running copy, then load this one. The bridge agent is not touched.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout is asynchronous: wait (up to ~10 s) until the service is really gone.
for _ in $(seq 1 20); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  echo "bootstrap failed; retrying once..."
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi

echo "Job watcher installed: runs every 5 minutes. To pause it: touch ~/.claude-safari-bridge/jobwatch/off  (log: $LOG)"
