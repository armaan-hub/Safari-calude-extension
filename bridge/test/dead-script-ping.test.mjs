// Tests the dead-content-script recovery in extension/background.js (ping + inject + resend) and the ping branch
// in extension/content.js. background.js is loaded into a node:vm context with a fake browser api.
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
const CONTENT_SRC = fs.readFileSync(path.join(ext, 'content.js'), 'utf8');

// mode: 'dead' (silent until injected), 'live-silent' (answers ping, exec returns undefined),
// 'restricted' (never answers, executeScript throws).
function load(mode) {
  const calls = [];
  let injected = false;
  const route = (p, args) => {
    if (p === 'api.tabs.sendMessage') {
      const type = args[1]?.type;
      if (mode === 'restricted') return undefined;
      if (mode === 'live-silent') return type === 'ping' ? { pong: true } : undefined;
      if (!injected) return undefined;
      if (type === 'ping') return { pong: true };
      if (type === 'exec') return { text: 'ok' };
      return undefined;
    }
    if (p === 'api.scripting.executeScript') {
      if (mode === 'restricted') throw new Error('Cannot access contents of this page');
      injected = true;
      return undefined;
    }
    return undefined;
  };
  const make = (p) =>
    new Proxy(function () {}, {
      get(_, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        if (prop === 'addListener') return () => {};
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
  const fastTimer = (f, ms, ...a) => { const t = setTimeout(f, 0, ...a); t.unref?.(); return t; };
  const ctx = {
    chrome: make('api'), console, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    URL, AbortController, setTimeout: fastTimer, clearTimeout, setInterval: () => 0, clearInterval,
  };
  vm.createContext(ctx);
  vm.runInContext(SITES_SRC, ctx, { filename: 'term-sites.js' });
  vm.runInContext(BG_SRC, ctx, { filename: 'background.js' });
  const sentTypes = (type) => calls.filter((c) => c.path === 'api.tabs.sendMessage' && c.args[1]?.type === type).length;
  const injectCount = () => calls.filter((c) => c.path === 'api.scripting.executeScript').length;
  return { ctx, sentTypes, injectCount };
}

test('a dead page is detected by ping, re-injected, and the exec is resent once', async () => {
  const env = load('dead');
  const r = await env.ctx.runToolInTab(1, 'read_page', {});
  assert.equal(r.text, 'ok');
  assert.equal(env.injectCount(), 1);
  assert.equal(env.sentTypes('exec'), 2);
});

test('a live page that returns nothing is not re-injected and the exec is not resent', async () => {
  const env = load('live-silent');
  const r = await env.ctx.runToolInTab(1, 'read_page', {});
  assert.match(r.error, /No response from page/);
  assert.equal(env.injectCount(), 0);
  assert.equal(env.sentTypes('exec'), 1);
});

test('a restricted page reports a reload hint', async () => {
  const env = load('restricted');
  const r = await env.ctx.runToolInTab(1, 'read_page', {});
  assert.match(r.error, /reload/i);
  assert.equal(env.sentTypes('exec'), 1);
});

test('content.js answers ping with pong: true', () => {
  assert.match(CONTENT_SRC, /msg\.type === "ping"[\s\S]{0,120}pong: true/);
});

test('termReach re-injects a dead page once and reports it reachable', async () => {
  const env = load('dead');
  assert.equal(await env.ctx.termReach(1), true);
  assert.equal(env.injectCount(), 1);
});

test('termReach returns false when injection throws and nothing answers', async () => {
  const env = load('restricted');
  assert.equal(await env.ctx.termReach(1), false);
});
