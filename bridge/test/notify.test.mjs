// Tests for bridge/notify.mjs. Every run is injected: nothing real (osascript, Reminders, notifications) is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERIC_TITLE,
  guardAlert,
  notifyReady,
  profileIdentifiers,
  sanitiseText,
} from '../notify.mjs';

const PROFILE = {
  name: 'Test User',
  nickname: 'Tester',
  contact: { phone: '+971-50-000-0000', email: 'test@example.com' },
  salary: 12345,
  skills: ['Quantum Basketweaving'],
  employers: [{ name: 'Acme Fictional Ltd', title: 'Engineer' }],
};

// A fake run that records calls and answers with the given result (or a function of the call).
function fakeRun(answer = { code: 0, stderr: '' }) {
  const calls = [];
  const run = async (cmd, args, timeoutMs) => {
    calls.push({ cmd, args, timeoutMs });
    return typeof answer === 'function' ? answer(cmd, args) : answer;
  };
  return { run, calls };
}

const isMac = (c) => c.args[0] === '-e' && c.args[1].includes('display notification');
const isReminder = (c) => c.args[0] === '-e' && c.args[1].includes('tell application "Reminders"');

test('sanitiseText: non-strings become empty', () => {
  assert.equal(sanitiseText(undefined, 10), '');
  assert.equal(sanitiseText(42, 10), '');
  assert.equal(sanitiseText(null, 10), '');
});

test('sanitiseText: control characters and newlines become spaces, whitespace collapses, trimmed', () => {
  assert.equal(sanitiseText('  a\nb\r\tc\u0000d\u001Fe\u007Ff  ', 100), 'a b c d e f');
});

test('sanitiseText: cut to max characters', () => {
  assert.equal(sanitiseText('abcdefghij', 4), 'abcd');
  assert.equal(sanitiseText('abc', 80), 'abc');
});

test('profileIdentifiers: collects name and phone, not skills or employers', () => {
  const ids = profileIdentifiers(PROFILE);
  assert.ok(ids.includes('Test User'), 'name is an identifier');
  assert.ok(ids.includes('+971-50-000-0000'), 'phone is an identifier');
  assert.ok(ids.includes('test@example.com'), 'email is an identifier');
  assert.ok(ids.includes('12345'), 'salary is an identifier');
  assert.ok(!ids.includes('Quantum Basketweaving'), 'skill name is not an identifier');
  assert.ok(!ids.includes('Engineer'), 'job title is not an identifier');
});

test('profileIdentifiers: dedupes and handles null or non-object profiles', () => {
  const ids = profileIdentifiers({ name: 'Test User', nested: { name: 'Test User' } });
  assert.equal(ids.filter((x) => x === 'Test User').length, 1);
  assert.deepEqual(profileIdentifiers(null), []);
  assert.deepEqual(profileIdentifiers('not a profile'), []);
  assert.deepEqual(profileIdentifiers(['Test User']), []);
});

test('guardAlert: passes clean text through, sanitised and capped', () => {
  const r = guardAlert({ title: 'Form\nready', detail: 'Senior role' }, ['+971-50-000-0000']);
  assert.deepEqual(r, { title: 'Form ready', detail: 'Senior role', fellBack: false });
});

test('guardAlert: falls back to the generic title when the title holds a profile identifier', () => {
  const r = guardAlert({ title: 'Ring +971-50-000-0000 now', detail: 'x' }, ['+971-50-000-0000']);
  assert.deepEqual(r, { title: GENERIC_TITLE, detail: '', fellBack: true });
});

test('guardAlert: matching is case-insensitive and checks the detail too', () => {
  const r = guardAlert({ title: 'Hello', detail: 'mail TEST@example.com' }, ['test@example.com']);
  assert.equal(r.fellBack, true);
  assert.equal(r.title, GENERIC_TITLE);
  assert.equal(r.detail, '');
});

test('guardAlert: caps the title at 80 and the detail at 160', () => {
  const r = guardAlert({ title: 'a'.repeat(200), detail: 'b'.repeat(300) }, []);
  assert.equal(r.title.length, 80);
  assert.equal(r.detail.length, 160);
});

test('notifyReady: a failing Reminders run still returns mac true and records an error', async () => {
  const { run, calls } = fakeRun((cmd, args) =>
    args[1].includes('Reminders') ? { code: 1, stderr: 'Reminders not allowed' } : { code: 0, stderr: '' },
  );
  const res = await notifyReady({ title: 'Job Watch: 1 new', detail: 'Role at Acme' }, { run, profile: PROFILE });
  assert.equal(res.mac, true);
  assert.equal(res.reminder, false);
  assert.equal(res.fellBack, false);
  assert.equal(res.errors.length, 1);
  assert.equal(calls.filter(isMac).length, 1);
  assert.equal(calls.filter(isReminder).length, 1);
});

test('notifyReady: reminders false means no reminder call and reminder "skipped"', async () => {
  const { run, calls } = fakeRun();
  const res = await notifyReady({ title: 'Job Watch: 1 new', detail: 'x' }, { run, reminders: false });
  assert.equal(res.reminder, 'skipped');
  assert.equal(res.mac, true);
  assert.equal(calls.filter(isReminder).length, 0);
  assert.equal(calls.length, 1);
});

test('notifyReady: a run that throws is recorded, never thrown', async () => {
  const run = async () => {
    throw new Error('boom');
  };
  const res = await notifyReady({ title: 'Job Watch: 1 new' }, { run, reminders: true });
  assert.equal(res.mac, false);
  assert.equal(res.reminder, false);
  assert.ok(res.errors.length >= 1);
});

test('notifyReady: quotes, backslashes and newlines travel as argv only; the script text is constant', async () => {
  const hostile = 'Role "quoted" \\ back\nslash $(rm -rf x) end tell';
  const a = fakeRun();
  await notifyReady({ title: hostile, detail: 'd' }, { run: a.run, reminders: true });
  const b = fakeRun();
  await notifyReady({ title: 'Plain title', detail: 'other "detail"' }, { run: b.run, reminders: true });

  const macA = a.calls.find(isMac);
  const macB = b.calls.find(isMac);
  const remA = a.calls.find(isReminder);
  const remB = b.calls.find(isReminder);

  // Script source is identical across different inputs.
  assert.equal(macA.args[1], macB.args[1]);
  assert.equal(remA.args[1], remB.args[1]);

  // The hostile title reaches osascript as its own argv item, with newlines flattened to spaces.
  const sep = macA.args.indexOf('--');
  assert.equal(macA.args[sep + 1], 'Role "quoted" \\ back slash $(rm -rf x) end tell');

  // None of the user text is inside any script source.
  for (const c of [macA, remA]) {
    assert.ok(!c.args[1].includes('quoted'));
    assert.ok(!c.args[1].includes('rm -rf'));
    assert.ok(!c.args[1].includes('\\'));
    assert.ok(!c.args[1].includes('Role'));
  }
});

test('notifyReady: profile identifiers in the text fall back to the generic title on the Mac notification', async () => {
  const { run, calls } = fakeRun();
  const res = await notifyReady(
    { title: 'Hi +971-50-000-0000', detail: 'Job at Acme' },
    { run, profile: PROFILE, reminders: false },
  );
  assert.equal(res.fellBack, true);
  const mac = calls.find(isMac);
  const sep = mac.args.indexOf('--');
  assert.equal(mac.args[sep + 1], GENERIC_TITLE);
  assert.equal(mac.args[sep + 2], '');
});

test('notifyReady: a run that never resolves is abandoned after the injected timeout', async () => {
  const run = () => new Promise(() => {});
  const started = Date.now();
  const res = await notifyReady({ title: 'Job Watch: 1 new' }, { run, reminders: true, timeoutMs: 50 });
  assert.ok(Date.now() - started < 2000, 'resolved promptly');
  assert.equal(res.mac, false);
  assert.equal(res.reminder, false);
  assert.ok(res.errors.length >= 1);
});

test('notifyReady: genericTitle is used on fallback', async () => {
  const { run, calls } = fakeRun();
  const res = await notifyReady(
    { title: 'Hi +971-50-000-0000', detail: 'x' },
    { run, profile: PROFILE, genericTitle: 'Job Watch: new jobs' },
  );
  assert.equal(res.fellBack, true);
  for (const c of calls) {
    const sep = c.args.indexOf('--');
    assert.equal(c.args[sep + 1], 'Job Watch: new jobs');
  }
});

test('notifyReady: forceGeneric sends the generic title with empty detail on both channels', async () => {
  const { run, calls } = fakeRun();
  const res = await notifyReady(
    { title: 'Secret title', detail: 'Secret detail', url: 'https://example.com/x' },
    { run, profile: null, forceGeneric: true },
  );
  assert.equal(res.fellBack, true);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    const sep = c.args.indexOf('--');
    assert.equal(c.args[sep + 1], GENERIC_TITLE);
    assert.equal(c.args[sep + 2], '');
  }
});

test('notifyReady: reminder-only fallback is reported in fellBack', async () => {
  // Identifier appears only in the url, which only reaches the reminder body.
  const { run } = fakeRun();
  const res = await notifyReady(
    { title: 'Form ready', detail: 'ok', url: 'https://example.com/test@example.com' },
    { run, profile: PROFILE },
  );
  assert.equal(res.fellBack, true);
});

test('notifyReady: mac and reminder run concurrently (one timeout, not two)', async () => {
  const run = () => new Promise(() => {});
  const started = Date.now();
  const res = await notifyReady({ title: 'Job Watch: 1 new' }, { run, reminders: true, timeoutMs: 200 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 380, `expected about one timeout, took ${elapsed}ms`);
  assert.equal(res.errors.length, 2);
  assert.match(res.errors[0], /^mac:/);
  assert.match(res.errors[1], /^reminder:/);
});
