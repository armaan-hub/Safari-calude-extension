# Session control and watcher interval Implementation Plan

> **For agentic workers:** Opus plans and verifies. Haiku writes code (one subagent at a time). Sonnet fixes failures. Haiku reviews read-only. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Clicking the Claude for Safari toolbar icon opens the Zellij session in Terminal, where the user controls Safari work (which page and form is being handled, live feed) and the Job Watcher (run interval, pause, run now) without being at the Mac.

**Architecture:** The bridge gets an endpoint that opens (or re-attaches) the Zellij session. The session layout gets a second tab, "watch", running the live feed. The watcher's run gate moves from the LaunchAgent interval to a config value (`interval_seconds`, default 600) so it can change without reinstalling; the LaunchAgent fires every 5 minutes and run-once skips until the interval has passed. The terminal Claude gets one `watcher_control` tool. The extension's icon click (terminal mode) opens the session and shares the current tab; it never unshares.

**Tech Stack:** Node 22+ built-ins (`node:test`), MV3 Safari extension (`background.js`), Zellij KDL layout, macOS LaunchAgent plist.

**Spec:** this plan is the spec (decisions below were made by Opus because the user asked for plan → code → review without answering questions).

## Global Constraints

- No personal data in the repo or tests: fictional profile values only (`bridge/test/fixtures.mjs`).
- Bridge must not print or log the token (`~/.claude-safari-bridge/mcp-token`).
- Never click Submit/Send/Apply/Post/Connect/Confirm; watcher denies risky tools (unchanged).
- Each task ends with `node --test bridge/test/*.test.mjs` all passing and `node --check` on each edited `.mjs`/`.js`.
- Subagents run one at a time; each brief names exact files it may touch.

## Decisions (Opus, chosen without asking)

1. Icon click (terminal mode) = open/attach Zellij session + share the current tab if not shared. It never unshares. Alt+Shift+C still toggles.
2. The session has two tabs: `claude` (the chat/control tab, unchanged) and `watch` (runs `node bridge/jobwatch.mjs watch`, the live feed).
3. Default watcher interval 600 s (10 min). Changeable 5–60 min via `jobwatch.mjs interval <minutes>` and the `watcher_control` tool.
4. LaunchAgent `StartInterval` becomes 300 s (5 min); run-once gates on `interval_seconds` and `last_run`. Reinstalling the LaunchAgent is a manual step for the user (it needs a watcher tab set first).
5. `run-now` ignores the interval only; it still honours pause, quiet hours and the lock. `run-once --force` keeps its current meaning.

## Review Focus

1. Icon click when Zellij is not installed, or the bridge is down: the click must show a visible error, not fail silently.
2. Interval set below 5 or above 60 minutes: refused with a clear message, config unchanged.
3. Two rapid icon clicks: only one Terminal window opens (existing debounce in `maybeOpenSession`).
4. `run-now` during a live run: refused with "already running" (lock), no second run.
5. Watch tab when no run has happened yet: shows "waiting for activity", does not exit.

---

### Task 1: Bridge: open-session endpoint and watch tab

**Files:**
- Modify: `bridge/claude-bridge.mjs` (route `POST /ext/open-session`, layout builder)
- Test: `bridge/test/session-layout.test.mjs` (new)

**Interfaces:**
- Consumes: existing `maybeOpenSession()`, `writeSessionFiles()`, `handleTerminal` header rules (`x-claude-bridge: 1`, localhost origin only).
- Produces: `buildLayout({ zellijCmd, workDir, mcpFile, prompt, watchCmd }) -> string` (exported, pure). `POST /ext/open-session` → `{ opened: true|false, reason }`.

- [ ] **Step 1: Write the failing test** `bridge/test/session-layout.test.mjs`: `buildLayout` output contains `tab name="claude"` and `tab name="watch"`; the watch pane command is `node` with args containing `jobwatch.mjs` and `watch`; default_tab_template kept; output parses as text with balanced braces.
- [ ] **Step 2: Run it, expect FAIL** (`buildLayout` not exported): `node --test bridge/test/session-layout.test.mjs`.
- [ ] **Step 3: Implement** `buildLayout` in `claude-bridge.mjs`, use it from `writeSessionFiles()`. Add `POST /ext/open-session` with the same auth as `/ext/sites`; call `maybeOpenSession()` with the debounce bypassed only for an explicit request; return `{opened, reason}` from the session log decision.
- [ ] **Step 4: Run the test, expect PASS**; run all bridge tests.

### Task 2: Job Watcher interval, run-now, interval command

**Files:**
- Modify: `bridge/jobwatch.mjs` (gate in run-once, `interval`, `run-now`, status line)
- Modify: `bridge/jobwatch-state.mjs` (`DEFAULT_CONFIG.interval_seconds` = 600, `setInterval` validator)
- Modify: `bridge/install-jobwatch.sh` (`StartInterval` 300)
- Test: `bridge/test/jobwatch-cli.test.mjs` (add cases), `bridge/test/jobwatch-state.test.mjs` (add cases)

**Interfaces:**
- Consumes: `loadConfig`, `loadState`, `saveState` (`last_run` is an ISO string already written at the end of a run).
- Produces: `jobwatch.mjs interval <minutes>` (5–60, integer, writes `config.json`); `jobwatch.mjs run-now` (behaves like `run-once` but skips the interval gate only); `run-once` without `--force` returns `skipped: interval (next at HH:MM)` when `now - last_run < interval_seconds`.

- [ ] **Step 1: Write failing tests**: interval gate skips when `last_run` is recent (use `JOBWATCH_NOW`); `run-now` runs the cycle inside the interval; `interval 3` and `interval 90` refused and config unchanged; `interval 10` writes `interval_seconds: 600`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the gate, the two commands, the validator and the plist change. Keep the existing pause/quiet-hours order.
- [ ] **Step 4: Run tests, expect PASS**; `bash -n bridge/install-jobwatch.sh`; `bash bridge/install-jobwatch.sh --dry-run | plutil -lint -` (expect OK, `900` replaced by `300`).

### Task 3: Terminal Claude tool `watcher_control` and prompt

**Files:**
- Modify: `bridge/assistant-mcp.mjs` (tool `watcher_control`: `status | pause | resume | run_now | set_interval`, optional `hours`/`minutes`)
- Modify: `bridge/claude-bridge.mjs` (`SAFARI_ONLY_PROMPT`: one sentence to name the page and form before each form step; mention `watcher_control`)
- Test: `bridge/test/assistant-mcp.test.mjs` (add cases)

**Interfaces:**
- Consumes: the `jobwatch.mjs` subcommands from Task 2 (spawned with `execFile`, never a shell string).
- Produces: `watcher_control({action, hours?, minutes?}) -> {text}`; refuses unknown actions; set_interval outside 5–60 returns an error text.

- [ ] **Step 1: Failing tests** with a fake `jobwatch.mjs` path via env (`JOBWATCH_CMD`); unknown action refused; `set_interval` 90 refused; `run_now` calls `run-now`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Prompt: keep plain ASCII, no double quotes or backslashes, no personal details.
- [ ] **Step 4: Run tests, expect PASS**; `node --check`.

### Task 4: Extension icon click opens the session

**Files:**
- Modify: `extension/background.js` (`api.action.onClicked` terminal branch → `termOpenSessionAndShare(tab)`)
- Test: `bridge/test/background-icon-open.test.mjs` (new, vm harness like `background-share-all.test.mjs`)

**Interfaces:**
- Consumes: `termShareTab(tabId, {enforceCap: true})`, `termFetchSites`/bridge base URL and token handling already in `background.js`.
- Produces: `termOpenSessionAndShare(tab) -> Promise<{opened, shared, error?}>`; calls `POST /ext/open-session` with `x-claude-bridge: 1`; on failure shows an error badge via `termSkipBadge` text.

- [ ] **Step 1: Failing vm tests**: icon click calls open-session once; tab is shared when allowed; an already-shared tab stays shared (no unshare); bridge down → error badge and no share attempted beyond what is allowed.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the branch; keep `termToggleShare` for Alt+Shift+C.
- [ ] **Step 4: Run all tests, expect PASS**; `node --check extension/background.js`.

## Manual steps for the user (not automated)

1. Reload the Safari extension (Safari > Settings > Extensions) after `bash build-safari.sh`.
2. Restart the bridge: `launchctl kickstart -k gui/$(id -u)/com.armaan.claude-safari-bridge`.
3. Choose the watcher tab: `node bridge/jobwatch.mjs set-tab <id>`.
4. Install the 5-minute LaunchAgent: `bash bridge/install-jobwatch.sh`.
5. Click the toolbar icon once; check the `watch` tab appears.
