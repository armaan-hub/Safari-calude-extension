# Form-prep session, profile lookup, phone alerts and multi-tab sharing — design

Status: draft for approval, 2026-11-04. Personal details are NOT in this file (the repo is public). The profile lives in `~/.claude-safari-bridge/` on the user's Mac and is never committed.

## Intent and why
The user is job hunting and wants Claude to take over the tedious part of applying: read the next page, fill the form from their profile, and stop. They press Submit. Today the "Claude for Safari" terminal session can act only on tabs the user shares one by one, cannot open a tab, does not know about the Job Watcher, and cannot look anything up about the user. This design closes those gaps without giving Claude any new way to send or submit anything.

The user also wants the same machinery to work on any site they choose later, not only LinkedIn, and wants safety to come first because the extension is very powerful.

## Goals
1. **Review-first form preparation.** In the terminal session the user says "prepare this". Claude fills the form from the profile, stops before the final step, and raises a "ready for your review" alert. The user clicks Submit/Send in the page themselves.
2. **Profile lookup on demand.** A markdown profile file on the Mac. Claude searches it and answers or fills from it only when the task needs it; it is never loaded into every session.
3. **Awareness.** The terminal session knows about the Job Watcher: it can read the Ready list and the recent activity feed.
4. **Phone alert.** "Ready for your review" reaches the user's iPhone through Apple Reminders (iCloud) as well as a Mac notification. The Job Watcher's per-cycle alert gets the same phone path.
5. **Many tabs.** One action shares every tab in the current Safari window (the user puts the pages they want in one window; a Safari Tab Group's tabs are the tabs in that window while the group is open). Claude can open a new tab to a page, and a tab opened from a shared tab is shared automatically.
6. **Site-agnostic by an allowed-sites list** the user controls. LinkedIn is the only entry by default.
7. **The whole Claude Code can answer from the profile** if asked (a pointer to the file, not the content).

## Non-goals
- Claude never submits, sends, posts, applies-final, or connects. No new tool can click for it past an outward-facing step.
- Claude cannot share or unshare a tab; only the user can (toolbar click, Alt+C, the new share-all key).
- No reading of unshared tabs (verified 2026-11-04: unshared tabs are refused with "Tab not shared").
- No dependence on a Safari Tab Groups API. None is documented for Safari web extensions; this design must work without one.
- The in-page Claude Panel extension is out of scope. The new tools and sharing live in the terminal ("Claude for Safari") mode only.
- No third-party notification service (ntfy etc.) unless the user asks later.
- Stage 3 (external company forms, file uploads, other sites' specifics) and a profile editor UI are later work.

## Anti-goals (a failure even if it technically works)
- Anything is submitted or sent without the user's own click.
- A wrong value in a form (guessed visa month, invented language level or salary).
- Profile values leak: into `activity.log`, into the repo, into the watcher's prompt or tools, into reminder text, or into a non-Claude third party.
- A tab is shared or opened on a site not on the allowed list, or on a bank/payment/health page.
- The watcher gains profile tools, or the terminal session gains the watcher's schedule powers.

## Constraints
- Safari MV3 extension plus the local bridge (`127.0.0.1:8787`, token header). Extension code changes need `./build-safari.sh` (with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`) and the user reloading the extension in Safari.
- The terminal session runs `claude` with `--strict-mcp-config --mcp-config ~/.claude-safari-bridge/safari-only-mcp.json --tools ""`; its only tools are MCP tools. Anything new it needs must be an MCP tool.
- The watcher run uses its own MCP config (`jobwatch-mcp.json`, `SAFARI_MCP_SOURCE=watcher`, deny-risky mode). It must not receive the new profile/notify tools.
- Existing safety rules stay: never type passwords, card or CVV numbers, or 2FA/one-time codes; risky clicks need the user's Allow in Safari and are never approved by Claude.
- Tests use fictional data ("Test User"); run with `node --test bridge/test/*.test.mjs` (Node 26 needs the glob).
- Private files are `chmod 600` and outside the repo; `.gitignore` already covers `.claude-safari-bridge/`, `profile.json` and friends and gets `profile.md`.

## Decisions already made (by the user)
- Review-first: Claude fills, stops before the final step, notifies "ready for your review"; the user clicks Submit.
- Profile: "look it up only when needed, keep it on my Mac", a markdown (or similar) file Claude can search.
- The entire Claude Code should be able to answer from it if asked, not only this session.
- Site-agnostic design; LinkedIn first.
- Safety first.
- Phone alert via Reminders or similar (the user asked me to think about it; Reminders is my recommendation, still to be confirmed by the user).
- Share a whole group of pages; Claude can follow an apply link to the next page and fill or read it; the user asked whether Claude can open the tabs itself.

## Design (my calls marked **[call]**)

### Stage A — bridge side, no extension rebuild
1. **Profile markdown** `~/.claude-safari-bridge/profile.md` (chmod 600), generated by `node bridge/jobwatch.mjs profile-md` from `profile.json` **[call]**: one `##` heading per topic (contact, work authorization, languages, experience, skills, salary/notice, links). Fields that are `null` are written as `NOT PROVIDED`, so the model leaves them empty. A final `## Notes (yours)` section is user-written and preserved on regeneration. Both files stay chmod 600.
2. **Assistant MCP server** `bridge/assistant-mcp.mjs` **[call]** (separate from `safari-mcp.mjs` so the boundary is clear), added to the terminal session's `safari-only-mcp.json` by `writeSessionFiles` in `claude-bridge.mjs`, and absent from `jobwatch-mcp.json`. Tools, all read-only except notify:
   - `profile_lookup {query}` — returns only the sections of `profile.md` whose heading or text match the query (case-insensitive terms), capped at a few KB. Never returns the whole file. The activity log records only "profile lookup (N sections)".
   - `ready_list {}` — items from `jobwatch/queue.json`: title, company, location, link, status. No profile data.
   - `recent_activity {lines?}` — the tail of `activity.log` (default 40, max 200).
   - `notify_ready {title, detail?, needs_you?[]}` — sends the "ready for your review" alert (see 4). `title` and `detail` are capped (80 and 160 chars), stripped of control characters, and the text is checked against the profile's *personal identifiers only* (phone, email, home address, passport/visa/ID numbers, date of birth, salary figures; not skills, employers or job titles) so those cannot be echoed into iCloud **[call]**. If the check trips, the alert is not dropped: it falls back to the generic line "Form ready for your review" and the tool tells Claude it did so. The watcher's per-cycle alert goes through the same module and the same check.
3. **Prompt update** to `SAFARI_ONLY_PROMPT` (`claude-bridge.mjs`): describes the watcher and the Ready list, the review-first workflow, the fill rules below, and that `notify_ready` is the last step. A new terminal session is needed to pick it up (bridge restart).
4. **Alerts** `bridge/notify.mjs`, one module used by `notify_ready` and by `jobwatch.mjs` **[call]**: a Mac notification (`osascript display notification`) plus an Apple Reminder (`osascript` to Reminders) in a list named "Claude Ready", due now, so iCloud pushes it to the iPhone. Reminder text is generic, for example "Form ready: <title>, <company>" with the page link in the notes. macOS asks the user once to allow Automation for Reminders (a physical step). If Reminders fails, the Mac notification still goes out and the failure is logged, not thrown. `config.json` gets `reminders: true|false` (default true).
5. **Allowed-sites list** `~/.claude-safari-bridge/allowed-sites.json` (a JSON array: `["linkedin.com"]`; a bare TLD such as `com` is refused), managed by `node bridge/sites.mjs list|add <host>|remove <host>` **[call]**. A host matches itself and its subdomains. It must be https. `add` refuses obviously sensitive hosts it can recognise (banking and payment keywords) unless `--force` is given. The bridge exposes the list to the extension (in the poll reply or a `GET /mcp/sites`, builder's choice) and to the MCP servers.
6. **Pointer for the whole Claude Code** **[call, needs the user's OK]**: one line in `~/.claude/CLAUDE.md`: "The user's job-application profile is at `~/.claude-safari-bridge/profile.md`; read it only when asked about their details or a form." A path only, no personal data, because other providers also load that file.

### Fill rules (apply to every form Claude prepares)
- Values come only from `profile_lookup`. A field with no answer in the profile (or `NOT PROVIDED`), any legal/consent/"are you sure" question, and any file upload is left empty and listed under `needs_you`.
- Never type passwords, card or CVV numbers, or 2FA/one-time codes. Login wall, account creation, CAPTCHA: stop and list as needs-you.
- Never click Submit, Send, Apply-final, Post, Connect, or Confirm. Stop on the last review step.
- Typed values are not written to `activity.log` (the terminal source already logs only character counts).

### Stage B — extension side (needs a rebuild and a reload in Safari)
7. **Share all tabs in this window.** A new keyboard command (Alt+Shift+C, **[call]**; the builder checks `manifest.json` for conflicts with Alt+C) shares every tab Safari reports for the front window (whatever tabs are showing; no notion of a "group" **[call]**) whose site is on the allowed list and whose page can take the content script. Tabs on other sites are skipped and their badge says why. If every eligible tab is already shared, the same key unshares them all. The toolbar click still toggles one tab. Cap: 10 shared tabs in total **[call]**; extra tabs are skipped with a message. This lives in `background.js` next to `termToggleShare`.
8. **`open_tab {url}`** — a new MCP tool in `safari-mcp.mjs` (terminal source only), handled in `background.js` (it is a browser action, not a page exec, so it joins `TERM_TOOLS` with its own handler). Rules: https only; host on the allowed list; opened in the same window next to the calling tab, in the background (`active:false`) so it does not steal focus **[call]**; the new tab is shared automatically; at most 5 opens per hour and the existing call budget **[call]**; it appears in the activity feed. It returns the new `tab_id`.
9. **Auto-share of tabs opened from a shared tab** (links with `target=_blank`, `window.open`). Uses `tabs.onCreated` and the opener tab id **if Safari provides it**; share only when the opener is shared, the destination host is allowed and the 10-tab cap is not hit. **Unconfirmed in Safari**: the plan starts with a small spike that logs what `onCreated` reports for a link opened from a shared tab. If Safari does not give an opener, this step is dropped and `open_tab` is the supported way to continue to a new page; Claude may also `navigate` within the shared tab.
10. **Where the allowed list applies**: share-all, `open_tab`, auto-share, **and `navigate` in the terminal session** (Claude may only load pages on allowed hosts). **[call — see "For you to decide"]**.

### Safety summary
Only the user shares tabs. The allowed list is a positive list, so banking, mail, payment and health pages are never shared or opened by default. All page traffic, the profile and the Ready list stay on the Mac; only a generic reminder line goes to iCloud. Submit/Send stays with the human and Safari's Allow prompt is untouched. The watcher gets none of the new powers.

### Testing and honest limits
- Bridge side: unit tests with fictional data for profile generation, section search, the profile-echo refusal, allowed-host matching (including lookalike hosts such as `linkedin.com.evil.test`), caps and sanitising, and notify's fall-back when Reminders fails (osascript stubbed).
- Extension side: the existing Chromium harness for share-all, caps, allowed-list filtering and `open_tab` logic.
- Not verifiable without the user in real Safari: the Reminders permission prompt and the iPhone alert arriving; share-all and `open_tab` in Safari; whether `onCreated` reports an opener; whether a Tab Group's tabs are what `tabs.query` returns for the window. These are listed as manual checks in the plan.

## Decided by the user on 2026-11-04
All three answered "yes, recommended option": (1) the allowed-sites list also limits `navigate` in the terminal session; (2) the `~/.claude/CLAUDE.md` pointer is added with the wording "official Anthropic sessions only"; (3) an iPhone Reminder (list "Claude Ready", generic text) is the phone alert. Consequence of (1): the terminal session can `navigate` only to listed hosts (LinkedIn by default); the user adds others with `node bridge/sites.mjs add <host>`. Clicking links inside a page is unaffected.

Correction found while planning: `Alt+Shift+C` is already the existing "share or unshare this tab" command in `manifest.json`, so share-all uses **Alt+Shift+A** instead of the key named in item 7.

Fail-closed rules added while planning: a missing `allowed-sites.json` means the default (`linkedin.com`); an unreadable, corrupt or malformed file, or an empty list, means no site is allowed. If the extension cannot fetch the list from the bridge, it shares and opens nothing.

(The questions below are kept for the record.)

## For you to decide (my recommendation first)
1. Should the allowed-sites list also limit where Claude can `navigate` in a shared tab? Recommended **yes**: it closes the gap where a shared LinkedIn tab could be steered anywhere. Today the terminal session can navigate shared tabs to any site.
2. May I add the one-line pointer to `~/.claude/CLAUDE.md` (path only)? One catch the review raised: your `run-claude-opencode` mode sends sessions to other providers (minimax, kimi, deepseek and so on). If you ask for your details in such a session, the part of the profile Claude reads would go to that provider. Options: (a) add the pointer and accept that, (b) add it with the wording "official Anthropic sessions only", or (c) skip the pointer; this session's `profile_lookup` still works. Recommended **(b)**.
3. Is an iPhone Reminder (list "Claude Ready", generic text) an acceptable phone alert, knowing you still press Submit at the Mac? If not, the fallback is the Mac notification only.

Also note (not a decision): filling a form necessarily sends the profile lines it needs to Anthropic's API, like any Claude chat. They never go anywhere else.

## What is left to the builder
Exact file layout inside `bridge/` for the new modules, the section-matching algorithm for `profile_lookup`, how the bridge hands the allowed list to the extension, the Reminders AppleScript, and the Chromium-harness test structure.

## Delivery order
Stage A first (usable the same day, no Safari reload), then Stage B. Each stage ends with its tests green and a HANDOFF.md entry.

## Status note (2026-11-04, Opus)
Stage A (profile.md, assistant tools, alerts, allowed list, prompt) and Stage B tasks 7-9 (share-all Alt+Shift+A, `open_tab`, navigate list check) are built and tested (279 tests). Tasks 10-11 (opener spike, auto-share of tabs opened from a shared tab) are deferred until the user can run the spike in real Safari. Limits found in review: the open_tab rate limit is persisted in extension storage but still depends on Safari keeping that storage; when the bridge is down the allowed list reads as empty, so share-all shares nothing and cannot unshare (per-tab toggle still works); a shared tab that follows a page link to an unlisted site stays shared (by design; `navigate` and `open_tab` redirects are re-checked).
