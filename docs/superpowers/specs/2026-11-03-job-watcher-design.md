# Job Watcher — design

Status: draft for approval, 2026-11-03. Personal details are NOT in this file (the repo is public); they live in `~/.claude-safari-bridge/jobwatch/profile.json`.

## Intent and why
The user is job hunting and loses hours on forms. LinkedIn cannot filter by "under 10 applicants" or "posted in the last 24 hours" the way they need, and good jobs fill up fast. They want a background helper that keeps checking for fresh, low-competition jobs that suit their profile, and has the application form filled in before they look, so their only job is to review and press Submit/Send.

## Goals
1. Every ~15 minutes, search LinkedIn Jobs (and follow links to company sites / other platforms) for the user's target roles in the user's locations.
2. Judge each job from its own page: posted < 24 h ago, applicants < 10, and a real fit for the profile. Keep only those.
3. Prepare each kept job so the user's last step is the final button:
   - LinkedIn Easy Apply and other application forms: filled in from the profile, stopped before Submit.
   - Recruiter / hiring-team contact on the job: a short tailored message drafted, never sent.
4. Show a **Ready list** (job, company, location, posted, applicants, one-line fit reason, what is waiting, link) and send a Mac notification when something new is ready.
5. Never show or prepare the same job twice.

## Non-goals
- No automatic Submit, Send, Apply-final, Post, or Connect. Ever.
- No bypassing logins, CAPTCHAs, or "verify you are human" steps.
- Not a general web scraper; no data leaves the Mac except normal page traffic.
- Windows/Linux, other browsers.

## Anti-goals (would make this a failure even if it technically works)
- Anything gets submitted/sent without the user's own click.
- A wrong value in a form (guessed visa month, invented language level, wrong salary).
- The watcher takes over the tab the user is working in.
- LinkedIn restricts the account because the watcher browsed too fast or too often.

## Constraints
- Runs on the existing stack: LaunchAgent/bridge, Safari extension tools (`read_page`, `get_page_text`, `click`, `type`, `press_key`, `scroll`, `navigate`, `wait`, `screenshot`), headless `claude -p`. No extension rebuild if avoidable.
- Safari-only: the watcher run has no shell and no file tools (`--tools ""`, `--strict-mcp-config`, safari MCP only). The profile is injected into its prompt by the launcher; results come back as JSON on stdout and the launcher (not Claude) writes files.
- Filters on job sites are applied by clicking one at a time (existing SAFARI_ONLY_PROMPT rule), never via URL parameters.
- Existing safety rules apply: never type passwords, card/CVV numbers, 2FA/one-time codes; outward-facing clicks are never approved by Claude.
- The Mac must be awake, logged in, Safari open. Safari may throttle/suspend a hidden tab or the extension's background script, so the watcher tab lives in its own visible (can be small, but not minimized) Safari window.
- Profile file is `chmod 600`, outside the repo, never committed.

## Decisions already made (by the user)
- It fills forms and drafts messages; the user submits/sends everything.
- Roles: Power BI developer, BI analyst/developer, data analyst, financial analyst, MIS analyst, reporting analyst, and close matches; "Senior" titles are fine when skills match. Accounting and audit roles excluded.
- Locations: Dubai, Sharjah, Abu Dhabi (about 80% of effort) and Germany (about 20%, English-speaking roles only, relocation with employer offer).
- Applies to LinkedIn and to other platforms' forms.

## Design (my calls marked **[call]**)

### Parts
1. `bridge/jobwatch.mjs` — launcher. `run-once` does one cycle; `set-tab`, `status`, `pause`/`resume`, `mark <id> done|skip` subcommands. A lock file stops overlapping runs. Reads `profile.json`, builds the prompt, spawns `claude -p`, parses the result, updates state, writes the Ready list, sends the notification (`osascript`).
2. A second LaunchAgent `com.armaan.claude-safari-jobwatch` with `StartInterval` 900 s running `node bridge/jobwatch.mjs run-once`. Installed/removed by `bridge/install.sh` / `uninstall.sh`; `touch ~/.claude-safari-bridge/jobwatch/off` pauses it. **[call]** Quiet hours (default 23:00–07:00 Dubai time) skip runs, to save Claude usage.
3. `bridge/safari-mcp.mjs` gets a **deny-risky mode** (env `SAFARI_MCP_DENY_RISKY=1`, set only in the watcher's own MCP config `jobwatch-mcp.json`). In that mode a `needs_approval` answer is immediately answered with `approve:false` (never waits for the human's pill, so a stray Allow cannot submit anything), and `press_key` Enter and `type` with `submit:true` are refused. The watcher prompt also forbids Submit/Send/Apply-final clicks (defence in depth).
4. State in `~/.claude-safari-bridge/jobwatch/`: `profile.json`, `seen.json` (job ids, so nothing repeats), `queue.json` (Ready items and their status), `ready.html` (the list you open; each row links to the job and to its prepared form), `runs.log`.
5. The watcher tab: the user opens one dedicated Safari window, shares its tab with the dark icon, and runs `jobwatch.mjs set-tab` once. If that tab is not shared at run time the run exits and sends a notification "share the Job Watch tab".

### One cycle
1. **Discover.** Round-robin over role x location combinations so every combination is covered at least hourly, UAE combinations more often than Germany **[call]**. Click the search and filters one at a time. Use "Past 24 hours". Open each result; read posted-time and applicant count (LinkedIn shows "N applicants" / "Be among the first 25"). Drop jobs not under 24 h or not under 10 applicants, excluded roles, and jobs seen before. Score fit against the profile; keep fits only. Skip when a posting states pay clearly below the user's UAE minimum **[call]**; for Germany prefer postings that mention visa sponsorship/relocation and flag any that say EU work permit required.
2. **Prepare.** The tab can only hold one filled form at a time (the tools cannot open extra tabs and cannot drive unshared tabs), so there is one **parked slot** **[call]**. If the slot is free, take the best kept job and fill it: Easy Apply steps one by one up to (not including) the final Submit; or follow "Apply" to the company site and fill that form. Leave the filled page open in the watcher tab. If the slot is busy, the job stays in the Ready list as "discovered, form not yet prepared" and gets its form when the slot frees. The slot frees when the page shows the application was sent, the user runs `mark <id> done|skip`, or 3 hours pass **[call]**.
3. **Fill rules.** Values come only from `profile.json`. A field with no answer in the profile (including any `null`), or any legal/consent/"are you sure" question, is left empty and listed as "needs you". Screening questions about experience: answer from what the profile and CV state; never invent. File uploads (CV, certificates) cannot be done by the tools: listed as "needs you: upload". Login walls, account creation, CAPTCHA: stop, list as "needs you: log in".
4. **Message draft.** If the job shows a hiring team / recruiter, write a 3-4 sentence message (role, 1-2 matching skills, availability: notice period from profile) and save it in the Ready item with a copy button. When that job is prepared, it is also typed into the message box but not sent.
5. **Report.** Final JSON: new Ready items, items needing the user, errors. The launcher updates `queue.json`/`ready.html` and notifies. At most one notification per cycle.

### Pacing and account safety **[call]**
Waits of 2-5 s between clicks (existing `wait` tool), at most about 25 job pages per cycle, a run is aborted after 12 minutes. If LinkedIn shows a challenge, "unusual activity", or login wall, the watcher pauses itself for 6 hours and notifies the user.

### Cost and models **[call]**
Each cycle uses Claude Pro/Max quota. Defaults: Haiku for discovery, Sonnet for form filling, configurable in `jobwatch/config.json` (`model_discover`, `model_fill`, `interval_seconds`, `quiet_hours`).

## Testing the builder must do
- Deny-risky mode: a Submit/Send click, Enter-to-submit, and `type submit:true` are refused and nothing is sent. Test against a harmless local HTML form first, then LinkedIn composer "Post" (must be refused).
- A full cycle on LinkedIn: discover only (prepare disabled), then prepare one Easy Apply job and stop before Submit; then the same on one non-LinkedIn application form.
- Overlap lock, quiet hours, pause/resume, a not-shared tab, and a LinkedIn challenge page (simulated) all behave as written.
- Dedup: a second cycle does not re-report a seen job.
- Empirically check that a background run works with Safari not frontmost and report what breaks.

## Settled after the builder check (my calls unless stated)
- **Parked form vs Ready-list link.** A row's "open prepared form" link works only while that job holds the parked slot; the row says "form parked" in that case. Otherwise it says "form not prepared" or "form expired" and links to the job itself. The 3-hour timeout only frees the slot; the page is left alone until the next job is prepared, which navigates away (typed values are lost). `jobwatch.mjs mark <id> prepare` re-queues a job for preparation when the slot is free.
- **Applicant gate.** Keep a job only if the page shows an exact count under 10, or "Be among the first 25 applicants" (meaning fewer than 25, exact count unknown). The latter is tagged "<25, exact unknown" and ranked below exact counts. "Over 100", "100+" or any count of 10 or more is dropped. No applicant text at all: dropped.
- **Profile and pay filter.** `profile.json` already exists (`~/.claude-safari-bridge/jobwatch/`). The UAE pay floor is `salary.expected_uae_minimum_monthly_aed`; Germany's is the low end of `salary.expected_germany_annual_eur_gross`. A job is skipped only when it states pay clearly below that floor. The builder reads the field names from the file.
- **Discovery scope.** LinkedIn Jobs only. Other platforms are reached when a LinkedIn job's Apply button leads to a company or job-board form (Stage 3 fills those). Searching other job boards directly (Bayt, GulfTalent, Indeed) is out of scope until asked.
- **Germany work-permit wording.** Postings that state an existing EU work permit/authorisation is required are skipped (counted in `runs.log`, not shown). Postings that mention visa sponsorship or relocation are preferred; silent postings are kept.
- **Shared-code risk.** `bridge/safari-mcp.mjs` is shared with normal sessions. Deny-risky mode is gated by an env var set only in the watcher's own MCP config; with the variable absent, behaviour must be unchanged. The builder must test both paths.

## Left to the builder
File layout inside `bridge/`, JSON field names, how the fit score is computed, the exact search order, the HTML design of the Ready list, how the launcher detects "application sent".

## Stages
1. Launcher + deny-risky mode + state files + LaunchAgent; discovery on LinkedIn only (no form filling). Verify with the user.
2. LinkedIn Easy Apply preparation + recruiter message drafts.
3. Other platforms' forms (same prepare step, different pages).
