// Harness test for the toolbar icon click in terminal mode (extension/background.js): the click calls
// POST /ext/open-session, then shares the clicked tab if it is not shared yet. It never unshares.
// Loads term-sites.js and background.js into a node:vm context with a fake browser api and fake fetch.
// Built-ins only. Fictional data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '../../extension');
const SITES_SRC = fs.readFileSync(path.join(ext, 'term-sites.js'), 'utf8');
const BG_SRC = fs.readFileSync(path.join(ext, 'background.js'), 'utf8');
const BRIDGE = 'http://127.0.0.1:8787';
const BADGE_TITLE = 'Claude: could not open the session (bridge not reachable)';

// openMode: 'ok' (200 {opened, reason}) | 'errbody' (200 {opened:false, reason:"error: ..."}) | 'already' (opened:false, already open) | 'down' (fetch rejects) | 'http500' (non-200 answer).
// panel: true swaps MODE to "panel" in the loaded source (non-terminal behaviour).
function load(tabs, { openMode = 'ok', panel = false } = {}) {
  const calls = [];
  const fetchPaths = [];
  const openHeaders = [];
  const listeners = {};
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const route = (p, args) => {
    if (p === 'api.windows.getLastFocused') return { id: 7 };
    if (p === 'api.tabs.query') return args[0].windowId === 7 ? tabs : [];
    if (p === 'api.tabs.get') return tabs.find((t) => t.id === args[0]);
    return undefined;
  };
  const make = (p) =>
    new Proxy(function () {}, {
      get(_, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        if (prop === 'addListener') return (fn) => { (listeners[p] ||= []).push(fn); };
        if (prop === 'getURL') return (s = '') => `chrome-extension://test/${s}`;
        return make(`${p}.${String(prop)}`);
      },
      apply(_, __, args) {
        calls.push({ path: p, args });
        return Promise.resolve(route(p, args));
      },
    });
  const api = make('api');
  const fetch = async (url, init = {}) => {
    const p = String(url).replace(BRIDGE, '');
    fetchPaths.push(p);
    if (p === '/ext/open-session') {
      openHeaders.push({ method: init.method, headers: init.headers || {} });
      if (openMode === 'down') throw new Error('bridge unreachable');
      if (openMode === 'http500') return res(500, { error: 'boom' });
      if (openMode === 'errbody') return res(200, { opened: false, reason: 'error: spawn failed' });
      if (openMode === 'nobody') return res(200, { opened: false, reason: 'could not open Terminal (exit 1)' });
      if (openMode === 'already') return res(200, { opened: false, reason: 'already open on screen, skipped' });
      return res(200, { opened: true, reason: 'opened Terminal' });
    }
    if (p === '/ext/sites') return res(200, { sites: ['linkedin.com'] });
    if (p === '/ext/poll') return new Promise(() => {}); // never answers: the poll loop just waits
    return res(200, {});
  };
  // Timers are unref'd so a leftover interval cannot keep the test process alive.
  const unrefTimer = (f, ms, ...a) => { const t = setTimeout(f, ms, ...a); t.unref?.(); return t; };
  const unrefInterval = (f, ms, ...a) => { const t = setInterval(f, ms, ...a); t.unref?.(); return t; };
  const ctx = {
    chrome: api, console, fetch, URL, AbortController,
    setTimeout: unrefTimer, clearTimeout, setInterval: unrefInterval, clearInterval,
  };
  vm.createContext(ctx);
  vm.runInContext(SITES_SRC, ctx, { filename: 'term-sites.js' });
  const src = panel ? BG_SRC.replace('const MODE = "terminal";', 'const MODE = "panel";') : BG_SRC;
  if (panel && src === BG_SRC) throw new Error('MODE line not found in background.js');
  vm.runInContext(src, ctx, { filename: 'background.js' });
  // Clicks the toolbar icon for the given tab and waits for the click's share chain to finish.
  const click = async (tab) => {
    for (const fn of listeners['api.action.onClicked'] || []) await fn(tab);
    await new Promise((r) => setImmediate(r));
  };
  const uniq = (xs) => [...new Set(xs)].sort((a, b) => a - b);
  const sent = (shared) => uniq(calls
    .filter((c) => c.path === 'api.tabs.sendMessage' && c.args[1]?.type === 'shareState' && c.args[1].shared === shared)
    .map((c) => c.args[0]));
  const titles = (tabId) => calls
    .filter((c) => c.path === 'api.action.setTitle' && c.args[0].tabId === tabId).map((c) => c.args[0].title);
  const badges = (tabId) => calls
    .filter((c) => c.path === 'api.action.setBadgeText' && c.args[0].tabId === tabId).map((c) => c.args[0].text);
  return { click, sent, titles, badges, fetchPaths, openHeaders, calls };
}

const tab = (id, url) => ({ id, url });
const linkedin = tab(1, 'https://www.linkedin.com/jobs');

test('icon click calls open-session once and shares an unshared allowed tab', async () => {
  const env = load([linkedin]);
  await env.click(linkedin);
  assert.equal(env.fetchPaths.filter((p) => p === '/ext/open-session').length, 1);
  assert.equal(env.openHeaders[0].method, 'POST');
  assert.equal(env.openHeaders[0].headers['x-claude-bridge'], '1');
  assert.deepEqual(env.sent(true), [1]);
});

test('icon click on an already-shared tab leaves it shared (no unshare)', async () => {
  const env = load([linkedin]);
  await env.click(linkedin);
  await env.click(linkedin);
  assert.equal(env.fetchPaths.filter((p) => p === '/ext/open-session').length, 2);
  assert.deepEqual(env.sent(false), []);
  assert.deepEqual(env.sent(true), [1]);
});

test('bridge down: error badge shown and nothing shared', async () => {
  const env = load([linkedin], { openMode: 'down' });
  await env.click(linkedin);
  assert.deepEqual(env.sent(true), []);
  assert.deepEqual(env.badges(1), ['!']);
  assert.equal(env.titles(1).at(-1), BADGE_TITLE);
});

test('non-200 answer from open-session: error badge and nothing shared', async () => {
  const env = load([linkedin], { openMode: 'http500' });
  await env.click(linkedin);
  assert.deepEqual(env.sent(true), []);
  assert.deepEqual(env.badges(1), ['!']);
  assert.equal(env.titles(1).at(-1), BADGE_TITLE);
});

test('non-terminal MODE still toggles the tab and never calls open-session', async () => {
  const env = load([linkedin], { panel: true });
  await env.click(linkedin);
  assert.equal(env.fetchPaths.filter((p) => p === '/ext/open-session').length, 0);
  assert.ok(
    env.calls.some((c) => c.path === 'api.tabs.sendMessage' && c.args[0] === 1 && c.args[1]?.type !== 'shareState'),
    'expected the page toggle message to be sent to tab 1',
  );
});

test('open-session body opened:false with "error:" reason: terminal badge, nothing shared', async () => {
  const env = load([linkedin], { openMode: 'errbody' });
  await env.click(linkedin);
  assert.deepEqual(env.sent(true), []);
  assert.deepEqual(env.badges(1), ['!']);
  assert.equal(env.titles(1).at(-1), 'Claude: could not open the session (Terminal failed to open)');
});

test('open-session body opened:false "could not open" reason: terminal badge, nothing shared', async () => {
  const env = load([linkedin], { openMode: 'nobody' });
  await env.click(linkedin);
  assert.deepEqual(env.sent(true), []);
  assert.deepEqual(env.badges(1), ['!']);
});

test('open-session body opened:true shares the tab with no error badge', async () => {
  const env = load([linkedin]);
  await env.click(linkedin);
  assert.deepEqual(env.sent(true), [1]);
  assert.ok(!env.titles(1).some((t) => /could not open the session/.test(t)), 'no error badge title');
});

test('open-session body opened:false "already open" still shares the tab', async () => {
  const env = load([linkedin], { openMode: 'already' });
  await env.click(linkedin);
  assert.deepEqual(env.sent(true), [1]);
  assert.ok(!env.titles(1).some((t) => /could not open the session/.test(t)), 'no error badge title');
});
