#!/bin/bash
# Installs the Claude Code bridge for Chrome and Brave as a LaunchAgent: starts at login, restarts if it stops.
# A separate instance from the other browser's bridge: own port (8788), own state folder, own LaunchAgent, own Zellij session.
set -euo pipefail

LABEL="com.armaan.claude-chromium-bridge"
BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$BRIDGE_DIR/claude-bridge.mjs"
NODE="$(command -v node || true)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/claude-chromium-bridge.log"
STATE_DIR="$HOME/.claude-chromium-bridge"
PORT_NUM=8788

[ -n "$NODE" ] || { echo "node not found on PATH. Install Node 20+ first (brew install node)."; exit 1; }
# Non-fatal hints: the bridge still installs without these.
command -v claude >/dev/null 2>&1 || echo "Warning: Claude Code (claude) not found on PATH. Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash, then run claude and log in."
if ! { [ -x /opt/homebrew/bin/zellij ] || [ -x /usr/local/bin/zellij ] || command -v zellij >/dev/null 2>&1; }; then
  echo "Optional: brew install zellij  (auto-opens a Claude Code terminal session when you share a tab in Chrome or Brave)"
fi
[ -f "$BRIDGE" ] || { echo "Missing $BRIDGE"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Own state folder for this bridge (token, allowed sites, profile, resume, queue). Owner-only, created before start.
mkdir -p -m 700 "$STATE_DIR"
chmod 700 "$STATE_DIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$BRIDGE</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PORT</key>
    <string>$PORT_NUM</string>
    <key>CLAUDE_BRIDGE_HOME</key>
    <string>$STATE_DIR</string>
    <key>CLAUDE_ZELLIJ_SESSION</key>
    <string>claude-chromium</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST_EOF

plutil -lint "$PLIST" >/dev/null

# Replace any running copy of this bridge, then start it. Other bridges are not touched.
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

echo "Chrome / Brave bridge installed on port $PORT_NUM, state folder $STATE_DIR."
echo "Register its MCP servers (chromium, chromium-assistant) with Claude Code as described in INSTALL.md, section Chrome and Brave."
echo "Risky Chrome or Brave actions (post, send, submit) ask you to Allow in Claude Code, or on the shared tab. Claude cannot approve them itself."

sleep 2
if HEALTH="$(curl -s --max-time 3 http://127.0.0.1:$PORT_NUM/health)"; then
  echo "Bridge answered: $HEALTH"
else
  echo "Chrome / Brave bridge did not answer yet. Check the log: $LOG"
  exit 1
fi
