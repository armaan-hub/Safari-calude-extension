# Installing Claude for Safari

## Quick install (one command)

Open **Terminal** and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/armaan-hub/Safari-calude-extension/main/setup.sh | bash
```

This does steps 1–3 below for you (it may ask for your Mac password while installing Homebrew). Then do only:

1. Log in to Claude Code: run `claude`, type `/login`, then `/exit`.
2. [Step 4](#4-turn-the-extensions-on-in-safari): turn the extensions on in Safari. If the script says it used the **prebuilt** apps, also turn on *Allow unsigned extensions* (Option A, steps 5–6).

Options (add after `bash -s --`):

| Option | Meaning |
|---|---|
| `--prebuilt` | Download the released apps (no Xcode). |
| `--build` | Build signed apps from source (needs Xcode + Apple Development certificate). |
| `--variant terminal` / `--variant panel` | Install only one of the two apps. |
| `--dir PATH` | Keep the source somewhere other than `~/claude-web-extension`. |

Example: `curl -fsSL https://raw.githubusercontent.com/armaan-hub/Safari-calude-extension/main/setup.sh | bash -s -- --prebuilt`

Run the same command again any time to update.

The rest of this page is the manual install.

There are two ways to install. Both need the **bridge** (step 2), because that is what connects Safari to Claude.

- **Option A – download the prebuilt apps** (no Xcode). Quickest. Safari will treat them as unsigned, so you must turn on *Allow unsigned extensions*.
- **Option B – build from source** (needs Xcode, free). Your own Mac signs the apps, so Safari accepts them normally.

You do **not** need a paid Apple Developer account for either option.

---

## 1. Requirements (both options)

Open **Terminal** and run these one at a time.

**Homebrew** (skip if `brew -v` already works):
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
After it finishes, run the two `echo ... >> ~/.zprofile` / `eval` lines it prints, then open a new Terminal window.

**Node.js 20+ and Zellij:**
```bash
brew install node zellij
```
Zellij is optional. It is only used by terminal mode to open a Claude Code session automatically when you share a tab.

**Claude Code**, then log in with your Claude account (Pro or Max):
```bash
curl -fsSL https://claude.ai/install.sh | bash
claude
```
Inside Claude Code type `/login`, finish the login in the browser, then quit with `/exit`.

**Get this repo:**
```bash
cd ~
git clone https://github.com/armaan-hub/Safari-calude-extension.git claude-web-extension
cd ~/claude-web-extension
```
(No git? `xcode-select --install` installs it, or download the ZIP from GitHub and unzip it to `~/claude-web-extension`.)

## 2. Install the bridge (both options)

```bash
cd ~/claude-web-extension
./bridge/install.sh
```

This:
- starts the bridge on `127.0.0.1:8787` and makes it start at every login,
- registers the `safari` MCP server with Claude Code.

It should end with `Bridge answered: {"ok":true,...}`.

Keep the folder where it is: the bridge runs from it. If you move the folder, run `./bridge/install.sh` again.

---

## 3A. Option A – prebuilt apps (no Xcode)

1. Download `Claude-for-Safari-apps.zip` from the [Releases page](https://github.com/armaan-hub/Safari-calude-extension/releases).
2. Unzip it and drag **Claude for Safari.app** and/or **Claude Panel for Safari.app** into **Applications**.
3. Remove the download quarantine:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Claude for Safari.app" "/Applications/Claude Panel for Safari.app"
   ```
4. Open each app once (double-click). A small window appears; you can close it.
5. In Safari: **Settings → Advanced** → tick **Show features for web developers**.
6. **Settings → Developer** → tick **Allow unsigned extensions** (enter your Mac password). On some Safari versions this is in the **Develop** menu, and Safari may switch it off after quitting; if the extension disappears, turn it on again.
7. Continue with [step 4](#4-turn-the-extensions-on-in-safari).

## 3B. Option B – build from source (Xcode)

1. Install **Xcode** from the App Store and open it once (accept the license, let it install components).
2. Create a free signing certificate: **Xcode → Settings → Accounts → +** → add your Apple ID → select your team → **Manage Certificates… → + → Apple Development**.
3. Build and install both apps:
   ```bash
   cd ~/claude-web-extension
   ./build-safari.sh
   ```
   - The signing team is detected from your Apple Development certificate. To choose one: `TEAM_ID=XXXXXXXXXX ./build-safari.sh`
   - If Xcode says the bundle identifier is not available, use your own prefix: `BUNDLE_PREFIX=com.yourname ./build-safari.sh`
   - Only one app: `./build-safari.sh --variant terminal` or `--variant panel`

   The script builds, signs, copies the apps to `/Applications`, and registers them with Safari.

## 4. Turn the extensions on in Safari

1. Quit Safari (**⌘Q**) and open it again.
2. **Safari → Settings → Extensions** → tick **Claude Code for Safari** and/or **Claude Panel for Safari**.
3. Select each one → **Edit Websites…** (or the website access setting) → **Always Allow on Every Website**. Claude can only work on sites it is allowed on.
4. Optional: right-click the toolbar → **Customize Toolbar** to place the icons.

---

## 5. Using it

### Terminal mode (Claude for Safari, dark icon)

1. Open the page you want help with and click the dark Claude icon (or press **Option+Shift+C**). The icon shows **ON**: this tab is shared.
2. A Terminal window opens with the Zellij session `claude-safari` running Claude Code. Later clicks reattach to the same session.
   - Attach by hand from any terminal: `zellij attach claude-safari`
   - Without Zellij, just run `claude` in any terminal.
   - Turn the auto-open off: `touch ~/.claude-safari-bridge/auto-session-off` (delete the file to turn it back on).
3. Ask Claude Code, e.g. *"Read my Safari tab and summarise it"* or *"Draft a LinkedIn post in the composer on my shared tab"*.
4. Click the icon again to unshare the tab.

The auto-opened session is **Safari-only**: it runs `claude --dangerously-skip-permissions --strict-mcp-config --tools ""` with only the `safari` tools loaded, so it has no shell, no file access and no other browser, and it is told to refuse non-Safari work. Risky Safari clicks still ask **you**. For other work, run a normal `claude` in another terminal.

To restart the session after an update (it keeps the old settings until it is recreated): `zellij delete-session claude-safari --force`, then click the dark icon on a tab again.

Risky clicks (Post, Send, Publish, Share...) show an **Allow / Deny** pill in Safari. If Terminal covers Safari you will not see it: keep Safari visible next to Terminal, or switch to Safari when Claude pauses. Opening a composer ("Start a post", "New message", "Compose") needs no approval.

### Panel mode (Claude Panel for Safari, cream icon)

1. Click the cream icon (or **Option+C**) to open the panel on the page.
2. Gear icon (⚙) → choose:
   - **Claude subscription** – uses your Claude Code login through the bridge (the dot should be green), or
   - **API key** – paste a key from [console.anthropic.com](https://console.anthropic.com) (billed per use).
3. Type your request and press Enter (Shift+Enter for a new line).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Extension missing in Safari Settings | Open the app from `/Applications` once, quit and reopen Safari. Option A: check *Allow unsigned extensions* is on. |
| Bridge not reachable / panel dot red | `curl http://127.0.0.1:8787/health`. If nothing answers, run `./bridge/install.sh` again and read `~/Library/Logs/claude-safari-bridge.log`. |
| Claude Code has no `safari` tools | `claude mcp list` should show `safari`. If not: `claude mcp add --scope user safari -- node ~/claude-web-extension/bridge/safari-mcp.mjs`, then restart Claude Code. |
| "Tab not shared" | Click the dark icon on that tab so it shows **ON**. |
| A click "did nothing" on WhatsApp/LinkedIn | These pages update slowly. Claude is told to `wait` and re-read before retrying. If it still fails, click the item yourself once and ask Claude to continue. |
| No Terminal opens on share | `brew install zellij`; check `~/.claude-safari-bridge/auto-session-off` does not exist; see the bridge log. |
| `build-safari.sh`: no signing team | Create the Apple Development certificate (step 3B.2) or pass `TEAM_ID=...`. |
| `build-safari.sh`: bundle id taken | `BUNDLE_PREFIX=com.yourname ./build-safari.sh` |

## Uninstall

```bash
cd ~/claude-web-extension
./bridge/uninstall.sh
claude mcp remove --scope user safari
rm -rf "/Applications/Claude for Safari.app" "/Applications/Claude Panel for Safari.app"
rm -rf ~/.claude-safari-bridge          # optional: chats and memory
zellij delete-session claude-safari --force 2>/dev/null
```

## Chrome and Brave

The same extension also runs in Google Chrome and Brave. The Chromium build is a copy of `extension/` with a
Chrome-style manifest (a service worker instead of the Safari background page).

**Build** (no Xcode, works offline):

```bash
cd ~/claude-web-extension
./build-chromium.sh          # writes dist/chromium
./build-chromium.sh --zip    # also writes dist/claude-code-chromium.zip
```

**Load it:**

1. Open `chrome://extensions` (Brave: `brave://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick `~/claude-web-extension/dist/chromium`.
3. Click the toolbar icon, or press **Alt+Shift+C** on a tab, to share that tab with Claude.

**Notes:**

- It uses the same bridge on `127.0.0.1:8787` (start it as in section 2) and the same Claude Code MCP tools. The tool
  names still start with `safari_`.
- Only one browser extension (Safari or Chrome/Brave) should share tabs at a time. The bridge serves a single
  extension poller.
- The allowed-sites list and the approval rules are identical in both builds.
- A Chrome service worker sleeps after a few idle minutes. The extension wakes it with its alarm, and its state is kept
  in extension storage, so sharing resumes on its own.
