// Tests bridge/install-chromium.sh and bridge/uninstall-chromium.sh as text only: key values present, Safari values
// absent, and both pass `bash -n`. Nothing is installed, launched or bootstrapped. Fictional data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(here, '..');
const install = path.join(bridgeDir, 'install-chromium.sh');
const uninstall = path.join(bridgeDir, 'uninstall-chromium.sh');

const installText = fs.readFileSync(install, 'utf8');
const uninstallText = fs.readFileSync(uninstall, 'utf8');

test('install-chromium.sh has the Chromium label, port, state folder, session and mode 700', () => {
  assert.ok(installText.includes('com.armaan.claude-chromium-bridge'));
  assert.ok(installText.includes('8788'));
  assert.ok(installText.includes('CLAUDE_BRIDGE_HOME'));
  assert.ok(installText.includes('.claude-chromium-bridge'));
  assert.ok(installText.includes('CLAUDE_ZELLIJ_SESSION'));
  assert.ok(installText.includes('claude-chromium'));
  assert.ok(installText.includes('700'));
  assert.ok(installText.includes('http://127.0.0.1:$PORT_NUM/health') || installText.includes('http://127.0.0.1:8788/health'));
});

test('uninstall-chromium.sh removes the Chromium label only', () => {
  assert.ok(uninstallText.includes('com.armaan.claude-chromium-bridge'));
});

test('neither script mentions 8787 or the Safari label or Safari session', () => {
  for (const text of [installText, uninstallText]) {
    assert.equal(text.includes('8787'), false);
    assert.equal(text.includes('com.armaan.claude-safari-bridge'), false);
    assert.equal(text.includes('claude-safari'), false);
    assert.equal(/safari/i.test(text), false);
  }
});

test('both scripts pass bash -n', () => {
  execFileSync('bash', ['-n', install], { stdio: 'pipe' });
  execFileSync('bash', ['-n', uninstall], { stdio: 'pipe' });
});
