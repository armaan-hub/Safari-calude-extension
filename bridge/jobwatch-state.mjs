// Job Watcher: state files, lock, pause and the Ready page. Built-ins only.
// Every file is written with mode 0600. Corrupt files are kept as <name>.corrupt-<epochms>.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeHomePath } from './paths.mjs';

export const DEFAULT_CONFIG = {
  model_discover: 'haiku',
  model_fill: 'sonnet',
  interval_seconds: 600,
  quiet_hours: { start: '23:00', end: '07:00', tz: 'Asia/Dubai' },
  max_job_pages: 25,
  run_timeout_seconds: 720,
  challenge_pause_hours: 6,
  combos_per_cycle: 2,
  max_tool_calls: 400,
  reminders: true,
};

export const INTERVAL_MIN_MINUTES = 5;
export const INTERVAL_MAX_MINUTES = 60;

// Whole minutes in [INTERVAL_MIN_MINUTES, INTERVAL_MAX_MINUTES], else null. Accepts digit strings or integers.
export function parseIntervalMinutes(raw) {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= INTERVAL_MIN_MINUTES && n <= INTERVAL_MAX_MINUTES ? n : null;
}

const DEFAULT_STATE = { rotation_index: 0, pause_until: null, last_run: null, setup_notice_at: null };
const STATUSES = new Set(['discovered', 'done', 'skipped', 'prepare']);
const LOCK_STALE_MS = 900000;
const MAX_SEEN = 5000;
const MAX_QUEUE = 300;
const QUEUE_MAX_AGE_MS = 14 * 86400000;
const LOG_MAX_BYTES = 1000000;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Returns the job-watcher state directory, creating it with mode 0700.
export function stateDir() {
  const dir =
    process.env.JOBWATCH_DIR || bridgeHomePath('jobwatch');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function quarantine(file) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    // Already gone or not renameable: nothing more to keep.
  }
}

// Missing file -> fallback. Unparseable file -> move it aside, return fallback. Never throws.
export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    quarantine(file);
    return fallback;
  }
}

// Atomic write (temp file + rename), mode 0600.
export function writeJson(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

// config.json merged over DEFAULT_CONFIG. The file is never created here.
export function loadConfig(dir) {
  const raw = readJson(path.join(dir, 'config.json'), {});
  const file = isObj(raw) ? raw : {};
  const quiet = isObj(file.quiet_hours)
    ? { ...DEFAULT_CONFIG.quiet_hours, ...file.quiet_hours }
    : { ...DEFAULT_CONFIG.quiet_hours };
  const merged = { ...DEFAULT_CONFIG, ...file, quiet_hours: quiet };
  const sec = merged.interval_seconds;
  if (!Number.isInteger(sec) || sec < 300 || sec > 3600) merged.interval_seconds = DEFAULT_CONFIG.interval_seconds;
  return merged;
}

export function loadSeen(dir) {
  const v = readJson(path.join(dir, 'seen.json'), []);
  return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
}

export function addSeen(dir, ids) {
  const set = loadSeen(dir);
  for (const id of ids) {
    if (typeof id === 'string' && id) set.add(id);
  }
  // Insertion order is the age order: keep the newest MAX_SEEN ids.
  writeJson(path.join(dir, 'seen.json'), [...set].slice(-MAX_SEEN));
}

export function loadQueue(dir) {
  const v = readJson(path.join(dir, 'queue.json'), []);
  return Array.isArray(v) ? v.filter(isObj) : [];
}

function foundAtMs(item) {
  const t = Date.parse(item.found_at);
  return Number.isFinite(t) ? t : null;
}

// Drops items found more than 14 days ago (any status; undated items are kept), then keeps the newest MAX_QUEUE.
export function saveQueue(dir, items, nowMs = Date.now()) {
  let kept = items.filter((i) => {
    const t = foundAtMs(i);
    return t === null || nowMs - t <= QUEUE_MAX_AGE_MS;
  });
  if (kept.length > MAX_QUEUE) {
    const newest = new Set(
      kept
        .map((item, index) => ({ item, index, t: foundAtMs(item) ?? -Infinity }))
        .sort((a, b) => b.t - a.t || b.index - a.index)
        .slice(0, MAX_QUEUE)
        .map((x) => x.item),
    );
    kept = kept.filter((i) => newest.has(i));
  }
  writeJson(path.join(dir, 'queue.json'), kept);
}

// Returns false for an unknown id or an unknown status.
export function markItem(dir, id, status, nowMs = Date.now()) {
  if (!STATUSES.has(status)) return false;
  const items = loadQueue(dir);
  const item = items.find((i) => i.id === id);
  if (!item) return false;
  item.status = status;
  saveQueue(dir, items, nowMs);
  return true;
}

export function loadState(dir) {
  const v = readJson(path.join(dir, 'state.json'), null);
  return isObj(v) ? { ...DEFAULT_STATE, ...v } : { ...DEFAULT_STATE };
}

export function saveState(dir, state) {
  writeJson(path.join(dir, 'state.json'), state);
}

// Paused by the off file, or by a state.pause_until that is still in the future.
export function pauseStatus(dir, now) {
  if (fs.existsSync(path.join(dir, 'off'))) return { paused: true, reason: 'off-file' };
  const { pause_until } = loadState(dir);
  if (pause_until) {
    const until = Date.parse(pause_until);
    if (Number.isFinite(until) && until > now.getTime()) {
      return { paused: true, reason: 'pause-until' };
    }
  }
  return { paused: false, reason: null };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Exclusive create. An existing lock is taken over when it is older than staleMs,
// its pid is dead, or its content is unreadable. Returns false on any other error.
export function acquireLock(dir, nowMs = Date.now(), staleMs = LOCK_STALE_MS) {
  const file = path.join(dir, 'run.lock');
  const body = JSON.stringify({ pid: process.pid, ts: nowMs }) + '\n';
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeSync(fd, body);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
  }
  const cur = readJson(file, null);
  const stale =
    !isObj(cur) ||
    !Number.isFinite(cur.ts) ||
    nowMs - cur.ts > staleMs ||
    !pidAlive(cur.pid);
  if (!stale) return false;
  writeJson(file, { pid: process.pid, ts: nowMs });
  return true;
}

export function releaseLock(dir) {
  try {
    fs.unlinkSync(path.join(dir, 'run.lock'));
  } catch {
    // No lock to release.
  }
}

// One ISO-timestamped line. Newlines inside the message become spaces.
// A runs.log over 1,000,000 bytes is first renamed to runs.log.1 (replacing any older one).
export function appendLog(dir, line, nowMs = Date.now()) {
  const clean = String(line).replace(/[\r\n]+/g, ' ');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'runs.log');
  try {
    if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // No log yet (or not rotatable): just append.
  }
  fs.appendFileSync(file, `${new Date(nowMs).toISOString()} ${clean}\n`, {
    mode: 0o600,
  });
}

const ACTIVITY_MAX_BYTES = 500000;
const DUBAI_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

// HH:MM:SS of an instant in Asia/Dubai, whatever the Mac's own time zone is.
export function activityStamp(nowMs = Date.now()) {
  const parts = Object.fromEntries(DUBAI_CLOCK.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

// One live-activity line: `HH:MM:SS <line>` in Asia/Dubai time, newlines become spaces.
// activity.log over 500,000 bytes is first renamed to activity.log.1 (replacing any older one).
export function appendActivity(dir, line, nowMs = Date.now()) {
  const clean = String(line).replace(/[\r\n]+/g, ' ');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'activity.log');
  try {
    if (fs.statSync(file).size > ACTIVITY_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // No log yet (or not rotatable): just append.
  }
  fs.appendFileSync(file, `${activityStamp(nowMs)} ${clean}\n`, { mode: 0o600 });
}

// The last maxLines lines of activity.log, oldest first. [] when there is no log.
export function readActivityTail(dir, maxLines = 30) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'activity.log'), 'utf8');
  } catch {
    return [];
  }
  const n = Number.isFinite(maxLines) ? Math.max(0, Math.floor(maxLines)) : 30;
  if (n === 0) return [];
  return text.split('\n').filter(Boolean).slice(-n);
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only https LinkedIn URLs become links. Anything else renders as plain text.
function safeHref(url) {
  if (typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.hostname !== 'linkedin.com' && u.hostname !== 'www.linkedin.com') return null;
  return u.href;
}

function applicantsLabel(applicants) {
  const a = isObj(applicants) ? applicants : {};
  if (a.tag === 'exact' && Number.isFinite(a.count)) return `${a.count} applicants`;
  if (a.tag === '<25') return '<25, exact unknown';
  return 'applicants unknown';
}

// Exact-count items first, then fit_score descending, then found_at newest first.
// Returns a new array; the input is not modified.
export function rankItems(items) {
  return [...items].sort((x, y) => {
    const rx = x.applicants && x.applicants.tag === 'exact' ? 0 : 1;
    const ry = y.applicants && y.applicants.tag === 'exact' ? 0 : 1;
    if (rx !== ry) return rx - ry;
    const fx = Number.isFinite(x.fit_score) ? x.fit_score : -Infinity;
    const fy = Number.isFinite(y.fit_score) ? y.fit_score : -Infinity;
    if (fx !== fy) return fy - fx;
    return String(y.found_at ?? '').localeCompare(String(x.found_at ?? ''));
  });
}

const PAGE_STYLE = `
  body { font-family: system-ui, sans-serif; margin: 16px; line-height: 1.4; color: #222; background: #fff; }
  h1 { font-size: 1.4em; margin: 0 0 4px; }
  .updated { color: #555; margin: 0 0 16px; }
  article.job { border: 1px solid #ccc; border-radius: 6px; padding: 10px 12px; margin: 0 0 12px; }
  article.job h2 { font-size: 1.05em; margin: 0 0 4px; }
  article.job p { margin: 4px 0; }
  .meta { color: #555; font-size: 0.9em; }
  .status { font-style: italic; color: #7a4b00; }
`;

// Ready page: discovered and prepare items only. Every dynamic string is escaped.
export function renderReady(items) {
  const shown = rankItems(
    (Array.isArray(items) ? items : [])
      .filter(isObj)
      .filter((i) => i.status === 'discovered' || i.status === 'prepare'),
  );
  const updated = new Date(Date.now()).toISOString();
  const rows = shown
    .map((i) => {
      const href = safeHref(i.url);
      const title = href
        ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a>`
        : esc(i.title);
      return [
        '<article class="job">',
        `<h2>${title}</h2>`,
        `<p>${esc(i.company)} &middot; ${esc(i.location)}</p>`,
        `<p class="meta">${esc(applicantsLabel(i.applicants))} &middot; fit ${esc(i.fit_score)} &middot; ${esc(i.posted_text)}</p>`,
        `<p>${esc(i.fit_reason)}</p>`,
        '<p class="status">form not prepared</p>',
        '</article>',
      ].join('\n');
    })
    .join('\n');
  const body = rows || '<p>No jobs ready yet.</p>';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Job Watcher: Ready</title>',
    `<style>${PAGE_STYLE}</style>`,
    '</head>',
    '<body>',
    `<h1>Ready: ${shown.length} job${shown.length === 1 ? '' : 's'}</h1>`,
    `<p class="updated">Last updated: ${esc(updated)}</p>`,
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export function writeReady(dir) {
  writeFileAtomic(path.join(dir, 'ready.html'), renderReady(loadQueue(dir)));
}
