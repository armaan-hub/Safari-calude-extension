# Recruiter + Filer agents Implementation Plan

> **For agentic workers:** Sonnet plans and verifies. Haiku writes code (one subagent at a time). Sonnet fixes failures. Haiku reviews read-only. No Opus anywhere in this job. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the "watch + controls" mental model with two agents: a Recruiter that finds jobs on a schedule and a Filer that prepares applications from the queue when the user asks. The user is the head; the terminal session (Sonnet) is where they talk to it.

**Architecture:** The Recruiter is the existing Job Watcher run (Haiku, `model_discover: 'haiku'`, deny-risky Safari tools, 10-minute interval, writes `queue.json`, sends the Reminder). The Filer is the terminal Claude session (Sonnet) following a short instruction file: take the next queue item, open it in a shared tab, name the page and form, fill from `profile_lookup` only, stop before Submit, mark the item, call `notify_ready`. Controls shrink to status, pause and resume.

**Tech Stack:** Node 22+ built-ins (`node:test`), the existing assistant MCP server (`bridge/assistant-mcp.mjs`), Zellij layout builder in `bridge/claude-bridge.mjs`.

## Global Constraints

- No Opus for any agent. Terminal session is started with `--model sonnet`; the Recruiter stays `haiku`.
- No personal data in the repo or tests: fictional values only (`bridge/test/fixtures.mjs`). The user's job filter stays in `~/.claude-safari-bridge/jobwatch/profile.json`, outside the repo.
- Never print or log the bridge token.
- The Filer never clicks Submit, Send, Apply, Post, Connect or Confirm, and never types passwords, card numbers or 2FA codes.
- Each task ends with `node --test bridge/test/*.test.mjs` all passing and `node --check` on each edited `.mjs`.
- Subagents run one at a time; each brief names the exact files it may touch.
- The Recruiter prompt (`buildDiscoverPrompt`) is NOT moved or rewritten; it already works and is heavily tested.

## Review Focus

1. `queue_mark` with an unknown id or a status that is not allowed: error text, queue unchanged.
2. `ready_list` shows each item's id so the Filer can mark it; no profile data appears.
3. Two items with the same title and company: the Filer marks by id, never by title.
4. Layout change (model flag) triggers the existing auto-recreate; the layout still parses with balanced braces.
5. Trimmed `watcher_control`: `run_now` and `set_interval` are refused with a clear message, while status, pause and resume still work.

---

### Task 1: Queue tools for the Filer

**Files:**
- Modify: `bridge/assistant-mcp.mjs` (`ready_list` output includes id; new tool `queue_mark`)
- Test: `bridge/test/assistant-mcp.test.mjs` (add cases)

**Interfaces:**
- Consumes: `loadQueue`, `markItem`, `writeReady`, `stateDir` from `jobwatch-state.mjs` (already imported or importable).
- Produces: `queue_mark({id: string, status: "done" | "skipped" | "prepare"}) -> {text}`. Unknown id returns `Unknown job id.`; any other status returns `Status must be done, skipped or prepare.`. `ready_list` lines become `id — title — company — location — url — status`.

- [ ] **Step 1: Write failing tests**: `ready_list` line starts with the item id; `queue_mark` with a known id and `done` changes the stored status; unknown id refused and queue file unchanged; status `discovered` refused.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** both changes. `queue_mark` also calls `writeReady` so `ready.html` matches.
- [ ] **Step 4: Run all tests, expect PASS**; `node --check bridge/assistant-mcp.mjs`.

### Task 2: Filer instruction file, Sonnet terminal, shorter prompt

**Files:**
- Create: `bridge/agents/filer.md` (plain ASCII, no double quotes or backslashes, no personal details)
- Modify: `bridge/claude-bridge.mjs` (`SAFARI_ONLY_PROMPT` appends the file text; `buildLayout` adds `--model sonnet`)
- Test: `bridge/test/session-layout.test.mjs` (add cases)

**Interfaces:**
- Produces: `loadFilerRules() -> string` (reads `bridge/agents/filer.md`; returns "" if missing). `buildLayout` output contains `"--model" "sonnet"`.

`filer.md` content (the Filer rules, one short list): when the user says "file next" or names a job, call `ready_list`; pick the top item unless the user names one; navigate to its url in a shared tab; say which job and which form; fill only from `profile_lookup`; list empty fields; stop on the review step; call `queue_mark` with the id and `prepare`; call `notify_ready`; mark `done` only when the user says they submitted it and `skipped` when they say skip.

- [ ] **Step 1: Failing tests**: layout contains `--model` and `sonnet`; `loadFilerRules()` returns text containing `queue_mark`; layout still has balanced braces and both tabs.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Keep the existing prompt sentences; replace the long form-preparation sentences with the file text only if the tests prove nothing regresses; otherwise append.
- [ ] **Step 4: Run all tests, expect PASS**; `node --check bridge/claude-bridge.mjs`.

### Task 3: Trim the controls

**Files:**
- Modify: `bridge/assistant-mcp.mjs` (`watcher_control` accepts `status | pause | resume` only)
- Modify: `bridge/claude-bridge.mjs` (prompt sentence about `watcher_control`)
- Test: `bridge/test/assistant-mcp.test.mjs` (update cases)

**Interfaces:**
- Produces: `watcher_control({action: "status"|"pause"|"resume", hours?})`. `run_now` and `set_interval` return `Not available. The Recruiter runs every 10 minutes; use status, pause or resume.`. The CLI commands `run-now` and `interval` stay in `jobwatch.mjs` untouched.

- [ ] **Step 1: Update tests** (run_now and set_interval now refused; status, pause, resume still call the CLI).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Update the prompt sentence to match.
- [ ] **Step 4: Run all tests, expect PASS**; `node --check`.

## Manual steps for the user (not automated)

1. Restart the bridge: `launchctl kickstart -k gui/$(id -u)/com.armaan.claude-safari-bridge` (the Zellij session recreates itself with the Sonnet flag when no client is attached).
2. Pick the Recruiter's tab: share a LinkedIn tab, then `node bridge/jobwatch.mjs set-tab <id>`.
3. Clear the pause: `node bridge/jobwatch.mjs resume`.
4. Review `~/.claude-safari-bridge/jobwatch/profile.json` for roles and locations; tell Sonnet what to change.
