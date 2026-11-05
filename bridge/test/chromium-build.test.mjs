// Tests build-chromium.sh: the Chrome / Brave copy of the extension. Runs the build offline, then checks the
// patched manifest, the service-worker entry file, and that the Safari manifest in extension/ is untouched.
// Built-ins only. Fictional data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dist = path.join(root, 'dist', 'chromium');
const ext = path.join(root, 'extension');

// Build once for the whole file. Throws (and fails the file) if the script cannot run offline.
execFileSync('bash', [path.join(root, 'build-chromium.sh')], { cwd: root, stdio: 'pipe' });

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('chromium manifest is MV3 with a service worker and no Safari background list', () => {
  const m = readJson(path.join(dist, 'manifest.json'));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.background, { service_worker: 'sw.js' });
  assert.equal('scripts' in m.background, false);
  assert.equal('persistent' in m.background, false);
  assert.match(m.name, /Chrome and Brave/);
  assert.doesNotMatch(m.description, /Safari/);
});

test('chromium manifest keeps permissions, host access, content scripts, action and commands', () => {
  const m = readJson(path.join(dist, 'manifest.json'));
  const orig = readJson(path.join(ext, 'manifest.json'));
  assert.ok(m.host_permissions.includes('http://127.0.0.1:8788/*'));
  assert.ok(!m.host_permissions.some((h) => h.includes('8787')));
  assert.deepEqual(m.permissions, orig.permissions);
  assert.deepEqual(
    m.host_permissions,
    orig.host_permissions.map((h) => h.replace('8787', '8788')),
  );
  assert.deepEqual(m.content_scripts, orig.content_scripts);
  assert.deepEqual(m.action, orig.action);
  assert.ok('toggle-claude' in m.commands);
  assert.ok('share-all' in m.commands);
});

test('sw.js is the importScripts line and both scripts it loads are staged', () => {
  assert.equal(
    fs.readFileSync(path.join(dist, 'sw.js'), 'utf8'),
    'importScripts("term-sites.js", "background.js");\n',
  );
  assert.ok(fs.existsSync(path.join(dist, 'term-sites.js')));
  assert.ok(fs.existsSync(path.join(dist, 'background.js')));
  assert.ok(fs.existsSync(path.join(dist, 'panel.html')));
  assert.ok(fs.existsSync(path.join(dist, 'panel-boot.js')));
});

test('the Safari manifest in extension/ is unchanged', () => {
  const m = readJson(path.join(ext, 'manifest.json'));
  assert.equal(m.name, 'Claude Code for Safari');
  assert.deepEqual(m.background, { scripts: ['term-sites.js', 'background.js'], persistent: false });
  assert.ok(m.host_permissions.includes('http://127.0.0.1:8787/*'));
});

test('staged background.js points at port 8788 and the original extension/background.js still says 8787', () => {
  const staged = fs.readFileSync(path.join(dist, 'background.js'), 'utf8');
  assert.ok(staged.includes('const BRIDGE_BASE = "http://127.0.0.1:8788";'));
  assert.ok(!staged.includes('8787'));
  const orig = fs.readFileSync(path.join(ext, 'background.js'), 'utf8');
  assert.ok(orig.includes('const BRIDGE_BASE = "http://127.0.0.1:8787";'));
});

test('dist/chromium contains no 8787 anywhere', () => {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.readFileSync(p).includes('8787')) hits.push(p);
    }
  };
  walk(dist);
  assert.deepEqual(hits, []);
});

test('the staged manifest carries the stable key; the Safari manifest has none', () => {
  const m = readJson(path.join(dist, 'manifest.json'));
  const keyFile = fs.readFileSync(path.join(root, 'tools', 'chromium-extension-key.txt'), 'utf8').trim();
  assert.equal(m.key, keyFile);
  assert.equal('key' in readJson(path.join(ext, 'manifest.json')), false);
});
