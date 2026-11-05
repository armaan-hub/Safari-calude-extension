# Form-prep, profile lookup, phone alerts and multi-tab sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the "Claude for Safari" terminal session look up the user's profile on demand, prepare forms and stop for review, alert the user's phone through Apple Reminders, and work across many tabs (share-all, open a tab, auto-share), all limited by an allowed-sites list.

**Architecture:** Stage A is bridge-side only: new small Node modules (`sites.mjs`, `profile-md.mjs`, `notify.mjs`, `assistant-mcp.mjs`) plus edits to `safari-mcp.mjs`, `claude-bridge.mjs` and `jobwatch.mjs`. Stage B changes the extension (`background.js`, `manifest.json`, new `term-sites.js`), the bridge route list and `safari-mcp.mjs`, and needs `./build-safari.sh` plus the user reloading the extension in Safari. Pure logic lives in plain functions with `node --test` tests; Safari-only behaviour is listed as manual checks.

**Tech Stack:** Node 26 (ESM, built-ins only, `node --test`), Safari MV3 extension (classic scripts), `osascript`, JSON-RPC MCP over stdio.

**Spec:** `docs/superpowers/specs/2026-11-04-form-prep-and-tab-sharing-design.md`

## Global Constraints
- Run tests with `node --test bridge/test/*.test.mjs` (a bare directory fails on Node 26). Baseline before this plan: 132 tests, all passing; they must stay passing.
- Tests and docs use fictional data only ("Test User", fake phone/email). Never put real personal data in the repo (it is public). `profile.md` is `chmod 600` and lives outside the repo; `allowed-sites.json` is not secret but also lives outside the repo.
- Built-ins only for bridge code (no npm dependencies).
- The watcher must never get the new tools: `jobwatch-mcp.json` stays safari-only, and `assistant-mcp.mjs` exposes an empty tool list when `SAFARI_MCP_SOURCE=watcher`.
- Typed values and profile values never appear in `activity.log` (terminal source logs counts only). Reminder text never contains profile identifiers.
- Nothing new may click, submit or send. Existing rules stay: never type passwords, card/CVV numbers or 2FA codes; risky clicks need the user's Allow in Safari.
- Only the user shares tabs. No tool may share or unshare a tab.
- Allowed list fails closed: missing file = `["linkedin.com"]`; unreadable/corrupt/not-an-array/empty = nothing allowed. A host matches itself or a subdomain; https only; no credentials in the URL.
- Workflow (user rule): Haiku writes code, Sonnet fixes failures, Haiku does read-only review, one agent at a time; Opus verifies, updates `HANDOFF.md` after each task, reminds the user to `/compact`. No commits or pushes unless the user asks (this directory is not a git repo in this environment).
- Share-all key is `Alt+Shift+A` (`Alt+Shift+C` already toggles one tab). Caps: 10 shared tabs, 5 `open_tab` calls per hour.

## Review Focus
- Lookalike or tricky URLs must be refused by every allowed-list check: `https://linkedin.com.evil.test/`, `https://evil-linkedin.com/`, `https://linkedin.com@evil.test/`, `http://linkedin.com/` (all refused); `HTTPS://LinkedIn.com./` and `https://www.linkedin.com/jobs` are allowed (case and one trailing dot are normalised).
- Allowed-sites file states: missing, empty list, corrupt JSON, `{"sites":"linkedin.com"}`, entries with schemes/paths/uppercase. Expected: the fail-closed rules above, never a throw.
- Reminders unavailable, permission denied, or hanging: the Mac notification still goes out, the call returns within about 30 s, the Job Watcher cycle is not blocked, failure is logged not thrown.
- Alert text with a profile identifier, newlines/control characters, a very long title, quotes and backslashes (AppleScript injection): text falls back to generic or is sanitised and passed as argv, never interpolated into script source.
- Share-all and `open_tab` edge cases: window with zero allowed tabs, more than 10 tabs, restricted pages (about:, safari://), cap already reached, sixth `open_tab` in an hour, bridge unreachable when fetching the list (must share/open nothing), `profile_lookup` with an empty query or a missing/empty profile file (must not return the whole file or crash).

---

## Stage A — bridge side (no extension rebuild)

### Task 1: Allowed-sites module and CLI

**Files:**
- Create: `bridge/sites.mjs`, `bridge/test/sites.test.mjs`, `bridge/test/sites-cases.json` (shared match cases, also used by Task 7)

**Interfaces:**
- Produces (all exported from `bridge/sites.mjs`):
  - `DEFAULT_SITES: string[]` = `["linkedin.com"]`
  - `sitesFile(): string` — `process.env.SAFARI_SITES_FILE` or `~/.claude-safari-bridge/allowed-sites.json`
  - `loadSites(file?: string): string[]` — applies the fail-closed rules; never throws
  - `hostAllowed(host: string, sites: string[]): boolean` — lower-cases, strips one trailing dot, exact or `.`-subdomain match only
  - `urlAllowed(url: string, sites: string[]): boolean` — parses with `URL`; `https:` only; no username/password; then `hostAllowed`
  - `normaliseHost(input: string): string|null` — accepts `https://Example.com/path`, `example.com`, returns lower-case hostname or null
  - `addSite(host: string, opts?: {force?: boolean, file?: string}): {ok: boolean, sites: string[], error?: string}` — refuses hosts matching `/bank|paypal|stripe|wallet|payment|checkout|creditcard|billing/i` unless `force`
  - `removeSite(host: string, opts?: {file?: string}): {ok: boolean, sites: string[]}`
- CLI: `node bridge/sites.mjs list|add <host> [--force]|remove <host>` prints the resulting list, exit code 1 on refusal.

- [ ] **Step 1: Write failing tests** in `bridge/test/sites.test.mjs`: one test per case in `sites-cases.json` (`{url, allowed}` rows: the six Review Focus URLs plus `https://sub.deep.linkedin.com/x` true and `https://linkedin.com:8443/x` true); `loadSites` for missing → default, empty list → `[]`, corrupt JSON → `[]`, `{"sites":"x"}` → `[]`; `addSite("https://Example.com/a")` stores `example.com`; `addSite("mybank.example")` refused without force and accepted with force; `removeSite`; CLI exit code via `spawnSync` with `SAFARI_SITES_FILE` pointing at a temp file.
- [ ] **Step 2: Run** `node --test bridge/test/sites.test.mjs` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `bridge/sites.mjs` to the interfaces above. Write the file with mode 0600 and atomically (temp file + rename), like `writeFileAtomic` in `bridge/jobwatch-state.mjs`.
- [ ] **Step 4: Run** the new test file and then the full suite — expect all PASS.

### Task 2: Profile markdown generator and section search

**Files:**
- Create: `bridge/profile-md.mjs`, `bridge/test/profile-md.test.mjs`
- Modify: `bridge/jobwatch.mjs` (add subcommand `profile-md`), `.gitignore` (add `profile.md`)

**Interfaces:**
- Produces from `bridge/profile-md.mjs`:
  - `renderProfileMd(profile: object, notes?: string): string` — generic, no hard-coded personal keys: one `## <Title Case key>` section per top-level key except keys starting with `_`; nested objects/arrays become bullet lists; `null`, `""` and empty arrays render as `NOT PROVIDED`; ends with `## Notes (yours)` containing `notes` between `<!-- notes:start -->` and `<!-- notes:end -->`.
  - `extractNotes(md: string): string` — returns the text between the markers (empty string if none).
  - `writeProfileMd(opts?: {profileFile?: string, outFile?: string}): {file: string, sections: number}` — reads `profile.json` (default in `stateDir()`), keeps existing notes, writes `~/.claude-safari-bridge/profile.md` (env `ASSISTANT_PROFILE_FILE` overrides) with mode 0600.
  - `searchProfile(md: string, query: string, opts?: {maxSections?: number, maxChars?: number}): {sections: {heading: string, text: string}[], truncated: boolean, note?: string}` — splits on `## ` headings; tokenises the query on non-alphanumerics, lower-case, drops tokens shorter than 2 characters; a section matches when a token appears in heading or body; rank by distinct tokens matched (heading hit counts 2); defaults 5 sections, 4000 chars total. An empty/no-token query returns only the list of headings in `note`, never section bodies.
- CLI: `node bridge/jobwatch.mjs profile-md` prints the path and section count, never the content.

- [ ] **Step 1: Write failing tests** with a fictional profile (`name: "Test User"`, `languages: {english: null, german: "A2"}`, `salary: {uae_min_aed: 12000}`): null becomes `NOT PROVIDED`; keys starting `_` are skipped; regenerating keeps text written inside the notes markers; `searchProfile(md, "salary")` returns only the salary section; `searchProfile(md, "")` and `searchProfile(md, "a ?")` return headings only and no bodies; query matching nothing returns `{sections: [], note}`; output is capped at `maxChars` with `truncated: true`; file mode is 0600; the CLI test asserts stdout does not contain "Test User".
- [ ] **Step 2: Run** `node --test bridge/test/profile-md.test.mjs` — expect FAIL.
- [ ] **Step 3: Implement** the module and the `profile-md` subcommand in `jobwatch.mjs` (follow how the other subcommands are dispatched there).
- [ ] **Step 4: Run** the file, then the full suite — expect PASS.

### Task 3: Alert module (Mac notification + Reminders) and the Job Watcher hookup

**Files:**
- Create: `bridge/notify.mjs`, `bridge/test/notify.test.mjs`
- Modify: `bridge/jobwatch.mjs` (the `notify(title, body)` helper near line 125 and the "N new" call near line 480), `bridge/jobwatch-state.mjs` (`DEFAULT_CONFIG` gets `reminders: true`), `bridge/test/jobwatch-cli.test.mjs` only if an existing assertion breaks

**Interfaces:**
- Produces from `bridge/notify.mjs`:
  - `sanitiseText(s: unknown, max: number): string` — string only, control chars/newlines to spaces, collapsed, trimmed, cut to `max`
  - `profileIdentifiers(profile: object): string[]` — string/number leaves (stringified, 4+ chars) under keys `name`, `nickname`, `salary`, `visa`, `earliest_start`, plus any key matching `/phone|email|address|passport|birth|dob|id$/i`, at any depth; no skills/employers/titles
  - `guardAlert(fields: {title: string, detail?: string}, identifiers: string[]): {title: string, detail: string, fellBack: boolean}` — case-insensitive substring check; on a hit, title becomes `"Form ready for your review"` and detail `""`
  - `notifyReady(input: {title: string, detail?: string, url?: string, needsYou?: string[]}, opts?: {run?: (cmd: string, args: string[], timeoutMs: number) => Promise<{code: number, stderr: string}>, reminders?: boolean, profile?: object}): Promise<{mac: boolean, reminder: boolean|"skipped", fellBack: boolean, errors: string[]}>` — title cap 80, detail cap 160; Mac notification first, Reminder second (list "Claude Ready", due now, body = detail + needs-you + url); never throws; each osascript call has a 30 s timeout
- Consumes: `loadConfig(dir)` from `bridge/jobwatch-state.mjs` for the `reminders` flag.

- [ ] **Step 1: Write failing tests** using an injected fake `run`: sanitising; `profileIdentifiers` on a fictional profile (includes "Test User" and a fake phone, excludes a skill name); `guardAlert` falls back when the title holds the fake phone; `notifyReady` with failing Reminders run still returns `mac: true` and records an error; with `reminders: false` the reminder call is never made; quotes, backslashes and newlines in the title arrive as a separate argv item and never inside the script text (assert the script source passed to `run` is the same constant for different inputs); a run that exceeds the timeout resolves (use a fake that never resolves plus a short injected timeout).
- [ ] **Step 2: Run** `node --test bridge/test/notify.test.mjs` — expect FAIL.
- [ ] **Step 3: Implement** `notify.mjs`. Use `osascript` with `on run argv` scripts (constant source, data via argv). Default `run` uses `execFile` with the given timeout. In `jobwatch.mjs`, route only the "N new" alert through `notifyReady` (passing the loaded profile for the guard and `config.reminders`); keep the other alerts Mac-only through the existing helper. Keep whatever hook the existing tests use to avoid real `osascript` calls.
- [ ] **Step 4: Run** the new file and the full suite — expect PASS.

### Task 4: Assistant MCP server (terminal session only)

**Files:**
- Create: `bridge/assistant-mcp.mjs`, `bridge/test/assistant-mcp.test.mjs`

**Interfaces:**
- Consumes: `searchProfile`, `renderProfileMd`-written file (path from `ASSISTANT_PROFILE_FILE` or `~/.claude-safari-bridge/profile.md`) from Task 2; `notifyReady`, `profileIdentifiers` from Task 3; `loadQueue`, `readActivityTail`, `appendActivity`, `stateDir` from `bridge/jobwatch-state.mjs`.
- Produces: a stdio JSON-RPC MCP server (same `initialize` / `tools/list` / `tools/call` / `ping` handling as `bridge/safari-mcp.mjs`; copy its framing, do not import from it) named `assistant`, with tools:
  - `profile_lookup {query: string}` → text of matching sections via `searchProfile`; missing profile file → text telling the user to run `node bridge/jobwatch.mjs profile-md`
  - `ready_list {}` → one line per Ready item: title, company, location, link, status (no profile data)
  - `recent_activity {lines?: integer}` → `readActivityTail(dir, clamp(lines, 1..200), default 40)`
  - `notify_ready {title: string, detail?: string, needs_you?: string[], url?: string}` → calls `notifyReady`; the result text says whether the generic fallback was used
- When `process.env.SAFARI_MCP_SOURCE === "watcher"`, `tools/list` returns `[]` and every `tools/call` is an error.
- Activity lines (via `appendActivity`): `[terminal] profile lookup (N sections)`, `[terminal] read the Ready list`, `[terminal] read the activity feed`, `[terminal] ready alert sent: <title>` — never section text.

- [ ] **Step 1: Write failing tests** spawning the server with temp `JOBWATCH_DIR`, `ASSISTANT_PROFILE_FILE` and a fake `osascript` via an env hook: tools/list has exactly the four names; `profile_lookup` for "salary" returns only that section and the activity log line contains the count but not the section text; empty query returns headings only; missing profile file message; watcher source returns empty tools and errors; `notify_ready` with title containing the fake phone falls back; `recent_activity` with `lines: 9999` is clamped to 200.
- [ ] **Step 2: Run** the file — expect FAIL.
- [ ] **Step 3: Implement** `assistant-mcp.mjs`. For the fake `osascript`, accept an env var `ASSISTANT_OSASCRIPT` (path of an executable) used only when set; document it in a comment.
- [ ] **Step 4: Run** the file and the full suite — expect PASS.

### Task 5: Terminal-session wiring (bridge, prompt, navigate limit, `/ext/sites`) and the CLAUDE.md pointer

**Files:**
- Modify: `bridge/claude-bridge.mjs` (`SAFARI_ONLY_PROMPT` ~line 1127, `writeSessionFiles` ~line 1130, route table ~line 1262-1274), `bridge/safari-mcp.mjs` (`runToolChecked` ~line 362, `describeToolCall` use), `bridge/jobwatch-activity.mjs` (no change needed for navigate), `~/.claude/CLAUDE.md`
- Test: `bridge/test/safari-mcp-sites.test.mjs`

**Interfaces:**
- Consumes: `loadSites`, `urlAllowed` (Task 1); the assistant server file (Task 4).
- Produces:
  - `safari-mcp.mjs`: in terminal mode (`!DENY_RISKY`), `navigate` returns `errorResult("Blocked: this site is not on the user's allowed list. Ask the user to run: node bridge/sites.mjs add <host>")` unless `urlAllowed(url, loadSites())`. The check runs before contacting the bridge and the refusal is logged by the existing `logCall`. Deny-risky (watcher) behaviour is unchanged.
  - `claude-bridge.mjs`: `GET /ext/sites` (same auth as the other `/ext/*` routes) answers `{sites: loadSites()}`; `writeSessionFiles` writes `safari-only-mcp.json` with two servers, `safari` (unchanged) and `assistant` (`bridge/assistant-mcp.mjs`); the prompt gains the workflow text below.
  - Prompt addition (exact points, wording is the builder's): there is a Job Watcher and a Ready list (`ready_list`, `recent_activity`); to prepare a form, look up facts with `profile_lookup` only when needed, fill only from it, leave unknown/legal/consent/upload fields empty and list them, never click Submit/Send/Apply/Post/Connect/Confirm, stop on the last review step and call `notify_ready`; navigation is limited to the user's allowed sites.
  - `~/.claude/CLAUDE.md`: append one line, path only: "The user's job-application profile is at ~/.claude-safari-bridge/profile.md — official Anthropic sessions only; read it only when the user asks about their details or a form." (done by Opus, not a subagent; no personal data).

- [ ] **Step 1: Write failing tests** in `safari-mcp-sites.test.mjs` (spawn `safari-mcp.mjs` with a fake bridge as `safari-mcp-deny.test.mjs` does): navigate to `https://example.com` is blocked with the sites file listing only linkedin; navigate to `https://www.linkedin.com/jobs` reaches the fake bridge; with an empty or corrupt sites file everything is blocked; watcher mode (`SAFARI_MCP_DENY_RISKY=1`) behaviour is unchanged (existing deny tests still pass).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the `safari-mcp.mjs` change, then the `claude-bridge.mjs` edits. Run `node --check bridge/claude-bridge.mjs bridge/safari-mcp.mjs`.
- [ ] **Step 4: Run** the new file and the full suite — expect PASS.
- [ ] **Step 5 (Opus):** add the CLAUDE.md line; restart the bridge with `launchctl kickstart -k gui/$(id -u)/com.armaan.claude-safari-bridge`; verify `curl` of `/ext/sites` is refused without the extension origin headers (auth works), `safari-only-mcp.json` lists both servers, and `node bridge/jobwatch.mjs profile-md` creates `profile.md` (mode 600, content not printed).

### Task 6: Stage A review and manual checks

**Files:** none changed by the reviewer.

- [ ] **Step 1 (Haiku, read-only):** review Tasks 1-5 against the spec and Review Focus; report gaps.
- [ ] **Step 2 (Sonnet):** fix anything the review reports; re-run the full suite.
- [ ] **Step 3 (Opus):** update `HANDOFF.md`; tell the user the manual checks: open a NEW terminal session; ask it to look up a profile detail and to call `notify_ready` once (macOS will ask to allow Automation for Reminders: Allow); confirm the Mac notification, the "Claude Ready" reminder, and the iPhone alert; confirm `navigate` to a non-listed site is refused; run `node bridge/sites.mjs list`.

---

## Stage B — extension side (rebuild + reload in Safari)

### Task 7: Pure tab/site logic in the extension, shared route, and `open_tab` plumbing in the bridge

**Files:**
- Create: `extension/term-sites.js`, `bridge/test/term-sites.test.mjs`
- Modify: `extension/manifest.json` (add `term-sites.js` to `background.scripts` before `background.js`; add command `share-all`: suggested key `Alt+Shift+A`, description "Share or unshare all tabs in this window with Claude Code"), `bridge/claude-bridge.mjs` (`MCP_TOOLS` gains `open_tab`)

**Interfaces:**
- Produces from `extension/term-sites.js` (classic script: top-level functions, plus `if (typeof module !== "undefined") module.exports = {...}` so Node can test it):
  - `termHostAllowed(host: string, sites: string[]): boolean` and `termUrlAllowed(url: string, sites: string[]): boolean` — identical behaviour to Task 1 (test with `bridge/test/sites-cases.json`)
  - `termPickShareable(tabs: {id: number, url?: string}[], sites: string[], shared: Set<number>, cap: number): {share: number[], skipped: {tabId: number, reason: "site"|"restricted"|"cap"}[], unshare: number[]}` — eligible = https and allowed; `restricted` = `about:`, `safari:`, `safari-web-extension:`, `file:`, empty URL; if every eligible tab is already shared, `unshare` lists them and `share` is empty; otherwise `share` lists the eligible unshared tabs in order until `shared.size + share.length` reaches `cap`, the rest are `cap`
  - `termOpenAllowed(history: number[], nowMs: number, limit: number, windowMs: number): boolean` — true when fewer than `limit` timestamps in `history` fall within the last `windowMs`
- Consumes: `bridge/test/sites-cases.json` from Task 1.

- [ ] **Step 1: Write failing tests** in `bridge/test/term-sites.test.mjs` (load the file with `createRequire`): every row of `sites-cases.json`; `termPickShareable` for zero eligible tabs, 12 eligible tabs with cap 10 (two `cap` skips), restricted tabs skipped, toggle-off when all eligible are shared, mixed windows; `termOpenAllowed` at 4 and 5 entries and with old entries outside the hour.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `term-sites.js`; make the manifest and `MCP_TOOLS` edits; add `GET /ext/sites` usage notes to `INSTALL.md` only if it documents routes.
- [ ] **Step 4: Run** the new file and the full suite — expect PASS. Run `node --check extension/term-sites.js`.

### Task 8: Share-all command and extension-side allowed-list fetch

**Files:**
- Modify: `extension/background.js` (near `termToggleShare` ~line 2096 and the commands listener that handles `toggle-claude`)

**Interfaces:**
- Consumes: `termPickShareable`, `termUrlAllowed` (Task 7); `bridgeFetch(path, opts, timeoutMs)` already in `background.js`; `termReach`, `termShared`, `termSave`, `termPaint`, `termSendShare`, `termUnshare`, `termHello`, `termEnsurePoll`, `termRestricted` already exist.
- Produces in `background.js`:
  - `async function termFetchSites(): Promise<string[]>` — `GET /ext/sites`; on any failure returns `[]` (fail closed)
  - `function termShareAll(): Promise<void>` — chains on `termOp`; queries `api.tabs.query({ windowId: <focused normal window> })`; applies `termPickShareable(tabs, sites, termShared, 10)`; for each id in `share` runs the same steps as `termToggleShare` (reach, add, save, paint, send, poll, hello); for each in `unshare` calls `termUnshare`; skipped tabs get `termRestricted`-style orange badge with title "Claude: not shared (site not allowed / cap reached)"
  - the `share-all` command in `api.commands.onCommand` calls `termShareAll()` (terminal mode only)
- Honest limit: the Chromium stub harness can exercise this with a fake `api`; real Safari behaviour (what `tabs.query` returns when a Tab Group is open) is a manual check in Task 11.

- [ ] **Step 1: Implement** the three items above, reusing the existing helpers; no duplicate share logic (extract the per-tab share steps from `termToggleShare` into one helper both use).
- [ ] **Step 2: Verify** `node --check extension/background.js`; run the existing stub-harness style check if available in the scratchpad (Opus), plus the full bridge suite.

### Task 9: `open_tab` tool and the extension-side `navigate` check

**Files:**
- Modify: `bridge/safari-mcp.mjs` (`TOOL_DEFS`, `cleanArgs`, hide from watcher), `bridge/jobwatch-activity.mjs` (`describeToolCall` wording), `extension/background.js` (`termDispatch` ~line 1810; new `termOpenTab`), `bridge/test/safari-mcp-sites.test.mjs` and `bridge/test/jobwatch-activity.test.mjs` (extend)

**Interfaces:**
- Consumes: `termFetchSites`, `termUrlAllowed`, `termOpenAllowed` (Tasks 7-8); the existing share helper from Task 8.
- Produces:
  - MCP tool `open_tab {tab_id: integer, url: string}` defined with `tabTool("open_tab", ..., {url: {type: "string"}}, ["url"])`; `tab_id` is the shared opener tab. Not listed when `SOURCE === "watcher"` or `DENY_RISKY`. In terminal mode `safari-mcp.mjs` applies the same allowed-list check as `navigate` (shared message).
  - `describeToolCall("open_tab", {url})` → `opening <host><path> in a new tab` (path trimmed to 60 characters).
  - `background.js`: `termDispatch` handles `cmd.tool === "open_tab"` after the shared-opener gate: re-checks `termUrlAllowed(url, await termFetchSites())`, `termOpenAllowed(termOpenTimes, Date.now(), 5, 3600000)`, shared count `< 10`; then `api.tabs.create({url, windowId: opener.windowId, index: opener.index + 1, active: false})`, waits up to 20 s for `status: "complete"`, shares the new tab with the Task 8 helper, records the timestamp, returns `{result: "Opened tab <id> (shared)", tab_id: <id>}`. Errors return `{error: "..."}` with the reason (not allowed, rate limit, cap, timeout).
  - `termDispatch` also applies the allowed-list check to `navigate` (fail closed when the list cannot be fetched), in addition to the `safari-mcp.mjs` check.

- [ ] **Step 1: Write failing tests** (bridge side): `tools/list` in terminal mode includes `open_tab` with required `tab_id` and `url`, in watcher mode it does not; `open_tab` to a non-listed host is blocked before the fake bridge is contacted; `describeToolCall` wording; the terminal log line for `open_tab` shows the host, not the whole query string.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the bridge-side parts, then the `background.js` parts.
- [ ] **Step 4: Run** the full suite and `node --check extension/background.js` — expect PASS.

### Task 10: Opener spike (decides whether auto-share is built)

**Files:**
- Modify: `extension/background.js` (temporary `api.tabs.onCreated` diagnostic), `bridge/claude-bridge.mjs` (`extHello` stores `created`, `mcpStatus` returns it) — both marked `// SPIKE: remove`

**Interfaces:**
- Produces: `termHello` body gains optional `created: [{tabId: number, openerTabId: number|null, host: string}]` (last 5, host only, never full URLs); `GET /mcp/status` returns it as `created`.

- [ ] **Step 1: Implement** the diagnostic only (no sharing behaviour).
- [ ] **Step 2 (Opus):** `./build-safari.sh`; ask the user to reload the extension, share a LinkedIn tab, click a link that opens a new tab, then read `created` from `/mcp/status`. Record whether `openerTabId` is a number for a tab opened from a shared tab.
- [ ] **Step 3 (Opus):** decide: opener reported → do Task 11; not reported → skip Task 11, remove the spike, note in the spec that `open_tab` is the supported path.

### Task 11: Auto-share of tabs opened from a shared tab (only if Task 10 says the opener is reported)

**Files:**
- Modify: `extension/background.js` (replace the spike with the real handler), `bridge/claude-bridge.mjs` (remove the spike fields), `extension/term-sites.js` (+ test) if a pure helper is needed

**Interfaces:**
- Consumes: the Task 8 share helper, `termFetchSites`, `termUrlAllowed`, the 10-tab cap.
- Produces: `api.tabs.onCreated` handler: acts only in terminal mode and only when `termShared.has(tab.openerTabId)`; the new tab's URL may be empty at creation, so wait (via `tabs.onUpdated`, up to 20 s) for a real `https` URL, then share only if `termUrlAllowed` and the cap permits; otherwise leave it unshared (badge shows the reason). `termPickShareable`-style pure helper `termShouldAutoShare(url, sites, sharedCount, cap): boolean` with tests.

- [ ] **Step 1: Write failing tests** for `termShouldAutoShare` (allowed host true; lookalike false; empty URL false; cap reached false).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the helper and the handler; delete the spike code.
- [ ] **Step 4: Run** the full suite and `node --check extension/background.js` — expect PASS.

### Task 12: Stage B review, build and manual checks

- [ ] **Step 1 (Haiku, read-only):** review Tasks 7-11 against the spec and Review Focus.
- [ ] **Step 2 (Sonnet):** fix what it reports; re-run the full suite.
- [ ] **Step 3 (Opus):** `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ./build-safari.sh`; update `HANDOFF.md`; ask the user to reload the extension in Safari.
- [ ] **Step 4 (manual, with the user, in real Safari):**
  1. Put LinkedIn tabs (and one non-listed tab) in one window, press Alt+Shift+A: listed tabs show ON, the other shows the "site not allowed" title; `/mcp/status` lists exactly the shared ones.
  2. With a Tab Group open, check whether share-all sees the group's tabs, only the visible tabs, or all groups; record the result in the spec.
  3. Press Alt+Shift+A again: all unshare.
  4. In a terminal session ask Claude to `open_tab` a LinkedIn URL: a background tab opens and appears as shared; a non-listed URL is refused; a sixth call in an hour is refused.
  5. Ask Claude to prepare a form on a test page you control: it fills from the profile, stops, and calls `notify_ready` (Mac notification + iPhone Reminder); it never clicks Submit.
- [ ] **Step 5:** `HANDOFF.md` final entry; remind the user to run `/compact`.

---

## Self-review notes
- Spec coverage: profile.md + lookup (T2, T4), awareness tools (T4), alerts and watcher phone path (T3), allowed list incl. navigate (T1, T5, T9), prompt + pointer (T5), share-all (T7, T8), `open_tab` (T7, T9), auto-share with spike (T10, T11), safety and fail-closed rules (Global Constraints, T1, T8, T9), testing limits (T12 manual list). The "profile identifiers only" guard and generic fallback are in T3.
- Signatures used across tasks: `loadSites`/`urlAllowed` (T1) → T5, T9; `searchProfile` (T2) → T4; `notifyReady`/`profileIdentifiers` (T3) → T4, jobwatch; `termPickShareable`/`termUrlAllowed`/`termOpenAllowed` (T7) → T8, T9; `termFetchSites` (T8) → T9, T11.
