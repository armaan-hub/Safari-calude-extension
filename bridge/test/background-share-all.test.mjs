// Harness test for share-all in extension/background.js: loads term-sites.js and background.js into a node:vm
// context with a fake browser api and fake fetch, then calls the registered "share-all" command listener.
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
const TITLE_RESTRICTED = "Claude can't run on this page — open a normal website";

// Loads both scripts into a fresh context. sitesMode: 'ok' | 'fail' | 'bad' (bad = sites is not an array).
// getOverride: tab id -> what tabs.get returns (a tab that moved after the tab list was read).
function load(tabs, sitesMode = 'ok', getOverride = {}) {
  const calls = [];
  const fetchPaths = [];
  const listeners = {};
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const route = (p, args) => {
    if (p === 'api.windows.getLastFocused') return { id: 7 };
    if (p === 'api.tabs.query') return args[0].windowId === 7 ? tabs : [];
    if (p === 'api.tabs.sendMessage' && args[1]?.type === 'ping') return { pong: true }; // a live page
    if (p === 'api.tabs.get') return args[0] in getOverride ? getOverride[args[0]] : tabs.find((t) => t.id === args[0]);
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
    if (p === '/ext/sites') {
      if (sitesMode === 'fail') throw new Error('bridge unreachable');
      return res(200, { sites: sitesMode === 'bad' ? 'linkedin.com' : ['linkedin.com'] });
    }
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
  vm.runInContext(BG_SRC, ctx, { filename: 'background.js' });
  const run = async (cmd) => {
    for (const fn of listeners['api.commands.onCommand'] || []) await fn(cmd);
    await new Promise((r) => setImmediate(r));
  };
  // termReach pings and termSendShare both send shareState, so ids are de-duplicated and sorted.
  const uniq = (xs) => [...new Set(xs)].sort((a, b) => a - b);
  const sent = (shared) => uniq(calls
    .filter((c) => c.path === 'api.tabs.sendMessage' && c.args[1]?.type === 'shareState' && c.args[1].shared === shared)
    .map((c) => c.args[0]));
  const titles = (tabId) => calls
    .filter((c) => c.path === 'api.action.setTitle' && c.args[0].tabId === tabId).map((c) => c.args[0].title);
  return { run, sent, titles, fetchPaths, calls };
}

const tab = (id, url) => ({ id, url });
const mixed = [
  tab(1, 'https://www.linkedin.com/jobs'), // allowed
  tab(2, 'https://evil-linkedin.com/'), // lookalike: site
  tab(3, 'about:blank'), // restricted
  tab(4, 'http://linkedin.com/'), // http: site
  tab(5, 'https://linkedin.com/'), // allowed
];

test('share-all shares only allowed tabs and badges the skipped ones', async () => {
  const env = load(mixed);
  await env.run('share-all');
  assert.deepEqual(env.sent(true), [1, 5]);
  assert.equal(env.titles(2)[0], 'Claude: not shared (site not allowed)');
  assert.equal(env.titles(4)[0], 'Claude: not shared (site not allowed)');
  assert.equal(env.titles(3)[0], TITLE_RESTRICTED);
});

test('a second share-all unshares the allowed tabs', async () => {
  const env = load(mixed);
  await env.run('share-all');
  await env.run('share-all');
  assert.deepEqual(env.sent(false), [1, 5]);
});

test('a failing /ext/sites fetch shares nothing', async () => {
  const env = load(mixed, 'fail');
  await env.run('share-all');
  assert.deepEqual(env.sent(true), []);
  assert.ok(env.fetchPaths.includes('/ext/sites'));
});

test('a malformed /ext/sites body (sites not an array) shares nothing', async () => {
  const env = load(mixed, 'bad');
  await env.run('share-all');
  assert.deepEqual(env.sent(true), []);
});

test('12 eligible tabs share exactly 10 and badge the other 2 for the cap', async () => {
  const many = Array.from({ length: 12 }, (_, i) => tab(100 + i, `https://www.linkedin.com/p${i}`));
  const env = load(many);
  await env.run('share-all');
  assert.equal(env.sent(true).length, 10);
  const capped = many.map((t) => t.id).filter((id) => !env.sent(true).includes(id));
  assert.equal(capped.length, 2);
  assert.equal(env.titles(capped[0])[0], 'Claude: not shared (cap of 10 tabs reached)');
});

test('a tab that moved off the allowed list after the tab list was read is not shared', async () => {
  const env = load(mixed, 'ok', { 5: tab(5, 'https://evil.test/landing') });
  await env.run('share-all');
  assert.deepEqual(env.sent(true), [1]);
  assert.equal(env.titles(5).at(-1), 'Claude: not shared (site not allowed)');
});

test('a tab whose re-read fails (closed meanwhile) is skipped, not shared', async () => {
  const env = load(mixed, 'ok', { 1: null });
  await env.run('share-all');
  assert.deepEqual(env.sent(true), [5]);
});
