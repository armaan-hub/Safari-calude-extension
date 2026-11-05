// Fit store: the local log of fit judgments (strong, stretch, no) per job. Built-ins only.
// Every write is atomic (tmp file + rename) with mode 0600 in a 0700 directory.
// Read helpers never throw: a missing or corrupt file reads as an empty list.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { bridgeHomePath } from './paths.mjs';

export const VERDICTS = new Set(['strong', 'stretch', 'no']);
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const LONG_DIGITS_RE = /\d{8,}/;
const HANDLE_RE = /(?:^|[^A-Za-z0-9])@[A-Za-z0-9_.]{2,}/;
// A run of digit groups joined by single spaces, dashes or dots (groups may be wrapped in brackets, optional leading plus).
const PHONE_RUN_RE = /\+?(?:\(\d+\)|\d+)(?:[\s.\-]{1,2}(?:\(\d+\)|\d+))+/g;

// Path of the fit log: FIT_LOG_FILE if set, else ~/.claude-safari-bridge/jobwatch/fit-log.json.
export function fitLogFile() {
  const fromEnv = process.env.FIT_LOG_FILE;
  if (fromEnv) return fromEnv;
  return bridgeHomePath('jobwatch', 'fit-log.json');
}

// Hex sha256 of the given texts joined with newlines. Used to tie a fit to the rules that produced it.
export function hashRules(...texts) {
  return crypto.createHash('sha256').update(texts.map(String).join('\n')).digest('hex');
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// True when the text has an email, an @ handle, a run of 8 or more digits, or phone-like digit groups (9 or more digits in total).
export function looksPersonal(text) {
  const t = String(text ?? '');
  if (EMAIL_RE.test(t) || HANDLE_RE.test(t) || LONG_DIGITS_RE.test(t)) return true;
  for (const run of t.match(PHONE_RUN_RE) ?? []) {
    if (run.replace(/\D/g, '').length >= 9) return true;
  }
  return false;
}

function personalDetailIn(texts) {
  return texts.some((t) => looksPersonal(t));
}

function readAll(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e === 'object') : [];
  } catch {
    return [];
  }
}

function writeAll(file, entries) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
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

// Validates and stores one fit entry. Same job_url overwrites. Returns { ok, error? }; never throws.
export function recordFit(entry, { file = fitLogFile(), rulesHash } = {}) {
  try {
    if (!entry || typeof entry !== 'object') return { ok: false, error: 'entry must be an object' };
    if (!isNonEmptyString(entry.job_url)) return { ok: false, error: 'job_url is required' };
    if (!isNonEmptyString(entry.title)) return { ok: false, error: 'title is required' };
    if (!isNonEmptyString(entry.company)) return { ok: false, error: 'company is required' };
    if (!VERDICTS.has(entry.verdict)) return { ok: false, error: 'verdict must be strong, stretch or no' };
    if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > 100) {
      return { ok: false, error: 'score must be an integer from 0 to 100' };
    }
    if (!Array.isArray(entry.reasons) || !entry.reasons.every((r) => typeof r === 'string')) {
      return { ok: false, error: 'reasons must be a list of strings' };
    }
    const gaps = entry.gaps === undefined ? [] : entry.gaps;
    if (!Array.isArray(gaps) || !gaps.every((g) => typeof g === 'string')) {
      return { ok: false, error: 'gaps must be a list of strings' };
    }
    if (personalDetailIn([...entry.reasons, ...gaps])) {
      return { ok: false, error: 'reasons or gaps contain personal details (email or long digit run)' };
    }
    if (!isNonEmptyString(rulesHash)) return { ok: false, error: 'rulesHash is required' };

    const stored = {
      job_url: entry.job_url,
      title: entry.title,
      company: entry.company,
      verdict: entry.verdict,
      score: entry.score,
      reasons: [...entry.reasons],
      gaps: [...gaps],
      rules_hash: rulesHash,
      recorded_at: new Date().toISOString(),
    };
    const entries = readAll(file).filter((e) => e.job_url !== stored.job_url);
    entries.push(stored);
    writeAll(file, entries);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `could not write fit log: ${err.message}` };
  }
}

// Entry for this job_url, or null. Returns null when the stored rules hash differs from rulesHash.
export function getFit(jobUrl, { file = fitLogFile(), rulesHash } = {}) {
  try {
    const found = readAll(file).find((e) => e.job_url === jobUrl);
    if (!found) return null;
    return found.rules_hash === rulesHash ? found : null;
  } catch {
    return null;
  }
}

// All entries, optionally only those with the given verdict. Never throws.
export function listFits({ file = fitLogFile(), verdict } = {}) {
  try {
    const all = readAll(file);
    return verdict === undefined ? all : all.filter((e) => e.verdict === verdict);
  } catch {
    return [];
  }
}
