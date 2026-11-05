#!/usr/bin/env bash
# Builds the Chrome / Brave copy of the extension into ./dist/chromium.
# Same extension sources as the Safari build; only the manifest and a service-worker entry file differ.
# No Xcode, no signing, works offline.
# Usage: ./build-chromium.sh [--zip]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/extension"
OUT="$ROOT/dist/chromium"
ZIP_OUT="$ROOT/dist/claude-code-chromium.zip"

want_zip=0
for arg in "$@"; do
  case "$arg" in
    --zip) want_zip=1 ;;
    *) echo "Unknown option: $arg" >&2; echo "Usage: $0 [--zip]" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "node is required on PATH" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$ROOT/dist"
cp -R "$SRC" "$OUT"

# Patch the staged manifest with node (JSON edits, not sed).
JS='
const fs = require("fs");
const file = process.argv[1];
const m = JSON.parse(fs.readFileSync(file, "utf8"));
m.name = "Claude Code for Chrome and Brave";
m.description = "Let Claude read and operate the page you are on, using your own logged-in Chrome or Brave session.";
m.background = { service_worker: "sw.js" };
fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
'
node -e "$JS" "$OUT/manifest.json"

# Chrome MV3 service workers load classic scripts with importScripts, not a background "scripts" list.
printf '%s\n' 'importScripts("term-sites.js", "background.js");' > "$OUT/sw.js"

# Stable extension ID: the public key (one base64 line) goes into the STAGED manifest only. Fails if missing or empty.
KEY_FILE="$ROOT/tools/chromium-extension-key.txt"
if [ ! -s "$KEY_FILE" ] || [ -z "$(tr -d '[:space:]' < "$KEY_FILE")" ]; then
  echo "build-chromium: public key missing or empty: $KEY_FILE" >&2
  exit 1
fi

# Point the Chromium copy at its own bridge (port 8788), so Safari (8787) and Chromium never share a bridge.
# Node edits of the staged files only; extension/ is never changed.
PORT_JS='
const fs = require("fs");
const path = require("path");
const dir = process.argv[1];
const key = fs.readFileSync(process.argv[2], "utf8").trim();
if (!key) {
  console.error("build-chromium: public key file is empty");
  process.exit(1);
}
const OLD_BASE = "const BRIDGE_BASE = \"http://127.0.0.1:8787\";";
const NEW_BASE = "const BRIDGE_BASE = \"http://127.0.0.1:8788\";";
const bgFile = path.join(dir, "background.js");
const bg = fs.readFileSync(bgFile, "utf8");
if (!bg.includes(OLD_BASE)) {
  console.error("build-chromium: exact BRIDGE_BASE line (port 8787) not found in background.js");
  process.exit(1);
}
fs.writeFileSync(bgFile, bg.replace(OLD_BASE, NEW_BASE));
const mFile = path.join(dir, "manifest.json");
const m = JSON.parse(fs.readFileSync(mFile, "utf8"));
const hp = Array.isArray(m.host_permissions) ? m.host_permissions : [];
const i = hp.indexOf("http://127.0.0.1:8787/*");
if (i < 0) {
  console.error("build-chromium: http://127.0.0.1:8787/* not found in host_permissions");
  process.exit(1);
}
hp[i] = "http://127.0.0.1:8788/*";
m.host_permissions = hp;
m.key = key;
fs.writeFileSync(mFile, JSON.stringify(m, null, 2) + "\n");
'
node -e "$PORT_JS" "$OUT" "$KEY_FILE"

# Fail the build if any Safari port is left anywhere in the Chromium copy (content.js, term-sites.js and panel files included).
if grep -rl "8787" "$OUT" >/dev/null 2>&1; then
  echo "build-chromium: port 8787 still present in $OUT:" >&2
  grep -rn "8787" "$OUT" >&2
  exit 1
fi
echo "Port check: no 8787 in dist/chromium (content.js, term-sites.js and panel files clean); bridge port is 8788."

EXT_ORIGIN="$(node "$ROOT/bridge/chromium-id.mjs")"
echo "Extension ID: ${EXT_ORIGIN#chrome-extension://}"

if [ "$want_zip" -eq 1 ]; then
  rm -f "$ZIP_OUT"
  (cd "$ROOT/dist" && zip -qr "$ZIP_OUT" chromium)
  echo "Wrote $ZIP_OUT"
fi

cat <<EOF
Built Chrome / Brave extension: $OUT

Install (Chrome or Brave):
  1. Open chrome://extensions (Brave: brave://extensions) and turn on "Developer mode".
  2. Click "Load unpacked" and pick: $OUT
  3. Click the toolbar icon, or press Alt+Shift+C on a tab, to share that tab with Claude.
EOF
