#!/bin/bash
# Installs the Claude for Safari bridge as a LaunchAgent: starts at login, restarts if it stops.
set -euo pipefail

LABEL="com.armaan.claude-safari-bridge"
BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$BRIDGE_DIR/claude-bridge.mjs"
NODE="$(command -v node || true)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/claude-safari-bridge.log"

[ -n "$NODE" ] || { echo "node not found on PATH. Install Node 20+ first (brew install node)."; exit 1; }
# Non-fatal hints: the bridge still installs without these.
command -v claude >/dev/null 2>&1 || echo "Warning: Claude Code (claude) not found on PATH. Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash, then run claude and log in."
if ! { [ -x /opt/homebrew/bin/zellij ] || [ -x /usr/local/bin/zellij ] || command -v zellij >/dev/null 2>&1; }; then
  echo "Optional: brew install zellij  (auto-opens a Claude Code terminal session when you share a tab)"
fi
[ -f "$BRIDGE" ] || { echo "Missing $BRIDGE"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

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
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST_EOF

plutil -lint "$PLIST" >/dev/null

# Replace any running copy, then start this one.
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

# Terminal mode (PLAN T13a): register the Safari MCP server with Claude Code, once.
MCP_SERVER="$BRIDGE_DIR/safari-mcp.mjs"
if command -v claude >/dev/null 2>&1; then
  if claude mcp get safari >/dev/null 2>&1; then
    echo "Claude Code already has the safari MCP server."
  elif claude mcp add --scope user safari -- "$NODE" "$MCP_SERVER"; then
    echo "Added the safari MCP server to Claude Code."
  else
    echo "Could not add the safari MCP server. Run: claude mcp add --scope user safari -- node \"$MCP_SERVER\""
  fi
  echo "Note: risky Safari actions (post, send, submit) ask you to Allow in Claude Code, or on the shared tab. Claude cannot approve them itself."
else
  echo "claude not found on PATH; skipped the safari MCP server."
fi

sleep 2
if HEALTH="$(curl -s --max-time 3 http://127.0.0.1:8787/health)"; then
  echo "Bridge answered: $HEALTH"
else
  echo "Bridge did not answer yet. Check the log: $LOG"
  exit 1
fi

# Chrome / Brave bridge: installed by the same command unless SKIP_CHROMIUM=1. Its failure never changes this exit status.
if [ "${SKIP_CHROMIUM:-}" != "1" ] && [ -f "$BRIDGE_DIR/install-chromium.sh" ]; then
  bash "$BRIDGE_DIR/install-chromium.sh" || echo "Chrome / Brave bridge install did not finish; run bridge/install-chromium.sh to retry."
fi
