// Job Watcher state tests. Every test uses its own temp directory. Fictional data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stateDir,
  DEFAULT_CONFIG,
  loadConfig,
  readJson,
  writeJson,
  loadSeen,
  addSeen,
  loadQueue,
  saveQueue,
  markItem,
  loadState,
  saveState,
  pauseStatus,
  acquireLock,
  releaseLock,
  parseIntervalMinutes,
  appendLog,
  appendActivity,
  readActivityTail,
  renderReady,
  rankItems,
  writeReady,
} from '../jobwatch-state.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jw-state-test-'));
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function item(overrides = {}) {
  return {
    id: 'job-1',
    title: 'Power BI Developer',
    company: 'Example Co',
    location: 'Dubai, United Arab Emirates',
    region: 'uae',
    posted_text: '3 hours ago',
    applicants: { tag: 'exact', count: 7 },
    fit_score: 80,
    fit_reason: 'Title and DAX skills match',
    url: 'https://www.linkedin.com/jobs/view/111/',
    sponsorship_mention: false,
    status: 'discovered',
    found_at: '2026-11-03T08:00:00.000Z',
    ...overrides,
  };
}

test('stateDir honours JOBWATCH_DIR and creates it with mode 0700', () => {
  const root = tmpDir();
  const target = path.join(root, 'jw');
  const before = process.env.JOBWATCH_DIR;
  try {
    process.env.JOBWATCH_DIR = target;
    const dir = stateDir();
    assert.equal(dir, target);
    assert.equal(mode(dir), 0o700);
  } finally {
    if (before === undefined) delete process.env.JOBWATCH_DIR;
    else process.env.JOBWATCH_DIR = before;
  }
});

test('loadConfig: missing file returns defaults and does not create the file', () => {
  const dir = tmpDir();
  assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
});

test('loadConfig: invalid interval_seconds falls back to the default; 900 is kept', () => {
  for (const bad of [0, -5, 1e9, '600', 299, 3601, 450.5, null]) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ interval_seconds: bad }));
    assert.equal(loadConfig(dir).interval_seconds, DEFAULT_CONFIG.interval_seconds, `falls back for ${String(bad)}`);
  }
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ interval_seconds: 900 }));
  assert.equal(loadConfig(dir).interval_seconds, 900);
});

test('loadConfig: partial file merges over defaults', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ interval_seconds: 300 }));
  assert.deepEqual(loadConfig(dir), { ...DEFAULT_CONFIG, interval_seconds: 300 });
});

test('readJson: garbage returns fallback, keeps a *.corrupt-* file, does not throw', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, 'not json {{{');
  let value;
  assert.doesNotThrow(() => {
    value = readJson(file, { fallback: true });
  });
  assert.deepEqual(value, { fallback: true });
  const corrupt = fs.readdirSync(dir).filter((f) => f.startsWith('bad.json.corrupt-'));
  assert.equal(corrupt.length, 1);
  assert.equal(fs.existsSync(file), false);
});

test('readJson: missing file returns fallback without creating anything', () => {
  const dir = tmpDir();
  assert.deepEqual(readJson(path.join(dir, 'nope.json'), []), []);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('writeJson then readJson round-trips', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.json');
  writeJson(file, { a: 1, b: ['c'] });
  assert.deepEqual(readJson(file, null), { a: 1, b: ['c'] });
});

test('addSeen then loadSeen round-trips and de-duplicates', () => {
  const dir = tmpDir();
  addSeen(dir, ['a', 'b']);
  addSeen(dir, ['b', 'c']);
  const seen = loadSeen(dir);
  assert.ok(seen instanceof Set);
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);
});

test('loadSeen: garbage seen.json starts fresh and keeps the bad file', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'seen.json'), '{{{ broken');
  assert.equal(loadSeen(dir).size, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('seen.json.corrupt-')));
});

test('loadQueue: garbage queue.json returns an empty list and keeps the bad file', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'queue.json'), '');
  assert.deepEqual(loadQueue(dir), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('queue.json.corrupt-')));
});

test('markItem: unknown id returns false and known id updates status', () => {
  const dir = tmpDir();
  saveQueue(dir, [item({ id: 'j1' })]);
  assert.equal(markItem(dir, 'nope', 'done'), false);
  assert.equal(markItem(dir, 'j1', 'skipped'), true);
  assert.equal(loadQueue(dir)[0].status, 'skipped');
});

test('loadState default and garbage handling', () => {
  const dir = tmpDir();
  assert.deepEqual(loadState(dir), { rotation_index: 0, pause_until: null, last_run: null, setup_notice_at: null });
  fs.writeFileSync(path.join(dir, 'state.json'), 'garbage');
  assert.deepEqual(loadState(dir), { rotation_index: 0, pause_until: null, last_run: null, setup_notice_at: null });
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-')));
});

test('saveState then loadState round-trips', () => {
  const dir = tmpDir();
  saveState(dir, { rotation_index: 3, pause_until: null, last_run: '2026-11-03T08:00:00.000Z', setup_notice_at: '2026-11-03T09:00:00.000Z' });
  assert.equal(loadState(dir).rotation_index, 3);
  assert.equal(loadState(dir).setup_notice_at, '2026-11-03T09:00:00.000Z');
});

test('pauseStatus: off file pauses with reason off-file', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'off'), '');
  assert.deepEqual(pauseStatus(dir, new Date('2026-11-03T12:00:00Z')), {
    paused: true,
    reason: 'off-file',
  });
});

test('pauseStatus: pause_until one hour ahead pauses', () => {
  const dir = tmpDir();
  const now = new Date('2026-11-03T12:00:00Z');
  saveState(dir, {
    rotation_index: 0,
    pause_until: new Date(now.getTime() + 3600_000).toISOString(),
    last_run: null,
  });
  assert.deepEqual(pauseStatus(dir, now), { paused: true, reason: 'pause-until' });
});

test('pauseStatus: pause_until one hour behind does not pause', () => {
  const dir = tmpDir();
  const now = new Date('2026-11-03T12:00:00Z');
  saveState(dir, {
    rotation_index: 0,
    pause_until: new Date(now.getTime() - 3600_000).toISOString(),
    last_run: null,
  });
  assert.equal(pauseStatus(dir, now).paused, false);
});

test('acquireLock: second acquire while the first is live returns false', () => {
  const dir = tmpDir();
  const now = Date.now();
  assert.equal(acquireLock(dir, now), true);
  assert.equal(acquireLock(dir, now), false);
});

test('acquireLock: lock 20 minutes old is taken over', () => {
  const dir = tmpDir();
  const now = Date.now();
  fs.writeFileSync(
    path.join(dir, 'run.lock'),
    JSON.stringify({ pid: process.pid, ts: now - 20 * 60 * 1000 }),
  );
  assert.equal(acquireLock(dir, now), true);
});

test('acquireLock: lock with dead pid 999999 is taken over', () => {
  const dir = tmpDir();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: 999999, ts: now }));
  assert.equal(acquireLock(dir, now), true);
});

test('acquireLock: unreadable lock content is treated as stale', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'run.lock'), '%%%');
  assert.equal(acquireLock(dir, Date.now()), true);
});

test('releaseLock then acquireLock returns true', () => {
  const dir = tmpDir();
  const now = Date.now();
  assert.equal(acquireLock(dir, now), true);
  releaseLock(dir);
  assert.equal(acquireLock(dir, now), true);
});

test('appendLog: a newline inside the line writes exactly one log line', () => {
  const dir = tmpDir();
  appendLog(dir, 'a\nb');
  const lines = fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith(' a b'));
});

test('files are created with mode 0600', () => {
  const dir = tmpDir();
  writeJson(path.join(dir, 'w.json'), { x: 1 });
  assert.equal(mode(path.join(dir, 'w.json')), 0o600);
  addSeen(dir, ['a']);
  assert.equal(mode(path.join(dir, 'seen.json')), 0o600);
  saveQueue(dir, [item()]);
  assert.equal(mode(path.join(dir, 'queue.json')), 0o600);
  saveState(dir, { rotation_index: 0, pause_until: null, last_run: null, setup_notice_at: null });
  assert.equal(mode(path.join(dir, 'state.json')), 0o600);
  appendLog(dir, 'line');
  assert.equal(mode(path.join(dir, 'runs.log')), 0o600);
  acquireLock(dir, Date.now());
  assert.equal(mode(path.join(dir, 'run.lock')), 0o600);
  writeReady(dir);
  assert.equal(mode(path.join(dir, 'ready.html')), 0o600);
});

test('renderReady: escapes hostile title, uses only the safe url, no scripts', () => {
  const html = renderReady([
    item({
      id: 'h1',
      title: '<script>alert(1)</script>',
      company: 'Ex & "Co"',
      fit_reason: '<img src=x onerror=alert(1)>',
      url: 'https://www.linkedin.com/jobs/view/222/',
    }),
  ]);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('Ex &amp; &quot;Co&quot;'));
  assert.ok(html.includes('href="https://www.linkedin.com/jobs/view/222/"'));
});

test('renderReady: a javascript: url never reaches href', () => {
  const html = renderReady([item({ id: 'h2', url: 'javascript:alert(1)' })]);
  assert.equal(html.includes('javascript:'), false);
});

test('renderReady: <25 applicants shows "<25, exact unknown"', () => {
  const html = renderReady([
    item({ id: 'lt', title: 'Beta Role', applicants: { tag: '<25', count: null } }),
  ]);
  assert.ok(html.includes('&lt;25, exact unknown'));
});

test('renderReady: exact-count items come before <25 items even with lower fit_score', () => {
  const html = renderReady([
    item({ id: 'b', title: 'Beta Role', fit_score: 95, applicants: { tag: '<25', count: null } }),
    item({ id: 'a', title: 'Alpha Role', fit_score: 60, applicants: { tag: 'exact', count: 4 } }),
    item({ id: 'g', title: 'Gamma Role', fit_score: 90, applicants: { tag: 'exact', count: 6 } }),
  ]);
  const alpha = html.indexOf('Alpha Role');
  const beta = html.indexOf('Beta Role');
  const gamma = html.indexOf('Gamma Role');
  assert.ok(alpha > -1 && beta > -1 && gamma > -1);
  assert.ok(gamma < alpha, 'higher fit_score first within exact group');
  assert.ok(alpha < beta, 'exact group before <25 group');
});

test('rankItems: exact before <25, fit_score desc, newest first; returns a new array', () => {
  const input = [
    item({ id: 'u1', fit_score: 99, applicants: { tag: '<25', count: null } }),
    item({ id: 'e-low', fit_score: 50, applicants: { tag: 'exact', count: 3 } }),
    item({ id: 'e-old', fit_score: 70, found_at: '2026-11-01T08:00:00.000Z' }),
    item({ id: 'e-new', fit_score: 70, found_at: '2026-11-03T08:00:00.000Z' }),
    item({ id: 'e-high', fit_score: 90 }),
  ];
  const copy = [...input];
  const ranked = rankItems(input);
  assert.deepEqual(ranked.map((i) => i.id), ['e-high', 'e-new', 'e-old', 'e-low', 'u1']);
  assert.notEqual(ranked, input);
  assert.deepEqual(input, copy, 'input not mutated');
});

test('renderReady: shows only discovered and prepare items', () => {
  const html = renderReady([
    item({ id: 'd', title: 'Shown Discovered', status: 'discovered' }),
    item({ id: 'p', title: 'Shown Prepare', status: 'prepare' }),
    item({ id: 'x', title: 'Hidden Done Job', status: 'done' }),
    item({ id: 's', title: 'Hidden Skipped Job', status: 'skipped' }),
  ]);
  assert.ok(html.includes('Shown Discovered'));
  assert.ok(html.includes('Shown Prepare'));
  assert.equal(html.includes('Hidden Done Job'), false);
  assert.equal(html.includes('Hidden Skipped Job'), false);
});

test('renderReady: every row says form not prepared and links use noopener noreferrer', () => {
  const html = renderReady([item({ id: 'r1' })]);
  assert.ok(html.includes('form not prepared'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('<h1'));
  assert.equal(html.includes('<script'), false);
});

test('renderReady: empty queue renders a page without throwing', () => {
  const html = renderReady([]);
  assert.ok(html.includes('<!doctype html>'));
});

test('writeReady writes ready.html from the saved queue', () => {
  const dir = tmpDir();
  saveQueue(dir, [item({ id: 'w1', title: 'Written Role' })]);
  writeReady(dir);
  const html = fs.readFileSync(path.join(dir, 'ready.html'), 'utf8');
  assert.ok(html.includes('Written Role'));
});

// ---------- bounded growth ----------

const CLOCK = Date.parse('2026-11-20T08:00:00.000Z');
const DAY_MS = 86400000;
const isoAgo = (days) => new Date(CLOCK - days * DAY_MS).toISOString();

test('addSeen keeps only the newest 5000 ids, dropping the oldest first', () => {
  const dir = tmpDir();
  const first = Array.from({ length: 4990 }, (_, i) => `id-${i}`);
  addSeen(dir, first);
  assert.equal(loadSeen(dir).size, 4990);
  addSeen(dir, Array.from({ length: 20 }, (_, i) => `new-${i}`));
  const seen = loadSeen(dir);
  assert.equal(seen.size, 5000);
  assert.ok(!seen.has('id-0') && !seen.has('id-9'), 'the 10 oldest ids are gone');
  assert.ok(seen.has('id-10') && seen.has('id-4989'), 'newer ids stay');
  assert.ok(seen.has('new-0') && seen.has('new-19'), 'the new ids stay');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8'));
  assert.ok(Array.isArray(stored), 'seen.json is still a plain array');
  assert.equal(stored[stored.length - 1], 'new-19', 'insertion order is stored');
});

test('addSeen: an existing seen.json with more than 5000 ids is trimmed on the next add', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'seen.json'), JSON.stringify(Array.from({ length: 5200 }, (_, i) => `old-${i}`)));
  addSeen(dir, ['fresh']);
  const seen = loadSeen(dir);
  assert.equal(seen.size, 5000);
  assert.ok(seen.has('fresh') && seen.has('old-5199'));
  assert.ok(!seen.has('old-0') && !seen.has('old-200'));
  assert.ok(seen.has('old-201'));
});

test('saveQueue drops items older than 14 days regardless of status, keeps younger and undated ones', () => {
  const dir = tmpDir();
  saveQueue(
    dir,
    [
      item({ id: 'old-discovered', status: 'discovered', found_at: isoAgo(15) }),
      item({ id: 'old-done', status: 'done', found_at: isoAgo(30) }),
      item({ id: 'edge', found_at: isoAgo(14) }),
      item({ id: 'young', found_at: isoAgo(13) }),
      item({ id: 'undated', found_at: undefined }),
    ],
    CLOCK,
  );
  assert.deepEqual(
    loadQueue(dir).map((i) => i.id),
    ['edge', 'young', 'undated'],
  );
});

test('saveQueue caps at 300 items keeping the newest, preserving order', () => {
  const dir = tmpDir();
  const items = Array.from({ length: 350 }, (_, i) =>
    item({ id: `j-${i}`, found_at: new Date(CLOCK - (350 - i) * 60000).toISOString() }),
  );
  saveQueue(dir, items, CLOCK);
  const q = loadQueue(dir);
  assert.equal(q.length, 300);
  assert.equal(q[0].id, 'j-50');
  assert.equal(q[299].id, 'j-349');
  // The newest are kept even when the array is not in time order.
  const shuffled = [...items].reverse();
  saveQueue(dir, shuffled, CLOCK);
  const ids = new Set(loadQueue(dir).map((i) => i.id));
  assert.equal(ids.size, 300);
  assert.ok(ids.has('j-349') && ids.has('j-50') && !ids.has('j-49'));
});

test('saveQueue: small recent queues are written unchanged', () => {
  const dir = tmpDir();
  const items = [item({ id: 'a', found_at: isoAgo(1) }), item({ id: 'b', found_at: isoAgo(2) })];
  saveQueue(dir, items, CLOCK);
  assert.deepEqual(loadQueue(dir), items);
});

test('appendLog rotates runs.log to runs.log.1 once it is over 1,000,000 bytes', () => {
  const dir = tmpDir();
  const log = path.join(dir, 'runs.log');
  fs.writeFileSync(log, 'x'.repeat(1000001), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'runs.log.1'), 'ancient', { mode: 0o600 });
  appendLog(dir, 'after rotation', CLOCK);
  assert.equal(fs.statSync(path.join(dir, 'runs.log.1')).size, 1000001, 'old runs.log.1 was replaced');
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `${new Date(CLOCK).toISOString()} after rotation`);
  assert.equal(mode(log), 0o600);
  assert.equal(mode(path.join(dir, 'runs.log.1')), 0o600);
});

test('appendLog does not rotate a log of exactly 1,000,000 bytes', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'runs.log'), 'x'.repeat(1000000));
  appendLog(dir, 'still same file', CLOCK);
  assert.ok(!fs.existsSync(path.join(dir, 'runs.log.1')));
  assert.ok(fs.statSync(path.join(dir, 'runs.log')).size > 1000000);
});

// Activity log: HH:MM:SS in Asia/Dubai (UTC+4, no DST), mode 600, rotates over 500,000 bytes.
const ACTIVITY_NOW = Date.parse('2026-11-03T08:05:09Z'); // 12:05:09 in Asia/Dubai

test('appendActivity writes HH:MM:SS in Asia/Dubai time and one line per call', () => {
  const dir = tmpDir();
  appendActivity(dir, 'hello there', ACTIVITY_NOW);
  appendActivity(dir, 'second', ACTIVITY_NOW + 1000);
  const lines = fs.readFileSync(path.join(dir, 'activity.log'), 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines, ['12:05:09 hello there', '12:05:10 second']);
});

test('appendActivity collapses newlines into spaces', () => {
  const dir = tmpDir();
  appendActivity(dir, 'a\nb\r\nc', ACTIVITY_NOW);
  const lines = fs.readFileSync(path.join(dir, 'activity.log'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '12:05:09 a b c');
});

test('appendActivity creates activity.log with mode 600', () => {
  const dir = tmpDir();
  appendActivity(dir, 'private', ACTIVITY_NOW);
  assert.equal(mode(path.join(dir, 'activity.log')), 0o600);
});

test('appendActivity renames a log over 500,000 bytes to activity.log.1 first', () => {
  const dir = tmpDir();
  const log = path.join(dir, 'activity.log');
  fs.writeFileSync(path.join(dir, 'activity.log.1'), 'old');
  fs.writeFileSync(log, 'x'.repeat(500001));
  appendActivity(dir, 'after rotation', ACTIVITY_NOW);
  assert.equal(fs.statSync(path.join(dir, 'activity.log.1')).size, 500001, 'old .1 replaced');
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines, ['12:05:09 after rotation']);
  assert.equal(mode(log), 0o600);
});

test('appendActivity does not rotate a log of exactly 500,000 bytes', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'activity.log'), 'x'.repeat(500000));
  appendActivity(dir, 'same file', ACTIVITY_NOW);
  assert.ok(!fs.existsSync(path.join(dir, 'activity.log.1')));
  assert.ok(fs.statSync(path.join(dir, 'activity.log')).size > 500000);
});

test('readActivityTail returns the last N lines, default 30; [] when there is no log', () => {
  const dir = tmpDir();
  assert.deepEqual(readActivityTail(dir), []);
  for (let i = 1; i <= 40; i++) appendActivity(dir, `line ${i}`, ACTIVITY_NOW);
  const tail = readActivityTail(dir);
  assert.equal(tail.length, 30);
  assert.equal(tail[0], '12:05:09 line 11');
  assert.equal(tail[29], '12:05:09 line 40');
  assert.deepEqual(readActivityTail(dir, 2), ['12:05:09 line 39', '12:05:09 line 40']);
});

test('DEFAULT_CONFIG.interval_seconds is 600', () => {
  assert.equal(DEFAULT_CONFIG.interval_seconds, 600);
});

test('parseIntervalMinutes accepts integers 5 to 60 and rejects everything else', () => {
  assert.equal(parseIntervalMinutes('5'), 5);
  assert.equal(parseIntervalMinutes('10'), 10);
  assert.equal(parseIntervalMinutes('60'), 60);
  assert.equal(parseIntervalMinutes(10), 10, 'whole numbers are accepted too');
  for (const bad of ['4', '3', '61', '90', '7.5', '', 'ten', '-5', '1e2', ' 10', '+5', '10.0', undefined, null]) {
    assert.equal(parseIntervalMinutes(bad), null, `rejects ${String(bad)}`);
  }
});
