#!/usr/bin/env node
// Job Watcher CLI: one search cycle per run-once, plus small control commands. Built-ins only.
// Pure decisions live in jobwatch-rules.mjs; files, lock, pause and the Ready page in jobwatch-state.mjs.
// Usage: jobwatch.mjs run-once [--force] | run-now | interval <minutes> | set-tab <id> | status | pause [hours] | resume | mark <id> done|skip|prepare | watch [--no-follow] [--lines N]

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatStreamEvent } from './jobwatch-activity.mjs';
import { writeProfileMd } from './profile-md.mjs';
import { notifyReady } from './notify.mjs';
import {
  buildDiscoverPrompt,
  evaluateJob,
  isQuietHours,
  parseDiscoverResult,
  pickCombos,
  safeJobUrl,
} from './jobwatch-rules.mjs';
import {
  acquireLock,
  activityStamp,
  addSeen,
  appendActivity,
  appendLog,
  readActivityTail,
  DEFAULT_CONFIG,
  INTERVAL_MAX_MINUTES,
  INTERVAL_MIN_MINUTES,
  loadConfig,
  loadQueue,
  loadSeen,
  loadState,
  markItem,
  parseIntervalMinutes,
  pauseStatus,
  rankItems,
  readJson,
  releaseLock,
  saveQueue,
  saveState,
  stateDir,
  writeJson,
  writeReady,
} from './jobwatch-state.mjs';
import { bridgeHomePath } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAFARI_MCP = path.join(HERE, 'safari-mcp.mjs');
const DEFAULT_PORT = 8787;
const STATUS_TIMEOUT_MS = 2000;
const KILL_GRACE_MS = 2000;
const MAX_OUTPUT_CHARS = 5_000_000;
const MAX_LINE_CHARS = 5_000_000;
const NOTIFY_TIMEOUT_MS = 10000;

// Real time unless JOBWATCH_NOW (ISO) is set. Used everywhere "now" is needed.
function nowDate() {
  const raw = process.env.JOBWATCH_NOW;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function bridgePort() {
  const n = Number(process.env.SAFARI_BRIDGE_PORT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT;
}

// Token is read from HOME and never printed or logged.
function readToken() {
  try {
    const token = fs.readFileSync(bridgeHomePath('mcp-token'), 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

// Resolves with the parsed /mcp/status body, or null on any failure.
function bridgeStatus() {
  const token = readToken();
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: bridgePort(),
        path: '/mcp/status',
        headers: { 'x-safari-mcp-token': token },
        timeout: STATUS_TIMEOUT_MS,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 1_000_000) res.destroy();
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(null);
          }
        });
        res.on('close', () => resolve(null));
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function tabShared(status, tabId) {
  return (
    Boolean(status) &&
    status.connected === true &&
    Array.isArray(status.sharedTabs) &&
    status.sharedTabs.some((t) => t && String(t.tabId) === String(tabId))
  );
}

// Notification: argv only, never a shell string and never interpolated into AppleScript.
function notify(title, body) {
  const cmd = process.env.JOBWATCH_NOTIFY_CMD;
  const opts = { timeout: NOTIFY_TIMEOUT_MS, stdio: 'ignore' };
  if (cmd) {
    spawnSync(cmd, [title, body], opts);
  } else {
    spawnSync(
      'osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        '--',
        title,
        body,
      ],
      opts,
    );
  }
}

// Runs the claude binary. Its stdout is newline-delimited JSON: each complete line is parsed and handed to
// onEvent as it arrives, and nothing else is kept except the last {type:"result"} event and a capped stderr.
// Resolves with {code, signal, result, stderr, timedOut} (result is null when no result event came) or {error}.
function runClaude(bin, args, stdinText, cwd, timeoutMs, onEvent) {
  return new Promise((resolve) => {
    let pending = '';
    let result = null;
    let err = '';
    let settled = false;
    let timedOut = false;
    let timer = null;
    let killTimer = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(outcome);
    };

    const handleLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return; // Not a stream event: nothing to show, nothing to keep.
      }
      if (event && typeof event === 'object' && event.type === 'result') result = event;
      if (onEvent) {
        try {
          onEvent(event);
        } catch {
          // A display problem must never stop the run.
        }
      }
    };

    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ error: e.message });
    }

    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let start = 0;
      let nl;
      while ((nl = pending.indexOf('\n', start)) !== -1) {
        handleLine(pending.slice(start, nl));
        start = nl + 1;
      }
      pending = pending.slice(start);
      // A runaway line without a newline is dropped rather than kept in memory.
      if (pending.length > MAX_LINE_CHARS) pending = '';
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < MAX_OUTPUT_CHARS) err += chunk;
    });
    child.stdin.on('error', () => {
      // The child may exit before reading its stdin; the exit code decides the outcome.
    });
    child.on('error', (e) => finish({ error: e.message }));
    child.on('close', (code, signal) => {
      if (pending) handleLine(pending);
      pending = '';
      finish({ code, signal, result, stderr: err, timedOut });
    });
    child.stdin.end(stdinText);
  });
}

// Turns the raw claude run into {result} or {error: short reason}. The result is the final stream event.
function interpretClaude(res, timeoutSeconds) {
  if (res.error) return { error: `claude failed to start: ${res.error}` };
  if (res.timedOut) return { error: `timeout after ${timeoutSeconds} s` };
  if (res.code !== 0) return { error: `claude exited ${res.code ?? res.signal}` };
  const resultEvent = res.result;
  if (!resultEvent || typeof resultEvent !== 'object') return { error: 'claude gave no result' };
  if (resultEvent.is_error === true) return { error: 'claude reported an error' };
  try {
    return { result: parseDiscoverResult(resultEvent.result) };
  } catch (e) {
    return { error: e.message };
  }
}

// Live activity: written to activity.log, and echoed to the terminal when stdout is a TTY.
function activity(dir, line) {
  const now = Date.now();
  appendActivity(dir, line, now);
  if (process.stdout.isTTY) {
    console.log(`${activityStamp(now)} ${String(line).replace(/[\r\n]+/g, ' ')}`);
  }
}

// A skip or error: the runs.log wording, also shown in the activity feed as a === line.
function logRun(dir, line) {
  appendLog(dir, line);
  activity(dir, `=== ${line} ===`);
}

const text = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

function buildItem(job, verdict, nowIso) {
  const safe = safeJobUrl(job.url);
  return {
    id: verdict.id,
    title: text(job.title),
    company: text(job.company),
    location: text(job.location),
    region: job.region === 'uae' || job.region === 'germany' ? job.region : '',
    posted_text: text(job.posted_text),
    applicants: verdict.applicants,
    fit_score: Number.isFinite(job.fit_score) ? job.fit_score : null,
    fit_reason: text(job.fit_reason, 1000),
    url: safe.url,
    status: 'discovered',
    found_at: nowIso,
  };
}

// Setup notices (set-tab / share-tab) repeat at most once per 2 hours.
const SETUP_NOTICE_INTERVAL_MS = 2 * 3600000;

// Sends the notification unless one was sent within the interval. Returns the new
// setup_notice_at value when it notified, else null.
function setupNotice(state, now, body) {
  const last = Date.parse(state.setup_notice_at);
  if (Number.isFinite(last) && now.getTime() - last < SETUP_NOTICE_INTERVAL_MS) return null;
  notify('Job Watch', body);
  return now.toISOString();
}

// One full cycle. The caller holds the lock and releases it.
async function cycle(dir, now, force, skipInterval = false) {
  const nowIso = now.toISOString();
  const config = loadConfig(dir);
  const state = loadState(dir);
  const rotation = Number.isInteger(state.rotation_index) ? state.rotation_index : 0;
  const finishRun = (extra = {}) =>
    saveState(dir, { ...state, ...extra, rotation_index: rotation + 1, last_run: nowIso });

  // Step 2: pause and quiet hours (skipped by --force).
  if (!force) {
    const p = pauseStatus(dir, now);
    if (p.paused) {
      logRun(dir, `skipped: paused (${p.reason})`);
      return;
    }
    if (isQuietHours(now, config.quiet_hours)) {
      logRun(dir, 'skipped: quiet hours');
      return;
    }
  }

  // Step 2b: interval gate (skipped by --force and run-now).
  if (!force && !skipInterval) {
    const last = Date.parse(state.last_run);
    const seconds = Number.isFinite(config.interval_seconds)
      ? config.interval_seconds
      : DEFAULT_CONFIG.interval_seconds;
    const gapMs = seconds * 1000;
    // 60 s slack: launchd ticks every 300 s, so a tick just under the interval must still run.
    if (Number.isFinite(last) && now.getTime() - last < gapMs - 60000) {
      const next = nextRunLabel(last + gapMs, config.quiet_hours.tz);
      logRun(dir, `skipped: interval (next at ${next})`);
      return;
    }
  }

  const profile = readJson(path.join(dir, 'profile.json'), null);
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    logRun(dir, 'error: no profile.json');
    return;
  }

  // Step 3: tab must be set and shared.
  const tab = readJson(path.join(dir, 'tab.json'), null);
  const tabId = tab && typeof tab === 'object' ? tab.tab_id : undefined;
  if (tabId === undefined || tabId === null || tabId === '') {
    const sent = setupNotice(state, now, 'Run jobwatch.mjs set-tab <tab_id> to choose the Job Watch tab.');
    if (sent) saveState(dir, { ...state, setup_notice_at: sent });
    logRun(dir, 'skipped: no tab set');
    return;
  }
  const status = await bridgeStatus();
  if (!tabShared(status, tabId)) {
    const sent = setupNotice(state, now, 'Share the Job Watch tab in Claude for Safari, then run again.');
    if (sent) saveState(dir, { ...state, setup_notice_at: sent });
    logRun(dir, 'skipped: tab not shared');
    return;
  }

  // Step 4: spawn the watcher-only claude run.
  const port = bridgePort();
  writeJson(path.join(dir, 'jobwatch-mcp.json'), {
    mcpServers: {
      safari: {
        command: process.execPath,
        args: [SAFARI_MCP],
        env: {
          SAFARI_MCP_DENY_RISKY: '1',
          SAFARI_MCP_MAX_CALLS: String(config.max_tool_calls),
          SAFARI_BRIDGE_PORT: String(port),
          SAFARI_MCP_SOURCE: 'watcher',
          ...(process.env.JOBWATCH_DIR ? { JOBWATCH_DIR: process.env.JOBWATCH_DIR } : {}),
          ...(process.env.CLAUDE_BRIDGE_HOME ? { CLAUDE_BRIDGE_HOME: process.env.CLAUDE_BRIDGE_HOME } : {}),
          HOME: os.homedir(),
        },
      },
    },
  });
  const combos = pickCombos(profile, rotation, config.combos_per_cycle);
  const { system, user } = buildDiscoverPrompt({
    combos,
    tabId,
    maxJobPages: config.max_job_pages,
    skills: profile.skills,
  });
  activity(dir, `=== cycle start: searching ${combos.map((c) => c.id).join(', ')} ===`);
  const bin = process.env.JOBWATCH_CLAUDE_BIN || 'claude';
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    path.join(dir, 'jobwatch-mcp.json'),
    '--dangerously-skip-permissions',
    '--setting-sources',
    'project',
    '--no-session-persistence',
    '--model',
    config.model_discover,
    '--system-prompt',
    system,
  ];
  const timeoutSeconds = config.run_timeout_seconds;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobwatch-run-'));
  const onEvent = (event) => {
    // Tool calls are logged by safari-mcp.mjs (one line per call), so only the model's words come from the stream.
    for (const line of formatStreamEvent(event, { tools: false })) activity(dir, line);
  };
  let raw;
  try {
    raw = await runClaude(bin, args, user, workDir, timeoutSeconds * 1000, onEvent);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  // Step 5: parse. Any failure is logged, seen and queue stay as they were.
  const parsed = interpretClaude(raw, timeoutSeconds);
  if (parsed.error) {
    logRun(dir, `error: ${parsed.error}`);
    finishRun();
    return;
  }
  const { status: resultStatus, message, jobs } = parsed.result;

  // Step 6: challenge, not shared, and status error.
  if (resultStatus === 'challenge') {
    const hours = config.challenge_pause_hours;
    finishRun({ pause_until: new Date(now.getTime() + hours * ONE_HOUR_MS).toISOString() });
    notify('Job Watch', `Job Watch paused ${hours} h: LinkedIn showed a check.`);
    logRun(dir, `paused ${hours} h: challenge`);
    return;
  }
  if (resultStatus === 'not_shared') {
    const sent = setupNotice(state, now, 'Share the Job Watch tab in Claude for Safari, then run again.');
    logRun(dir, 'skipped: tab not shared');
    finishRun(sent ? { setup_notice_at: sent } : {});
    return;
  }
  if (resultStatus === 'error') {
    logRun(dir, `error: ${text(message, 200) || 'status error'}`);
    finishRun();
    return;
  }
  if (jobs.length === 0) {
    appendLog(dir, 'ok: no postings read');
    activity(dir, '=== cycle end: kept 0, dropped 0 ===');
    finishRun();
    return;
  }

  // Step 7: evaluate every job; keep the good ones; remember every evaluated id.
  const ctx = { profile, seenIds: loadSeen(dir) };
  const keptById = new Map();
  const evaluatedIds = [];
  const dropped = {};
  const diagJobs = [];
  for (const job of jobs) {
    const verdict = evaluateJob(job, ctx);
    // An unconfirmed-filter or unconfirmed-location job is not remembered: it may be fresh and valid in a later, confirmed run.
    if (verdict.id && verdict.reason !== 'filter-unconfirmed' && verdict.reason !== 'location-unconfirmed') evaluatedIds.push(verdict.id);
    diagJobs.push({
      id: verdict.id,
      title: text(job && job.title, 200),
      company: text(job && job.company, 200),
      posted_text: text(job && job.posted_text, 200),
      applicants_text: text(job && job.applicants_text, 200),
      date_filter_confirmed: Boolean(job && job.date_filter_confirmed === true),
      location_confirmed: Boolean(job && job.location_confirmed === true),
      verdict_reason: verdict.reason,
    });
    const j = job && typeof job === 'object' ? job : {};
    const title = text(j.title, 80);
    if (verdict.keep) {
      activity(dir, `KEPT ${title} - ${text(j.company, 80)} (${text(j.posted_text, 80)}, ${text(j.applicants_text, 80)})`);
    } else {
      activity(dir, `dropped (${verdict.reason}) ${title}`);
    }
    if (verdict.keep) {
      if (!keptById.has(verdict.id)) keptById.set(verdict.id, buildItem(job, verdict, nowIso));
    } else {
      dropped[verdict.reason] = (dropped[verdict.reason] || 0) + 1;
    }
  }
  const queue = loadQueue(dir);
  const queuedIds = new Set(queue.map((i) => i.id));
  const newItems = [...keptById.values()].filter((i) => !queuedIds.has(i.id));

  addSeen(dir, evaluatedIds);
  saveQueue(dir, [...queue, ...newItems], now.getTime());
  writeReady(dir);

  writeJson(path.join(dir, 'last-run.json'), { at: nowIso, combos: combos.map((c) => c.id), jobs: diagJobs });

  const dropText = Object.entries(dropped)
    .map(([reason, n]) => `${reason}=${n}`)
    .join(', ');
  appendLog(dir, `ok: kept ${newItems.length}, dropped ${jobs.length - newItems.length}${dropText ? ` (${dropText})` : ''}`);
  activity(dir, `=== cycle end: kept ${newItems.length}, dropped ${jobs.length - newItems.length} ===`);
  if (newItems.length > 0) {
    const best = rankItems(newItems)[0];
    const title = `Job Watch: ${newItems.length} new`;
    const detail = `${best.title} — ${best.company} (${best.location})`;
    if (process.env.JOBWATCH_NOTIFY_CMD) {
      // Test hook: the existing no-real-notification command records argv; no Reminders item is made.
      notify(title, detail);
    } else {
      try {
        const res = await notifyReady(
          { title, detail },
          { reminders: config.reminders, profile, genericTitle: 'Job Watch: new jobs', timeoutMs: 15000 },
        );
        if (res.errors.length > 0) logRun(dir, `notify: mac=${res.mac} reminder=${res.reminder}`);
      } catch (err) {
        logRun(dir, `notify: unexpected: ${err && err.name ? err.name : 'error'}`);
      }
    }
  }

  // Step 8: advance rotation and record the run.
  finishRun();
}

const ONE_HOUR_MS = 3600000;

// Local HH:MM for the next run in the configured zone; UTC if the zone is unknown.
function nextRunLabel(ms, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ms));
  } catch {
    return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
  }
}

// runNow ignores the interval gate only; pause, quiet hours and the lock still apply.
async function runOnce(force, runNow = false) {
  const dir = stateDir();
  const now = nowDate();
  if (!acquireLock(dir, now.getTime())) {
    logRun(dir, 'skipped: another run active');
    if (runNow) {
      process.stderr.write('jobwatch: already running\n');
      return 1;
    }
    return 0;
  }
  try {
    await cycle(dir, now, force, runNow);
  } catch (err) {
    logRun(dir, `error: unexpected: ${err && err.message ? err.message : err}`);
  } finally {
    releaseLock(dir);
  }
  return 0;
}

// Sets the watch interval in whole minutes (5 to 60) and writes interval_seconds to config.json.
function cmdInterval(value) {
  const minutes = parseIntervalMinutes(value);
  if (minutes === null) {
    process.stderr.write(
      `usage: jobwatch.mjs interval <minutes>; minutes must be a whole number from ${INTERVAL_MIN_MINUTES} to ${INTERVAL_MAX_MINUTES}\n`,
    );
    return 2;
  }
  const dir = stateDir();
  const file = path.join(dir, 'config.json');
  const raw = readJson(file, {});
  const current = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  writeJson(file, { ...current, interval_seconds: minutes * 60 });
  console.log(`interval set to ${minutes} minutes`);
  return 0;
}

const MARK_MAP = { done: 'done', skip: 'skipped', prepare: 'prepare' };

function cmdSetTab(value) {
  if (!/^\d+$/.test(String(value ?? ''))) {
    process.stderr.write('usage: jobwatch.mjs set-tab <numeric tab id>\n');
    return 2;
  }
  const dir = stateDir();
  writeJson(path.join(dir, 'tab.json'), { tab_id: Number(value) });
  console.log(`tab set to ${Number(value)}`);
  return 0;
}

// Writes profile.md from profile.json. Prints the path and section count only, never the content.
function cmdProfileMd() {
  try {
    const { file, sections } = writeProfileMd();
    process.stdout.write(`profile.md written: ${file} (${sections} sections)\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

function cmdStatus() {
  const dir = stateDir();
  const now = nowDate();
  const config = loadConfig(dir);
  const state = loadState(dir);
  const tab = readJson(path.join(dir, 'tab.json'), null);
  const p = pauseStatus(dir, now);
  const counts = {};
  for (const item of loadQueue(dir)) {
    const key = typeof item.status === 'string' ? item.status : 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  const countText = Object.keys(counts).length
    ? Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')
    : 'empty';
  console.log(`paused: ${p.paused ? p.reason : 'no'}`);
  if (state.pause_until) console.log(`pause until: ${state.pause_until}`);
  console.log(`quiet hours: ${isQuietHours(now, config.quiet_hours) ? 'yes' : 'no'}`);
  console.log(`interval: ${Math.round(config.interval_seconds / 60)} minutes`);
  console.log(`tab: ${tab && tab.tab_id !== undefined ? tab.tab_id : 'not set'}`);
  console.log(`last run: ${state.last_run ?? 'never'}`);
  console.log(`queue: ${countText}`);
  console.log('live activity: jobwatch.mjs watch');
  return 0;
}

function cmdPause(hoursArg) {
  const hours = hoursArg === undefined ? 6 : Number(hoursArg);
  if (!Number.isFinite(hours) || hours <= 0) {
    process.stderr.write('usage: jobwatch.mjs pause [hours]\n');
    return 2;
  }
  const dir = stateDir();
  const until = new Date(nowDate().getTime() + hours * ONE_HOUR_MS).toISOString();
  saveState(dir, { ...loadState(dir), pause_until: until });
  console.log(`paused until ${until}`);
  return 0;
}

function cmdResume() {
  const dir = stateDir();
  try {
    fs.unlinkSync(path.join(dir, 'off'));
  } catch {
    // No off file.
  }
  saveState(dir, { ...loadState(dir), pause_until: null });
  console.log('resumed');
  return 0;
}

function cmdMark(id, word) {
  const status = MARK_MAP[word];
  if (!id || !status) {
    process.stderr.write('usage: jobwatch.mjs mark <id> done|skip|prepare\n');
    return 2;
  }
  const dir = stateDir();
  if (!markItem(dir, id, status, nowDate().getTime())) {
    process.stderr.write(`unknown job id: ${id}\n`);
    return 1;
  }
  writeReady(dir);
  console.log(`${id} marked ${status}`);
  return 0;
}

const WATCH_USAGE = 'usage: jobwatch.mjs watch [--no-follow] [--lines N]\n';
const POLL_MS = 500;
const ANSI = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};

// Colour for one activity line (only used when stdout is a terminal). Time is dim; KEPT green;
// dropped, error results and Blocked red; === lines bold; [terminal] lines (Safari calls from a terminal) cyan.
function colourLine(line) {
  const m = /^(\d\d:\d\d:\d\d) (.*)$/.exec(line);
  if (!m) return line;
  const [, time, body] = m;
  let style = '';
  if (body.startsWith('KEPT')) style = ANSI.green;
  else if (body.startsWith('dropped') || body.includes('result: Error') || body.includes('Blocked')) style = ANSI.red;
  else if (body.startsWith('===')) style = ANSI.bold;
  else if (body.startsWith('[terminal]')) style = ANSI.cyan;
  return `${ANSI.dim}${time}${ANSI.reset} ${style ? style + body + ANSI.reset : body}`;
}

// Prints the last N lines of activity.log, then follows new lines until Ctrl+C (exit 0).
// Rotation or truncation (the file gets smaller) restarts from the top of the new file.
async function cmdWatch(rest) {
  let follow = true;
  let lines = 30;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--no-follow') {
      follow = false;
    } else if (rest[i] === '--lines') {
      const n = Number(rest[i + 1]);
      if (!Number.isInteger(n) || n < 0) {
        process.stderr.write(WATCH_USAGE);
        return 2;
      }
      lines = n;
      i++;
    } else {
      process.stderr.write(WATCH_USAGE);
      return 2;
    }
  }
  const dir = stateDir();
  const file = path.join(dir, 'activity.log');
  const colour = Boolean(process.stdout.isTTY);
  const show = (line) => console.log(colour ? colourLine(line) : line);

  const tty = follow && Boolean(process.stdin.isTTY);
  if (tty) console.log(KEY_HELP);
  for (const line of readActivityTail(dir, lines)) show(line);
  if (!follow) return 0;

  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch {
    // No log yet: start from the top of the first one.
  }
  let partial = '';
  return new Promise((resolve) => {
    const poll = () => {
      try {
        const size = fs.statSync(file).size;
        if (size < offset) {
          offset = 0;
          partial = '';
        }
        if (size > offset) {
          const buf = Buffer.alloc(size - offset);
          const fd = fs.openSync(file, 'r');
          try {
            fs.readSync(fd, buf, 0, buf.length, offset);
          } finally {
            fs.closeSync(fd);
          }
          offset = size;
          const parts = (partial + buf.toString('utf8')).split('\n');
          partial = parts.pop();
          for (const l of parts) if (l) show(l);
        }
      } catch {
        // The log is missing for now; keep polling.
      }
    };
    const timer = setInterval(poll, POLL_MS);
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (tty) {
        process.stdin.removeListener('data', onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      resolve(0);
    };
    const onKey = (chunk) => {
      for (const ch of String(chunk)) {
        const action = keyAction(ch);
        if (action === 'quit') {
          stop();
          return;
        }
        if (action) runKeyAction(action);
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (tty) {
      process.stdin.setRawMode(true);
      process.stdin.on('data', onKey);
      process.stdin.resume();
    }
  });
}

// Single-key controls for the watch view (TTY only). Pure mapping; Ctrl+C arrives as \u0003 in raw mode.
const KEY_HELP = 'p pause  r resume  n run now  i status  q quit';
export function keyAction(key) {
  switch (key) {
    case 'p':
      return 'pause';
    case 'r':
      return 'resume';
    case 'n':
      return 'run-now';
    case 'i':
      return 'status';
    case 'q':
    case '\u0003':
      return 'quit';
    default:
      return null;
  }
}

// Runs the same command functions as the CLI; pause uses the 2-hour default.
function runKeyAction(action) {
  switch (action) {
    case 'pause':
      cmdPause('2');
      break;
    case 'resume':
      cmdResume();
      break;
    case 'run-now':
      runOnce(false, true).catch((err) => {
        process.stderr.write(`jobwatch: ${err && err.message ? err.message : err}\n`);
      });
      break;
    case 'status':
      cmdStatus();
      break;
    default:
      break;
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'run-once':
      return runOnce(rest.includes('--force'));
    case 'run-now':
      return runOnce(false, true);
    case 'interval':
      return cmdInterval(rest[0]);
    case 'set-tab':
      return cmdSetTab(rest[0]);
    case 'status':
      return cmdStatus();
    case 'pause':
      return cmdPause(rest[0]);
    case 'resume':
      return cmdResume();
    case 'mark':
      return cmdMark(rest[0], rest[1]);
    case 'watch':
      return cmdWatch(rest);
    case 'profile-md':
      return cmdProfileMd();
    default:
      process.stderr.write(
        'usage: jobwatch.mjs run-once [--force] | run-now | interval <minutes> | set-tab <id> | status | pause [hours] | resume | mark <id> done|skip|prepare | watch [--no-follow] [--lines N] | profile-md\n',
      );
      return 2;
  }
}

// Run the CLI only when executed directly, so tests can import keyAction without side effects.
function isEntryPoint() {
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`jobwatch: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 1;
    });
}
