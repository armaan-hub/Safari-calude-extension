// Tests for the profile markdown generator and section search (bridge/profile-md.mjs) and the
// `profile-md` CLI subcommand. Built-ins only. Fictional data only ("Test User", fake phone/email).
// Every test works in its own temp directory; the real profile.json is never read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProfileMd, extractNotes, writeProfileMd, searchProfile } from '../profile-md.mjs';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(TESTS_DIR, '..', 'jobwatch.mjs');

const PROFILE = {
  _comment: 'internal, must not appear',
  name: 'Test User',
  email: 'test@example.com',
  phone: '+971-50-000-0000',
  languages: { english: null, german: 'A2' },
  skills: ['SQL', 'Python'],
  salary: { uae_min_aed: 12000 },
  empty_list: [],
  notes_hint: null,
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'profile-md-test-'));
}

function writeProfile(dir, profile = PROFILE) {
  const file = path.join(dir, 'profile.json');
  fs.writeFileSync(file, JSON.stringify(profile));
  return file;
}

function runCli(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'profile-md'], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('renderProfileMd: Title Case sections, bullets, NOT PROVIDED for empty values', () => {
  const md = renderProfileMd(PROFILE);
  assert.match(md, /^# Profile/);
  assert.match(md, /^## Name$/m);
  assert.doesNotMatch(md, /^## Uae Min Aed$/m, 'nested key is not promoted to a section');
  assert.match(md, /^## Notes Hint$/m);
  assert.match(md, /^## Empty List\nNOT PROVIDED$/m);
  assert.match(md, /^- english: NOT PROVIDED$/m);
  assert.match(md, /^- german: A2$/m);
  assert.match(md, /^- uae_min_aed: 12000$/m);
  assert.match(md, /^- SQL$/m);
  assert.match(md, /^## Notes \(yours\)$/m);
  assert.match(md, /<!-- notes:start -->[\s\S]*<!-- notes:end -->/);
});

test('renderProfileMd: a null top-level value renders the section body as NOT PROVIDED', () => {
  const md = renderProfileMd({ notes_hint: null, name: '' });
  assert.match(md, /^## Notes Hint\nNOT PROVIDED$/m);
  assert.match(md, /^## Name\nNOT PROVIDED$/m);
});

test('renderProfileMd: keys starting with underscore are skipped', () => {
  const md = renderProfileMd(PROFILE);
  assert.ok(!md.includes('internal, must not appear'));
  assert.ok(!/^## _/m.test(md));
});

test('renderProfileMd: notes are placed between the markers', () => {
  const md = renderProfileMd({ name: 'Test User' }, 'Prefers mornings');
  assert.equal(extractNotes(md), 'Prefers mornings');
});

test('extractNotes returns empty string when there are no markers', () => {
  assert.equal(extractNotes('# Profile\n\nnothing here'), '');
});

test('writeProfileMd regenerates and keeps the notes written between the markers', () => {
  const dir = tempDir();
  try {
    const profileFile = writeProfile(dir);
    const outFile = path.join(dir, 'out', 'profile.md');
    writeProfileMd({ profileFile, outFile });
    const first = fs.readFileSync(outFile, 'utf8');
    fs.writeFileSync(outFile, first.replace('<!-- notes:start -->\n', '<!-- notes:start -->\nCall before 9am\n'));

    writeProfile(dir, { ...PROFILE, name: 'Test Person' });
    const result = writeProfileMd({ profileFile, outFile });
    const second = fs.readFileSync(outFile, 'utf8');

    assert.match(second, /^## Name\nTest Person$/m);
    assert.ok(!second.includes('Test User'));
    assert.equal(extractNotes(second), 'Call before 9am');
    assert.equal(result.file, outFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeProfileMd reports the section count without counting Notes', () => {
  const dir = tempDir();
  try {
    const profileFile = writeProfile(dir);
    const outFile = path.join(dir, 'profile.md');
    const { sections } = writeProfileMd({ profileFile, outFile });
    // name, email, phone, languages, skills, salary, empty_list, notes_hint
    assert.equal(sections, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeProfileMd writes the file with mode 0600', () => {
  const dir = tempDir();
  try {
    const profileFile = writeProfile(dir);
    const outFile = path.join(dir, 'profile.md');
    writeProfileMd({ profileFile, outFile });
    assert.equal(fs.statSync(outFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeProfileMd throws a clear error when profile.json is missing or invalid', () => {
  const dir = tempDir();
  try {
    const outFile = path.join(dir, 'profile.md');
    assert.throws(
      () => writeProfileMd({ profileFile: path.join(dir, 'absent.json'), outFile }),
      /profile\.json/,
    );
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    assert.throws(() => writeProfileMd({ profileFile: bad, outFile }), /not valid JSON/);
    assert.ok(!fs.existsSync(outFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchProfile: a salary query returns only the salary section', () => {
  const md = renderProfileMd(PROFILE);
  const res = searchProfile(md, 'salary');
  assert.equal(res.sections.length, 1);
  assert.equal(res.sections[0].heading, 'Salary');
  assert.ok(res.sections[0].text.includes('12000'));
  assert.equal(res.truncated, false);
});

test('searchProfile: empty and punctuation-only queries return headings only', () => {
  const md = renderProfileMd(PROFILE);
  for (const q of ['', 'a ?']) {
    const res = searchProfile(md, q);
    assert.deepEqual(res.sections, []);
    assert.equal(res.truncated, false);
    assert.match(res.note, /^Sections: /);
    assert.ok(res.note.includes('Salary'));
    assert.ok(!res.note.includes('12000'), 'no section bodies in the note');
  }
});

test('searchProfile: a query matching nothing returns no sections and a note', () => {
  const md = renderProfileMd(PROFILE);
  const res = searchProfile(md, 'zebra');
  assert.deepEqual(res.sections, []);
  assert.equal(res.truncated, false);
  assert.match(res.note, /^No matching section\. Sections: /);
});

test('searchProfile: never includes the notes marker lines', () => {
  const md = renderProfileMd(PROFILE, 'Prefers mornings');
  const res = searchProfile(md, 'mornings');
  assert.equal(res.sections.length, 1);
  assert.equal(res.sections[0].heading, 'Notes (yours)');
  assert.ok(res.sections[0].text.includes('Prefers mornings'));
  assert.ok(!res.sections[0].text.includes('notes:start'));
  assert.ok(!res.sections[0].text.includes('notes:end'));
});

test('searchProfile: maxChars caps the summed text and sets truncated', () => {
  const md = renderProfileMd(PROFILE);
  const res = searchProfile(md, 'languages', { maxChars: 5 });
  const total = res.sections.reduce((n, s) => n + s.text.length, 0);
  assert.ok(total <= 5);
  assert.equal(res.truncated, true);
});

test('CLI profile-md prints the path and count, never the profile content', async () => {
  const dir = tempDir();
  try {
    writeProfile(dir);
    const outFile = path.join(dir, 'out', 'profile.md');
    const res = await runCli({
      HOME: dir,
      JOBWATCH_DIR: dir,
      ASSISTANT_PROFILE_FILE: outFile,
    });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^profile\.md written: .+ \(\d+ sections\)\n$/);
    assert.ok(!res.stdout.includes('Test User'));
    assert.ok(!res.stdout.includes('test@example.com'));
    assert.ok(fs.existsSync(outFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI profile-md exits 1 with only the message when profile.json is missing', async () => {
  const dir = tempDir();
  try {
    const res = await runCli({
      HOME: dir,
      JOBWATCH_DIR: dir,
      ASSISTANT_PROFILE_FILE: path.join(dir, 'profile.md'),
    });
    assert.equal(res.code, 1);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /profile\.json/);
    assert.ok(!res.stderr.includes('Test User'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
