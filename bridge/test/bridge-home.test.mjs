// Bridge home tests. Every test uses a temp directory (never the real ~/.claude-safari-bridge). Fictional data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeHome, bridgeHomePath } from '../paths.mjs';
import { fitLogFile } from '../fit-store.mjs';
import { scoutFile } from '../site-scout.mjs';
import { sitesFile } from '../sites.mjs';
import { resumeDir } from '../resume-build.mjs';

const KEYS = ['CLAUDE_BRIDGE_HOME', 'FIT_LOG_FILE', 'SITE_SCOUT_FILE', 'SAFARI_SITES_FILE', 'RESUME_DIR'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-home-test-'));
const realHome = path.join(os.homedir(), '.claude-safari-bridge');

function clearEnv() {
  for (const k of KEYS) delete process.env[k];
}
function restoreEnv() {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
after(() => {
  restoreEnv();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

test('bridgeHome defaults to ~/.claude-safari-bridge when CLAUDE_BRIDGE_HOME is unset or empty', () => {
  clearEnv();
  assert.equal(bridgeHome(), path.join(os.homedir(), '.claude-safari-bridge'));
  process.env.CLAUDE_BRIDGE_HOME = '   ';
  assert.equal(bridgeHome(), path.join(os.homedir(), '.claude-safari-bridge'));
  restoreEnv();
});

test('bridgeHome returns CLAUDE_BRIDGE_HOME at call time', () => {
  clearEnv();
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'chrome-'));
  process.env.CLAUDE_BRIDGE_HOME = dir;
  assert.equal(bridgeHome(), dir);
  assert.equal(bridgeHomePath('a', 'b.json'), path.join(dir, 'a', 'b.json'));
  restoreEnv();
});

test('bridgeHome expands a leading ~/ with the home directory', () => {
  clearEnv();
  process.env.CLAUDE_BRIDGE_HOME = '~/chromium-bridge';
  assert.equal(bridgeHome(), path.join(os.homedir(), 'chromium-bridge'));
  restoreEnv();
});

test('bridgeHomePath joins parts under bridgeHome', () => {
  clearEnv();
  assert.equal(bridgeHomePath(), path.join(os.homedir(), '.claude-safari-bridge'));
  assert.equal(bridgeHomePath('jobwatch', 'x.json'), path.join(os.homedir(), '.claude-safari-bridge', 'jobwatch', 'x.json'));
  restoreEnv();
});

test('path helpers resolve inside CLAUDE_BRIDGE_HOME and never inside the real Safari folder', () => {
  clearEnv();
  const home = fs.mkdtempSync(path.join(tmpRoot, 'instance-'));
  process.env.CLAUDE_BRIDGE_HOME = home;
  const files = [fitLogFile(), scoutFile(), sitesFile(), resumeDir()];
  for (const f of files) {
    assert.ok(inside(f, home), `${f} should be inside ${home}`);
    assert.ok(!inside(f, realHome), `${f} must not be inside ${realHome}`);
  }
  restoreEnv();
});

test('per-file env overrides still take priority over CLAUDE_BRIDGE_HOME', () => {
  clearEnv();
  const home = fs.mkdtempSync(path.join(tmpRoot, 'override-'));
  process.env.CLAUDE_BRIDGE_HOME = home;
  process.env.FIT_LOG_FILE = path.join(tmpRoot, 'fit.json');
  process.env.SITE_SCOUT_FILE = path.join(tmpRoot, 'scout.json');
  process.env.SAFARI_SITES_FILE = path.join(tmpRoot, 'sites.json');
  process.env.RESUME_DIR = path.join(tmpRoot, 'resume');
  assert.equal(fitLogFile(), path.join(tmpRoot, 'fit.json'));
  assert.equal(scoutFile(), path.join(tmpRoot, 'scout.json'));
  assert.equal(sitesFile(), path.join(tmpRoot, 'sites.json'));
  assert.equal(resumeDir(), path.join(tmpRoot, 'resume'));
  restoreEnv();
});
