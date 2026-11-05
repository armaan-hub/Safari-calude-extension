// Tests for the allowed-sites module and CLI (bridge/sites.mjs). Built-ins only. Fictional data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SITES,
  sitesFile,
  loadSites,
  hostAllowed,
  urlAllowed,
  normaliseHost,
  addSite,
  removeSite,
} from '../sites.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'sites.mjs');
const cases = JSON.parse(fs.readFileSync(path.join(here, 'sites-cases.json'), 'utf8'));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sites-test-'));
}

for (const c of cases) {
  test(`urlAllowed(${c.url}) is ${c.allowed}`, () => {
    assert.equal(urlAllowed(c.url, ['linkedin.com']), c.allowed);
  });
}

test('hostAllowed refuses lookalikes and accepts exact or subdomain', () => {
  assert.equal(hostAllowed('linkedin.com', ['linkedin.com']), true);
  assert.equal(hostAllowed('LinkedIn.com.', ['linkedin.com']), true);
  assert.equal(hostAllowed('evil-linkedin.com', ['linkedin.com']), false);
  assert.equal(hostAllowed('linkedin.com.evil.test', ['linkedin.com']), false);
  assert.equal(hostAllowed('a.linkedin.com', ['linkedin.com']), true);
  assert.equal(hostAllowed('linkedin.com', []), false);
});

test('urlAllowed refuses invalid URLs and non-https schemes', () => {
  assert.equal(urlAllowed('not a url', ['linkedin.com']), false);
  assert.equal(urlAllowed('', ['linkedin.com']), false);
  assert.equal(urlAllowed('about:blank', ['linkedin.com']), false);
  assert.equal(urlAllowed('safari://x', ['linkedin.com']), false);
});

test('normaliseHost strips scheme, path, case and trailing dot', () => {
  assert.equal(normaliseHost('https://Example.com/path'), 'example.com');
  assert.equal(normaliseHost('example.com'), 'example.com');
  assert.equal(normaliseHost('Example.com.'), 'example.com');
  assert.equal(normaliseHost(''), null);
  assert.equal(normaliseHost(42), null);
});

test('DEFAULT_SITES is linkedin.com only', () => {
  assert.deepEqual(DEFAULT_SITES, ['linkedin.com']);
});

test('sitesFile honours SAFARI_SITES_FILE', () => {
  const prev = process.env.SAFARI_SITES_FILE;
  process.env.SAFARI_SITES_FILE = '/tmp/fictional-sites.json';
  try {
    assert.equal(sitesFile(), '/tmp/fictional-sites.json');
  } finally {
    if (prev === undefined) delete process.env.SAFARI_SITES_FILE;
    else process.env.SAFARI_SITES_FILE = prev;
  }
});

test('loadSites: missing file returns the default list', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(loadSites(path.join(dir, 'nope.json')), ['linkedin.com']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSites: empty array returns []', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    fs.writeFileSync(file, '[]');
    assert.deepEqual(loadSites(file), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSites: corrupt JSON returns []', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    fs.writeFileSync(file, '[linkedin.com');
    assert.deepEqual(loadSites(file), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSites: non-array object returns []', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    fs.writeFileSync(file, '{"sites":"x"}');
    assert.deepEqual(loadSites(file), []);
    fs.writeFileSync(file, '{"sites":"linkedin.com"}');
    assert.deepEqual(loadSites(file), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSites: normalises entries and drops non-strings', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    fs.writeFileSync(file, JSON.stringify(['https://Example.com/a', 'Other.Example.', 7, null]));
    assert.deepEqual(loadSites(file), ['example.com', 'other.example']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addSite normalises https://Example.com/a to example.com', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    const r = addSite('https://Example.com/a', { file });
    assert.equal(r.ok, true);
    assert.ok(r.sites.includes('example.com'));
    assert.equal(r.sites.filter((s) => s === 'example.com').length, 1);
    assert.deepEqual(loadSites(file), r.sites);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addSite does not add duplicates', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    addSite('example.com', { file });
    const r = addSite('EXAMPLE.com', { file });
    assert.equal(r.ok, true);
    assert.equal(r.sites.filter((s) => s === 'example.com').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addSite on a missing file starts from DEFAULT_SITES', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    const r = addSite('example.com', { file });
    assert.deepEqual(r.sites, ['linkedin.com', 'example.com']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addSite on a corrupt file treats it as [] and adds', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    fs.writeFileSync(file, 'not json');
    const r = addSite('example.com', { file });
    assert.equal(r.ok, true);
    assert.deepEqual(r.sites, ['example.com']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addSite refuses bank-like hosts without force and accepts with force', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    const refused = addSite('mybank.example', { file });
    assert.equal(refused.ok, false);
    assert.equal(typeof refused.error, 'string');
    assert.ok(!refused.sites.includes('mybank.example'));
    const forced = addSite('mybank.example', { file, force: true });
    assert.equal(forced.ok, true);
    assert.ok(forced.sites.includes('mybank.example'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addSite rejects an unparseable host', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    const r = addSite('', { file });
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeSite removes a host and persists the result', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    addSite('example.com', { file });
    const r = removeSite('https://Example.com', { file });
    assert.equal(r.ok, true);
    assert.ok(!r.sites.includes('example.com'));
    assert.deepEqual(loadSites(file), r.sites);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addSite writes the file with mode 0600 and creates the parent directory', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'deeper', 'sites.json');
  try {
    addSite('example.com', { file });
    assert.ok(fs.existsSync(file));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args, file) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, SAFARI_SITES_FILE: file },
    encoding: 'utf8',
  });
}

test('CLI list prints hosts one per line and exits 0', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    fs.writeFileSync(file, JSON.stringify(['example.com', 'other.example']));
    const r = runCli(['list'], file);
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.trim().split('\n'), ['example.com', 'other.example']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI add accepts a normal host and exits 0', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    const r = runCli(['add', 'https://Example.com/a'], file);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.split('\n').includes('example.com'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI add refuses a bank-like host with exit 1, and accepts it with --force', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    const refused = runCli(['add', 'mybank.example'], file);
    assert.equal(refused.status, 1);
    const forced = runCli(['add', 'mybank.example', '--force'], file);
    assert.equal(forced.status, 0);
    assert.ok(forced.stdout.split('\n').includes('mybank.example'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI remove exits 0 and bad usage exits 1', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    fs.writeFileSync(file, JSON.stringify(['example.com']));
    const r = runCli(['remove', 'example.com'], file);
    assert.equal(r.status, 0);
    assert.equal(runCli(['frobnicate'], file).status, 1);
    assert.equal(runCli(['add'], file).status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('urlAllowed: non-string urls are refused (array, number, undefined)', () => {
  const sites = ['linkedin.com'];
  assert.equal(urlAllowed(['https://linkedin.com/'], sites), false);
  assert.equal(urlAllowed(12345, sites), false);
  assert.equal(urlAllowed(undefined, sites), false);
  assert.equal(urlAllowed('https://linkedin.com/', sites), true);
});

test('addSite rejects a single-label host (bare TLD, localhost) and writes nothing', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    for (const h of ['com', 'localhost', 'https://com/']) {
      const r = addSite(h, { file });
      assert.equal(r.ok, false, h);
      assert.equal(r.error, 'needs at least two labels (for example example.com)');
    }
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSites drops single-label entries from a hand-edited file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  try {
    fs.writeFileSync(file, JSON.stringify(['com', 'localhost', 'example.com']));
    assert.deepEqual(loadSites(file), ['example.com']);
    fs.writeFileSync(file, JSON.stringify(['com']));
    assert.deepEqual(loadSites(file), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runScoutCli(args, file, scoutFileArg) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, SAFARI_SITES_FILE: file, SITE_SCOUT_FILE: scoutFileArg },
    encoding: 'utf8',
  });
}

test('CLI pending lists host, country and reason; deny clears the request and leaves the allowed list alone', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  const scout = path.join(dir, 'site-scout.json');
  const { requestSite } = await import('../site-scout.mjs');
  try {
    requestSite({ host: 'careers.example.org', country: 'AE', reason: 'Good listings' }, { file: scout, allowed: [] });
    const listed = runScoutCli(['pending'], file, scout);
    assert.equal(listed.status, 0);
    assert.equal(listed.stdout, 'careers.example.org\tAE\tGood listings\n');
    const denied = runScoutCli(['deny', 'careers.example.org'], file, scout);
    assert.equal(denied.status, 0);
    assert.equal(runScoutCli(['pending'], file, scout).stdout, '');
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI approve adds the host to the temp allowed list and clears the pending entry', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  const scout = path.join(dir, 'site-scout.json');
  const { requestSite } = await import('../site-scout.mjs');
  try {
    requestSite({ host: 'careers.example.org', country: 'AE', reason: 'Good listings' }, { file: scout, allowed: [] });
    const r = runScoutCli(['approve', 'careers.example.org'], file, scout);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.split('\n').includes('careers.example.org'));
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).includes('careers.example.org'));
    assert.equal(runScoutCli(['pending'], file, scout).stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI approve of a bank-like host is refused and the request stays pending', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'sites.json');
  const scout = path.join(dir, 'site-scout.json');
  try {
    // requestSite never stores a bank-like host, so seed the pending entry directly to test the CLI refusal.
    fs.writeFileSync(
      scout,
      JSON.stringify({ notes: [], resolved: [], pending: [{ host: 'bank.example.net', country: 'AE', reason: 'Jobs' }] }),
    );
    const r = runScoutCli(['approve', 'bank.example.net'], file, scout);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refused/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(runScoutCli(['pending'], file, scout).stdout, 'bank.example.net\tAE\tJobs\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
