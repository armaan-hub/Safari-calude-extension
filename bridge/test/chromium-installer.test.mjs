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
    // SAFARI_BRIDGE_PORT (env name the MCP server reads) and safari-mcp.mjs (the server file) are the allowed uses of the word.
    assert.equal(/safari/i.test(text.replace(/SAFARI_BRIDGE_PORT/g, '').replace(/safari-mcp\.mjs/g, '')), false);
  }
});

test('install-chromium.sh builds dist/chromium if missing and registers the two MCP servers', () => {
  assert.ok(installText.includes('build-chromium.sh'));
  assert.ok(installText.includes('claude mcp add --scope user'));
  assert.ok(installText.includes('chromium-assistant'));
  assert.ok(installText.includes('CLAUDE_BRIDGE_HOME'));
});

test('uninstall-chromium.sh removes the two MCP servers', () => {
  assert.ok(uninstallText.includes('claude mcp remove'));
  assert.ok(uninstallText.includes('chromium-assistant'));
});

test('install.sh runs the Chrome / Brave installer behind SKIP_CHROMIUM, and stays Safari-only otherwise', () => {
  const safariInstall = fs.readFileSync(path.join(bridgeDir, 'install.sh'), 'utf8');
  assert.ok(safariInstall.includes('install-chromium.sh'));
  assert.ok(safariInstall.includes('SKIP_CHROMIUM'));
  assert.ok(safariInstall.includes('com.armaan.claude-safari-bridge'));
  assert.ok(safariInstall.includes('8787'));
  assert.equal(safariInstall.includes('8788'), false);
  assert.equal(safariInstall.includes('CLAUDE_EXT_ORIGIN'), false);
  execFileSync('bash', ['-n', path.join(bridgeDir, 'install.sh')], { stdio: 'pipe' });
});

test('uninstall.sh calls uninstall-chromium.sh unless SKIP_CHROMIUM=1', () => {
  const safariUninstall = fs.readFileSync(path.join(bridgeDir, 'uninstall.sh'), 'utf8');
  assert.ok(safariUninstall.includes('uninstall-chromium.sh'));
  assert.ok(safariUninstall.includes('SKIP_CHROMIUM'));
  execFileSync('bash', ['-n', path.join(bridgeDir, 'uninstall.sh')], { stdio: 'pipe' });
});

test('both scripts pass bash -n', () => {
  execFileSync('bash', ['-n', install], { stdio: 'pipe' });
  execFileSync('bash', ['-n', uninstall], { stdio: 'pipe' });
});

test('install-chromium.sh sets CLAUDE_EXT_ORIGIN from chromium-id.mjs; the Safari install.sh never does', () => {
  assert.ok(installText.includes('CLAUDE_EXT_ORIGIN'));
  assert.ok(installText.includes('chromium-id.mjs'));
  const safariInstall = fs.readFileSync(path.join(bridgeDir, 'install.sh'), 'utf8');
  assert.equal(safariInstall.includes('CLAUDE_EXT_ORIGIN'), false);
});
