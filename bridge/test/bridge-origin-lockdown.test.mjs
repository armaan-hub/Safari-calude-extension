// Origin lockdown on the general bridge gate: only safari-web-extension:// and the single pinned CLAUDE_EXT_ORIGIN
// may use the data routes. Starts the real bridge on a free port with temp CLAUDE_BRIDGE_HOME and temp HOME. Fictional data only.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeScript = path.resolve(here, '..', 'claude-bridge.mjs');

const PINNED = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MOZ = 'moz-extension://11111111-2222-3333-4444-555555555555';
const SAFARI = 'safari-web-extension://11111111-2222-3333-4444-555555555555';
const DATA_ROUTES = ['/profile', '/chats', '/memory', '/skills'];

const running = [];
const tempDirs = [];
after(() => {
  for (const c of running) c.kill();
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function get(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startBridge(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-lockdown-test-'));
  tempDirs.push(home);
  const profile = path.join(home, 'profile.md');
  fs.writeFileSync(profile, '# Fictional Test Person\n');
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    HOME: home,
    CLAUDE_BRIDGE_HOME: home,
    ASSISTANT_PROFILE_FILE: profile,
    ...extraEnv,
  };
  if (extraEnv.CLAUDE_EXT_ORIGIN === undefined) delete env.CLAUDE_EXT_ORIGIN;
  const child = spawn(process.execPath, [bridgeScript], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  running.push(child);
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      await get(port, '/health', { 'x-claude-bridge': '1' });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('bridge did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { port };
}

test('no CLAUDE_EXT_ORIGIN: a random chrome-extension origin gets 403 on data routes and /health', async () => {
  const b = await startBridge();
  for (const route of [...DATA_ROUTES, '/health']) {
    assert.equal(await get(b.port, route, { Origin: OTHER }), 403, route);
  }
});

test('pinned CLAUDE_EXT_ORIGIN: pinned origin allowed, other chrome and moz origins get 403', async () => {
  const b = await startBridge({ CLAUDE_EXT_ORIGIN: PINNED });
  for (const route of ['/chats', '/profile']) {
    assert.notEqual(await get(b.port, route, { Origin: PINNED }), 403, route);
    assert.equal(await get(b.port, route, { Origin: OTHER }), 403, route);
    assert.equal(await get(b.port, route, { Origin: MOZ }), 403, route);
  }
});

test('safari-web-extension origin is still allowed on data routes (with and without a pinned origin)', async () => {
  for (const env of [{}, { CLAUDE_EXT_ORIGIN: PINNED }]) {
    const b = await startBridge(env);
    for (const route of DATA_ROUTES) {
      assert.notEqual(await get(b.port, route, { Origin: SAFARI }), 403, route);
    }
  }
});

test('no Origin plus x-claude-bridge:1 GET is still allowed; without the header it is 403', async () => {
  const b = await startBridge();
  for (const route of DATA_ROUTES) {
    assert.notEqual(await get(b.port, route, { 'x-claude-bridge': '1' }), 403, route);
    assert.equal(await get(b.port, route, {}), 403, route);
  }
});
