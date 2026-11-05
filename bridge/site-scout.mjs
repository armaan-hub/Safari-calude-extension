// Site scout store: notes on job sites by country, and requests to add a site to the allowed list. Built-ins only.
// Every write is atomic (tmp file + rename) with mode 0600 in a 0700 directory.
// Read helpers never throw: a missing or corrupt file reads as empty.
// Approval is never automatic: a request only waits in pendingSites until the user runs sites.mjs approve or deny.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksPersonal } from './fit-store.mjs';
import { normaliseHost, hostAllowed, hasTwoLabels, isBlockedHost } from './sites.mjs';

const NOTE_MAX = 300;
const QUALITY_MIN = 1;
const QUALITY_MAX = 5;

// Path of the scout file: SITE_SCOUT_FILE if set, else ~/.claude-safari-bridge/site-scout.json.
export function scoutFile() {
  const fromEnv = process.env.SITE_SCOUT_FILE;
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), '.claude-safari-bridge', 'site-scout.json');
}

function emptyState() {
  return { notes: [], pending: [], resolved: [] };
}

// Reads the whole file. Missing, corrupt or non-object content reads as empty.
function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState();
    return {
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter((e) => e && typeof e === 'object') : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending.filter((e) => e && typeof e === 'object') : [],
      resolved: Array.isArray(parsed.resolved) ? parsed.resolved.filter((e) => e && typeof e === 'object') : [],
    };
  } catch {
    return emptyState();
  }
}

function writeState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function personalDetailIn(texts) {
  return texts.some((t) => looksPersonal(t));
}

// Validates a host for storage. Returns { host } or { error }.
function checkHost(input) {
  const h = normaliseHost(input);
  if (!h) return { error: 'not a valid host' };
  if (!hasTwoLabels(h)) return { error: 'needs at least two labels (for example example.com)' };
  return { host: h };
}

// Stores or replaces the note for one host. Returns { ok, error? }; never throws.
export function noteSite({ host, country, quality, notes } = {}, { file = scoutFile() } = {}) {
  try {
    const checked = checkHost(host);
    if (checked.error) return { ok: false, error: checked.error };
    if (!isNonEmptyString(country)) return { ok: false, error: 'country is required' };
    if (!Number.isInteger(quality) || quality < QUALITY_MIN || quality > QUALITY_MAX) {
      return { ok: false, error: 'quality must be an integer from 1 to 5' };
    }
    if (typeof notes !== 'string') return { ok: false, error: 'notes must be a string' };
    if (notes.length > NOTE_MAX) return { ok: false, error: `notes must be ${NOTE_MAX} characters or fewer` };
    if (personalDetailIn([country, notes])) {
      return { ok: false, error: 'notes contain personal details (email or long digit run)' };
    }
    const state = readState(file);
    const stored = {
      host: checked.host,
      country: country.trim(),
      quality,
      notes,
      recorded_at: new Date().toISOString(),
    };
    state.notes = state.notes.filter((n) => n.host !== stored.host);
    state.notes.push(stored);
    writeState(file, state);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `could not write site scout file: ${err.message}` };
  }
}

// Notes for one country (case-insensitive), best quality first. Never throws.
export function siteNotes(country, { file = scoutFile() } = {}) {
  try {
    if (!isNonEmptyString(country)) return [];
    const want = country.trim().toLowerCase();
    return readState(file)
      .notes.filter((n) => typeof n.country === 'string' && n.country.toLowerCase() === want)
      .sort((a, b) => b.quality - a.quality)
      .map((n) => ({ host: n.host, country: n.country, quality: n.quality, notes: n.notes }));
  } catch {
    return [];
  }
}

// Records a request to allow a host. Returns { ok, status, error? }.
// status: 'already-allowed' (host is under an allowed site), 'pending' (waiting for the user), 'refused' (invalid or bank-like host).
export function requestSite({ host, country, reason } = {}, { file = scoutFile(), allowed = [] } = {}) {
  try {
    const checked = checkHost(host);
    if (checked.error) return { ok: false, status: 'refused', error: checked.error };
    if (isBlockedHost(checked.host)) {
      return { ok: false, status: 'refused', error: `${checked.host} looks like a bank or payment site; it cannot be requested` };
    }
    if (!isNonEmptyString(country)) return { ok: false, status: 'refused', error: 'country is required' };
    if (typeof reason !== 'string') return { ok: false, status: 'refused', error: 'reason must be a string' };
    if (reason.length > NOTE_MAX) return { ok: false, status: 'refused', error: `reason must be ${NOTE_MAX} characters or fewer` };
    if (personalDetailIn([country, reason])) {
      return { ok: false, status: 'refused', error: 'reason contains personal details (email or long digit run)' };
    }
    if (hostAllowed(checked.host, allowed)) return { ok: true, status: 'already-allowed' };

    const state = readState(file);
    const entry = {
      host: checked.host,
      country: country.trim(),
      reason,
      requested_at: new Date().toISOString(),
    };
    state.pending = state.pending.filter((p) => p.host !== entry.host);
    state.pending.push(entry);
    writeState(file, state);
    return { ok: true, status: 'pending' };
  } catch (err) {
    return { ok: false, status: 'refused', error: `could not write site scout file: ${err.message}` };
  }
}

// Requests waiting for the user. Never throws.
export function pendingSites({ file = scoutFile() } = {}) {
  try {
    return readState(file).pending.map((p) => ({ host: p.host, country: p.country, reason: p.reason, requested_at: p.requested_at }));
  } catch {
    return [];
  }
}

// Removes the pending request for a host and records the outcome. Returns { ok, error? }; never throws.
export function resolveSite(host, outcome, { file = scoutFile() } = {}) {
  try {
    if (outcome !== 'approved' && outcome !== 'denied') return { ok: false, error: 'outcome must be approved or denied' };
    const h = normaliseHost(host);
    if (!h) return { ok: false, error: 'not a valid host' };
    const state = readState(file);
    if (!state.pending.some((p) => p.host === h)) return { ok: false, error: `no pending request for ${h}` };
    state.pending = state.pending.filter((p) => p.host !== h);
    state.resolved = state.resolved.filter((x) => x.host !== h);
    state.resolved.push({ host: h, outcome, resolved_at: new Date().toISOString() });
    writeState(file, state);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `could not write site scout file: ${err.message}` };
  }
}
