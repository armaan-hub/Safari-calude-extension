// Fit store tests. Every test uses its own temp directory (never the real ~/.claude-safari-bridge). Fictional data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fitLogFile, recordFit, getFit, listFits, hashRules, looksPersonal } from '../fit-store.mjs';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-store-test-'));
  return { dir, file: path.join(dir, 'fit-log.json') };
}

function entry(overrides = {}) {
  return {
    job_url: 'https://jobs.example.test/view/1001',
    title: 'Data Analyst',
    company: 'Example Corp',
    verdict: 'strong',
    score: 82,
    reasons: ['Skills match the must-haves', 'Location is right'],
    gaps: ['No Power BI certificate'],
    ...overrides,
  };
}

const RULES = hashRules('rules text one', 'rules text two');

test('rejects a verdict outside strong, stretch and no', () => {
  const { file } = tempFile();
  const res = recordFit(entry({ verdict: 'maybe' }), { file, rulesHash: RULES });
  assert.equal(res.ok, false);
  assert.equal(typeof res.error, 'string');
  assert.deepEqual(listFits({ file }), []);
});

test('accepts each of the three verdicts', () => {
  const { file } = tempFile();
  for (const verdict of ['strong', 'stretch', 'no']) {
    const res = recordFit(entry({ job_url: `https://jobs.example.test/${verdict}`, verdict }), { file, rulesHash: RULES });
    assert.equal(res.ok, true, verdict);
  }
  assert.equal(listFits({ file }).length, 3);
});

test('rejects score -1, 101, non-integers and non-numbers', () => {
  const { file } = tempFile();
  for (const score of [-1, 101, 50.5, NaN, '50', null, undefined]) {
    const res = recordFit(entry({ score }), { file, rulesHash: RULES });
    assert.equal(res.ok, false, String(score));
  }
  assert.deepEqual(listFits({ file }), []);
});

test('accepts scores 0 and 100 at the boundaries', () => {
  const { file } = tempFile();
  assert.equal(recordFit(entry({ job_url: 'https://j.example.test/a', score: 0 }), { file, rulesHash: RULES }).ok, true);
  assert.equal(recordFit(entry({ job_url: 'https://j.example.test/b', score: 100 }), { file, rulesHash: RULES }).ok, true);
});

test('rejects reasons containing an email address', () => {
  const { file } = tempFile();
  const res = recordFit(entry({ reasons: ['Contact person@example.test for details'] }), { file, rulesHash: RULES });
  assert.equal(res.ok, false);
  assert.deepEqual(listFits({ file }), []);
});

test('rejects reasons containing a run of 8 or more digits', () => {
  const { file } = tempFile();
  const res = recordFit(entry({ reasons: ['Phone 05012345678 on file'] }), { file, rulesHash: RULES });
  assert.equal(res.ok, false);
});

test('rejects gaps containing an email address or a long digit run', () => {
  const { file } = tempFile();
  assert.equal(recordFit(entry({ gaps: ['ask at hr@example.test'] }), { file, rulesHash: RULES }).ok, false);
  assert.equal(recordFit(entry({ gaps: ['ID 12345678'] }), { file, rulesHash: RULES }).ok, false);
});

test('allows a digit run shorter than 8 digits', () => {
  const { file } = tempFile();
  const res = recordFit(entry({ reasons: ['Two years of experience since 2019'] }), { file, rulesHash: RULES });
  assert.equal(res.ok, true);
});

test('rejects reasons that are not an array of strings', () => {
  const { file } = tempFile();
  assert.equal(recordFit(entry({ reasons: 'one reason' }), { file, rulesHash: RULES }).ok, false);
  assert.equal(recordFit(entry({ reasons: ['ok', 7] }), { file, rulesHash: RULES }).ok, false);
});

test('rejects an empty job_url, title or company', () => {
  const { file } = tempFile();
  assert.equal(recordFit(entry({ job_url: '' }), { file, rulesHash: RULES }).ok, false);
  assert.equal(recordFit(entry({ title: '   ' }), { file, rulesHash: RULES }).ok, false);
  assert.equal(recordFit(entry({ company: '' }), { file, rulesHash: RULES }).ok, false);
});

test('stores an entry and reads it back with rulesHash and a timestamp', () => {
  const { file } = tempFile();
  const res = recordFit(entry(), { file, rulesHash: RULES });
  assert.equal(res.ok, true);
  const got = getFit('https://jobs.example.test/view/1001', { file, rulesHash: RULES });
  assert.equal(got.title, 'Data Analyst');
  assert.equal(got.company, 'Example Corp');
  assert.equal(got.verdict, 'strong');
  assert.equal(got.score, 82);
  assert.deepEqual(got.reasons, ['Skills match the must-haves', 'Location is right']);
  assert.deepEqual(got.gaps, ['No Power BI certificate']);
  assert.equal(got.rules_hash, RULES);
  assert.ok(!Number.isNaN(Date.parse(got.recorded_at)));
});

test('gaps default to an empty list when omitted', () => {
  const { file } = tempFile();
  const e = entry();
  delete e.gaps;
  assert.equal(recordFit(e, { file, rulesHash: RULES }).ok, true);
  assert.deepEqual(getFit(e.job_url, { file, rulesHash: RULES }).gaps, []);
});

test('the same job_url overwrites the earlier entry', () => {
  const { file } = tempFile();
  recordFit(entry({ verdict: 'stretch', score: 60 }), { file, rulesHash: RULES });
  recordFit(entry({ verdict: 'no', score: 10 }), { file, rulesHash: RULES });
  const all = listFits({ file });
  assert.equal(all.length, 1);
  assert.equal(all[0].verdict, 'no');
  assert.equal(all[0].score, 10);
});

test('getFit returns null for an unknown job_url', () => {
  const { file } = tempFile();
  recordFit(entry(), { file, rulesHash: RULES });
  assert.equal(getFit('https://jobs.example.test/none', { file, rulesHash: RULES }), null);
});

test('getFit returns null after the rules hash changes', () => {
  const { file } = tempFile();
  recordFit(entry(), { file, rulesHash: RULES });
  const changed = hashRules('rules text one', 'rules text changed');
  assert.notEqual(changed, RULES);
  assert.equal(getFit('https://jobs.example.test/view/1001', { file, rulesHash: changed }), null);
  assert.notEqual(getFit('https://jobs.example.test/view/1001', { file, rulesHash: RULES }), null);
});

test('listFits filters by verdict', () => {
  const { file } = tempFile();
  recordFit(entry({ job_url: 'https://j.example.test/1', verdict: 'strong' }), { file, rulesHash: RULES });
  recordFit(entry({ job_url: 'https://j.example.test/2', verdict: 'stretch' }), { file, rulesHash: RULES });
  recordFit(entry({ job_url: 'https://j.example.test/3', verdict: 'stretch' }), { file, rulesHash: RULES });
  assert.equal(listFits({ file }).length, 3);
  const stretch = listFits({ file, verdict: 'stretch' });
  assert.equal(stretch.length, 2);
  assert.ok(stretch.every((e) => e.verdict === 'stretch'));
});

test('writes atomically with mode 0600 and leaves no temp files behind', () => {
  const { dir, file } = tempFile();
  assert.equal(recordFit(entry(), { file, rulesHash: RULES }).ok, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const names = fs.readdirSync(dir);
  assert.deepEqual(names, ['fit-log.json']);
});

test('a corrupt file reads as an empty list and never throws', () => {
  const { file } = tempFile();
  fs.writeFileSync(file, '{this is not json', { mode: 0o600 });
  assert.deepEqual(listFits({ file }), []);
  assert.equal(getFit('https://jobs.example.test/view/1001', { file, rulesHash: RULES }), null);
  assert.deepEqual(listFits({ file, verdict: 'strong' }), []);
});

test('a file holding a non-array reads as an empty list', () => {
  const { file } = tempFile();
  fs.writeFileSync(file, JSON.stringify({ hello: 'world' }), { mode: 0o600 });
  assert.deepEqual(listFits({ file }), []);
});

test('a missing file reads as an empty list and never throws', () => {
  const { dir } = tempFile();
  const file = path.join(dir, 'does-not-exist', 'fit-log.json');
  assert.deepEqual(listFits({ file }), []);
  assert.equal(getFit('https://jobs.example.test/view/1001', { file, rulesHash: RULES }), null);
});

test('recording over a corrupt file recovers it', () => {
  const { file } = tempFile();
  fs.writeFileSync(file, '[[[', { mode: 0o600 });
  assert.equal(recordFit(entry(), { file, rulesHash: RULES }).ok, true);
  assert.equal(listFits({ file }).length, 1);
});

test('fitLogFile honours FIT_LOG_FILE and otherwise uses the jobwatch directory', () => {
  const saved = process.env.FIT_LOG_FILE;
  try {
    process.env.FIT_LOG_FILE = '/fictional/custom/fit.json';
    assert.equal(fitLogFile(), '/fictional/custom/fit.json');
    delete process.env.FIT_LOG_FILE;
    assert.equal(fitLogFile(), path.join(os.homedir(), '.claude-safari-bridge', 'jobwatch', 'fit-log.json'));
  } finally {
    if (saved === undefined) delete process.env.FIT_LOG_FILE;
    else process.env.FIT_LOG_FILE = saved;
  }
});

test('hashRules returns the hex sha256 of the texts joined', () => {
  const expected = crypto.createHash('sha256').update(['alpha', 'beta'].join('\n')).digest('hex');
  assert.equal(hashRules('alpha', 'beta'), expected);
  assert.match(hashRules('alpha'), /^[0-9a-f]{64}$/);
  assert.notEqual(hashRules('alpha', 'beta'), hashRules('alpha', 'gamma'));
});

test('rejects phone numbers written with spaces, dashes, brackets or a leading plus', () => {
  const { file } = tempFile();
  for (const text of ['Call +971 50 123 4567', 'Call 050-123-4567', 'Call (555) 123-4567', 'Call +44 20 7946 0958', 'Handle @test_user here']) {
    assert.equal(recordFit(entry({ reasons: [text] }), { file, rulesHash: RULES }).ok, false, text);
  }
  assert.deepEqual(listFits({ file }), []);
});

test('accepts year ranges and small numbers', () => {
  const { file } = tempFile();
  const reasons = ['Worked 2019-2021', '3 to 5 years asked', '10-20 employees', '100 applicants'];
  assert.equal(recordFit(entry({ reasons }), { file, rulesHash: RULES }).ok, true);
});

test('looksPersonal flags emails, handles, long digits and phone-like groups only', () => {
  assert.equal(looksPersonal('a@example.test'), true);
  assert.equal(looksPersonal('+971 50 123 4567'), true);
  assert.equal(looksPersonal('2019-2021'), false);
  assert.equal(looksPersonal('3 to 5 years'), false);
  assert.equal(looksPersonal(undefined), false);
});
