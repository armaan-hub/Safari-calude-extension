// Harness test for open_tab and the navigate allowed-list check in extension/background.js (terminal mode).
// Loads term-sites.js and background.js into a node:vm context with a fake browser api, a fake bridge
// (/ext/poll hands out commands, /ext/result records answers) and a controllable clock.
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
const BLOCKED = "Blocked: this site is not on the user's allowed list. Ask the user to run: node bridge/sites.mjs add";

const OPENER = { id: 1, windowId: 7, index: 3, url: 'https://www.linkedin.com/feed', status: 'complete' };

// tabs: initial tab list (the opener is tab 1). opts.createStatus: status of new tabs ('complete' or 'loading').
// opts.redirectTo: a new tab ends up at this URL (simulates a redirect after it is opened).
// opts.redirectAfterShare: a new tab moves to this URL once the content script is first contacted (a late redirect).
// opts.navigateRedirectTo: tabs.update (navigate) lands the tab on this URL instead.
// opts.storage: a Map used as the extension storage; pass the same Map to a second load() to simulate a restart.
function load(tabs = [OPENER], opts = {}) {
  const calls = [];
  const listeners = {};
  const results = [];
  const queue = [];
  let pollResolve = null;
  let sitesMode = 'ok';
  let nextId = 100;
  const clock = { t: 1700000000000 };
  const tabsDb = new Map(tabs.map((t) => [t.id, { ...t }]));
  const store = opts.storage ?? new Map();

  class FakeDate extends Date {
    static now() {
      return clock.t;
    }
  }

  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const route = (p, args) => {
    if (p === 'api.windows.getLastFocused') return { id: 7 };
    if (p === 'api.tabs.query') return args[0].windowId === 7 ? [...tabsDb.values()].filter((t) => t.windowId === 7 && (!args[0].active || t.active)) : [];
    if (p === 'api.tabs.get') return tabsDb.has(args[0]) ? tabsDb.get(args[0]) : Promise.reject(new Error('no such tab'));
    if (p === 'api.storage.session.get' || p === 'api.storage.local.get') {
      const k = typeof args[0] === 'string' ? args[0] : null;
      return k && store.has(k) ? { [k]: JSON.parse(store.get(k)) } : {};
    }
    if (p === 'api.storage.session.set' || p === 'api.storage.local.set') {
      for (const [k, v] of Object.entries(args[0])) store.set(k, JSON.stringify(v));
      return undefined;
    }
    if (p === 'api.tabs.sendMessage' && opts.redirectAfterShare && args[0] >= 100 && tabsDb.has(args[0])) {
      tabsDb.get(args[0]).url = opts.redirectAfterShare;
      return args[1]?.type === 'ping' ? { pong: true } : undefined;
    }
    if (p === 'api.tabs.sendMessage' && args[1]?.type === 'ping') return { pong: true }; // a live page
    if (p === 'api.tabs.update' && tabsDb.has(args[0]) && args[1]?.url) {
      const id = args[0];
      tabsDb.get(id).url = opts.navigateRedirectTo ?? args[1].url;
      // The navigation "finishes" a little later, once the extension is listening for it.
      const t = setTimeout(() => {
        for (const fn of listeners['api.tabs.onUpdated'] || []) fn(id, { status: 'complete' });
      }, 25);
      t.unref?.();
      return undefined;
    }
    if (p === 'api.tabs.create') {
      const o = args[0];
      const id = nextId++;
      const t = {
        id, windowId: o.windowId, index: o.index, active: o.active,
        url: opts.redirectTo ?? o.url, status: opts.createStatus ?? 'complete',
      };
      tabsDb.set(id, t);
      return t;
    }
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
        try {
          return Promise.resolve(route(p, args));
        } catch (e) {
          return Promise.reject(e);
        }
      },
    });
  const api = make('api');

  const fetch = async (url, init = {}) => {
    const p = String(url).replace(BRIDGE, '');
    if (p === '/ext/sites') {
      if (sitesMode === 'fail') throw new Error('bridge unreachable');
      return res(200, { sites: sitesMode === 'bad' ? 'linkedin.com' : ['linkedin.com'] });
    }
    if (p === '/ext/poll') {
      if (queue.length) return res(200, queue.shift());
      return new Promise((r) => { pollResolve = r; }); // answered when a command is sent
    }
    if (p === '/ext/result') {
      results.push(JSON.parse(init.body));
      return res(200, {});
    }
    return res(200, {});
  };
  // Timers up to 1 s fire at once (the 250 ms poll and the navigate pauses); the bridge timers keep their length.
  const fastTimer = (f, ms, ...a) => { const t = setTimeout(f, ms <= 1000 ? 0 : ms, ...a); t.unref?.(); return t; };
  const unrefInterval = (f, ms, ...a) => { const t = setInterval(f, ms, ...a); t.unref?.(); return t; };
  const ctx = {
    chrome: api, console, fetch, URL, AbortController, Date: FakeDate,
    setTimeout: fastTimer, clearTimeout, setInterval: unrefInterval, clearInterval,
  };
  vm.createContext(ctx);
  vm.runInContext(SITES_SRC, ctx, { filename: 'term-sites.js' });
  vm.runInContext(BG_SRC, ctx, { filename: 'background.js' });

  const tick = () => new Promise((r) => setTimeout(r, 2));
  const waitFor = async (fn, what) => {
    for (let i = 0; i < 3000; i++) {
      const v = fn();
      if (v) return v;
      await tick();
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const run = async (command) => {
    for (const fn of listeners['api.commands.onCommand'] || []) await fn(command);
    await tick();
  };
  let seq = 0;
  // Sends one bridge command through the real poll loop and returns the result the extension posts back.
  const cmd = async (tool, args) => {
    const id = `c${++seq}`;
    const msg = { id, tool, args };
    if (pollResolve) {
      const r = pollResolve;
      pollResolve = null;
      r(res(200, msg));
    } else {
      queue.push(msg);
    }
    const hit = await waitFor(() => results.find((x) => x.id === id), `result ${id}`);
    return hit.result;
  };
  const shareStates = (tabId) => calls
    .filter((c) => c.path === 'api.tabs.sendMessage' && c.args[0] === tabId && c.args[1]?.type === 'shareState')
    .map((c) => c.args[1].shared);
  const lastShare = (tabId) => shareStates(tabId).at(-1);
  const sent = (shared) => [...new Set(calls
    .filter((c) => c.path === 'api.tabs.sendMessage' && c.args[1]?.type === 'shareState' && c.args[1].shared === shared)
    .map((c) => c.args[0]))].sort((a, b) => a - b);
  const callsTo = (path) => calls.filter((c) => c.path === path);
  return {
    run, cmd, sent, lastShare, callsTo, clock, tabsDb, store,
    waitCall: (path) => waitFor(() => callsTo(path)[0], path),
    setSites: (mode) => { sitesMode = mode; },
  };
}

const sharedOpener = async () => {
  const env = load();
  await env.run('share-all');
  return env;
};

test('an allowed URL opens a background tab after the opener and shares it', async () => {
  const env = await sharedOpener();
  const r = await env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
  const created = env.callsTo('api.tabs.create');
  assert.equal(created.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(created[0].args[0])), { url: 'https://www.linkedin.com/jobs', windowId: 7, index: 4, active: false });
  assert.equal(r.tab_id, 100);
  assert.match(r.text, /^Opened tab 100 \(shared\)/);
  assert.equal(env.lastShare(100), true);
  assert.ok(env.sent(true).includes(100));
});

test('a URL not on the allowed list is refused before any tab is created', async () => {
  const env = await sharedOpener();
  for (const url of ['https://evil-linkedin.com/', 'https://linkedin.com.evil.test/', 'http://linkedin.com/']) {
    const r = await env.cmd('open_tab', { tab_id: 1, url });
    assert.ok(r.error.startsWith(BLOCKED + ' '), r.error);
  }
  assert.equal(env.callsTo('api.tabs.create').length, 0);
});

test('when the sites list cannot be fetched, open_tab opens nothing', async () => {
  for (const mode of ['fail', 'bad']) {
    const env = await sharedOpener();
    env.setSites(mode);
    const r = await env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
    assert.match(r.error, /^Blocked: /);
    assert.equal(env.callsTo('api.tabs.create').length, 0);
  }
});

test('the sixth open_tab within an hour is rate limited; an entry older than an hour is not counted', async () => {
  const env = await sharedOpener();
  for (let i = 0; i < 5; i++) {
    const r = await env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
    assert.ok(r.tab_id, `call ${i + 1} should open a tab`);
  }
  const sixth = await env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
  assert.equal(sixth.error, 'Rate limit: at most 5 open_tab calls per hour.');
  assert.equal(env.callsTo('api.tabs.create').length, 5);

  env.clock.t += 3600001; // the five earlier calls are now older than an hour
  const later = await env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
  assert.ok(later.tab_id, 'a call after the hour should open a tab');
  assert.equal(env.callsTo('api.tabs.create').length, 6);
});

test('with 10 tabs already shared, open_tab reports the cap and creates nothing', async () => {
  const tabs = [OPENER, ...Array.from({ length: 9 }, (_, i) => ({
    id: 2 + i, windowId: 7, index: i, url: `https://www.linkedin.com/p${i}`, status: 'complete',
  }))];
  const env = load(tabs);
  await env.run('share-all');
  assert.equal(env.sent(true).length, 10);
  const r = await env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
  assert.equal(r.error, 'Cap reached: 10 tabs are already shared.');
  assert.equal(env.callsTo('api.tabs.create').length, 0);
});

test('open_tab from a tab that is not shared is refused and creates nothing', async () => {
  const env = load(); // the opener is shared, then unshared, so the poll loop runs but tab 1 is not shared
  await env.run('share-all');
  await env.run('share-all');
  const r = await env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
  assert.equal(r.error, 'Tab not shared. Ask the user to click the Claude icon on that tab.');
  assert.equal(env.callsTo('api.tabs.create').length, 0);
});

const REDIRECT_ERROR = 'The page redirected to a site that is not on the allowed list; the tab is not shared.';

test('a page that redirects off the allowed list before sharing is never shared or injected', async () => {
  const env = load([OPENER], { redirectTo: 'https://evil.test/landing' });
  await env.run('share-all');
  const r = await env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
  assert.equal(r.error, REDIRECT_ERROR);
  // No share path ran for the new tab: no content-script message, no injection, no hello that lists it.
  assert.equal(env.lastShare(100), undefined);
  assert.equal(env.callsTo('api.scripting.executeScript').length, 0);
  assert.equal(env.callsTo('api.tabs.executeScript').length, 0);
  assert.equal(env.callsTo('api.tabs.sendMessage').filter((c) => c.args[0] === 100).length, 0);
  assert.equal(env.callsTo('api.tabs.remove').length, 0);
});

test('a page that redirects off the allowed list right after sharing is unshared and reported', async () => {
  const env = load([OPENER], { redirectAfterShare: 'https://evil.test/landing' });
  await env.run('share-all');
  const r = await env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
  assert.equal(r.error, REDIRECT_ERROR);
  assert.equal(env.lastShare(100), false);
});

test('a new tab that never reaches "complete" is reported as a timeout, not shared', async () => {
  const env = load([OPENER], { createStatus: 'loading' });
  await env.run('share-all');
  const r = await env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
  assert.equal(r.error, 'Timed out waiting for the new tab to load. It was opened but is not shared.');
  assert.equal(env.callsTo('api.tabs.create').length, 1);
  assert.equal(env.lastShare(100), undefined);
});

test('navigate to a site not on the list is blocked and the tab is not moved', async () => {
  const env = await sharedOpener();
  const r = await env.cmd('navigate', { tab_id: 1, url: 'https://example.com/' });
  assert.equal(r.error, `${BLOCKED} example.com`);
  const http = await env.cmd('navigate', { tab_id: 1, url: 'http://linkedin.com/' });
  assert.equal(http.error, `${BLOCKED} linkedin.com`);
  assert.equal(env.callsTo('api.tabs.update').length, 0);
});

test('navigate to an allowed https site goes on to the normal run path', async () => {
  const env = await sharedOpener();
  env.cmd('navigate', { tab_id: 1, url: 'https://www.linkedin.com/x' }).catch(() => {}); // answered after the page loads; not awaited
  const update = await env.waitCall('api.tabs.update');
  assert.equal(update.args[0], 1);
  assert.equal(update.args[1].url, 'https://www.linkedin.com/x');
});

test('navigate with an unparsable URL still reports Invalid URL', async () => {
  const env = await sharedOpener();
  const r = await env.cmd('navigate', { tab_id: 1, url: 'not a url' });
  assert.equal(r.error, 'Invalid URL');
});

test('concurrent open_tab calls are serialised: with 4 recent opens only one of three succeeds', async () => {
  const env = await sharedOpener();
  for (let i = 0; i < 4; i++) {
    const r = await env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
    assert.ok(r.tab_id, `call ${i + 1} should open a tab`);
  }
  const rs = await Promise.all([1, 2, 3].map(() => env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' })));
  assert.equal(rs.filter((r) => r.tab_id).length, 1);
  assert.equal(rs.filter((r) => r.error === 'Rate limit: at most 5 open_tab calls per hour.').length, 2);
  assert.equal(env.callsTo('api.tabs.create').length, 5);
});

test('the cap is enforced where the tab is shared: it fills while open_tab waits for the load', async () => {
  const tabs = [OPENER, ...Array.from({ length: 8 }, (_, i) => ({
    id: 2 + i, windowId: 7, index: i, url: `https://www.linkedin.com/p${i}`, status: 'complete',
  }))];
  const env = load(tabs, { createStatus: 'loading' });
  await env.run('share-all'); // 9 shared
  const pending = env.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
  await env.waitCall('api.tabs.create');
  // While the new tab loads, the user shares a 10th tab by hand (toggle is not capped).
  env.tabsDb.set(50, { id: 50, windowId: 7, index: 20, active: true, url: 'https://www.linkedin.com/extra', status: 'complete' });
  await env.run('toggle-claude');
  env.tabsDb.get(100).status = 'complete';
  const r = await pending;
  assert.equal(r.error, 'Cap reached: 10 tabs are already shared.');
  assert.equal(env.lastShare(100), undefined, 'the over-cap tab is not shared, injected or badged as restricted');
});

test('the open_tab rate limit survives a restart of the background page', async () => {
  const storage = new Map();
  const first = load([OPENER], { storage });
  await first.run('share-all');
  for (let i = 0; i < 5; i++) {
    const r = await first.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
    assert.ok(r.tab_id, `call ${i + 1} should open a tab`);
  }
  assert.ok(storage.has('termOpenTimes'));
  const second = load([OPENER], { storage }); // new context, same storage: the shared set and timestamps are restored
  const r = await second.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
  assert.equal(r.error, 'Rate limit: at most 5 open_tab calls per hour.');
  assert.equal(second.callsTo('api.tabs.create').length, 0);
});

test('open_tab timestamps older than an hour are dropped on restore', async () => {
  const storage = new Map();
  const first = load([OPENER], { storage });
  await first.run('share-all');
  for (let i = 0; i < 5; i++) await first.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
  const second = load([OPENER], { storage });
  second.clock.t += 3600001;
  const r = await second.cmd('open_tab', { tab_id: 1, url: 'https://www.linkedin.com/jobs' });
  assert.ok(r.tab_id);
});

test('navigate that lands off the allowed list unshares the tab and reports it', async () => {
  const env = load([OPENER], { navigateRedirectTo: 'https://evil.test/landing' });
  await env.run('share-all');
  const r = await env.cmd('navigate', { tab_id: 1, url: 'https://www.linkedin.com/x' });
  assert.equal(r.error, 'The page redirected to a site that is not on the allowed list; the tab has been unshared.');
  assert.equal(env.lastShare(1), false);
});

test('navigate that stays on the allowed list keeps the tab shared', async () => {
  const env = await sharedOpener();
  const r = await env.cmd('navigate', { tab_id: 1, url: 'https://www.linkedin.com/x' });
  assert.equal(r.error, undefined);
  assert.equal(env.lastShare(1), true);
});
