# Fit judgment, ATS resume, page intelligence, multi-site - Implementation Plan

> **For agentic workers:** Execute task by task, one subagent at a time (user rule). Haiku writes code from the exact
> brief of one task, Sonnet fixes failures, Haiku reviews read-only after each task. Steps use checkboxes.

**Goal:** Agents judge job fit from the full posting and the profile, make an honest ATS resume per strong fit, work on any
allowed job site (not only LinkedIn), and the extension can brief any page.

**Architecture:** Judgment stays with the model, guided by a rubric file loaded into the terminal prompt. Two small
bridge modules hold state and files (fit store, resume builder) and are exposed to the terminal agent as new assistant
tools. The extension gets a page-brief instruction and three panel buttons.

**Tech Stack:** Node built-ins only (node:test, fs, crypto, child_process for macOS textutil), MV3 extension JS.

**Spec:** docs/superpowers/specs/2026-11-05-fit-judgment-and-resume-design.md

## Global Constraints

- No Opus for any agent. One subagent at a time. Existing 331 tests keep passing: `node --test bridge/test/*.test.mjs`.
- Rule and prompt text that goes into the Zellij layout: plain ASCII, no double quotes, no backslashes, no curly braces.
- Personal data (profile, master resume, generated resumes, fit log) lives only under ~/.claude-safari-bridge/. Tests use
  fictional data and a temp dir through an env override; the real directory is never touched by tests.
- New bridge code uses built-ins only. Never commit or push anything. Never print the profile or the bridge token.
- Never click Submit, Send, Post, Connect, Confirm or a final Apply. Safety rules stay as written in filer.md.

## Review Focus

- A job with the right title but no work-permit route, or the wrong country, must not be a strong fit (rubric + fit_record test).
- A resume bullet that adds a number, tool or name not in its source quote must be refused (gate test).
- Missing master resume: resume_build says so and creates no file.
- A job on a site that shows no posted date or no applicant count: the rules say how to treat it, not stall the run.
- Reading a profile section that is missing: fit check says unknown and caps the verdict at stretch.

---

### Task 1: Fit store

**Files:** Create `bridge/fit-store.mjs`, `bridge/test/fit-store.test.mjs`.

**Interfaces:**
- Produces: `fitLogFile()` (env `FIT_LOG_FILE` or ~/.claude-safari-bridge/jobwatch/fit-log.json),
  `recordFit(entry, { file, rulesHash })` -> `{ ok, error? }`, `getFit(jobUrl, { file, rulesHash })` -> entry or null
  (null when stored rulesHash differs), `listFits({ file, verdict })` -> entry[], `hashRules(...texts)` -> hex sha256.
- Entry: `{ job_url, title, company, verdict: 'strong'|'stretch'|'no', score: 0-100 int, reasons: string[], gaps: string[] }`.

- [ ] Tests (fictional data): rejects verdict outside the three; rejects score -1, 101 and non-integers; rejects reasons
  that contain an email address, a phone-number-like digit run of 8+ digits, or are not strings; stores and reads back;
  same job_url overwrites; `getFit` returns null after `rulesHash` changes; writes atomically with mode 0600; corrupt
  file reads as empty list, never throws.
- [ ] Run tests, see them fail. Implement. Run tests, see them pass.

### Task 2: Fit tools in the assistant MCP server

**Files:** Modify `bridge/assistant-mcp.mjs` (TOOL_DEFS + dispatch near `case "profile_lookup"`), `bridge/test/assistant-mcp.test.mjs`.

**Interfaces:**
- Consumes: Task 1 functions. Produces tools `fit_record` (args as Entry, all required except gaps) and `fit_lookup`
  (arg `job_url`, returns the stored entry or "none"); `ready_list` lines gain the verdict when a fit exists for the url.
- rulesHash = `hashRules(profile.json text, bridge/agents/fit.md text)` (fit.md may not exist yet: hash of empty string).

- [ ] Tests: `fit_record` valid call stores; invalid verdict returns an error text and stores nothing; `fit_lookup` of
  unknown url says none; tool list contains both names; no existing assistant test changes meaning.
- [ ] Implement, run the full suite.

### Task 3: Resume builder (gate and ATS text)

**Files:** Create `bridge/resume-build.mjs`, `bridge/test/resume-build.test.mjs`.

**Interfaces:**
- Produces: `resumeDir()` (env `RESUME_DIR` or ~/.claude-safari-bridge/resume), `masterStatus({ dir })` ->
  `{ present: boolean, format?: string, readable?: boolean }`, `readMasterText({ dir })` -> string or null,
  `checkBullet(bullet, source, masterText)` -> `{ ok, reason? }`, `renderAtsHtml(resume)` -> string,
  `buildResume(input, { dir })` -> `{ ok, error?, docx?, pdf?, gaps?: string[] }`.
- Input: `{ job_title, company, summary, skills: string[], experience: [{ role, company, dates, bullets: [{ text, source }] }], education: [{ text, source }], keywords_used: string[], job_keywords: string[] }`.
- Gate: `source` must occur in master text after lower-casing and collapsing whitespace and punctuation; and every number,
  and every capitalised or all-caps token, in `text` must also occur in `source` (normalised the same way). Refusal names the bullet.
- `gaps` = `job_keywords` not found in the master text.
- ATS html: one column, h2 headings Summary, Skills, Experience, Education, ul/li bullets, no table, img, header, footer.

- [ ] Tests with a fictional master text: accepts reorder and shortening; refuses a bullet adding "10 million" or
  a tool not in source; refuses a source that is not in the master; missing master dir returns `{ok:false}` and writes no
  file; `renderAtsHtml` output contains no `<table`, `<img`, `<header`, `<footer`, `<div`; gaps lists only absent keywords.
- [ ] Implement gate, master reading (txt, md; docx via `textutil -convert txt -stdout`; pdf best effort via `mdls`/`textutil`,
  unreadable -> `readable:false` and an error that says to supply a Word or text copy), html render. File output in Task 4.
- [ ] Run tests.

### Task 4: Word and PDF output

**Files:** Modify `bridge/resume-build.mjs`, `bridge/test/resume-build.test.mjs`.

- [ ] In `buildResume`, after the gate passes write html to `<dir>/out/<company>-<role>.html`, convert to `.docx` with
  `textutil -convert docx`, and to `.pdf` with `cupsfilter` (or `textutil -convert pdf` if available; builder picks what
  works on this Mac), delete the html, chmod files 0600, return their paths. On non-macOS or missing tool return the
  html path and an error naming the missing tool, never throw.
- [ ] Tests skip the conversion assertions when `process.platform !== 'darwin'`; on macOS assert the docx and pdf exist
  in a temp dir, are non-empty, and the file names contain no path separators from company or role (sanitised).

### Task 5: Resume tools in the assistant MCP server

**Files:** Modify `bridge/assistant-mcp.mjs`, `bridge/test/assistant-mcp.test.mjs`.

- [ ] Tools `resume_status` (no args, returns present/format/readable, never contents) and `resume_build` (Task 3 input,
  returns file paths and gaps, or the refusal text). Tests: status with no master says missing; build with no master
  refuses; build with a fictional master and valid bullets returns paths under the temp dir.

### Task 6: Rubric file, multi-site rules, prompt loading

**Files:** Create `bridge/agents/fit.md`; modify `bridge/claude-bridge.mjs` (`loadFilerRules` also appends fit.md, and
`SAFARI_ONLY_PROMPT` mentions fit_record, fit_lookup, resume_status, resume_build and the page-brief procedure);
modify `bridge/agents/filer.md` recruit block; modify `bridge/test/session-layout.test.mjs`.

**fit.md content (plain ASCII, no quotes, braces or backslashes), sections:**
1. Fit check after the applicant count: open the full job; call profile_lookup with the queries visa, salary, search,
   languages, based_in; judge role and seniority, must-have versus nice-to-have skills, location and work mode, work
   permit and sponsorship, salary against the stated minimum, language, red flags (commission only, unpaid, vague, title
   different from role). Must-haves are what the posting marks as required.
2. Verdicts: no (any hard blocker, or most must-haves missing); strong (no blocker, nearly all must-haves, location and
   level right); stretch (meaningful gap, or a fact needed for a blocker check is unknown - never strong when unknown).
3. Call fit_lookup first (skip if a verdict exists), then fit_record with verdict, score 0 to 100, three to five reasons,
   gaps. Never put personal details in reasons.
4. strong: call resume_status; if a master exists, build the resume with resume_build (each bullet carries a source quote
   from the master; reorder, shorten and use the job wording but add no fact); report the file path and gaps; then file
   (Apply or Easy Apply) as in the filer rules and tell the user to attach the file because file pickers are not driven.
   stretch: do not file, keep going, list it. no: skip with the reason. Never stop a run to ask about a stretch.
5. If the user named a site or sites in the request, search only those, do not scout, and go straight to the search
   (a named site not on the allowed list: call site_request and wait for the user). Otherwise site scout (no fixed
   site list in the rules): at the start of a run, call site_notes for each country in the profile
   locations, then decide from your own knowledge and what you see which job sites are best for the target roles there
   (fresh volume, shows posted date and applicant count, charges job seekers nothing, no scam signs, easy apply versus
   external, past notes). Pick the best two or three per country. For one not on the allowed list call site_request with
   host, country and reason, say it is waiting for the user, and carry on with the allowed sites. After searching a site
   call site_note with a 1 to 5 quality and a short note. On any allowed job site (company career pages too): use the site search form like a person (role, then location, then sort by newest or date),
   click filters one at a time and confirm each took effect. Posted time: use the site date; if the site shows none, say
   so and treat the posting as unverified - judge it but do not file it unless it says within 24 hours. Applicant count:
   apply the under-80 rule only where the site shows a number; if none shows, say not shown and continue to the fit
   check. Same filing rules, same stop at the review step, same external handling, same Allow gate. If a site is not on
   the allowed list say so and name the host; never edit the list.

- [ ] Tests: `loadFilerRules()` contains fit_record, resume_build, never stop a run, site_request, named site, f_TPR still present, no quotes,
  no braces, plain ASCII; `SAFARI_ONLY_PROMPT` still ASCII with no quotes, braces or backslashes and contains
  resume_build and fit_record; layout braces still balance; old tests still pass.

### Task 6b: Site scout store, tools and approval

Order: do this task BEFORE Task 6 so the rubric can name the tools.

**Files:** Create `bridge/site-scout.mjs`, `bridge/test/site-scout.test.mjs`; modify `bridge/assistant-mcp.mjs`,
`bridge/test/assistant-mcp.test.mjs`, `bridge/sites.mjs` (CLI only: `pending`, `approve <host>`, `deny <host>`),
`bridge/test/sites.test.mjs`.

**Interfaces:**
- Produces: `scoutFile()` (env `SITE_SCOUT_FILE` or ~/.claude-safari-bridge/site-scout.json),
  `noteSite({ host, country, quality (int 1-5), notes }, { file })` -> `{ ok, error? }`,
  `siteNotes(country, { file })` -> notes[] sorted by quality desc,
  `requestSite({ host, country, reason }, { file, allowed })` -> `{ ok, status: 'already-allowed'|'pending'|'refused', error? }`
  (refuses invalid hosts and hosts the existing BLOCKED_HOST rule in sites.mjs would refuse; deduplicates a repeat),
  `pendingSites({ file })` -> request[], `resolveSite(host, 'approved'|'denied', { file })`.
- Tools in assistant-mcp: `site_note`, `site_notes` (arg country), `site_request`. `site_request` also calls the existing
  notify path with a generic title (no personal details).
- CLI: `node bridge/sites.mjs pending` lists requests; `approve <host>` runs addSite then marks approved; `deny <host>`.

- [ ] Tests (fictional hosts, temp dirs, never the real files): note stores and sorts; bad quality refused; request for an
  allowed host says already-allowed; request for a bank-like host refused; duplicate request stays one; approve adds to a
  temp allowed-sites file and clears the pending entry; notes and reasons containing an email or 8+ digit run are refused.

### Task 7: Page intelligence in the extension

**Files:** Modify `extension/background.js` (built-in prompt), `extension/content.js` (panel buttons),
`bridge/claude-bridge.mjs` (`SAFARI_ONLY_PROMPT` page-brief paragraph), a new `bridge/test/page-brief.test.mjs`.

- [ ] Add a page-brief procedure paragraph (ASCII, no quotes/braces/backslashes) to the built-in prompts: read the page;
  if get_page_text is cut off scroll and read to the end; brief = what the page is, key facts (names, numbers, dates,
  prices), what the user can do here, what is unclear; facts only from the page, say not shown for absent ones;
  questions answered from the page; two tabs compared in a table; Is this for me compares the page with profile_lookup
  results and says so when the profile has nothing relevant.
- [ ] Add panel buttons Summarize page, Key details, Is this for me. Each puts the matching one-line instruction into the
  existing chat send path (find the current send function in content.js; do not add a new tool or permission).
- [ ] Test: the new paragraph is present in `SAFARI_ONLY_PROMPT`, ASCII-clean; content.js still parses (`node --check`).

### Task 8: Skill, handoff, profile placeholder, allowed sites

**Files:** `~/.claude/skills/job-agents/SKILL.md`, `HANDOFF.md`, `~/.claude-safari-bridge/jobwatch/profile.json` (Search section).

- [ ] SKILL.md recruit steps gain: fit check, verdicts, resume, other sites. HANDOFF.md gets a dated section.
- [ ] Add empty `work_mode`, `excluded_industries`, `other_dealbreakers` keys to the profile Search section (no values
  invented). Ask the user for the values.
- [ ] Allowed sites: show the user the proposed job-site list and add only after the user says yes (changes where the
  agent may browse). Command: `node bridge/sites.mjs add <host>`.

### Task 9: Whole-build check

- [ ] Run the full test suite; Haiku read-only review of all changed files against the spec; Sonnet fixes any finding.
- [ ] Bridge restart is the user's step (`launchctl kickstart -k gui/$(id -u)/com.armaan.claude-safari-bridge`) after
  closing the Zellij Terminal window.

---

## Self-review

- Spec coverage: fit check (1,2,6), verdict store and expiry (1,2), resume gate and files (3,4,5), stretch handling (6),
  page intelligence (7), profile gaps and dealbreakers (8), multi-site (6, 8). Verdict expiry uses the rules hash (Task 2).
- Types: Entry fields, `rulesHash`, `buildResume` input are defined once and reused by name in Tasks 2, 5.
- Not covered by tests and left to live use: real LinkedIn and other-site behaviour, Easy Apply forms, PDF extraction of
  a designed master resume.
