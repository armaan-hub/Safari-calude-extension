// Allowed-sites list for the Claude for Safari bridge. Built-ins only.
// Fails closed: missing file = DEFAULT_SITES; unreadable, corrupt, non-array or empty = nothing allowed.
// Never throws from the read/match helpers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SITES = ['linkedin.com'];

const BLOCKED_HOST = /bank|paypal|stripe|wallet|payment|checkout|creditcard|billing/i;

export function sitesFile() {
  return process.env.SAFARI_SITES_FILE || path.join(os.homedir(), '.claude-safari-bridge', 'allowed-sites.json');
}

// Accepts "https://Example.com/path", "example.com", "Example.com." and returns the lower-case hostname.
export function normaliseHost(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  try {
    const url = new URL(s.includes('://') ? s : `https://${s}`);
    let host = url.hostname.toLowerCase();
    if (host.endsWith('.')) host = host.slice(0, -1);
    return host || null;
  } catch {
    return null;
  }
}

export function hasTwoLabels(host) {
  return host.split('.').filter(Boolean).length >= 2;
}

// True when the host matches the bank/payment rule that addSite refuses without force.
export function isBlockedHost(host) {
  return typeof host === 'string' && BLOCKED_HOST.test(host);
}

function uniqueNormalised(list) {
  const out = [];
  for (const entry of list) {
    const h = normaliseHost(entry);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

export function loadSites(file = sitesFile()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [...DEFAULT_SITES];
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // Fail closed against a hand-edited ["com"]: a bare TLD or "localhost" would match a whole zone.
  return uniqueNormalised(parsed.filter((e) => typeof e === 'string')).filter(hasTwoLabels);
}

export function hostAllowed(host, sites) {
  if (typeof host !== 'string' || !Array.isArray(sites)) return false;
  let h = host.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return false;
  for (const raw of sites) {
    if (typeof raw !== 'string') continue;
    let site = raw.toLowerCase();
    if (site.endsWith('.')) site = site.slice(0, -1);
    if (!site) continue;
    if (h === site || h.endsWith(`.${site}`)) return true;
  }
  return false;
}

export function urlAllowed(url, sites) {
  if (typeof url !== 'string') return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username !== '' || u.password !== '') return false;
  return hostAllowed(u.hostname, sites);
}

function writeSites(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function addSite(host, opts = {}) {
  const file = opts.file ?? sitesFile();
  const current = loadSites(file);
  const h = normaliseHost(host);
  if (!h) return { ok: false, sites: current, error: 'not a valid host' };
  if (!hasTwoLabels(h)) return { ok: false, sites: current, error: 'needs at least two labels (for example example.com)' };
  if (BLOCKED_HOST.test(h) && !opts.force) {
    return { ok: false, sites: current, error: `${h} looks like a bank or payment site; use force to add it` };
  }
  const next = current.includes(h) ? current : [...current, h];
  try {
    writeSites(file, next);
  } catch (err) {
    return { ok: false, sites: current, error: `could not write ${file}: ${err.message}` };
  }
  return { ok: true, sites: next };
}

export function removeSite(host, opts = {}) {
  const file = opts.file ?? sitesFile();
  const current = loadSites(file);
  const h = normaliseHost(host) ?? (typeof host === 'string' ? host.trim().toLowerCase() : '');
  const next = current.filter((s) => s !== h);
  try {
    writeSites(file, next);
  } catch {
    return { ok: false, sites: current };
  }
  return { ok: true, sites: next };
}

function usage(out) {
  out.write('usage: node bridge/sites.mjs list | add <host> [--force] | remove <host> | pending | approve <host> | deny <host>\n');
}

// Pending requests come from site-scout.mjs, which imports this module; it is loaded lazily to avoid a cycle.
async function runPendingCommand(cmd, rest) {
  const scout = await import('./site-scout.mjs');
  if (cmd === 'pending') {
    const list = scout.pendingSites();
    process.stdout.write(list.map((p) => `${p.host}\t${p.country}\t${p.reason}\n`).join(''));
    return 0;
  }
  const host = rest[0];
  if (!host) {
    usage(process.stderr);
    return 1;
  }
  if (cmd === 'deny') {
    const r = scout.resolveSite(host, 'denied');
    if (!r.ok) {
      process.stderr.write(`${r.error}\n`);
      return 1;
    }
    process.stdout.write(`denied ${normaliseHost(host)}\n`);
    return 0;
  }
  // approve: the host is added first; a refusal leaves the request pending.
  const added = addSite(host);
  if (!added.ok) {
    process.stderr.write(`refused: ${added.error}\n`);
    return 1;
  }
  scout.resolveSite(host, 'approved');
  process.stdout.write(added.sites.map((s) => `${s}\n`).join(''));
  return 0;
}

async function runCli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'pending' || cmd === 'approve' || cmd === 'deny') return runPendingCommand(cmd, rest);
  if (cmd === 'list') {
    process.stdout.write(loadSites().map((s) => `${s}\n`).join(''));
    return 0;
  }
  if (cmd === 'add') {
    const force = rest.includes('--force');
    const host = rest.find((a) => a !== '--force');
    if (!host) {
      usage(process.stderr);
      return 1;
    }
    const r = addSite(host, { force });
    if (!r.ok) {
      process.stderr.write(`refused: ${r.error}\n`);
      return 1;
    }
    process.stdout.write(r.sites.map((s) => `${s}\n`).join(''));
    return 0;
  }
  if (cmd === 'remove') {
    const host = rest[0];
    if (!host) {
      usage(process.stderr);
      return 1;
    }
    const r = removeSite(host);
    if (!r.ok) {
      process.stderr.write('could not update the allowed-sites file\n');
      return 1;
    }
    process.stdout.write(r.sites.map((s) => `${s}\n`).join(''));
    return 0;
  }
  usage(process.stderr);
  return 1;
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
