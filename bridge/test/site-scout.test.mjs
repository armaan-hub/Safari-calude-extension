// Tests for the site scout store (bridge/site-scout.mjs). Built-ins only. Fictional hosts; temp files only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scoutFile,
  noteSite,
  siteNotes,
  requestSite,
  pendingSites,
  resolveSite,
} from '../site-scout.mjs';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-scout-test-'));
  return path.join(dir, 'site-scout.json');
}

test('scoutFile honours SITE_SCOUT_FILE and defaults under ~/.claude-safari-bridge', () => {
  const before = process.env.SITE_SCOUT_FILE;
  try {
    process.env.SITE_SCOUT_FILE = '/tmp/fictional-scout.json';
    assert.equal(scoutFile(), '/tmp/fictional-scout.json');
    delete process.env.SITE_SCOUT_FILE;
    assert.equal(scoutFile(), path.join(os.homedir(), '.claude-safari-bridge', 'site-scout.json'));
  } finally {
    if (before === undefined) delete process.env.SITE_SCOUT_FILE;
    else process.env.SITE_SCOUT_FILE = before;
  }
});

test('noteSite stores notes and siteNotes returns them sorted by quality, descending', () => {
  const file = tempFile();
  assert.equal(noteSite({ host: 'jobs.example.com', country: 'AE', quality: 3, notes: 'Mid listings' }, { file }).ok, true);
  assert.equal(noteSite({ host: 'careers.example.org', country: 'AE', quality: 5, notes: 'Best filters' }, { file }).ok, true);
  assert.equal(noteSite({ host: 'other.example.net', country: 'SG', quality: 4, notes: 'Other country' }, { file }).ok, true);
  const notes = siteNotes('AE', { file });
  assert.deepEqual(
    notes.map((n) => [n.host, n.quality]),
    [
      ['careers.example.org', 5],
      ['jobs.example.com', 3],
    ],
  );
  assert.deepEqual(Object.keys(notes[0]).sort(), ['country', 'host', 'notes', 'quality']);
  assert.equal(notes[0].notes, 'Best filters');
});

test('noteSite overwrites the note for the same host, so there is one entry per host', () => {
  const file = tempFile();
  noteSite({ host: 'jobs.example.com', country: 'AE', quality: 2, notes: 'First' }, { file });
  noteSite({ host: 'jobs.example.com', country: 'AE', quality: 4, notes: 'Second' }, { file });
  const notes = siteNotes('AE', { file });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].notes, 'Second');
  assert.equal(notes[0].quality, 4);
});

test('noteSite refuses a quality that is not an integer from 1 to 5', () => {
  const file = tempFile();
  for (const quality of [0, 6, -1, 2.5, '3', null, undefined]) {
    const r = noteSite({ host: 'jobs.example.com', country: 'AE', quality, notes: 'x' }, { file });
    assert.equal(r.ok, false, `quality ${String(quality)} should be refused`);
    assert.equal(typeof r.error, 'string');
  }
  assert.deepEqual(siteNotes('AE', { file }), []);
});

test('noteSite refuses an invalid host and a single-label host', () => {
  const file = tempFile();
  assert.equal(noteSite({ host: '', country: 'AE', quality: 3, notes: 'x' }, { file }).ok, false);
  assert.equal(noteSite({ host: 'localhost', country: 'AE', quality: 3, notes: 'x' }, { file }).ok, false);
  assert.equal(noteSite({ host: 'com', country: 'AE', quality: 3, notes: 'x' }, { file }).ok, false);
});

test('noteSite refuses notes with an email address, an 8+ digit run, or over 300 characters', () => {
  const file = tempFile();
  const base = { host: 'jobs.example.com', country: 'AE', quality: 3 };
  assert.equal(noteSite({ ...base, notes: 'Contact hr@example.com' }, { file }).ok, false);
  assert.equal(noteSite({ ...base, notes: 'Ref 12345678 here' }, { file }).ok, false);
  assert.equal(noteSite({ ...base, notes: 'x'.repeat(301) }, { file }).ok, false);
  assert.equal(noteSite({ ...base, notes: 'x'.repeat(300) }, { file }).ok, true);
  assert.equal(noteSite({ ...base, notes: 'Lists 1234567 jobs' }, { file }).ok, true);
});

test('noteSite refuses a non-string country or notes', () => {
  const file = tempFile();
  assert.equal(noteSite({ host: 'jobs.example.com', country: 7, quality: 3, notes: 'x' }, { file }).ok, false);
  assert.equal(noteSite({ host: 'jobs.example.com', country: 'AE', quality: 3, notes: ['x'] }, { file }).ok, false);
});

test('a corrupt or missing store reads as empty and is replaced on the next write', () => {
  const file = tempFile();
  assert.deepEqual(siteNotes('AE', { file }), []);
  assert.deepEqual(pendingSites({ file }), []);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(siteNotes('AE', { file }), []);
  assert.deepEqual(pendingSites({ file }), []);
  assert.equal(noteSite({ host: 'jobs.example.com', country: 'AE', quality: 3, notes: 'ok' }, { file }).ok, true);
  assert.equal(siteNotes('AE', { file }).length, 1);
});

test('the store file is written with mode 0600', () => {
  const file = tempFile();
  noteSite({ host: 'jobs.example.com', country: 'AE', quality: 3, notes: 'ok' }, { file });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('requestSite says already-allowed for a host under an allowed site', () => {
  const file = tempFile();
  const r = requestSite({ host: 'jobs.example.com', country: 'AE', reason: 'Listings' }, { file, allowed: ['example.com'] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'already-allowed');
  assert.deepEqual(pendingSites({ file }), []);
});

test('requestSite refuses a bank-like host and records nothing', () => {
  const file = tempFile();
  const r = requestSite({ host: 'bank.example.net', country: 'AE', reason: 'Jobs' }, { file, allowed: [] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'refused');
  assert.equal(typeof r.error, 'string');
  assert.deepEqual(pendingSites({ file }), []);
});

test('requestSite refuses an invalid host', () => {
  const file = tempFile();
  const r = requestSite({ host: 'not a host', country: 'AE', reason: 'Jobs' }, { file, allowed: [] });
  assert.equal(r.status, 'refused');
  assert.equal(requestSite({ host: 'localhost', country: 'AE', reason: 'Jobs' }, { file, allowed: [] }).status, 'refused');
});

test('requestSite refuses a reason with an email address or an 8+ digit run', () => {
  const file = tempFile();
  assert.equal(
    requestSite({ host: 'careers.example.org', country: 'AE', reason: 'Mail a@example.com' }, { file, allowed: [] }).status,
    'refused',
  );
  assert.equal(
    requestSite({ host: 'careers.example.org', country: 'AE', reason: 'Phone 12345678' }, { file, allowed: [] }).status,
    'refused',
  );
  assert.deepEqual(pendingSites({ file }), []);
});

test('a repeated request for the same host stays one pending entry', () => {
  const file = tempFile();
  const first = requestSite({ host: 'careers.example.org', country: 'AE', reason: 'Good listings' }, { file, allowed: [] });
  const second = requestSite({ host: 'careers.example.org', country: 'AE', reason: 'Still good' }, { file, allowed: [] });
  assert.equal(first.status, 'pending');
  assert.equal(second.status, 'pending');
  const pending = pendingSites({ file });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].host, 'careers.example.org');
  assert.equal(pending[0].country, 'AE');
  assert.equal(pending[0].reason, 'Still good');
});

test('pendingSites lists each request with host, country and reason', () => {
  const file = tempFile();
  requestSite({ host: 'careers.example.org', country: 'AE', reason: 'Listings' }, { file, allowed: [] });
  requestSite({ host: 'jobs.example.com', country: 'SG', reason: 'Other market' }, { file, allowed: [] });
  const pending = pendingSites({ file });
  assert.deepEqual(
    pending.map((p) => [p.host, p.country, p.reason]),
    [
      ['careers.example.org', 'AE', 'Listings'],
      ['jobs.example.com', 'SG', 'Other market'],
    ],
  );
});

test('resolveSite approved removes the pending entry and records the outcome', () => {
  const file = tempFile();
  requestSite({ host: 'careers.example.org', country: 'AE', reason: 'Listings' }, { file, allowed: [] });
  const r = resolveSite('careers.example.org', 'approved', { file });
  assert.equal(r.ok, true);
  assert.deepEqual(pendingSites({ file }), []);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.resolved.some((x) => x.host === 'careers.example.org' && x.outcome === 'approved'));
});

test('resolveSite denied removes the pending entry and records the outcome', () => {
  const file = tempFile();
  requestSite({ host: 'careers.example.org', country: 'AE', reason: 'Listings' }, { file, allowed: [] });
  assert.equal(resolveSite('careers.example.org', 'denied', { file }).ok, true);
  assert.deepEqual(pendingSites({ file }), []);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.resolved.some((x) => x.host === 'careers.example.org' && x.outcome === 'denied'));
});

test('resolveSite refuses an unknown host or a bad outcome', () => {
  const file = tempFile();
  assert.equal(resolveSite('jobs.example.com', 'approved', { file }).ok, false);
  requestSite({ host: 'careers.example.org', country: 'AE', reason: 'Listings' }, { file, allowed: [] });
  assert.equal(resolveSite('careers.example.org', 'maybe', { file }).ok, false);
  assert.equal(pendingSites({ file }).length, 1);
});

test('noteSite and requestSite refuse phone-like text and accept ordinary numbers', () => {
  const file = tempFile();
  const base = { host: 'jobs.example.com', country: 'AE', quality: 3 };
  for (const text of ['Call +971 50 123 4567', 'Call 050-123-4567', 'Call (555) 123-4567', 'Reach @test_user']) {
    assert.equal(noteSite({ ...base, notes: text }, { file }).ok, false, text);
    assert.equal(
      requestSite({ host: 'careers.example.org', country: 'AE', reason: text }, { file, allowed: [] }).status,
      'refused',
      text,
    );
  }
  for (const text of ['Posts 2019-2021 archive', '3 to 5 years', '10-20 employees', '100 applicants']) {
    assert.equal(noteSite({ ...base, notes: text }, { file }).ok, true, text);
  }
});
