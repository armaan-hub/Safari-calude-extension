// Bridge home folder. CLAUDE_BRIDGE_HOME (a second bridge instance, e.g. Chromium) if set and non-empty,
// else ~/.claude-safari-bridge (the Safari default). Read at call time so tests and child processes can set it.
// Built-ins only: os, path.

import os from 'node:os';
import path from 'node:path';

export function bridgeHome() {
  const fromEnv = process.env.CLAUDE_BRIDGE_HOME;
  if (fromEnv && fromEnv.trim()) {
    const v = fromEnv.trim();
    if (v === '~') return os.homedir();
    if (v.startsWith('~/')) return path.join(os.homedir(), v.slice(2));
    return v;
  }
  return path.join(os.homedir(), '.claude-safari-bridge');
}

export function bridgeHomePath(...parts) {
  return path.join(bridgeHome(), ...parts);
}
