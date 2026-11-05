# Claude for Safari

Let Claude read and operate Safari tabs, using your own logged-in Safari sessions. There is no official Claude extension for Safari; this project fills that gap.

The repo builds **two separate Safari extensions** from one source folder. Install one or both.

| | **Claude for Safari** (terminal) | **Claude Panel for Safari** (side panel) |
|---|---|---|
| Where you chat | In **Claude Code** in a Terminal | In a panel inside the web page |
| How Claude reaches the page | Claude Code's `safari` MCP tools | The extension itself |
| Toolbar icon | Dark | Cream |
| Shortcut | **Option+Shift+C** shares/unshares the tab | **Option+C** shows/hides the panel |
| Uses | Your Claude Pro/Max login (via Claude Code) | Your Claude login (via the local bridge) **or** an Anthropic API key |

## Quick install (one command)

Paste this into **Terminal** on your Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/armaan-hub/Safari-calude-extension/main/setup.sh | bash
```

It installs everything needed (Homebrew, Node, Zellij, git, Claude Code), downloads this repo to `~/claude-web-extension`, starts the local bridge, and installs both Safari apps. If Xcode and an Apple Development certificate are present it builds signed apps; otherwise it installs the prebuilt release. Safe to run again to update.

Options: `--prebuilt`, `--build`, `--variant terminal|panel`, `--dir PATH` (pass them as `| bash -s -- --prebuilt`).

Afterwards: log in to Claude Code (`claude`, then `/login`) and enable the extensions in Safari. Step-by-step and manual install: **[INSTALL.md](INSTALL.md)**.

## How it works

```
Safari extension  <-- long-poll -->  local bridge (127.0.0.1:8787, LaunchAgent)  <-->  Claude Code
   (content.js does                    bridge/claude-bridge.mjs                       safari MCP server
    the clicking/typing)                                                               bridge/safari-mcp.mjs
```

- The **bridge** is a small Node server that runs in the background on your Mac (localhost only). It starts at login.
- **Terminal mode:** click the toolbar icon on a tab to share it (the icon shows **ON**). Claude Code can act only on shared tabs. Sharing a tab also opens a Terminal with a [Zellij](https://zellij.dev) session named `claude-safari` running Claude Code, or reattaches it if it already exists.
- **Panel mode:** the panel sends your message to the bridge, which runs `claude -p` with your Claude login. Alternatively, paste an Anthropic API key in the panel settings (gear icon).

Claude Code tools in terminal mode: `safari_status`, `read_page`, `get_page_text`, `click`, `type`, `press_key`, `scroll`, `navigate`, `wait`, `screenshot`.

**The auto-opened session is Safari-only.** It starts Claude Code with just the `safari` tools (no shell, no file access, no other browser or MCP server) and instructions to do Safari work only. For anything else, open a normal `claude` session in another terminal.

## Safety

- Claude can only touch tabs you shared (terminal mode) or the tab where the panel is open.
- Outward-facing clicks (Post, Send, Submit, Delete, Buy and similar) wait for **your** Allow/Deny, shown in Claude Code and on the tab. Claude cannot approve them itself, even when Claude Code runs with `--dangerously-skip-permissions`.
- Claude refuses to type into password, card-number, CVV and 2FA/one-time-code fields. Fill those yourself.
- The bridge listens on 127.0.0.1 only and checks a token / the extension's origin on every request.
- A drawn orange arrow shows where Claude clicks or types. It never moves your real mouse.

## Repository layout

```
extension/          Web extension source (shared by both apps)
  background.js     Agent loop and terminal-mode command handling
  content.js        Page tools, side panel, approval pill, arrow overlay
  manifest.json
  icons/terminal, icons/panel
bridge/
  claude-bridge.mjs Local bridge server (LaunchAgent)
  safari-mcp.mjs    MCP server that Claude Code uses
  install.sh        Install/restart the bridge and register the MCP server
  uninstall.sh      Stop and remove the bridge
build-safari.sh     Convert, sign and install both Safari apps (needs Xcode)
tools/make-icons.py Regenerates the icon sets
```

## Local data

Everything stays on your Mac, in `~/.claude-safari-bridge/` (chat history, `memory.md`, the MCP token, the Zellij launcher). Bridge log: `~/Library/Logs/claude-safari-bridge.log`.

## Known limits

- macOS + Safari only (built and tested on macOS 26 / Safari 26, Xcode 26, Node 20+).
- Synthetic key presses cannot move keyboard focus between fields; Claude clicks a field first.
- On long runs Safari may suspend the background script until you return to the tab.
