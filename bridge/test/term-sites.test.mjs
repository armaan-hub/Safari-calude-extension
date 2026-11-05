// Tests for the extension's pure tab/site logic (extension/term-sites.js) and the
// manifest/bridge wiring from Task 7. Built-ins only. Fictional data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { urlAllowed } from '../sites.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const {
  termHostAllowed,
  termUrlAllowed,
  termPickShareable,
  termOpenAllowed,
} = require(path.join(root, 'extension', 'term-sites.js'));

const SITES = ['linkedin.com'];
const cases = JSON.parse(fs.readFileSync(path.join(here, 'sites-cases.json'), 'utf8'));

test('sites-cases rows: termUrlAllowed matches the expected verdict', () => {
  for (const row of cases) {
    assert.equal(termUrlAllowed(row.url, SITES), row.allowed, row.url);
  }
});

test('sites-cases rows: termUrlAllowed agrees with bridge/sites.mjs urlAllowed', () => {
  for (const row of cases) {
    assert.equal(termUrlAllowed(row.url, SITES), urlAllowed(row.url, SITES), row.url);
  }
});

test('termUrlAllowed refuses non-string, invalid, credentialed and non-https URLs', () => {
  assert.equal(termUrlAllowed(undefined, SITES), false);
  assert.equal(termUrlAllowed(42, SITES), false);
  assert.equal(termUrlAllowed('not a url', SITES), false);
  assert.equal(termUrlAllowed('https://user:pw@linkedin.com/', SITES), false);
  assert.equal(termUrlAllowed('https://user@linkedin.com/', SITES), false);
});

test('termHostAllowed: exact, subdomain, trailing dot, case, bad inputs', () => {
  assert.equal(termHostAllowed('linkedin.com', SITES), true);
  assert.equal(termHostAllowed('WWW.LinkedIn.com.', SITES), true);
  assert.equal(termHostAllowed('evil-linkedin.com', SITES), false);
  assert.equal(termHostAllowed('linkedin.com.evil.test', SITES), false);
  assert.equal(termHostAllowed(null, SITES), false);
  assert.equal(termHostAllowed('linkedin.com', 'linkedin.com'), false);
  assert.equal(termHostAllowed('linkedin.com', ['', 7, 'linkedin.com']), true);
  assert.equal(termHostAllowed('', SITES), false);
});

function tabs(...specs) {
  return specs.map(([id, url]) => (url === undefined ? { id } : { id, url }));
}

test('termPickShareable: zero eligible tabs shares and unshares nothing', () => {
  const r = termPickShareable(
    tabs([1, 'about:blank'], [2, 'https://example.test/'], [3, 'http://linkedin.com/']),
    SITES,
    new Set(),
    10,
  );
  assert.deepEqual(r.share, []);
  assert.deepEqual(r.unshare, []);
  assert.deepEqual(r.skipped, [
    { tabId: 1, reason: 'restricted' },
    { tabId: 2, reason: 'site' },
    { tabId: 3, reason: 'site' },
  ]);
});

test('termPickShareable: 12 eligible tabs with cap 10 shares 10 and cap-skips 2', () => {
  const list = [];
  for (let i = 1; i <= 12; i++) list.push([i, `https://www.linkedin.com/p${i}`]);
  const r = termPickShareable(tabs(...list), SITES, new Set(), 10);
  assert.deepEqual(r.share, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(r.unshare, []);
  assert.deepEqual(r.skipped, [
    { tabId: 11, reason: 'cap' },
    { tabId: 12, reason: 'cap' },
  ]);
});

test('termPickShareable: existing shared tabs count against the cap', () => {
  const list = [];
  for (let i = 1; i <= 5; i++) list.push([i, `https://linkedin.com/${i}`]);
  const shared = new Set([101, 102, 103, 104, 105, 106, 107, 108]);
  const r = termPickShareable(tabs(...list), SITES, shared, 10);
  assert.deepEqual(r.share, [1, 2]);
  assert.deepEqual(r.unshare, []);
  assert.deepEqual(r.skipped, [
    { tabId: 3, reason: 'cap' },
    { tabId: 4, reason: 'cap' },
    { tabId: 5, reason: 'cap' },
  ]);
});

test('termPickShareable: restricted URLs are skipped as restricted', () => {
  const r = termPickShareable(
    tabs(
      [1, 'about:blank'],
      [2, 'safari://x'],
      [3, ''],
      [4, 'file:///x'],
      [5],
      [6, 'safari-web-extension://abc/page.html'],
      [7, 'not a url'],
    ),
    SITES,
    new Set(),
    10,
  );
  assert.deepEqual(r.share, []);
  assert.deepEqual(r.skipped, [
    { tabId: 1, reason: 'restricted' },
    { tabId: 2, reason: 'restricted' },
    { tabId: 3, reason: 'restricted' },
    { tabId: 4, reason: 'restricted' },
    { tabId: 5, reason: 'restricted' },
    { tabId: 6, reason: 'restricted' },
    { tabId: 7, reason: 'restricted' },
  ]);
});

test('termPickShareable: a non-listed https tab is skipped as site', () => {
  const r = termPickShareable(
    tabs([1, 'https://example.test/'], [2, 'https://linkedin.com/in/x']),
    SITES,
    new Set(),
    10,
  );
  assert.deepEqual(r.share, [2]);
  assert.deepEqual(r.skipped, [{ tabId: 1, reason: 'site' }]);
});

test('termPickShareable: toggle-off when every eligible tab is already shared', () => {
  const r = termPickShareable(
    tabs([1, 'https://linkedin.com/a'], [2, 'https://linkedin.com/b'], [3, 'about:blank']),
    SITES,
    new Set([1, 2]),
    10,
  );
  assert.deepEqual(r.share, []);
  assert.deepEqual(r.unshare, [1, 2]);
  assert.deepEqual(r.skipped, [{ tabId: 3, reason: 'restricted' }]);
});

test('termPickShareable: mixed window shares only the unshared eligible tabs', () => {
  const r = termPickShareable(
    tabs(
      [1, 'https://linkedin.com/a'],
      [2, 'https://linkedin.com/b'],
      [3, 'https://evil-linkedin.com/'],
      [4, 'https://linkedin.com/c'],
    ),
    SITES,
    new Set([1]),
    10,
  );
  assert.deepEqual(r.share, [2, 4]);
  assert.deepEqual(r.unshare, []);
  assert.deepEqual(r.skipped, [{ tabId: 3, reason: 'site' }]);
});

test('termPickShareable: ignores tabs without a numeric id', () => {
  const r = termPickShareable(
    [{ url: 'https://linkedin.com/x' }, { id: 'nope', url: 'https://linkedin.com/y' }, { id: 9, url: 'https://linkedin.com/z' }],
    SITES,
    new Set(),
    10,
  );
  assert.deepEqual(r.share, [9]);
  assert.deepEqual(r.skipped, []);
});

test('termOpenAllowed: 4 opens in the last hour is allowed, 5 is not', () => {
  const now = 10_000_000;
  const hour = 3_600_000;
  const four = [now - 1000, now - 2000, now - 3000, now - 4000];
  assert.equal(termOpenAllowed(four, now, 5, hour), true);
  const five = [...four, now - 5000];
  assert.equal(termOpenAllowed(five, now, 5, hour), false);
});

test('termOpenAllowed: entries older than the window do not count', () => {
  const now = 10_000_000;
  const hour = 3_600_000;
  const old = [now - hour - 1, now - hour - 500, now - 2 * hour, now - 3 * hour, now - 4 * hour];
  assert.equal(termOpenAllowed(old, now, 5, hour), true);
  const mixed = [...old, now - 10, now - 20, now - 30, now - 40];
  assert.equal(termOpenAllowed(mixed, now, 5, hour), true);
  assert.equal(termOpenAllowed([now - 10, now - 20, now - 30, now - 40, now - 50], now, 5, hour), false);
});

test('termOpenAllowed: non-array history is treated as empty', () => {
  assert.equal(termOpenAllowed(undefined, 1000, 5, 3600), true);
  assert.equal(termOpenAllowed('x', 1000, 5, 3600), true);
  assert.equal(termOpenAllowed(null, 1000, 5, 3600), true);
});

test('manifest.json parses, loads term-sites.js before background.js, and has share-all', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const scripts = manifest.background.scripts;
  assert.ok(scripts.includes('term-sites.js'));
  assert.ok(scripts.indexOf('term-sites.js') < scripts.indexOf('background.js'));
  assert.equal(manifest.commands['share-all'].suggested_key.default, 'Alt+Shift+A');
  assert.equal(
    manifest.commands['share-all'].description,
    'Share or unshare all tabs in this window with Claude Code',
  );
  assert.ok(manifest.commands['toggle-claude']);
});

test('bridge MCP_TOOLS includes open_tab', () => {
  const src = fs.readFileSync(path.join(root, 'bridge', 'claude-bridge.mjs'), 'utf8');
  const m = src.match(/const MCP_TOOLS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'MCP_TOOLS declaration found');
  assert.match(m[1], /"open_tab"/);
});
