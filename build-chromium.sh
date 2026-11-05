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
