// Job Watcher alerts: a Mac notification plus a Reminders item. Built-ins only.
// All user text travels as osascript argv; the AppleScript source is a module constant and never changes.
// Never throws: every failure is recorded in errors[].

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const GENERIC_TITLE = 'Form ready for your review';
const TITLE_MAX = 80;
const DETAIL_MAX = 160;
const BODY_MAX = 400;
const DEFAULT_TIMEOUT_MS = 30000;
const REMINDER_LIST = 'Claude Ready';

const IDENTIFIER_KEYS = new Set(['name', 'nickname', 'salary', 'visa', 'earliest_start']);
const IDENTIFIER_KEY_RE = /phone|email|address|passport|birth|dob|id$/i;

// Control characters (U+0000-001F, U+007F) become spaces, whitespace collapses, text is trimmed and cut to max characters.
export function sanitiseText(s, max) {
  if (typeof s !== 'string') return '';
  const cleaned = s
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, max).join('');
}

function isSensitiveKey(key) {
  return IDENTIFIER_KEYS.has(key) || IDENTIFIER_KEY_RE.test(key);
}

// String and number leaves under an identifying key (or any ancestor with one), at any depth. Skills, employers, titles etc. are not collected.
export function profileIdentifiers(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return [];
  const found = new Set();
  const walk = (node, sensitive) => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v, sensitive);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, sensitive || isSensitiveKey(key));
      return;
    }
    if (!sensitive) return;
    if (typeof node === 'string' || typeof node === 'number') {
      const text = String(node).trim();
      if (text.length >= 4) found.add(text);
    }
  };
  walk(profile, false);
  return [...found];
}

// Refuses alert text that contains a profile identifier (case-insensitive) by falling back to the generic title.
export function guardAlert(fields, identifiers) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const title = sanitiseText(f.title, TITLE_MAX);
  const detail = sanitiseText(f.detail, DETAIL_MAX);
  const needles = (Array.isArray(identifiers) ? identifiers : [])
    .filter((x) => typeof x === 'string' && x.length > 0)
    .map((x) => x.toLowerCase());
  const haystack = `${title}\n${detail}`.toLowerCase();
  if (needles.some((n) => haystack.includes(n))) {
    return { title: GENERIC_TITLE, detail: '', fellBack: true };
  }
  return { title, detail, fellBack: false };
}

// Constant scripts: identical for every call. Data arrives only as argv items.
const MAC_SCRIPT = [
  'on run argv',
  '  display notification (item 2 of argv) with title (item 1 of argv)',
  'end run',
].join('\n');

const REMINDER_SCRIPT = [
  'on run argv',
  '  set theTitle to item 1 of argv',
  '  set theBody to item 2 of argv',
  '  tell application "Reminders"',
  `    if not (exists list "${REMINDER_LIST}") then make new list with properties {name:"${REMINDER_LIST}"}`,
  `    tell list "${REMINDER_LIST}"`,
  '      make new reminder with properties {name:theTitle, body:theBody, due date:(current date)}',
  '    end tell',
  '  end tell',
  'end run',
].join('\n');

const execFileAsync = promisify(execFile);

// Never rejects. Resolves {code, stderr}.
async function defaultRun(cmd, args, timeoutMs) {
  try {
    const { stderr } = await execFileAsync(cmd, args, { timeout: timeoutMs });
    return { code: 0, stderr: String(stderr || '') };
  } catch (err) {
    const code = typeof err.code === 'number' && err.code !== 0 ? err.code : 1;
    const msg = err.killed ? 'timed out' : String(err.stderr || err.message || 'failed');
    return { code, stderr: sanitiseText(msg, 300) };
  }
}

// Calls run and abandons it after timeoutMs. Always resolves to {code, stderr}.
function callRun(run, cmd, args, timeoutMs) {
  let timer;
  const abandoned = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ code: 1, stderr: 'timed out' }), timeoutMs);
  });
  const attempt = Promise.resolve()
    .then(() => run(cmd, args, timeoutMs))
    .then(
      (r) => ({
        code: r && typeof r.code === 'number' ? r.code : 1,
        stderr: sanitiseText(r && r.stderr, 300),
      }),
      (err) => ({ code: 1, stderr: sanitiseText(err && err.message ? err.message : 'failed', 300) }),
    );
  return Promise.race([attempt, abandoned]).finally(() => clearTimeout(timer));
}

export async function notifyReady(input, opts = {}) {
  const errors = [];
  const o = opts && typeof opts === 'object' ? opts : {};
  const run = typeof o.run === 'function' ? o.run : defaultRun;
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const inp = input && typeof input === 'object' ? input : {};
  const identifiers = profileIdentifiers(o.profile);
  const forceGeneric = o.forceGeneric === true;
  const genericTitle = sanitiseText(o.genericTitle, TITLE_MAX) || GENERIC_TITLE;

  const detailText = sanitiseText(inp.detail, DETAIL_MAX);
  const needs = (Array.isArray(inp.needsYou) ? inp.needsYou : [])
    .map((x) => sanitiseText(x, DETAIL_MAX))
    .filter(Boolean);
  const needsLine = needs.length > 0 ? `Needs you: ${needs.join('; ')}` : '';
  const url = sanitiseText(inp.url, BODY_MAX);

  // Guard with the generic title: forced (fail closed) or on an identifier hit.
  const guard = (fields) => {
    if (forceGeneric) return { title: genericTitle, detail: '', fellBack: true };
    const g = guardAlert(fields, identifiers);
    return g.fellBack ? { title: genericTitle, detail: '', fellBack: true } : g;
  };

  // Mac notification: title and detail guarded.
  const mac = guard({ title: inp.title, detail: detailText });
  const macTitle = mac.title || genericTitle;
  const macPromise = callRun(run, 'osascript', ['-e', MAC_SCRIPT, '--', macTitle, mac.detail], timeoutMs);

  // Reminder: title and combined body guarded; the constant script receives them as argv.
  let reminderGuard = { fellBack: false };
  let remPromise = null;
  if (o.reminders !== false) {
    const combined = [mac.detail, needsLine, url].filter(Boolean).join('\n');
    reminderGuard = guard({ title: inp.title, detail: sanitiseText(combined, BODY_MAX) });
    const remTitle = reminderGuard.title || genericTitle;
    remPromise = callRun(run, 'osascript', ['-e', REMINDER_SCRIPT, '--', remTitle, reminderGuard.detail], timeoutMs);
  }

  // Both run concurrently so the worst case is one timeout; mac error is pushed first.
  const [macResult, remResult] = await Promise.all([macPromise, remPromise]);
  const macOk = macResult.code === 0;
  if (!macOk) errors.push(`mac: ${macResult.stderr || `exit ${macResult.code}`}`);
  let reminder = 'skipped';
  if (remResult) {
    reminder = remResult.code === 0;
    if (!reminder) errors.push(`reminder: ${remResult.stderr || `exit ${remResult.code}`}`);
  }

  return { mac: macOk, reminder, fellBack: mac.fellBack || reminderGuard.fellBack, errors };
}
