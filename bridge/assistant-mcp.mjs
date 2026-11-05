#!/usr/bin/env node
// Claude for Safari: assistant MCP server for the terminal session (Task 4, form-prep plan).
// Newline-delimited JSON-RPC 2.0 on stdio, same framing as safari-mcp.mjs. Built-ins only.
// stdout carries JSON-RPC and nothing else; logs go to stderr.
//
// Tools: profile_lookup, ready_list, queue_mark, recent_activity, notify_ready, watcher_control, fit_record, fit_lookup, fit_list, site_note, site_notes, site_request, resume_status, resume_read, resume_build. Never clicks, types or shares anything.
// SAFARI_MCP_SOURCE=watcher (the Job Watcher) gets an empty tool list and every call is refused, before any file is read.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { searchProfile } from "./profile-md.mjs";
import { fitLogFile, getFit, hashRules, listFits, recordFit } from "./fit-store.mjs";
import { noteSite, pendingSites, requestSite, siteNotes, scoutFile } from "./site-scout.mjs";
import { loadSites, normaliseHost } from "./sites.mjs";
import { buildResume, masterStatus, readMasterText, resumeDir } from "./resume-build.mjs";
import { GENERIC_TITLE, notifyReady, profileIdentifiers, sanitiseText } from "./notify.mjs";
import {
  appendActivity,
  loadConfig,
  loadQueue,
  markItem,
  readActivityTail,
  rankItems,
  stateDir,
  writeReady,
} from "./jobwatch-state.mjs";
import { bridgeHomePath } from './paths.mjs';

const DEFAULT_PROTOCOL = "2025-06-18";
const SERVER_INFO = { name: "assistant", version: "0.1.0" };
const WATCHER = process.env.SAFARI_MCP_SOURCE === "watcher";
const PROFILE_FILE =
  process.env.ASSISTANT_PROFILE_FILE || bridgeHomePath("profile.md");
const NO_PROFILE = "No profile.md yet. Ask the user to run: node bridge/jobwatch.mjs profile-md";
const READY_STATUSES = new Set(["discovered", "prepare"]);
const ACTIVITY_LINES_DEFAULT = 40;
const ACTIVITY_LINES_MAX = 200;
const FIT_LIST_DEFAULT = 20;
const FIT_LIST_MAX = 50;
const PROFILE_UNCHECKED_NOTE = " The profile could not be checked, so the generic line was sent instead.";
const ALERT_FALLBACK_NOTE = " The text contained personal details, so the generic line was sent instead.";
// TEST ONLY: when ASSISTANT_OSASCRIPT is set, alerts run that executable (with the same argv) instead of the real
// osascript. The tests use it with a fake script so the real osascript is never run. Normal use leaves it unset.
const OSASCRIPT = process.env.ASSISTANT_OSASCRIPT || "";
// TEST ONLY: when ASSISTANT_TEST_MODE=1 and JOBWATCH_CMD is set, watcher_control runs that executable with the subcommand argv
// instead of jobwatch.mjs. JOBWATCH_CMD alone is ignored, so a stray environment variable cannot redirect the watcher.
const JOBWATCH_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "jobwatch.mjs");
const JOBWATCH_CMD = process.env.ASSISTANT_TEST_MODE === "1" ? process.env.JOBWATCH_CMD || "" : "";
const WATCHER_ACTIONS = ["status", "pause", "resume"];
// Refused without running jobwatch: the Recruiter's interval is fixed at 10 minutes and it cannot be run on demand.
const WATCHER_REFUSED_ACTIONS = ["run_now", "set_interval"];
const WATCHER_REFUSED_TEXT = "Not available. The Recruiter runs every 10 minutes; use status, pause or resume.";
const WATCHER_OUT_MAX = 1500;
const WATCHER_TIMEOUT_MS = 15_000;
const WATCHER_HOURS = { min: 1, max: 24 };
// The fit rubric next to this module. Its text, with the profile text, decides whether a stored fit is still current.
const FIT_RULES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents", "fit.md");

function log(...parts) {
  process.stderr.write(`[assistant-mcp] ${parts.join(" ")}\n`);
}

process.stdout.on("error", () => process.exit(0));

// ---------- live activity feed ----------
// One plain-English line per call in activity.log. Counts and guarded titles only; never section text or the query.
function feedLine(line) {
  try {
    appendActivity(stateDir(), `[terminal] ${line}`);
  } catch {
    // Best effort: an unwritable feed must not change the tool result.
  }
}

// ---------- JSON-RPC output ----------

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---------- tool definitions ----------

const TOOL_DEFS = [
  {
    name: "profile_lookup",
    description:
      "Look up sections of the user's profile (contact, work history, preferences and so on) that match a query. Returns the matching sections only; an empty query returns the section headings. Use it for form answers; never ask the user for details already in the profile.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look up, e.g. 'salary' or 'visa'." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "ready_list",
    description: "List the jobs on the Ready list (id, title, company, location, link, status). No profile data.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "queue_mark",
    description:
      "Mark one Ready-list job by its id as done, skipped or prepare. Refuses unknown ids and other statuses.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, status: { type: "string" } },
      required: ["id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "recent_activity",
    description: `Read the last lines of the Job Watcher activity feed (1 to ${ACTIVITY_LINES_MAX}, default ${ACTIVITY_LINES_DEFAULT}).`,
    inputSchema: {
      type: "object",
      properties: { lines: { type: "integer", description: `How many lines (1 to ${ACTIVITY_LINES_MAX}).` } },
      additionalProperties: false,
    },
  },
  {
    name: "notify_ready",
    description:
      "Send the user a Mac notification and an iPhone reminder that a form is ready for review. Keep personal details out: text that contains one is replaced by a generic line.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: { type: "string" },
        needs_you: { type: "array", items: { type: "string" } },
        url: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "watcher_control",
    description: `Check or change the Recruiter (the Job Watcher). action is one of ${WATCHER_ACTIONS.join(", ")}. hours (pause only, ${WATCHER_HOURS.min} to ${WATCHER_HOURS.max}) is optional. The Recruiter runs every 10 minutes by itself.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: WATCHER_ACTIONS },
        hours: { type: "integer", description: "Pause length in hours." },
        // Accepted only so an old call gets the refusal text; it is never used.
        minutes: { type: "integer", description: "Not supported. Interval changes are refused." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "fit_record",
    description:
      "Store the fit judgment for one job: verdict strong, stretch or no, score 0 to 100, reasons (three to five) and gaps. Never put personal details in reasons or gaps; they are refused.",
    inputSchema: {
      type: "object",
      properties: {
        job_url: { type: "string" },
        title: { type: "string" },
        company: { type: "string" },
        verdict: { type: "string", enum: ["strong", "stretch", "no"] },
        score: { type: "integer", description: "0 to 100." },
        reasons: { type: "array", items: { type: "string" } },
        gaps: { type: "array", items: { type: "string" } },
      },
      required: ["job_url", "title", "company", "verdict", "score", "reasons"],
      additionalProperties: false,
    },
  },
  {
    name: "fit_lookup",
    description:
      "Look up the stored fit judgment for one job URL. Returns the verdict and score, or none when there is no current fit.",
    inputSchema: {
      type: "object",
      properties: { job_url: { type: "string" } },
      required: ["job_url"],
      additionalProperties: false,
    },
  },
  {
    name: "fit_list",
    description: `List stored fit judgments, newest first, numbered from 1: title, company, verdict, score, link, first reason, gap count and a stale marker when the rules changed since. verdict (strong, stretch or no) and limit (1 to ${FIT_LIST_MAX}, default ${FIT_LIST_DEFAULT}) are optional. Use it to pick stretch N.`,
    inputSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["strong", "stretch", "no"] },
        limit: { type: "integer", description: `How many entries (1 to ${FIT_LIST_MAX}).` },
      },
      additionalProperties: false,
    },
  },
  {
    name: "site_note",
    description:
      "Save a note about one job site for a country: host, country, quality 1 to 5 (5 best) and notes (300 characters at most). One note per host; a repeat overwrites it. Never put personal details in notes; they are refused.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        country: { type: "string" },
        quality: { type: "integer", description: "1 to 5." },
        notes: { type: "string" },
      },
      required: ["host", "country", "quality", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "site_notes",
    description: "List the saved notes about job sites for one country, best quality first.",
    inputSchema: {
      type: "object",
      properties: { country: { type: "string" } },
      required: ["country"],
      additionalProperties: false,
    },
  },
  {
    name: "site_request",
    description:
      "Ask the user to allow a job site that is not on the allowed list. Records the request for review; nothing is browsed until the user approves it. Bank and payment sites are refused. Never put personal details in the reason; they are refused.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        country: { type: "string" },
        reason: { type: "string" },
      },
      required: ["host", "country", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "resume_status",
    description:
      "Check whether the master resume is in the resume folder. Returns one line: missing, or present with its format and whether it can be read. Never returns its contents.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "resume_read",
    description:
      "Returns the text of the user's master resume so you can quote it word for word in resume_build. The text is for you only: never print or repeat it to the user, never put it in notifications.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "resume_build",
    description:
      "Build a tailored resume (Word and PDF) from the master resume. Every bullet text must be a reordered or shortened wording of its source, and each source must be a quote copied verbatim from the master resume. New tools, numbers, names or leadership claims are refused, and a refused build writes no file. The user attaches the file to the application themselves.",
    inputSchema: {
      type: "object",
      properties: {
        header: {
          type: "object",
          description: "Name and contact line, both copied from the master resume.",
          properties: {
            name: { type: "string", description: "Full name, exactly as in the master resume." },
            contact: { type: "string", description: "Contact line, segments separated by | or commas." },
          },
          required: ["name", "contact"],
        },
        job_title: { type: "string", description: "Job title from the posting, used in the file name." },
        company: { type: "string", description: "Company name, used in the file name." },
        summary: { type: "string", description: "One-line summary of the candidate for this role." },
        skills: { type: "array", items: { type: "string" }, description: "Skills to list, from the master resume." },
        experience: {
          type: "array",
          items: {
            type: "object",
            description: "One job: role, company, dates and bullets.",
            properties: {
              role: { type: "string", description: "Job title as in the master resume." },
              company: { type: "string", description: "Employer as in the master resume." },
              dates: { type: "string", description: "Dates as in the master resume." },
              bullets: {
                type: "array",
                description: "Bullets for this job, each with its source quote.",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string", description: "The bullet: reordered or shortened wording of the source." },
                    source: { type: "string", description: "A verbatim quote from the master resume." },
                  },
                  required: ["text", "source"],
                },
              },
            },
            required: ["role", "company", "dates", "bullets"],
          },
        },
        education: {
          type: "array",
          items: {
            type: "object",
            description: "One education line with its source quote.",
            properties: {
              text: { type: "string", description: "The education line, as in the master resume." },
              source: { type: "string", description: "A verbatim quote from the master resume." },
            },
            required: ["text", "source"],
          },
        },
        keywords_used: { type: "array", items: { type: "string" }, description: "Job keywords the resume uses." },
        job_keywords: { type: "array", items: { type: "string" }, description: "Keywords from the job posting, checked for gaps." },
      },
      required: ["header", "job_title", "company", "summary", "skills", "experience", "education", "keywords_used", "job_keywords"],
      additionalProperties: false,
    },
  },
];

const TOOL_BY_NAME = new Map(TOOL_DEFS.map((t) => [t.name, t]));

// Checks types, required keys and unknown keys against the schema. Returns an error message, or null.
function validate(name, args) {
  const schema = TOOL_BY_NAME.get(name).inputSchema;
  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) return `${key} is not a valid argument for ${name}.`;
  }
  for (const key of schema.required || []) {
    if (args[key] === undefined) return `${key} is required.`;
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const v = args[key];
    if (v === undefined) continue;
    if (spec.type === "string" && typeof v !== "string") return `${key} must be a string.`;
    if (spec.type === "integer" && !Number.isInteger(v)) return `${key} must be an integer.`;
    if (spec.type === "object" && !isPlainObject(v)) return `${key} must be an object.`;
    if (spec.type === "array") {
      const objects = spec.items?.type === "object";
      if (!Array.isArray(v)) return `${key} must be a list.`;
      if (objects ? !v.every(isPlainObject) : v.some((x) => typeof x !== "string")) {
        return objects ? `${key} must be a list of objects.` : `${key} must be a list of strings.`;
      }
    }
  }
  if (name === "resume_build") {
    for (const job of args.experience ?? []) {
      if (!Array.isArray(job.bullets) || !job.bullets.every(isPlainObject)) return "experience bullets must be a list of objects.";
    }
  }
  return null;
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------- results ----------

function errorResult(message) {
  const text = message.startsWith("Error:") ? message : `Error: ${message}`;
  return { content: [{ type: "text", text }], isError: true };
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// ---------- tools ----------

// Runs jobwatch with an argument array (never a shell string). Never rejects.
function runJobwatch(subArgs) {
  const [cmd, argv] = JOBWATCH_CMD ? [JOBWATCH_CMD, subArgs] : [process.execPath, [JOBWATCH_SCRIPT, ...subArgs]];
  return new Promise((resolve) => {
    execFile(cmd, argv, { timeout: WATCHER_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout: String(stdout) });
      resolve({ ok: false, stdout: String(stdout || ""), stderr: String(stderr || err.message) });
    });
  });
}

async function watcherControl(args) {
  const action = args.action;
  // Refused before any jobwatch call, whatever else the arguments say.
  if (WATCHER_REFUSED_ACTIONS.includes(action)) return textResult(WATCHER_REFUSED_TEXT);
  if (!WATCHER_ACTIONS.includes(action)) return errorResult(`action must be one of ${WATCHER_ACTIONS.join(", ")}.`);
  if (action !== "pause" && args.hours !== undefined) return errorResult("hours is only valid with pause.");
  if (args.minutes !== undefined) return errorResult("minutes is not supported by watcher_control.");

  let sub;
  if (action === "pause") {
    sub = ["pause"];
    if (args.hours !== undefined) {
      const h = args.hours;
      if (!Number.isInteger(h) || h < WATCHER_HOURS.min || h > WATCHER_HOURS.max) {
        return errorResult(`hours must be a whole number from ${WATCHER_HOURS.min} to ${WATCHER_HOURS.max}.`);
      }
      sub.push(String(h));
    }
  } else {
    sub = [{ status: "status", resume: "resume" }[action]];
  }

  const r = await runJobwatch(sub);
  const out = r.stdout.trim().slice(0, WATCHER_OUT_MAX);
  feedLine(`watcher ${action}${r.ok ? "" : " (failed)"}`);
  if (!r.ok) {
    log("watcher_control failed:", r.stderr.trim().slice(0, 200));
    return errorResult(`The Job Watcher did not complete the request.${out ? ` ${out}` : ""}`);
  }
  return textResult(out || "The Job Watcher returned no output.");
}

function profileLookup(query) {
  let md = "";
  try {
    md = fs.readFileSync(PROFILE_FILE, "utf8");
  } catch {
    md = "";
  }
  if (md.trim() === "") {
    feedLine("profile lookup (0 sections)");
    return textResult(NO_PROFILE);
  }
  const found = searchProfile(md, query);
  feedLine(`profile lookup (${found.sections.length} sections)`);
  if (found.sections.length === 0) return textResult(found.note || "No matching section.");
  const body = found.sections.map((s) => `## ${s.heading}\n${s.text}`).join("\n\n");
  return textResult(found.truncated ? `${body}\n(truncated)` : body);
}

// Hash of the profile text and the fit rubric. A stored fit counts only while this matches the hash it was recorded with.
function fitRulesHash() {
  let profile = "";
  let rubric = "";
  try {
    profile = fs.readFileSync(PROFILE_FILE, "utf8");
  } catch {
    profile = "";
  }
  try {
    rubric = fs.readFileSync(FIT_RULES_FILE, "utf8");
  } catch {
    rubric = "";
  }
  return hashRules(profile, rubric);
}

function fitRecord(args) {
  const r = recordFit(
    {
      job_url: args.job_url,
      title: args.title,
      company: args.company,
      verdict: args.verdict,
      score: args.score,
      reasons: args.reasons,
      gaps: args.gaps,
    },
    { file: fitLogFile(), rulesHash: fitRulesHash() },
  );
  if (!r.ok) return errorResult(r.error);
  feedLine("fit recorded");
  return textResult("Stored.");
}

function fitLookup(args) {
  const fit = getFit(args.job_url, { file: fitLogFile(), rulesHash: fitRulesHash() });
  feedLine("fit lookup");
  return textResult(fit ? `${fit.verdict} ${fit.score}` : "none");
}

// Stored fits, newest first and numbered from 1, so "stretch N" always names the same entry. Stored fields only.
function fitListTool(args) {
  const verdict = args.verdict;
  if (verdict !== undefined && !["strong", "stretch", "no"].includes(verdict)) {
    return errorResult("verdict must be strong, stretch or no.");
  }
  const limit = Math.min(FIT_LIST_MAX, Math.max(1, args.limit === undefined ? FIT_LIST_DEFAULT : args.limit));
  feedLine("fit list");
  const all = listFits({ file: fitLogFile(), verdict });
  if (all.length === 0) return textResult(verdict ? `No stored ${verdict} fits.` : "No stored fits.");
  const oneLine = (v) => sanitiseText(typeof v === "string" ? v : "", 300);
  const rulesHash = fitRulesHash();
  // The log appends in time order, so reversing gives newest first; the stable sort keeps that order on equal times.
  const sorted = [...all].reverse().sort((a, b) => String(b.recorded_at ?? "").localeCompare(String(a.recorded_at ?? "")));
  const lines = sorted.slice(0, limit).map((e, i) => {
    const gaps = Array.isArray(e.gaps) ? e.gaps.length : 0;
    const reason = Array.isArray(e.reasons) && e.reasons.length > 0 ? oneLine(e.reasons[0]) : "none";
    const parts = [oneLine(e.title), oneLine(e.company), `${oneLine(e.verdict)} ${Number.isInteger(e.score) ? e.score : "?"}`, oneLine(e.job_url), `reason: ${reason}`, `gaps: ${gaps}`];
    return `${i + 1}. ${parts.join(" — ")}${e.rules_hash === rulesHash ? "" : " | stale (rules changed, judge again before filing)"}`;
  });
  const more = sorted.length > lines.length ? `\n(${sorted.length - lines.length} more not shown)` : "";
  return textResult(lines.join("\n") + more);
}

function readyList() {
  feedLine("read the Ready list");
  const items = rankItems(loadQueue(stateDir()).filter((i) => READY_STATUSES.has(i.status)));
  if (items.length === 0) return textResult("The Ready list is empty.");
  const oneLine = (v) => sanitiseText(typeof v === "string" ? v : "", 300);
  const rulesHash = fitRulesHash();
  const lines = items.map((i) => {
    const base = [i.id, i.title, i.company, i.location, i.url, i.status].map(oneLine).join(" — ");
    const fit = typeof i.url === "string" ? getFit(i.url, { file: fitLogFile(), rulesHash }) : null;
    return fit ? `${base} | fit: ${fit.verdict} ${fit.score}` : base;
  });
  return textResult(lines.join("\n"));
}

const MARK_STATUSES = new Set(["done", "skipped", "prepare"]);

// Marks one queue item by id, then rewrites ready.html so it matches. Unknown id leaves the queue unchanged.
function queueMark(args) {
  if (!MARK_STATUSES.has(args.status)) return textResult("Status must be done, skipped or prepare.");
  const dir = stateDir();
  if (!markItem(dir, args.id, args.status)) return textResult("Unknown job id.");
  writeReady(dir);
  feedLine(`queue marked ${args.status}`);
  return textResult(`Marked ${args.id} as ${args.status}.`);
}

function recentActivity(args) {
  let n = args.lines === undefined ? ACTIVITY_LINES_DEFAULT : args.lines;
  n = Math.min(ACTIVITY_LINES_MAX, Math.max(1, n));
  feedLine("read the activity feed");
  const lines = readActivityTail(stateDir(), n);
  return textResult(lines.length === 0 ? "The activity feed is empty." : lines.join("\n"));
}

// Runs the test-only executable with the given argv. Never rejects; resolves {code, stderr}.
function runOverride(_cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(OSASCRIPT, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (!err) return resolve({ code: 0, stderr: "" });
      resolve({ code: typeof err.code === "number" && err.code !== 0 ? err.code : 1, stderr: String(stderr || err.message) });
    });
  });
}

async function notifyTool(args) {
  const dir = stateDir();
  // Read-only: never renames or writes profile.json. Unreadable or non-object means fail closed (generic line).
  let profile = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "profile.json"), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) profile = parsed;
  } catch {
    profile = null;
  }
  const config = loadConfig(dir);
  const opts = { profile, reminders: config.reminders !== false };
  if (profile === null) opts.forceGeneric = true;
  if (OSASCRIPT) opts.run = runOverride;
  const r = await notifyReady(
    { title: args.title, detail: args.detail, needsYou: args.needs_you, url: args.url },
    opts,
  );
  const macText = r.mac ? "ok" : "failed";
  const remText = r.reminder === "skipped" ? "skipped" : r.reminder === true ? "ok" : "failed";
  let text = `Alert sent (Mac: ${macText}, iPhone Reminder: ${remText}).`;
  if (r.fellBack) text += profile === null ? PROFILE_UNCHECKED_NOTE : ALERT_FALLBACK_NOTE;
  if (r.errors.length > 0) text += ` Errors: ${r.errors.join("; ")}`;
  const titleForLog = r.fellBack ? GENERIC_TITLE : sanitiseText(args.title, 80);
  feedLine(`ready alert sent: ${titleForLog}`);
  return textResult(text);
}

function siteNoteTool(args) {
  const r = noteSite(
    { host: args.host, country: args.country, quality: args.quality, notes: args.notes },
    { file: scoutFile() },
  );
  if (!r.ok) return errorResult(r.error);
  feedLine("site note saved");
  return textResult("Site note saved.");
}

function siteNotesTool(args) {
  const notes = siteNotes(args.country, { file: scoutFile() });
  feedLine("site notes read");
  if (notes.length === 0) return textResult("No notes for that country.");
  return textResult(notes.map((n) => `${n.host} (quality ${n.quality}): ${n.notes}`).join("\n"));
}

// Records the request; when it is pending, sends a generic alert (no host in the text). Already-allowed hosts get no alert.
async function siteRequestTool(args) {
  // A host that is already pending is recorded again quietly: the user was alerted the first time.
  const host = normaliseHost(args.host);
  const wasPending = host ? pendingSites({ file: scoutFile() }).some((p) => p.host === host) : false;
  const r = requestSite(
    { host: args.host, country: args.country, reason: args.reason },
    { file: scoutFile(), allowed: loadSites() },
  );
  if (!r.ok) return errorResult(r.error);
  if (r.status === "already-allowed") {
    feedLine("site request: already allowed");
    return textResult("That site is already allowed.");
  }
  if (wasPending) {
    feedLine("site request already pending");
    return textResult("Site request recorded; it is pending approval.");
  }
  await notifyTool({
    title: "Site approval needed",
    detail: "Open the bridge terminal and run the pending command to review site requests.",
  });
  feedLine("site request recorded");
  return textResult("Site request recorded; it is pending approval.");
}

// Reports only whether a master resume exists, its format and whether it reads. Never returns contents or names.
function resumeStatusTool() {
  const s = masterStatus({ dir: resumeDir() });
  feedLine("resume status checked");
  if (!s.present) return textResult("master resume: missing");
  return textResult(`master resume: present (${s.format}), readable: ${s.readable ? "yes" : "no"}`);
}

// Returns the master resume text for the model to quote from, capped at 20000 characters. Never printed to the user.
const RESUME_READ_LIMIT = 20000;
function resumeReadTool() {
  const dir = resumeDir();
  const text = readMasterText({ dir });
  feedLine("resume read");
  if (text === null) {
    const s = masterStatus({ dir });
    if (!s.present) return textResult("master resume: missing. Supply a Word or text copy of your resume in the resume folder.");
    return textResult("master resume: present but not readable. Supply a Word or text copy of your resume in the resume folder.");
  }
  if (text.length <= RESUME_READ_LIMIT) return textResult(text);
  return textResult(`${text.slice(0, RESUME_READ_LIMIT)}\ntext cut at ${RESUME_READ_LIMIT} characters`);
}

// Replaces every bullet, education line, contact text and personal-looking summary, date or skill in a builder message, so a refusal never echoes them.
function scrubEcho(message, args) {
  const always = [args.header?.contact];
  // Summary, dates and skills are removed only when they hold a digit or @ (possible personal values), so plain
  // skill names stay readable in a refusal.
  const personal = [args.summary];
  for (const job of args.experience ?? []) {
    personal.push(job?.dates);
    for (const b of Array.isArray(job?.bullets) ? job.bullets : []) always.push(b?.text);
  }
  for (const e of args.education ?? []) always.push(e?.text);
  for (const k of args.skills ?? []) personal.push(k);
  const pieces = [...always, ...personal.filter((p) => typeof p === "string" && /[\d@]/.test(p))];
  let out = String(message ?? "");
  for (const p of pieces) {
    if (typeof p === "string" && p.trim()) out = out.split(p).join("[text removed]");
  }
  return out;
}

function resumeBuildTool(args) {
  const r = buildResume(args, { dir: resumeDir() });
  if (!r.ok) {
    feedLine("resume build refused");
    return errorResult(scrubEcho(r.error, args));
  }
  if (!r.docx) {
    feedLine("resume build failed");
    return errorResult(scrubEcho(r.error ?? "The Word file was not made.", args));
  }
  feedLine("resume built");
  const pdfLine = r.pdf ? `PDF file: ${r.pdf}` : `PDF file not made: ${scrubEcho(r.pdfError ?? "unknown error", args)}`;
  const gapLine = r.gaps.length > 0 ? `job keywords not in your resume: ${r.gaps.join(", ")}` : "none";
  return textResult([`Resume built. Word file: ${r.docx}`, pdfLine, `gaps: ${gapLine}`].join("\n"));
}

async function runTool(name, args) {
  const bad = validate(name, args);
  if (bad) return errorResult(bad);
  try {
    switch (name) {
      case "profile_lookup":
        return profileLookup(args.query);
      case "ready_list":
        return readyList();
      case "queue_mark":
        return queueMark(args);
      case "recent_activity":
        return recentActivity(args);
      case "notify_ready":
        return await notifyTool(args);
      case "watcher_control":
        return await watcherControl(args);
      case "fit_record":
        return fitRecord(args);
      case "fit_lookup":
        return fitLookup(args);
      case "fit_list":
        return fitListTool(args);
      case "site_note":
        return siteNoteTool(args);
      case "site_notes":
        return siteNotesTool(args);
      case "site_request":
        return await siteRequestTool(args);
      case "resume_status":
        return resumeStatusTool();
      case "resume_read":
        return resumeReadTool();
      case "resume_build":
        return resumeBuildTool(args);
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (e) {
    log("tool error:", e && e.message);
    return errorResult("The assistant tool failed. Check the activity feed.");
  }
}

// ---------- JSON-RPC dispatch ----------

async function onRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: WATCHER ? [] : TOOL_DEFS });
    case "tools/call": {
      const name = params?.name;
      // Watcher mode: every call is refused before any argument is read or any file is touched.
      if (WATCHER || typeof name !== "string" || !TOOL_BY_NAME.has(name)) {
        return fail(id, -32602, `Unknown tool: ${name}`);
      }
      const args = params.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return fail(id, -32602, "arguments must be an object");
      }
      return reply(id, await runTool(name, args));
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return fail(null, -32700, "Parse error");
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return fail(null, -32600, "Invalid Request");
  if (typeof msg.method !== "string") {
    if (msg.id !== undefined) fail(msg.id, -32600, "Invalid Request");
    return;
  }
  // Notifications (no id, e.g. notifications/initialized) get no reply.
  if (!("id" in msg)) return;
  onRequest(msg).catch((e) => {
    log("handler error:", e.message);
    fail(msg.id, -32603, "Internal error");
  });
});

log(`ready${WATCHER ? " (watcher: no tools)" : ""}`);
