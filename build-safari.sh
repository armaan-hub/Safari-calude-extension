#!/usr/bin/env bash
set -euo pipefail

# Usage: ./build-safari.sh [--variant terminal|panel] [--no-install]
#   default               build both variants (Claude Code for Safari, Claude Panel for Safari)
#   --variant terminal    build only the terminal variant
#   --variant panel       build only the panel variant
#   --no-install          build and sign, but leave /Applications and LaunchServices alone
#   The signing team is auto-detected from your Apple Development certificate.
#   TEAM_ID=XXXXXXXXXX ./build-safari.sh   override the signing team
#   BUNDLE_PREFIX=com.yourname ./build-safari.sh   bundle id prefix (default com.armaan; change it if Xcode says the id is taken)

INSTALL=1
VARIANTS="terminal panel"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-install) INSTALL=0 ;;
    --variant)
      [ $# -ge 2 ] || { echo "error: --variant needs terminal or panel" >&2; exit 1; }
      case "$2" in
        terminal|panel) VARIANTS="$2" ;;
        *) echo "error: unknown variant: $2" >&2; exit 1 ;;
      esac
      shift
      ;;
    --variant=*)
      case "${1#--variant=}" in
        terminal|panel) VARIANTS="${1#--variant=}" ;;
        *) echo "error: unknown variant: ${1#--variant=}" >&2; exit 1 ;;
      esac
      ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

cd "$(dirname "$0")"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
[ -d /Applications/Xcode.app ] || { echo "Xcode is required to build. Install it from the App Store, open it once, then re-run." >&2; exit 1; }

PROJECT_DIR="./safari-app"
BUNDLE_PREFIX="${BUNDLE_PREFIX:-com.armaan}"
if [ -n "${TEAM_ID:-}" ]; then
  TEAM="$TEAM_ID"
else
  TEAM="$(security find-certificate -c "Apple Development" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU=\([A-Z0-9]\{10\}\).*/\1/p' | head -n 1)"
fi
if [ -z "$TEAM" ]; then
  echo "error: no Apple Development signing certificate found in your keychain." >&2
  echo "Fix one of these:" >&2
  echo "  1. Open Xcode > Settings > Accounts, add an Apple ID, then Manage Certificates > + > Apple Development" >&2
  echo "  2. Or run with your team ID: TEAM_ID=XXXXXXXXXX ./build-safari.sh" >&2
  exit 1
fi
echo "Signing team: $TEAM"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# The source tree is the terminal variant. These are the values the staged manifest is patched from.
SRC_MODE="terminal"
SRC_NAME="Claude Code for Safari"
SRC_TITLE="Claude Code"
SRC_KEY="Alt+Shift+C"
SRC_DESC="Share or unshare this tab with Claude Code"

SUMMARY=""

# set_variant <terminal|panel>: sets the per-variant values used by the build.
set_variant() {
  case "$1" in
    terminal)
      V_APP="Claude for Safari"
      V_BUNDLE="$BUNDLE_PREFIX.claude-safari"
      V_NAME="Claude Code for Safari"
      V_TITLE="Claude Code"
      V_KEY="Alt+Shift+C"
      V_DESC="Share or unshare this tab with Claude Code"
      ;;
    panel)
      V_APP="Claude Panel for Safari"
      V_BUNDLE="$BUNDLE_PREFIX.claude-safari-panel"
      V_NAME="Claude Panel for Safari"
      V_TITLE="Claude Panel"
      V_KEY="Alt+C"
      V_DESC="Show or hide the Claude panel"
      ;;
    *) echo "error: unknown variant: $1" >&2; exit 1 ;;
  esac
  V_MODE="$1"
  # The converter names the parent app <prefix>.<App-Name-With-Dashes>.
  V_PARENT_ID="$BUNDLE_PREFIX.$(echo "$V_APP" | tr ' ' '-')"
}

# patch_exact <file> <old> <new> <expected-count>
# Replaces <old> with <new>, but only if <old> occurs exactly <expected-count> times.
patch_exact() {
  python3 -I - "$1" "$2" "$3" "$4" <<'PY'
import sys
path, old, new, want = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
with open(path, encoding="utf-8") as f:
    text = f.read()
found = text.count(old)
if found != want:
    sys.exit(f"patch failed: {path}: expected {want} occurrence(s) of {old!r}, found {found}")
with open(path, "w", encoding="utf-8") as f:
    f.write(text.replace(old, new))
PY
}

# install_variant <built .app>: copy to /Applications, retire the build-folder copy, register the installed copy.
install_variant() {
  local built="$1"
  local dest="/Applications/$V_APP.app"
  echo "Installing to $dest"
  pkill -x "$V_APP" || true
  rm -rf "$dest"
  ditto "$built" "$dest"

  # Unregister and delete the build-folder copy so Safari only sees the /Applications copy.
  local build_appex
  build_appex="$(find "$built/Contents/PlugIns" -maxdepth 1 -name '*.appex' -print -quit)"
  "$LSREG" -u "$built" || true
  if [ -n "$build_appex" ]; then
    pluginkit -r "$build_appex" || true
  fi
  rm -rf "$built"

  # Register the /Applications copy.
  "$LSREG" -f "$dest"
  if [ -n "$build_appex" ]; then
    pluginkit -a "$dest/Contents/PlugIns/$(basename "$build_appex")" || true
  fi
  open "$dest"
  echo "Extension registration:"
  pluginkit -mA -p com.apple.Safari.web-extension | grep -i claude || true
}

build_variant() {
  set_variant "$1"
  local stage="$PROJECT_DIR/stage-$V_MODE"
  local vdir="$PROJECT_DIR/$V_MODE"
  echo
  echo "=== Variant: $V_MODE ($V_APP, $V_BUNDLE) ==="

  # 1. Stage a copy of the source tree and patch it for this variant. Every pattern must match exactly.
  rm -rf "$stage"
  cp -R extension "$stage"
  patch_exact "$stage/background.js" "const MODE = \"$SRC_MODE\";" "const MODE = \"$V_MODE\";" 1
  patch_exact "$stage/content.js" "const BUILD_VARIANT = \"$SRC_MODE\";" "const BUILD_VARIANT = \"$V_MODE\";" 1
  local man="$stage/manifest.json"
  patch_exact "$man" "\"name\": \"$SRC_NAME\"" "\"name\": \"$V_NAME\"" 1
  patch_exact "$man" "\"default_title\": \"$SRC_TITLE\"" "\"default_title\": \"$V_TITLE\"" 1
  patch_exact "$man" "\"default\": \"$SRC_KEY\"" "\"default\": \"$V_KEY\"" 1
  patch_exact "$man" "\"description\": \"$SRC_DESC\"" "\"description\": \"$V_DESC\"" 1
  patch_exact "$man" "icons/$SRC_MODE/" "icons/$V_MODE/" 10
  # The panel build has no bridge to share tabs with, so it must not ship the share-all command.
  if [ "$V_MODE" = "panel" ]; then
    patch_exact "$man" $',\n    "share-all": {\n      "suggested_key": { "default": "Alt+Shift+A" },\n      "description": "Share or unshare all tabs in this window with Claude Code"\n    }' "" 1
    python3 -I - "$man" <<'CHECK'
import json, sys
cmds = json.load(open(sys.argv[1], encoding="utf-8")).get("commands", {})
if "share-all" in cmds or "toggle-claude" not in cmds:
    sys.exit("manifest check failed: panel manifest must keep toggle-claude and drop share-all")
CHECK
  fi
  # Ship only this variant's icon set.
  if [ "$V_MODE" = "terminal" ]; then rm -rf "$stage/icons/panel"; else rm -rf "$stage/icons/terminal"; fi

  # 2. Convert the staged tree into a Safari app project.
  rm -rf "$vdir"
  xcrun safari-web-extension-converter "$stage" \
    --project-location "$vdir" \
    --app-name "$V_APP" \
    --bundle-identifier "$V_BUNDLE" \
    --swift --macos-only --no-open --no-prompt --force

  local proj
  proj="$(find "$vdir" -maxdepth 3 -name '*.xcodeproj' -print -quit)"
  if [ -z "$proj" ]; then
    echo "error: no .xcodeproj found under $vdir" >&2
    exit 1
  fi
  echo "Project: $proj"

  # The converter names the parent app <prefix>.<App-Name-With-Dashes> while the extension gets the
  # --bundle-identifier prefix. Xcode rejects that mismatch, so align the parent app's identifier.
  local pbx="$proj/project.xcproj"
  [ -f "$pbx" ] || pbx="$proj/project.pbxproj"
  sed -i '' "s/\"PRODUCT_BUNDLE_IDENTIFIER\": \"$V_PARENT_ID\"/\"PRODUCT_BUNDLE_IDENTIFIER\": \"$V_BUNDLE\"/" "$pbx"
  if ! grep -q "\"PRODUCT_BUNDLE_IDENTIFIER\": \"$V_BUNDLE\"" "$pbx"; then
    echo "error: parent app bundle id was not aligned to $V_BUNDLE in $pbx" >&2
    exit 1
  fi

  # 3. Build.
  local derived="$vdir/build"
  local log="$vdir/xcodebuild.log"
  if ! xcodebuild -project "$proj" -scheme "$V_APP" -configuration Debug \
    -derivedDataPath "$derived" \
    -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
    CODE_SIGN_IDENTITY="Apple Development" build > "$log" 2>&1; then
    tail -40 "$log" >&2
    echo "error: xcodebuild failed for $V_MODE (full log: $log)" >&2
    exit 1
  fi
  grep -E '\*\* BUILD' "$log" || true

  local app
  app="$(find "$derived/Build/Products/Debug" -maxdepth 1 -name '*.app' -print -quit)"
  if [ -z "$app" ]; then
    echo "error: build finished but no .app was found for $V_MODE" >&2
    exit 1
  fi
  app="$(cd "$(dirname "$app")" && pwd)/$(basename "$app")"
  echo "Built app: $app"

  # 4. Verify the signature. Any failure here aborts the script (set -e).
  echo "Verifying signature..."
  codesign --verify --deep --strict "$app"
  echo "Signature OK"
  codesign -dv "$app" 2>&1 | grep -E 'Authority|TeamIdentifier' || true

  # 5. Install (or stop here with --no-install).
  if [ "$INSTALL" -eq 1 ]; then
    install_variant "$app"
    SUMMARY="${SUMMARY}$V_MODE: /Applications/$V_APP.app ($V_BUNDLE), signed, installed"$'\n'
  else
    echo "Skipping install (--no-install)"
    SUMMARY="${SUMMARY}$V_MODE: build only, $app ($V_BUNDLE), signed"$'\n'
  fi
}

# Remove the old single-project layout (safari-app/<old project>, safari-app/build) if present.
mkdir -p "$PROJECT_DIR"
rm -rf "$PROJECT_DIR/build" "$PROJECT_DIR/Claude for Safari"

for v in $VARIANTS; do
  build_variant "$v"
done

echo
echo "=== Summary ==="
printf '%s' "$SUMMARY"
