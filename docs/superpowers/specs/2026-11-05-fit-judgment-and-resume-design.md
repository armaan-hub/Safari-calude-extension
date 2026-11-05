# Fit judgment, ATS resume and page intelligence - design

Date: 2026-11-05. Status: draft for the user's approval. Contains no personal data.

## Intent and why

Today the agents (Recruiter and Filer, running as Sonnet in the Zellij session) follow a checklist: posted in
the last 24 hours, fewer than 80 applicants, not an excluded role, not already applied. They never judge
whether a job is good for the user. The user wants the agents to use their intelligence: read the whole job,
decide if it suits the user, and give the user a resume made for that job. The user also wants the extension to
be smart on any page, not only job pages: read it, summarize it, pull out the details.

## Goals

1. Fit check: for every job that passes the cheap filters, the agent reads the full description and the
   user's profile and returns a verdict (strong fit, stretch, not for you) with reasons and gaps.
2. Only strong fits are filed automatically. Stretches are shown to the user with reasons. Not-for-you jobs
   are skipped with the reason.
3. ATS-friendly resume per job, made from the user's own master resume, saved as Word and PDF on the Mac.
4. Page intelligence: built-in ability to summarize any page, extract key details, answer a question about it,
   and say whether it suits the user, with no pasted prompt.
5. It all works from the one word the user types (for example recruit) and from the extension panel.

## Non-goals

- No submitting, sending, posting, connecting or confirming. Same safety rules as today.
- No learning loop that trains on the user's past choices (later, if wanted).
- No change to the Job Watcher (paused; still the 3 hour / under 10 rules).
- No attempt to upload the resume inside a form (the extension cannot drive file pickers); the agent tells
  the user the file path to attach. See open items.

## Anti-goals (a failure even if it works)

- A resume that claims anything not in the user's master resume or profile.
- Personal details printed in chat, notifications or committed to GitHub.
- Strong-fit verdicts that are really a keyword count (a job with the right title but wrong country or no
  sponsorship must not be a strong fit).
- Agents that stall and ask the user what to do instead of running.

## Constraints

- Agents never use Opus. Haiku writes code, Sonnet fixes, Haiku reviews read-only, one subagent at a time.
- The terminal session is Sonnet, has no built-in tools, only the Safari tools and the assistant tools
  (profile_lookup, ready_list, queue_mark, notify_ready, ...). Anything new it needs must be a tool there.
- Rule and prompt text that goes into the Zellij layout is plain ASCII with no double quotes, no
  backslashes, no curly braces (existing tests enforce this).
- Personal data (profile, master resume, generated resumes, verdict log) lives under
  ~/.claude-safari-bridge/, never in the repo. Tests use fictional data only.
- Built-ins only for new bridge code where possible (the bridge has no npm dependencies today). macOS tools
  such as textutil may be used for file conversion.
- Existing 331 tests keep passing.

## Design

### 1. Fit check (agent judgment guided by a rubric)

The agent decides; the code does not score. A rubric file, bridge/agents/fit.md, is loaded into the prompt
next to filer.md (same loadFilerRules mechanism). The agent opens the job, reads the full description, calls
profile_lookup for the facts it needs, and judges these dimensions:

- Role and seniority, and years of experience asked for.
- Must-have skills versus nice-to-have skills; list the user's gaps.
- Location and work mode (on-site, hybrid, remote); the user's allowed locations come from the profile.
- Visa or work permit and sponsorship (a hard blocker if the job cannot work for the user).
- Salary, when shown, against the user's preference in the profile.
- Industry or company type the user wants or excludes, language requirements.
- Red flags: commission-only, unpaid, vague or misleading posting, a different role than the title says.

Verdict rules (judgment, with these anchors):
- Not for you: any hard blocker (location impossible, no work-permit route, excluded role or industry),
  or most must-haves missing.
- Strong fit: no hard blocker, nearly all must-haves met, location and level right.
- Stretch: no hard blocker but a meaningful gap the user could still close or accept.

Output per job, one block: title, company, verdict, score 0 to 100, three to five reasons, gaps list.

New assistant tool fit_record(job_url, title, company, verdict, score, reasons[], gaps[]) stores the block in a
local store (~/.claude-safari-bridge/jobwatch/fit-log.json) so the run summary table and ready_list can show it
and so the same job is not judged twice. It refuses a verdict other than the three above and refuses a score
outside 0 to 100. Text with personal details in it is refused the way notify_ready already does.

In a recruit run the order becomes: search (24 hour filter) -> open job -> read applicant count (under 80) ->
fit check -> strong fit: resume + file; stretch: list for the user; not for you: skip with reason.
The cheap filters stay because they save time; they are no longer the decision.

### 2. ATS-friendly resume per job

The user drops a master resume into ~/.claude-safari-bridge/resume/ (Word, PDF, markdown or text) when ready.
The tool must work without it present: it says the master resume is missing and stops, it never makes one up.

New assistant tools:
- resume_status(): says whether a master resume is present and readable (no contents).
- resume_build(job_title, company, summary, skills[], experience[], education[], keywords_used[]): renders
  the tailored resume. Every experience bullet must carry a source: a quote from the master. The tool checks
  each source against the master text and refuses a bullet whose source is not found. This is the honesty
  gate: the agent may reorder, shorten and reword for the job's vocabulary, never add a fact.
- Output: Word and PDF files in ~/.claude-safari-bridge/resume/out/, named by company and role, returns the
  path and a list of job keywords the resume could not truthfully include (the gaps).

ATS format rules the renderer enforces: single column, standard headings (Summary, Skills, Experience,
Education), plain bullets, a standard font, no tables, images, text boxes, headers or footers, dates in one
consistent format, contact line as plain text.

Master resume text extraction (Word, PDF to plain text) is the builder's choice; if a format cannot be read
the tool says which format to supply instead.

### 3. Page intelligence (any page)

The extension already has read_page, get_page_text (truncated near 30k characters), screenshot, scroll and the
rest. What is missing is a built-in way of working with them. Add to the extension's built-in prompt
(background.js) and to the terminal prompt (SAFARI_ONLY_PROMPT) a short page-brief procedure:

- Read the page; if get_page_text is cut off, scroll and read on until the end.
- Brief: what the page is, key facts (names, numbers, dates, prices), what the user can do here (actions,
  links), what is unclear or missing. Facts only from the page; say not shown for anything absent.
- Questions about the page are answered from the page; "is this good for me" uses profile_lookup.
- Comparison of two tabs: read both, side-by-side table of differences.

Panel buttons (my call, small): Summarize page, Key details, Is this for me. They send the matching
instruction into the existing chat; no new tool.

### 4. Site scout (not hard-coded, added 2026-11-05 at the user's request)

No fixed list of job sites in the rules. At the start of a recruit run, for each country in the user's profile
locations, the agent works out the best job sites for the user's target roles from its own knowledge and from what
it sees on the pages. It ranks by: fresh volume for those roles, shows posted date and applicant count, honest
(no fees charged to job seekers, no scam signs), apply flow (easy apply versus external), and how well past runs
went there. It then searches the best two or three per country.

- The user's word wins: if the user names a site or sites in the request (for example recruit on Bayt), the agent
  searches only those, skips scouting and goes straight to the search. Scouting happens only when no site is named.
  A named site that is not on the allowed list still goes through site_request (the allowed list is a safety gate the
  agent cannot edit, and a web page could fake a user instruction), so the user approves once with one yes; the user
  can also have the host added before the run.
- site_note(host, country, quality 1-5, notes): remembers what it learned (stored locally, personal-data free);
  site_notes(country): returns what it already knows so the next run starts smarter.
- Sites not on the user's allowed list: the agent cannot browse them and cannot edit the list. It calls
  site_request(host, country, reason), which records a pending request and sends one notify_ready. The user
  approves with one command or by saying yes in chat (bridge/sites.mjs pending / approve <host>). Hosts that look
  like bank or payment sites are refused by the existing sites.mjs rule.
- Until a request is approved the run continues on the sites already allowed.
- Optional later choice for the user: pre-approve any job board the agent proposes. Not enabled by default.

### Where things live

- bridge/agents/fit.md (new): rubric text. bridge/claude-bridge.mjs: load it into the prompt.
- bridge/assistant-mcp.mjs: new tools fit_record, resume_status, resume_build (+ tool definitions).
- bridge/fit-store.mjs and bridge/resume-build.mjs (new): storage and rendering, unit tested.
- extension/background.js and extension/content.js: page-brief prompt and panel buttons.
- ~/.claude/skills/job-agents/SKILL.md and HANDOFF.md: updated.

## Decisions made by me (the user can change)

- Verdict has three levels, score is 0 to 100 and is advisory.
- Stretches wait for the user instead of being filed.
- Resume honesty gate by source quotes.
- Word + PDF output; the agent tells the file path, the user attaches it.
- Master resume location ~/.claude-safari-bridge/resume/.
- Panel buttons for page intelligence.

## Calls added after the builder check (mine; the user can change)

- Facts for the fit check come from profile.json via profile_lookup: visa and sponsorship, salary (UAE and
  Germany), languages, target and excluded roles, locations. Missing today: preferred work mode, excluded
  industries, other dealbreakers; the user supplies them and they are added to the Search section of the
  profile. A must-have is whatever the job posting marks as required; the agent reads it from the job.
- If a fact needed for a hard-blocker check is missing or unclear, the verdict cannot be strong fit; it is
  stretch and the reason says what is unknown.
- Unattended runs never stop for a stretch. The run files strong fits, keeps going, and lists stretches and
  skips in the final table. Stretches are stored with fit_record, shown by ready_list with their verdict,
  and one notify_ready summarizes the run. The user later says file stretch N to file one.
- Resume honesty gate, two layers: (1) each bullet's source quote must be found in the master after
  normalizing case, whitespace and punctuation; (2) every number, tool name and proper noun in a reworded
  bullet must also appear in its source quote, otherwise the bullet is refused. The user reads the resume
  before attaching it; nothing is sent automatically.
- Master resume: one resume for v1. Word, markdown and text must work; PDF is best effort. If extraction
  fails the tool says which format to supply instead.
- A resume file is made only for strong fits (and for a stretch the user asks to file).
- Verdicts expire: the fit log stores a hash of profile.json and fit.md with each verdict; a changed hash
  means the job is judged again.
- Is this for me on a non-job page compares the page with the whole profile (goals, interests, preferences,
  budget); if the profile has nothing relevant the agent says so and does not guess.

## Left to the builder

Master resume text extraction, Word/PDF rendering method (macOS textutil or hand-built), file naming, tests
layout, exact wording of the rubric file within the ASCII rules.

## Open items

- Resume upload inside Easy Apply forms is not possible through the extension today; user attaches manually.
- Germany searches: LinkedIn drops the location parameter, so location judgment in the fit check matters more.
