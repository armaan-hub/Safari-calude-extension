#!/usr/bin/env bash
#
# Claude for Safari - one-command installer (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/armaan-hub/Safari-calude-extension/main/setup.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/armaan-hub/Safari-calude-extension/main/setup.sh | bash -s -- --prebuilt
#   ./setup.sh --help
#
# Safe to re-run. All work happens inside main(), which is called on the last
# line, so a partially downloaded script never runs half of its body.

set -euo pipefail

REPO_URL="https://github.com/armaan-hub/Safari-calude-extension.git"
RELEASE_URL="https://github.com/armaan-hub/Safari-calude-extension/releases/latest/download/Claude-for-Safari-apps.zip"
DOCS_URL="https://github.com/armaan-hub/Safari-calude-extension/blob/main/INSTALL.md"
HOMEBREW_INSTALL_URL="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"
CLAUDE_INSTALL_URL="https://claude.ai/install.sh"

MODE="auto"                          # auto | build | prebuilt
VARIANT=""                           # "" (both apps) | terminal | panel
INSTALL_DIR="$HOME/claude-web-extension"
TMP_DIR=""
USED_PREBUILT=0

if [ -t 1 ]; then
  C_BOLD=$'\033[1m'
  C_CYAN=$'\033[36m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_RESET=$'\033[0m'
else
  C_BOLD=""
  C_CYAN=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
  C_RESET=""
fi

step() { printf '\n%s==> %s. %s%s\n' "$C_BOLD$C_CYAN" "$1" "$2" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s    warning: %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()  { printf '%serror: %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

usage() {
  cat <<'EOF'
Claude for Safari installer

Usage:
  ./setup.sh [options]
  curl -fsSL https://raw.githubusercontent.com/armaan-hub/Safari-calude-extension/main/setup.sh | bash -s -- [options]

Options:
  --prebuilt        Install the released (prebuilt) apps. No Xcode needed.
  --build           Build and sign the apps from source. Needs Xcode in
                    /Applications and an "Apple Development" certificate.
  --variant NAME    Install only one app: terminal or panel.
  --dir PATH        Where to keep the source checkout
                    (default: $HOME/claude-web-extension).
  -h, --help        Show this help and exit.

Without --prebuilt or --build, the installer builds from source when Xcode and
an Apple Development certificate are both present, and otherwise uses the
prebuilt apps.
EOF
}

set_mode() {
  if [ "$MODE" != "auto" ] && [ "$MODE" != "$1" ]; then
    die "use either --prebuilt or --build, not both"
  fi
  MODE="$1"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --prebuilt)   set_mode prebuilt ;;
      --build)      set_mode build ;;
      --variant)
        [ $# -ge 2 ] || die "--variant needs a value: terminal or panel"
        VARIANT="$2"
        shift
        ;;
      --variant=*)  VARIANT="${1#--variant=}" ;;
      --dir)
        [ $# -ge 2 ] || die "--dir needs a path"
        INSTALL_DIR="$2"
        shift
        ;;
      --dir=*)      INSTALL_DIR="${1#--dir=}" ;;
      -h|--help)    usage; exit 0 ;;
      *)            die "unknown option: $1 (try --help)" ;;
    esac
    shift
  done

  case "$VARIANT" in
    ""|terminal|panel) ;;
    *) die "--variant must be terminal or panel" ;;
  esac
  [ -n "$INSTALL_DIR" ] || die "--dir needs a path"
}

cleanup() {
  if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  return 0
}

has_xcode() { [ -d /Applications/Xcode.app ]; }
has_cert()  { security find-certificate -c "Apple Development" >/dev/null 2>&1; }

# 1. Platform checks and app-mode selection.
check_platform() {
  step 1 "Checking this Mac"
  [ "$(uname -s)" = "Darwin" ] || die "this installer only runs on macOS"
  [ "$(id -u)" -ne 0 ] || die "do not run this as root or with sudo; run it as your normal user"
  info "macOS $(sw_vers -productVersion 2>/dev/null || echo unknown), user $(id -un)"

  case "$MODE" in
    build)
      has_xcode || die "--build needs Xcode at /Applications/Xcode.app. Install Xcode from the App Store, then re-run."
      has_cert || die "--build needs an 'Apple Development' certificate in your keychain. Open Xcode > Settings > Accounts to create one, then re-run."
      ;;
    auto)
      if has_xcode && has_cert; then
        MODE="build"
      else
        MODE="prebuilt"
      fi
      ;;
    prebuilt) ;;
  esac
  info "App mode: $MODE"
}

find_brew() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
    return 0
  fi
  local p
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$p" ]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

# 2. Homebrew.
ensure_homebrew() {
  step 2 "Homebrew"
  local brew_bin=""
  if brew_bin="$(find_brew)"; then
    info "Found $brew_bin"
  else
    info "Homebrew not found. Installing (you may be asked for your password)..."
    local brew_script
    brew_script="$(curl -fsSL "$HOMEBREW_INSTALL_URL")" || die "could not download the Homebrew installer"
    /bin/bash -c "$brew_script" </dev/tty || die "Homebrew install failed"
    brew_bin="$(find_brew)" || die "Homebrew installed but not found in /opt/homebrew or /usr/local"
  fi

  eval "$("$brew_bin" shellenv)"

  if ! grep -qF "$brew_bin shellenv" "$HOME/.zprofile" 2>/dev/null; then
    printf "\n# Homebrew\neval \"\$(%s shellenv)\"\n" "$brew_bin" >> "$HOME/.zprofile"
    info "Added Homebrew to ~/.zprofile"
  fi
}

node_major() {
  local v
  v="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  case "$v" in
    ''|*[!0-9]*) echo 0 ;;
    *)           echo "$v" ;;
  esac
}

# 3. Dependencies: node (>= 20), zellij, git.
install_deps() {
  step 3 "Dependencies (node, zellij, git)"

  if command -v node >/dev/null 2>&1; then
    if [ "$(node_major)" -lt 20 ]; then
      info "node is older than v20; upgrading"
      if brew list --formula node >/dev/null 2>&1; then
        brew upgrade node || true
      else
        brew install node
      fi
    fi
  fi

  local need=()
  command -v node   >/dev/null 2>&1 || need+=(node)
  command -v zellij >/dev/null 2>&1 || need+=(zellij)
  command -v git    >/dev/null 2>&1 || need+=(git)

  if [ "${#need[@]}" -gt 0 ]; then
    info "Installing with Homebrew: ${need[*]}"
    brew install "${need[@]}"
  else
    info "node, zellij and git are already present"
  fi

  if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt 20 ]; then
    die "Node 20 or newer is required. Run: brew install node"
  fi
  info "node $(node -v), zellij and git OK"
}

# 4. Claude Code CLI (login is left to the user).
ensure_claude() {
  step 4 "Claude Code"
  export PATH="$HOME/.local/bin:$PATH"

  if command -v claude >/dev/null 2>&1; then
    info "Found $(command -v claude)"
  else
    info "Installing Claude Code with the official installer..."
    curl -fsSL "$CLAUDE_INSTALL_URL" | bash || die "Claude Code install failed. See $CLAUDE_INSTALL_URL"
    export PATH="$HOME/.local/bin:$PATH"
    if ! command -v claude >/dev/null 2>&1; then
      warn "claude is not on PATH yet. Open a new terminal, or check ~/.local/bin."
    fi
  fi
}

# 5. Source checkout.
fetch_repo() {
  step 5 "Getting the extension source into $INSTALL_DIR"
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Existing checkout found; updating"
    git -C "$INSTALL_DIR" pull --ff-only \
      || warn "could not update the repo (local changes or no network); using the existing copy"
  elif [ -e "$INSTALL_DIR" ]; then
    die "$INSTALL_DIR exists but is not a git checkout. Move it aside, or use --dir PATH."
  else
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone "$REPO_URL" "$INSTALL_DIR" || die "git clone failed"
  fi
}

# 6. Local bridge LaunchAgent and the safari MCP server registration.
run_bridge() {
  step 6 "Starting the local bridge and registering the MCP server"
  local script="$INSTALL_DIR/bridge/install.sh"
  [ -f "$script" ] || die "missing $script; the checkout may be incomplete"
  bash "$script" || die "bridge/install.sh failed (see output above)"
}

install_app() {
  # $1 = directory holding the unpacked release, $2 = app name without .app
  local src="$1/$2.app"
  local dest="/Applications/$2.app"
  [ -d "$src" ] || die "the release zip has no '$2.app' at its top level"
  info "Installing $2.app"
  pkill -x "$2" >/dev/null 2>&1 || true
  rm -rf "$dest"
  ditto "$src" "$dest"
  xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
  open "$dest" || warn "could not open $dest; launch it from /Applications"
}

install_prebuilt() {
  info "Downloading the released apps..."
  TMP_DIR="$(mktemp -d)"
  local zip="$TMP_DIR/Claude-for-Safari-apps.zip"
  local extract="$TMP_DIR/apps"
  curl -fL --progress-bar -o "$zip" "$RELEASE_URL" || die "download failed: $RELEASE_URL"
  mkdir -p "$extract"
  ditto -x -k "$zip" "$extract" || die "could not unpack the downloaded zip"

  if [ -z "$VARIANT" ] || [ "$VARIANT" = "terminal" ]; then
    install_app "$extract" "Claude for Safari"
  fi
  if [ -z "$VARIANT" ] || [ "$VARIANT" = "panel" ]; then
    install_app "$extract" "Claude Panel for Safari"
  fi
  USED_PREBUILT=1
}

# 7. Build from source, or install the prebuilt apps.
install_apps() {
  step 7 "Installing the Safari apps ($MODE mode)"
  if [ "$MODE" = "build" ]; then
    local script="$INSTALL_DIR/build-safari.sh"
    [ -f "$script" ] || die "missing $script; the checkout may be incomplete"
    if [ -n "$VARIANT" ]; then
      (cd "$INSTALL_DIR" && bash "$script" --variant "$VARIANT")
    else
      (cd "$INSTALL_DIR" && bash "$script")
    fi
  else
    install_prebuilt
  fi
}

needs_login() {
  if [ -f "$HOME/.claude/.credentials.json" ]; then
    return 1
  fi
  if grep -q '"oauthAccount"' "$HOME/.claude.json" 2>/dev/null; then
    return 1
  fi
  return 0
}

box_top() {
  local dashes
  dashes="$(printf '%80s' '' | tr ' ' '-')"
  printf '+%s+\n' "$dashes"
}
box_row() { printf '| %-78s |\n' "$1"; }

# 8. Summary.
print_summary() {
  step 8 "Finished"
  printf '%sClaude for Safari is installed.%s\n\n' "$C_GREEN" "$C_RESET"

  box_top
  box_row "NEXT STEPS"
  box_row ""
  if needs_login; then
    box_row "- Log in to Claude Code: run  claude  then type  /login"
  fi
  box_row "- Quit Safari completely (Cmd+Q), then reopen it."
  box_row "- Safari > Settings > Extensions: tick the extension(s) and choose"
  box_row "    Always Allow on Every Website."
  if [ "$USED_PREBUILT" -eq 1 ]; then
    box_row "- Safari > Settings > Advanced: tick \"Show features for web developers\"."
    box_row "- Safari > Settings > Developer: tick \"Allow unsigned extensions\"."
  fi
  box_row ""
  box_row "USAGE"
  if [ -z "$VARIANT" ] || [ "$VARIANT" = "terminal" ]; then
    box_row "- Dark icon or Option+Shift+C: share a tab with Claude Code"
    box_row "    (opens Terminal in the Zellij session 'claude-safari')."
  fi
  if [ -z "$VARIANT" ] || [ "$VARIANT" = "panel" ]; then
    box_row "- Cream icon or Option+C: open the side panel."
  fi
  box_row ""
  box_row "Docs:"
  box_row "  $DOCS_URL"
  box_top
}

main() {
  trap cleanup EXIT
  parse_args "$@"
  check_platform
  ensure_homebrew
  install_deps
  ensure_claude
  fetch_repo
  run_bridge
  install_apps
  print_summary
}

main "$@"
