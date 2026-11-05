import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isQuietHours,
  gateApplicants,
  gatePosted,
  isExcludedRole,
  payBelowFloor,
  safeJobUrl,
  evaluateJob,
  pickCombos,
  parseDiscoverResult,
  buildDiscoverPrompt,
} from '../jobwatch-rules.mjs';
import { TEST_PROFILE, rawJob } from './fixtures.mjs';

const QUIET = { start: '23:00', end: '07:00', tz: 'Asia/Dubai' };

test('isQuietHours uses Dubai time across midnight', () => {
  assert.equal(isQuietHours(new Date('2026-11-03T20:30:00Z'), QUIET), true); // 00:30 Dubai
  assert.equal(isQuietHours(new Date('2026-11-03T03:00:00Z'), QUIET), false); // 07:00 Dubai
  assert.equal(isQuietHours(new Date('2026-11-03T18:59:00Z'), QUIET), false); // 22:59 Dubai
  assert.equal(isQuietHours(new Date('2026-11-03T19:00:00Z'), QUIET), true); // 23:00 Dubai
});

test('gateApplicants accepts under 10 and first-25 phrasing', () => {
  assert.deepEqual(gateApplicants('7 applicants'), { ok: true, tag: 'exact', count: 7 });
  assert.equal(gateApplicants('9 applicants').ok, true);
  assert.equal(gateApplicants('10 applicants').ok, false);
  assert.equal(gateApplicants('Be among the first 25 applicants').ok, false);
  assert.equal(gateApplicants('First 10 applicants').ok, true);
  assert.equal(gateApplicants('First 11 applicants').ok, false);
  assert.equal(gateApplicants('First 25 applicants').ok, false);
  assert.equal(gateApplicants('7 applicants').ok, true);
  assert.equal(gateApplicants('10 applicants').ok, false);
  assert.equal(gateApplicants('Over 100 applicants').ok, false);
  assert.equal(gateApplicants('150 people clicked apply').ok, false);
  assert.equal(gateApplicants('').ok, false);
  assert.equal(gateApplicants(null).ok, false);
});

test('gatePosted is true only for minutes, hours or just now', () => {
  assert.equal(gatePosted('3 hours ago'), true);
  assert.equal(gatePosted('12 minutes ago'), true);
  assert.equal(gatePosted('Just now'), true);
  assert.equal(gatePosted('Reposted 2 hours ago'), true);
  assert.equal(gatePosted('1 day ago'), false);
  assert.equal(gatePosted('2 weeks ago'), false);
  assert.equal(gatePosted(null), false);
});

test('isExcludedRole maps profile terms to stems, case-insensitive', () => {
  const excluded = TEST_PROFILE.search.excluded_roles;
  assert.equal(isExcludedRole('Senior Accountant', excluded), true);
  assert.equal(isExcludedRole('Internal Auditor', excluded), true);
  assert.equal(isExcludedRole('Accounting Manager', excluded), true);
  assert.equal(isExcludedRole('Financial Analyst', excluded), false);
  assert.equal(isExcludedRole('Power BI Developer', excluded), false);
});

test('isExcludedRole catches plural/variant accounting and audit roles', () => {
  const excluded = ['accounting', 'audit'];
  assert.equal(isExcludedRole('Senior Accountants', excluded), true);
  assert.equal(isExcludedRole('Accounts Payable Analyst', excluded), true);
  assert.equal(isExcludedRole('Chartered Accountant', excluded), true);
  assert.equal(isExcludedRole('Auditors', excluded), true);
  assert.equal(isExcludedRole('Financial Analyst', excluded), false);
  assert.equal(isExcludedRole('Power BI Developer', excluded), false);
  assert.equal(isExcludedRole('Data Analyst', excluded), false);
});

test('payBelowFloor compares the upper bound and converts AED yearly', () => {
  const s = TEST_PROFILE.salary;
  assert.equal(payBelowFloor('AED 6,000 per month', 'uae', s), true);
  assert.equal(payBelowFloor('AED 12,000 - 15,000 / month', 'uae', s), false);
  assert.equal(payBelowFloor('AED 90,000 per year', 'uae', s), true); // 7,500 / month
  assert.equal(payBelowFloor('EUR 40,000 per year', 'germany', s), true);
  assert.equal(payBelowFloor('€55k - €65k', 'germany', s), false);
  assert.equal(payBelowFloor(null, 'uae', s), false);
  assert.equal(payBelowFloor('Competitive', 'uae', s), false);
});

test('safeJobUrl keeps only LinkedIn job-view URLs over https', () => {
  assert.deepEqual(safeJobUrl('https://www.linkedin.com/jobs/view/3912345678/?trk=x'), {
    url: 'https://www.linkedin.com/jobs/view/3912345678/',
    id: '3912345678',
  });
  assert.deepEqual(safeJobUrl('https://linkedin.com/jobs/view/1/'), {
    url: 'https://linkedin.com/jobs/view/1/',
    id: '1',
  });
  assert.equal(safeJobUrl('javascript:alert(1)'), null);
  assert.equal(safeJobUrl('https://evil.com/jobs/view/1'), null);
  assert.equal(safeJobUrl('https://www.linkedin.com.evil.com/jobs/view/1'), null);
  assert.equal(safeJobUrl(42), null);
  assert.equal(safeJobUrl(null), null);
});

test('evaluateJob keeps a valid job', () => {
  const r = evaluateJob(rawJob(), { profile: TEST_PROFILE, seenIds: new Set() });
  assert.equal(r.keep, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.id, '3912345678');
});

test('evaluateJob takes the id from the URL, not job_id', () => {
  const r = evaluateJob(rawJob({ job_id: '999' }), { profile: TEST_PROFILE, seenIds: new Set() });
  assert.equal(r.id, '3912345678');
});

test('evaluateJob rejects bad-url', () => {
  const r = evaluateJob(rawJob({ url: 'javascript:alert(1)' }), { profile: TEST_PROFILE, seenIds: new Set() });
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'bad-url');
  assert.equal(r.id, null);
});

test('evaluateJob rejects seen', () => {
  const r = evaluateJob(rawJob(), { profile: TEST_PROFILE, seenIds: new Set(['3912345678']) });
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'seen');
});

test('evaluateJob rejects filter-unconfirmed, after seen and before not-fresh', () => {
  const ctx = { profile: TEST_PROFILE, seenIds: new Set() };
  for (const v of [false, undefined, 'true', null]) {
    const r = evaluateJob(rawJob({ date_filter_confirmed: v }), ctx);
    assert.equal(r.keep, false);
    assert.equal(r.reason, 'filter-unconfirmed');
  }
  const missing = rawJob();
  delete missing.date_filter_confirmed;
  assert.equal(evaluateJob(missing, ctx).reason, 'filter-unconfirmed');
  // seen wins over filter-unconfirmed
  const seen = evaluateJob(rawJob({ date_filter_confirmed: false }), {
    profile: TEST_PROFILE,
    seenIds: new Set(['3912345678']),
  });
  assert.equal(seen.reason, 'seen');
  // filter-unconfirmed wins over not-fresh
  const both = evaluateJob(rawJob({ date_filter_confirmed: false, posted_text: '2 weeks ago' }), ctx);
  assert.equal(both.reason, 'filter-unconfirmed');
  // unconfirmed job still has its id (it is recorded as seen by the caller)
  assert.equal(both.id, '3912345678');
});

test('evaluateJob rejects location-unconfirmed, right after filter-unconfirmed and before not-fresh', () => {
  const ctx = { profile: TEST_PROFILE, seenIds: new Set() };
  for (const v of [false, undefined, 'true', null]) {
    const r = evaluateJob(rawJob({ location_confirmed: v }), ctx);
    assert.equal(r.keep, false);
    assert.equal(r.reason, 'location-unconfirmed');
  }
  const missing = rawJob();
  delete missing.location_confirmed;
  assert.equal(evaluateJob(missing, ctx).reason, 'location-unconfirmed');
  // seen wins
  const seen = evaluateJob(rawJob({ location_confirmed: false }), {
    profile: TEST_PROFILE,
    seenIds: new Set(['3912345678']),
  });
  assert.equal(seen.reason, 'seen');
  // filter-unconfirmed wins over location-unconfirmed
  const both = evaluateJob(rawJob({ date_filter_confirmed: false, location_confirmed: false }), ctx);
  assert.equal(both.reason, 'filter-unconfirmed');
  // location-unconfirmed wins over not-fresh
  const stale = evaluateJob(rawJob({ location_confirmed: false, posted_text: '2 weeks ago' }), ctx);
  assert.equal(stale.reason, 'location-unconfirmed');
  assert.equal(stale.id, '3912345678');
  // confirmed passes
  assert.equal(evaluateJob(rawJob({ location_confirmed: true }), ctx).keep, true);
});

test('evaluateJob rejects not-fresh', () => {
  const r = evaluateJob(rawJob({ posted_text: '2 weeks ago' }), { profile: TEST_PROFILE, seenIds: new Set() });
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'not-fresh');
});

test('evaluateJob rejects applicants', () => {
  const r = evaluateJob(rawJob({ applicants_text: 'Over 100 applicants' }), { profile: TEST_PROFILE, seenIds: new Set() });
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'applicants');
});

test('evaluateJob rejects excluded-role', () => {
  const r = evaluateJob(rawJob({ title: 'Senior Accountant' }), { profile: TEST_PROFILE, seenIds: new Set() });
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'excluded-role');
});

test('evaluateJob rejects permit-required for germany only', () => {
  const germany = rawJob({
    region: 'germany',
    location: 'Germany',
    url: 'https://www.linkedin.com/jobs/view/3912345679/',
    job_id: '3912345679',
    permit_required: true,
  });
  const g = evaluateJob(germany, { profile: TEST_PROFILE, seenIds: new Set() });
  assert.equal(g.keep, false);
  assert.equal(g.reason, 'permit-required');

  const uae = rawJob({ permit_required: true });
  const u = evaluateJob(uae, { profile: TEST_PROFILE, seenIds: new Set() });
  assert.equal(u.keep, true);
  assert.equal(u.reason, 'ok');
});

test('evaluateJob rejects pay-below-floor', () => {
  const r = evaluateJob(rawJob({ pay_text: 'AED 6,000 per month' }), { profile: TEST_PROFILE, seenIds: new Set() });
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'pay-below-floor');
});

test('pickCombos: 8 distinct combos over four cycles of two', () => {
  const all = [0, 1, 2, 3].flatMap(i => pickCombos(TEST_PROFILE, i, 2));
  assert.equal(all.length, 8);
  assert.equal(new Set(all.map(c => c.id)).size, 8);
  assert.equal(all.filter(c => c.region === 'germany').length, 2);
});

test('pickCombos: fixed order and keyword strings', () => {
  const all = [0, 1, 2, 3].flatMap(i => pickCombos(TEST_PROFILE, i, 2));
  assert.deepEqual(
    all.map(c => `${c.location}-${c.group}`),
    ['Dubai-A', 'Germany-A', 'Dubai-B', 'Abu Dhabi-A', 'Sharjah-A', 'Germany-B', 'Abu Dhabi-B', 'Sharjah-B'],
  );
  const groupA = all.find(c => c.group === 'A');
  const groupB = all.find(c => c.group === 'B');
  assert.equal(groupA.keywords, '"Power BI developer" OR "BI analyst" OR "BI developer" OR "data analyst"');
  assert.equal(groupB.keywords, '"financial analyst" OR "MIS analyst" OR "reporting analyst"');
  assert.equal(all.find(c => c.region === 'germany').location, 'Germany');
});

test('pickCombos: search_url has keywords, country, Past 3 hours and Most recent sort, exact for dubai-A', () => {
  const dubaiA = pickCombos(TEST_PROFILE, 0, 2)[0];
  assert.equal(dubaiA.id, 'dubai-A');
  assert.equal(
    dubaiA.search_url,
    'https://www.linkedin.com/jobs/search/?keywords=%22Power%20BI%20developer%22%20OR%20%22BI%20analyst%22%20OR%20%22BI%20developer%22%20OR%20%22data%20analyst%22&location=United%20Arab%20Emirates&f_TPR=r10800&sortBy=DD',
  );
});

test('pickCombos: every search_url has keywords, country, f_TPR=r10800 and sortBy=DD for all 8 combos', () => {
  const all = [0, 1, 2, 3].flatMap(i => pickCombos(TEST_PROFILE, i, 2));
  assert.equal(all.length, 8);
  for (const c of all) {
    assert.equal(typeof c.search_url, 'string');
    const u = new URL(c.search_url);
    assert.equal(u.origin + u.pathname, 'https://www.linkedin.com/jobs/search/');
    assert.deepEqual([...u.searchParams.keys()], ['keywords', 'location', 'f_TPR', 'sortBy']);
    assert.equal(u.searchParams.get('keywords'), c.keywords);
    assert.equal(u.searchParams.get('location'), c.country_word);
    assert.equal(u.searchParams.get('f_TPR'), 'r10800');
    assert.equal(u.searchParams.get('sortBy'), 'DD');
    assert.ok(c.search_url.includes('keywords=%22'), `${c.id} quotes are percent-encoded`);
    assert.equal(c.search_url.includes('"'), false);
    assert.equal(c.search_url.includes(' '), false);
  }
});

test('buildDiscoverPrompt says the date filter comes from the search_url and never to click Date posted', () => {
  const { system } = buildDiscoverPrompt({
    combos: pickCombos(TEST_PROFILE, 0, 2),
    tabId: 4133,
    maxJobPages: 25,
    skills: TEST_PROFILE.skills,
  });
  assert.ok(system.includes('DATE FILTER (step 3)'));
  assert.equal(system.includes('click the "Date posted" filter pill'), false);
  assert.ok(system.includes('do NOT click Date posted'));
});

test('pickCombos: location_target and country_word per location', () => {
  const all = [0, 1, 2, 3].flatMap(i => pickCombos(TEST_PROFILE, i, 2));
  const expected = {
    Dubai: ['Dubai, Dubai, United Arab Emirates', 'United Arab Emirates'],
    Sharjah: ['Sharjah, United Arab Emirates', 'United Arab Emirates'],
    'Abu Dhabi': ['Abu Dhabi, United Arab Emirates', 'United Arab Emirates'],
    Germany: ['Germany', 'Germany'],
  };
  for (const c of all) {
    assert.equal(c.location_target, expected[c.location][0], `${c.id} location_target`);
    assert.equal(c.country_word, expected[c.location][1], `${c.id} country_word`);
  }
});

test('pickCombos: rotation 4 equals rotation 0', () => {
  assert.deepEqual(pickCombos(TEST_PROFILE, 4, 2), pickCombos(TEST_PROFILE, 0, 2));
});

test('parseDiscoverResult accepts bare JSON and fenced JSON inside prose', () => {
  const bare = parseDiscoverResult('{"status":"ok","message":"","jobs":[]}');
  assert.equal(bare.status, 'ok');
  assert.deepEqual(bare.jobs, []);

  const fenced = parseDiscoverResult(
    'Here is the result:\n```json\n{"status":"challenge","message":"security check","jobs":[]}\n```\nDone.',
  );
  assert.equal(fenced.status, 'challenge');
  assert.equal(fenced.message, 'security check');
});

test('parseDiscoverResult throws on junk', () => {
  assert.throws(() => parseDiscoverResult('not json'), Error);
  assert.throws(() => parseDiscoverResult('{'), Error);
  assert.throws(() => parseDiscoverResult('{"message":"x","jobs":[]}'), Error);
  assert.throws(() => parseDiscoverResult('{"status":"ok","jobs":"nope"}'), Error);
});

test('buildDiscoverPrompt system and user prompts', () => {
  const combos = pickCombos(TEST_PROFILE, 0, 2);
  const { system, user } = buildDiscoverPrompt({
    combos,
    tabId: 4133,
    maxJobPages: 25,
    skills: TEST_PROFILE.skills,
  });

  assert.ok(system.includes('one at a time'));
  assert.ok(system.includes('never'));
  assert.ok(system.includes('Submit'));
  assert.ok(system.includes('4133'));
  assert.ok(system.includes('25'));
  assert.ok(system.includes('"challenge"'));
  assert.ok(system.includes('"not_shared"'));

  for (const c of combos) {
    assert.ok(user.includes(c.location), `user prompt lists ${c.location}`);
    assert.ok(user.includes(c.keywords), `user prompt lists keywords for ${c.id}`);
  }
  for (const c of combos) {
    assert.ok(user.includes(c.search_url), `user prompt lists search_url for ${c.id}`);
  }
  assert.ok(user.includes('ONE final JSON object'));
  for (const field of ['job_id', 'title', 'fit_score', 'pay_text', 'permit_required', 'status']) {
    assert.ok(user.includes(field), `user prompt names ${field}`);
  }
});

test('buildDiscoverPrompt makes the Past 3 hours date filter a verified step', () => {
  const { system, user } = buildDiscoverPrompt({
    combos: pickCombos(TEST_PROFILE, 0, 2),
    tabId: 4133,
    maxJobPages: 25,
    skills: TEST_PROFILE.skills,
  });
  const all = `${system}\n${user}`;
  for (const needle of [
    'Date posted',
    'All filters',
    'Past 3 hours',
    'CONFIRM',
    'before reading any job',
    'skip that search',
    'first 5 postings',
    'Most recent',
    'date_filter_confirmed',
    'Never edit the URL yourself',
  ]) {
    assert.ok(all.includes(needle), `prompt mentions ${needle}`);
  }
  assert.ok(user.includes('"location_confirmed":false') || user.includes('"location_confirmed":true'));
  assert.ok(user.includes('"date_filter_confirmed":false') || user.includes('"date_filter_confirmed":true'));
});

test('buildDiscoverPrompt starts each search by navigating to the given URL', () => {
  const { system, user } = buildDiscoverPrompt({
    combos: pickCombos(TEST_PROFILE, 0, 2),
    tabId: 4133,
    maxJobPages: 25,
    skills: TEST_PROFILE.skills,
  });
  for (const needle of [
    'calling navigate with that exact URL',
    "global search box",
    'Describe the job you want',
    'never press Enter to search',
    'carries the keywords',
    'EVERY search',
    'never edit the URL yourself',
    'login page',
    'verify you',
    'zero postings',
  ]) {
    assert.ok(system.includes(needle), `system prompt mentions ${needle}`);
  }
  assert.equal(user.includes('type the keywords in the search box'), false);
  assert.ok(user.includes('navigate'));
});

test('buildDiscoverPrompt sets the location by clicking, then date, then applicants, then reads', () => {
  const combos = pickCombos(TEST_PROFILE, 0, 2);
  const { system, user } = buildDiscoverPrompt({ combos, tabId: 4133, maxJobPages: 25, skills: TEST_PROFILE.skills });
  const all = `${system}\n${user}`;
  for (const needle of [
    'location button',
    'remembered city',
    'clear the field',
    'wait 2-3 s',
    'suggestion',
    'country_word',
    'location_confirmed',
    'Under 10 applicants',
    'read_page with mode "all"',
    'Tab, Enter or Space',
    'Describe the job you want',
    'Never click Submit',
  ]) {
    assert.ok(all.includes(needle), `prompt mentions ${needle}`);
  }
  for (const c of combos) {
    assert.ok(user.includes(c.location_target), `user prompt lists location_target for ${c.id}`);
    assert.ok(user.includes(c.country_word), `user prompt lists country_word for ${c.id}`);
  }
  // required order within the system rules
  const idx = k => system.indexOf(k);
  const order = ['SEARCH ORDER', 'LOCATION (step 2)', 'DATE FILTER (step 3)', 'APPLICANTS (step 4)', 'READ JOBS (step 5)'].map(idx);
  for (const i of order) assert.ok(i >= 0);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(system.includes('&location='), false);
});

test('buildDiscoverPrompt does not leak personal profile data', () => {
  const { system, user } = buildDiscoverPrompt({
    combos: pickCombos(TEST_PROFILE, 0, 2),
    tabId: 4133,
    maxJobPages: 25,
    skills: TEST_PROFILE.skills,
  });
  for (const text of [system, user]) {
    assert.equal(text.includes('Test User'), false);
    assert.equal(text.includes('10000'), false);
  }
});
