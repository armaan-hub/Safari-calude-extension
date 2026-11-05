// Tests the /ext/* origin gate in claude-bridge.mjs by starting the real bridge on a free port with a temp
// CLAUDE_BRIDGE_HOME, plus the stable Chromium extension ID (chromium-id.mjs). Fictional data only. Built-ins only.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extensionIdFromKey, chromiumExtensionOrigin, DEFAULT_KEY_FILE } from '../chromium-id.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(here, '..');
const bridgeScript = path.join(bridgeDir, 'claude-bridge.mjs');
const idScript = path.join(bridgeDir, 'chromium-id.mjs');

const ALLOWED = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SAFARI = 'safari-web-extension://11111111-2222-3333-4444-555555555555';

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

// Starts the bridge with the given env overrides (CLAUDE_EXT_ORIGIN removed unless set), waits until it answers.
async function startBridge(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium-origin-test-'));
  tempDirs.push(home);
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CLAUDE_BRIDGE_HOME: home, ...extraEnv };
  if (extraEnv.CLAUDE_EXT_ORIGIN === undefined) delete env.CLAUDE_EXT_ORIGIN;
  const child = spawn(process.execPath, [bridgeScript], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  running.push(child);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      await get(port, '/ext/sites', {});
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('bridge did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { port, child, stderr: () => stderr };
}

const sitesWithOrigin = (port, origin) => get(port, '/ext/sites', { Origin: origin });

test('with CLAUDE_EXT_ORIGIN set: the exact Chromium origin is accepted on /ext/sites', async () => {
  const b = await startBridge({ CLAUDE_EXT_ORIGIN: ALLOWED });
  assert.notEqual(await sitesWithOrigin(b.port, ALLOWED), 403);
});

test('with CLAUDE_EXT_ORIGIN set: a different chrome-extension origin gets 403', async () => {
  const b = await startBridge({ CLAUDE_EXT_ORIGIN: ALLOWED });
  assert.equal(await sitesWithOrigin(b.port, OTHER), 403);
});

test('with CLAUDE_EXT_ORIGIN set: the Safari origin is still accepted', async () => {
  const b = await startBridge({ CLAUDE_EXT_ORIGIN: ALLOWED });
  assert.notEqual(await sitesWithOrigin(b.port, SAFARI), 403);
});

test('with CLAUDE_EXT_ORIGIN unset: a chrome-extension origin gets 403, the Safari origin is accepted', async () => {
  const b = await startBridge();
  assert.equal(await sitesWithOrigin(b.port, ALLOWED), 403);
  assert.notEqual(await sitesWithOrigin(b.port, SAFARI), 403);
});

test('an invalid CLAUDE_EXT_ORIGIN is ignored (403 for it) and logs one line', async () => {
  const b = await startBridge({ CLAUDE_EXT_ORIGIN: 'chrome-extension://NOT-A-VALID-ID' });
  assert.equal(await sitesWithOrigin(b.port, 'chrome-extension://NOT-A-VALID-ID'), 403);
  await new Promise((r) => setTimeout(r, 100));
  const lines = b.stderr().split('\n').filter((l) => l.includes('CLAUDE_EXT_ORIGIN ignored'));
  assert.equal(lines.length, 1);
});

test('the x-claude-bridge GET path without an Origin still works', async () => {
  const b = await startBridge({ CLAUDE_EXT_ORIGIN: ALLOWED });
  assert.notEqual(await get(b.port, '/ext/sites', { 'x-claude-bridge': '1' }), 403);
});

test('chromium-id.mjs: the ID is 32 chars from a-p, deterministic, and matches the origin', () => {
  const key = fs.readFileSync(DEFAULT_KEY_FILE, 'utf8').trim();
  const id1 = extensionIdFromKey(key);
  const id2 = extensionIdFromKey(key);
  assert.equal(id1, id2);
  assert.match(id1, /^[a-p]{32}$/);
  assert.equal(chromiumExtensionOrigin(), `chrome-extension://${id1}`);
  const cli = execFileSync(process.execPath, [idScript], { encoding: 'utf8' }).trim();
  assert.equal(cli, `chrome-extension://${id1}`);
});
