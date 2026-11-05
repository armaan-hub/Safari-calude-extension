// Resume builder tests. Fictional person and employers only. Every test uses its own temp directory,
// never the real ~/.claude-safari-bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkSummary, checkSkills,
  resumeDir, masterStatus, readMasterText, normalise, checkBullet, renderAtsHtml, buildResume, COMMON_WORDS, CLAIM_WORDS,
  safeFileStem, checkHeader, checkJobHeader,
} from '../resume-build.mjs';

const MAC = process.platform === 'darwin';
const MAC_SKIP = MAC ? false : 'needs macOS textutil and cupsfilter';

const MASTER = [
  'Alex Testman',
  'alex.testman@example.com | +000 (0) 000-0000 | Dubai, UAE',
  'Senior Analyst at Northwind Traders, 2019 to 2023.',
  'Led a team of 12 analysts at Northwind Traders.',
  'Built Power BI dashboards for 4 regions.',
  'Reduced month-end close time by 30%.',
  'Education: BSc Accounting, Example University, 2015.',
].join('\n');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resume-build-test-'));
}

function withMaster(text = MASTER, name = 'master.md') {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, name), text, 'utf8');
  return dir;
}

test('normalise lower-cases, collapses punctuation and trims', () => {
  assert.equal(normalise('  Power-BI,  Dashboards!  '), 'power bi dashboards');
  assert.equal(normalise(null), '');
});

test('checkBullet accepts a reordered and shortened bullet whose facts are all in the source', () => {
  const r = checkBullet('Built dashboards for 4 regions in Power BI', 'Built Power BI dashboards for 4 regions', MASTER);
  assert.deepEqual(r, { ok: true });
});

test('checkBullet refuses a bullet that adds a number not in its source', () => {
  const r = checkBullet('Led a team of 15 analysts', 'Led a team of 12 analysts at Northwind Traders', MASTER);
  assert.equal(r.ok, false);
  assert.match(r.reason, /added number/);
  assert.doesNotMatch(r.reason, /15/);
});

test('checkBullet refuses a bullet that adds a tool name not in its source', () => {
  const r = checkBullet('Built Tableau dashboards for 4 regions', 'Built Power BI dashboards for 4 regions', MASTER);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Tableau/);
});

test('checkBullet refuses a source that is not in the master text', () => {
  const r = checkBullet('Ran payroll for 4 regions', 'Ran payroll for Contoso in 2021', MASTER);
  assert.equal(r.ok, false);
  assert.match(r.reason, /source not found/);
});

test('checkBullet ignores the capitalised first word of the bullet', () => {
  const r = checkBullet('Reduced month-end close time by 30%', 'Reduced month-end close time by 30%', MASTER);
  assert.equal(r.ok, true);
});

const MASTER2 = 'Built Power BI dashboards for finance team. Reduced reporting time by 30 percent using SQL and Excel.';
const SRC2 = 'Built Power BI dashboards for finance team';

test('checkBullet refuses added lowercase tool names and added claims', () => {
  for (const [bullet, word] of [
    ['Built dashboards in tableau for finance team', 'tableau'],
    ['Built dashboards for the finance team using python', 'python'],
    ['Led a team of managers building dashboards', 'added claim word'],
  ]) {
    const r = checkBullet(bullet, SRC2, MASTER2);
    assert.equal(r.ok, false, bullet);
    assert.match(r.reason, new RegExp(word), bullet);
  }
  assert.match(checkBullet('Led a team of managers building dashboards', SRC2, MASTER2).reason, /^added claim word "Led"/);
});

test('checkBullet refuses an added claim word with the claim reason', () => {
  const r = checkBullet('Built dashboards for the finance team and saved money', SRC2, MASTER2);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'added claim word "saved" is not in its source');
  const u = checkBullet('Built dashboards for the finance team with zebra', SRC2, MASTER2);
  assert.equal(u.reason, 'added word "zebra" is not in its source');
});

test('checkBullet accepts rewording with common words', () => {
  for (const bullet of [
    'Built Power BI dashboards for finance team',
    'Developed finance team dashboards in Power BI',
    'Power BI dashboards built for the finance team',
  ]) {
    assert.deepEqual(checkBullet(bullet, SRC2, MASTER2), { ok: true }, bullet);
  }
});

test('checkBullet allows a claim word that is in the source', () => {
  const m = 'Led a team of managers on dashboards.';
  assert.deepEqual(checkBullet('Led managers on dashboards', 'Led a team of managers on dashboards', m), { ok: true });
});

test('COMMON_WORDS and CLAIM_WORDS do not overlap', () => {
  const both = [...CLAIM_WORDS].filter((w) => COMMON_WORDS.has(w));
  assert.deepEqual(both, []);
  assert.ok(COMMON_WORDS.size >= 250 && COMMON_WORDS.size <= 600);
  for (const w of ['led', 'managed', 'percent', 'senior']) assert.ok(CLAIM_WORDS.has(w), w);
});

test('missing master returns ok false, names the fix, and writes no file', () => {
  const dir = tempDir();
  const before = fs.readdirSync(dir);
  assert.equal(readMasterText({ dir }), null);
  const r = buildResume({ header: HEADER, job_title: 'Analyst', company: 'Example Co', summary: 'x', skills: [], experience: [], education: [], keywords_used: [], job_keywords: [] }, { dir });
  assert.equal(r.ok, false);
  assert.match(r.error, /Word|text/);
  assert.deepEqual(fs.readdirSync(dir), before);
});

test('buildResume refuses the whole build and names each refused bullet', () => {
  const dir = withMaster();
  const r = buildResume({
    header: HEADER,
    job_title: 'Analyst', company: 'Example Co', summary: 'Analyst.', skills: ['Power BI'],
    experience: [{
      role: 'Senior Analyst', company: 'Northwind Traders', dates: '2019 to 2023',
      bullets: [
        { text: 'Led a team of 15 analysts', source: 'Led a team of 12 analysts at Northwind Traders' },
        { text: 'Built dashboards for 4 regions in Power BI', source: 'Built Power BI dashboards for 4 regions' },
      ],
    }],
    education: [], keywords_used: [], job_keywords: [],
  }, { dir });
  assert.equal(r.ok, false);
  assert.match(r.error, /Led a team of 15 analysts/);
  assert.doesNotMatch(r.error, /Built dashboards/);
});

const HEADER = { name: 'Alex Testman', contact: 'alex.testman@example.com | +000 000 0000 | Dubai' };

const GOOD_INPUT = {
  header: HEADER,
  job_title: 'Analyst', company: 'Example Co', summary: 'Analyst.', skills: ['Power BI'],
  experience: [{
    role: 'Senior Analyst', company: 'Northwind Traders', dates: '2019 to 2023',
    bullets: [{ text: 'Built dashboards for 4 regions in Power BI', source: 'Built Power BI dashboards for 4 regions' }],
  }],
  education: [{ text: 'BSc Accounting, Example University, 2015', source: 'BSc Accounting, Example University, 2015' }],
  keywords_used: ['Power BI'], job_keywords: ['Power BI', 'Tableau'],
};

test('buildResume returns gaps and writes docx and pdf, removing the html, on macOS', { skip: MAC_SKIP }, () => {
  const dir = withMaster();
  const r = buildResume(GOOD_INPUT, { dir });
  assert.equal(r.ok, true);
  assert.deepEqual(r.gaps, ['Tableau']);
  assert.equal(r.html, null, 'intermediate html is removed after conversion');
  const outDir = path.join(dir, 'out');
  assert.equal(path.dirname(r.docx), outDir);
  assert.equal(path.basename(r.docx), 'example-co-analyst.docx');
  const docx = fs.readFileSync(r.docx);
  assert.ok(docx.length > 0);
  assert.equal(docx.subarray(0, 2).toString('latin1'), 'PK');
  assert.equal(fs.statSync(r.docx).mode & 0o777, 0o600);
  assert.equal(fs.statSync(outDir).mode & 0o777, 0o700);
  if (r.pdf) {
    assert.equal(path.dirname(r.pdf), outDir);
    const pdf = fs.readFileSync(r.pdf);
    assert.ok(pdf.length > 0);
    assert.equal(pdf.subarray(0, 4).toString('latin1'), '%PDF');
    assert.equal(fs.statSync(r.pdf).mode & 0o777, 0o600);
  } else {
    assert.equal(typeof r.pdfError, 'string');
  }
  assert.deepEqual(fs.readdirSync(outDir).filter((n) => /\.(html|txt)$/.test(n)), []);
});

test('buildResume file names have no path separators when company or title hold ../ or /', { skip: MAC_SKIP }, () => {
  const dir = withMaster();
  const r = buildResume({ ...GOOD_INPUT, company: '../../Evil/Co', job_title: '../x/y', experience: [], education: [] }, { dir });
  assert.equal(r.ok, true);
  assert.equal(path.dirname(r.docx), path.join(dir, 'out'));
  assert.match(path.basename(r.docx), /^[a-z0-9-]+\.docx$/);
  assert.doesNotMatch(r.docx.slice(path.join(dir, 'out').length + 1), /[/\\]|\.\./);
});

test('safeFileStem keeps only a-z, 0-9 and single hyphens, trimmed and at most 80 characters', () => {
  assert.equal(safeFileStem('../../Evil/Co', '../x'), 'evil-co-x');
  assert.equal(safeFileStem('Example Co.', 'Senior  Analyst (BI)'), 'example-co-senior-analyst-bi');
  assert.equal(safeFileStem('', ''), 'resume');
  assert.ok(safeFileStem('A'.repeat(100), 'b').length <= 80);
  assert.doesNotMatch(safeFileStem('A'.repeat(79) + ' b', 'c'), /-$/);
});

test('a refused build creates no out folder and no file', () => {
  const dir = withMaster();
  const before = fs.readdirSync(dir);
  const r = buildResume({
    ...GOOD_INPUT,
    experience: [{
      role: 'Senior Analyst', company: 'Northwind Traders', dates: '2019 to 2023',
      bullets: [{ text: 'Led a team of 15 analysts', source: 'Led a team of 12 analysts at Northwind Traders' }],
    }],
  }, { dir });
  assert.equal(r.ok, false);
  assert.deepEqual(fs.readdirSync(dir), before);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});

test('a missing master creates no out folder', () => {
  const dir = tempDir();
  const r = buildResume(GOOD_INPUT, { dir });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});

test('a bullet that adds an audience noun is refused unless its source has it', () => {
  const src = 'Built Power BI dashboards for finance team';
  for (const word of ['clients', 'client', 'customers', 'customer', 'stakeholders', 'stakeholder', 'executives',
    'executive', 'management', 'leadership', 'partners', 'users']) {
    const r = checkBullet(`Built dashboards for finance team and ${word}`, src, MASTER2);
    assert.equal(r.ok, false, word);
  }
  assert.equal(checkBullet('Built dashboards for finance team and clients', src, MASTER2).ok, false);
  const withClients = 'Built dashboards for finance team and clients';
  assert.deepEqual(checkBullet(withClients, withClients, withClients), { ok: true });
});

test('renderAtsHtml has none of the forbidden tags and escapes angle brackets', () => {
  const html = renderAtsHtml({
    header: { name: 'Alex <b>Testman', contact: 'a@example.com | +000 000' },
    job_title: 'Analyst', company: 'Example Co', summary: 'Good <script>alert(1)</script> fit & clear',
    skills: ['Excel', 'Power BI'],
    experience: [{ role: 'Analyst', company: 'Northwind', dates: '2019', bullets: [{ text: 'Did <b>x</b>', source: 's' }] }],
    education: [{ text: 'BSc <i>', source: 's' }], keywords_used: [], job_keywords: [],
  });
  assert.doesNotMatch(html, /<(table|img|header|footer|div|span)\b/i);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /<h1>Alex &lt;b&gt;Testman<\/h1>\n<p>a@example.com \| \+000 000<\/p>\n<h2>Summary/);
  assert.match(html, /<h2>Summary<\/h2>/);
  assert.match(html, /<h2>Skills<\/h2>/);
  assert.match(html, /<h2>Education<\/h2>/);
  assert.match(html, /Excel, Power BI/);
  assert.match(html, /font-family:\s*Arial/);
});

test('masterStatus reports present and format for txt and md, absent for an empty dir', () => {
  const txtDir = withMaster('plain text master', 'master.txt');
  assert.deepEqual(masterStatus({ dir: txtDir }).present, true);
  assert.equal(masterStatus({ dir: txtDir }).format, 'txt');
  assert.equal(masterStatus({ dir: txtDir }).readable, true);

  const mdDir = withMaster(MASTER, 'master.md');
  assert.equal(masterStatus({ dir: mdDir }).format, 'md');

  const empty = tempDir();
  assert.deepEqual(masterStatus({ dir: empty }), { present: false });
});

test('txt is preferred over md when both exist', () => {
  const dir = withMaster('from txt', 'master.txt');
  fs.writeFileSync(path.join(dir, 'master.md'), 'from md', 'utf8');
  assert.equal(readMasterText({ dir }), 'from txt');
});

test('resumeDir honours RESUME_DIR', () => {
  const saved = process.env.RESUME_DIR;
  process.env.RESUME_DIR = '/fictional/resume-dir';
  try {
    assert.equal(resumeDir(), '/fictional/resume-dir');
  } finally {
    if (saved === undefined) delete process.env.RESUME_DIR; else process.env.RESUME_DIR = saved;
  }
});

test('checkHeader accepts a name and contact line that are in the master, with loose email and phone matching', () => {
  assert.deepEqual(checkHeader(HEADER, MASTER), { ok: true });
  assert.deepEqual(checkHeader({ name: 'alex testman', contact: 'ALEX.TESTMAN@EXAMPLE.COM, +000 0 000 0000' }, MASTER), { ok: true });
});

test('checkHeader refuses a missing or unknown name and names the failed part', () => {
  assert.equal(checkHeader({ name: 'Sam Faker', contact: HEADER.contact }, MASTER).ok, false);
  assert.match(checkHeader({ name: 'Sam Faker', contact: HEADER.contact }, MASTER).reason, /name/);
  assert.equal(checkHeader({ name: '', contact: HEADER.contact }, MASTER).ok, false);
  assert.equal(checkHeader(undefined, MASTER).ok, false);
});

test('checkHeader refuses a contact segment not in the master and never echoes the contact line', () => {
  const contact = 'alex.testman@example.com | other@example.com | Dubai';
  const r = checkHeader({ name: HEADER.name, contact }, MASTER);
  assert.equal(r.ok, false);
  assert.match(r.reason, /contact segment 2/);
  assert.doesNotMatch(r.reason, /other@example/);
  assert.equal(checkHeader({ name: HEADER.name, contact: 'alex.testman@example.com | +000 111 1111' }, MASTER).ok, false);
  assert.equal(checkHeader({ name: HEADER.name, contact: 'alex.testman@example.com | Paris' }, MASTER).ok, false);
  assert.equal(checkHeader({ name: HEADER.name, contact: ' | , ' }, MASTER).ok, false);
});

test('a header whose name or contact is not in the master is refused and creates no file', () => {
  for (const header of [
    { name: 'Sam Faker', contact: HEADER.contact },
    { name: HEADER.name, contact: 'fake@example.com | +000 999 9999' },
    undefined,
  ]) {
    const dir = withMaster();
    const before = fs.readdirSync(dir);
    const r = buildResume({ ...GOOD_INPUT, header }, { dir });
    assert.equal(r.ok, false);
    assert.match(r.error, /header/);
    assert.doesNotMatch(r.error, /fake@example|999/);
    assert.deepEqual(fs.readdirSync(dir), before);
    assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  }
});

test('buildResume writes a formatted pdf with US Letter pages on macOS', { skip: MAC_SKIP }, () => {
  const dir = withMaster();
  const r = buildResume(GOOD_INPUT, { dir });
  assert.equal(r.ok, true);
  assert.equal(r.pdfError, undefined);
  const pdf = fs.readFileSync(r.pdf).toString('latin1');
  assert.ok(pdf.startsWith('%PDF'));
  assert.match(pdf, /\/MediaBox\s*\[\s*0\s+0\s+612\s+792\s*\]/);
  assert.match(pdf, /Arial/);
  assert.match(pdf, /Bold/);
});

test('a long resume paginates onto more than one US Letter page on macOS', { skip: MAC_SKIP }, () => {
  const bullets = Array.from({ length: 45 }, (_, i) => `Built Power BI dashboards for ${i + 1} regions at Northwind Traders`);
  const dir = withMaster([MASTER, ...bullets].join('\n'));
  const r = buildResume({
    ...GOOD_INPUT,
    experience: [{ role: 'Senior Analyst', company: 'Northwind Traders', dates: '2019 to 2023', bullets: bullets.map((b) => ({ text: b, source: b })) }],
  }, { dir });
  assert.equal(r.ok, true);
  assert.equal(r.pdfError, undefined);
  const pdf = fs.readFileSync(r.pdf).toString('latin1');
  assert.ok((pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length >= 2);
});

// ---------- summary, skills and keywords_used honesty gate ----------

const JANE = 'Jane Example\njane@example.com | Dubai\nFinance Analyst. Built Power BI dashboards for finance team.';
const JANE_HEADER = { name: 'Jane Example', contact: 'jane@example.com | Dubai' };
const JANE_INPUT = {
  header: JANE_HEADER, job_title: 'Analyst', company: 'Example Co',
  summary: 'Analyst who builds Power BI dashboards for the finance team.',
  skills: ['Power BI'], experience: [], education: [], keywords_used: ['Power BI'], job_keywords: ['Tableau'],
};

test('a summary and skills that claim things not in the master are refused and nothing is written', () => {
  const dir = withMaster(JANE);
  const before = fs.readdirSync(dir);
  const r = buildResume({
    ...JANE_INPUT,
    summary: 'Expert in Tableau and Python with ten years leading teams.',
    skills: ['Tableau', 'Python', 'Kubernetes'],
  }, { dir });
  assert.equal(r.ok, false);
  assert.match(r.error, /summary/);
  assert.match(r.error, /skill 1/);
  assert.match(r.error, /skill 3/);
  assert.deepEqual(fs.readdirSync(dir), before);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});

test('an honest summary with master skills passes the gate', { skip: MAC_SKIP }, () => {
  const dir = withMaster(JANE);
  const r = buildResume(JANE_INPUT, { dir });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.gaps, ['Tableau']);
});

test('checkSummary accepts several sentences and refuses claim words, numbers and tools', () => {
  assert.deepEqual(checkSummary('Analyst who builds Power BI dashboards for the finance team. Finance reporting.', JANE), { ok: true });
  for (const bad of [
    'Expert analyst with dashboards.', 'Analyst with ten years of dashboards.', 'Analyst with 10 dashboards.',
    'Analyst who builds Tableau dashboards.', 'Seasoned analyst. Proven results.', 'Analyst leading the finance team.',
    'Passionate professional building dashboards.',
  ]) {
    assert.equal(checkSummary(bad, JANE).ok, false, bad);
  }
  // a claim word that the master itself contains is allowed
  assert.deepEqual(checkSummary('Expert dashboards.', 'Expert in dashboards at Example.'), { ok: true });
});

test('checkSkills matches whole words case-insensitively and flags the rest by index', () => {
  assert.deepEqual(checkSkills(['power bi', 'FINANCE', 'Dashboards'], JANE), []);
  assert.equal(checkSkills(['Power BI', 'Tableau', 'Dash'], JANE).length, 2);
  assert.match(checkSkills(['Power BI', 'Tableau'], JANE)[0], /^skill 2/);
  assert.equal(checkSkills([''], JANE).length, 1);
});

test('keywords_used outside the master are refused, job_keywords are not gated', () => {
  const dir = withMaster(JANE);
  const r = buildResume({ ...JANE_INPUT, keywords_used: ['Power BI', 'Tableau'] }, { dir });
  assert.equal(r.ok, false);
  assert.match(r.error, /keyword_used 2/);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});

test('COMMON_WORDS and CLAIM_WORDS stay disjoint with the summary claim words added', () => {
  for (const w of ['expert', 'experienced', 'proven', 'seasoned', 'skilled', 'extensive', 'years', 'year', 'decade',
    'passionate', 'leading', 'specialist', 'professional']) {
    assert.ok(CLAIM_WORDS.has(w), w);
    assert.equal(COMMON_WORDS.has(w), false, w);
  }
});

// ---------- hardening round: role/company/dates, outcome words, per-line summary, hidden values, robustness ----------

const JOB_MASTER = [
  'Alex Testman',
  'alex.testman@example.com | +000 (0) 000-0000 | Dubai, UAE',
  'Accountant at Beta Trading, 2019 to 2021',
  'Prepared monthly reconciliations for the finance team.',
  'Managed a finance team of 10 at Gamma Retail.',
  'Reduced month-end close time by 30%.',
  'Shipped 1,000 invoices per month.',
  'Analyst, Gamma Retail, 2022 to 2024',
].join('\n');

const JOB_BULLET = { text: 'Prepared monthly reconciliations for the finance team', source: 'Prepared monthly reconciliations for the finance team' };

function jobInput(job, extra = {}) {
  return { ...GOOD_INPUT, header: HEADER, experience: [job], education: [], skills: [], summary: '', keywords_used: [], ...extra };
}

test('an invented role, company or dates are refused by name without echoing the values', () => {
  const dir = withMaster(JOB_MASTER);
  const bad = [
    { role: 'Financial Controller', company: 'Acme Holdings', dates: '2015 to 2022' },
    { role: 'Financial Controller', company: 'Beta Trading', dates: '2019 to 2021' },
    { role: 'Accountant', company: 'Acme Holdings', dates: '2019 to 2021' },
    { role: 'Accountant', company: 'Beta Trading', dates: '2018 to 2021' },
    { role: 'Accountant', company: 'Beta Trading', dates: '2019 to Present' },
    { role: 'Analyst', company: 'Beta Trading', dates: '2022 to 2024' },
  ];
  for (const job of bad) {
    const r = buildResume(jobInput({ ...job, bullets: [JOB_BULLET] }), { dir });
    assert.equal(r.ok, false, JSON.stringify(job));
    assert.match(r.error, /experience 1 role\/company\/dates/);
    assert.doesNotMatch(r.error, /Acme|Controller|2015/);
  }
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});

test('checkJobHeader accepts a job whose role, company and dates sit on one master line or its neighbours', () => {
  assert.equal(checkJobHeader({ role: 'Accountant', company: 'Beta Trading', dates: '2019 to 2021' }, JOB_MASTER).ok, true);
  assert.equal(checkJobHeader({ role: 'Analyst', company: 'Gamma Retail', dates: '2022 to 2024' }, JOB_MASTER).ok, true);
  const split = 'Senior Analyst\nNorthwind Traders\n2019 to 2023';
  assert.equal(checkJobHeader({ role: 'Senior Analyst', company: 'Northwind Traders', dates: '2019 - 2023' }, split).ok, true);
  assert.equal(checkJobHeader({ role: 'Senior Analyst', company: 'Northwind Traders', dates: '2019 - 2023' }, 'Senior Analyst\n\n\nNorthwind Traders\n\n2019 to 2023').ok, true);
  const far = 'Senior Analyst\nline\nline\nNorthwind Traders\nline\nline\n2019 to 2023';
  assert.equal(checkJobHeader({ role: 'Senior Analyst', company: 'Northwind Traders', dates: '2019 to 2023' }, far).ok, false);
  assert.equal(checkJobHeader(null, JOB_MASTER).ok, false);
  assert.equal(checkJobHeader({ role: '', company: 'Beta Trading', dates: '2019' }, JOB_MASTER).ok, false);
});

test('education text and source are gated like bullets', () => {
  const dir = withMaster(MASTER);
  const r = buildResume({ ...GOOD_INPUT, education: [{ text: 'MSc Accounting, Example University, 2015', source: 'BSc Accounting, Example University, 2015' }] }, { dir });
  assert.equal(r.ok, false);
  assert.match(r.error, /MSc/);
  const r2 = buildResume({ ...GOOD_INPUT, education: [{ text: 'BSc', source: 'BSc' }] }, { dir });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /source too short/);
});

test('outcome and quality words are claim words, refused unless the bullet source has them', () => {
  const words = ['reduced', 'reduction', 'improved', 'improvement', 'accurate', 'accuracy', 'reliable', 'timely', 'efficient',
    'efficiency', 'errors', 'error', 'better', 'best', 'good', 'great', 'high', 'higher', 'faster', 'quality', 'effective',
    'effectively', 'successfully', 'strong', 'excellent', 'outstanding', 'optimised', 'optimized', 'streamlined', 'automated',
    'enhanced', 'increased', 'cost', 'costs', 'savings', 'growth', 'productivity', 'performance'];
  for (const w of words) {
    assert.ok(CLAIM_WORDS.has(w), `${w} is a claim word`);
    assert.equal(COMMON_WORDS.has(w), false, `${w} is not common`);
  }
  const src = 'Prepared monthly reconciliations for the finance team';
  const r = checkBullet('Prepared accurate monthly reconciliations for the finance team', src, JOB_MASTER);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'added claim word "accurate" is not in its source');
  const own = 'Reduced month-end close time by 30%';
  assert.equal(checkBullet('Reduced close time by 30%', own, JOB_MASTER).ok, true);
});

test('a source shorter than 3 words is refused as too short', () => {
  const r = checkBullet('Reduced time', 'Reduced', JOB_MASTER);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'source too short');
  assert.equal(checkBullet('Reduced time', 'Reduced month end close time by 30%', JOB_MASTER).ok, true);
});

test('a summary cannot combine claim words and numbers from different master lines', () => {
  assert.equal(checkSummary('Managed a finance team of 10.', JOB_MASTER).ok, true);
  const mixed = 'Managed a team of 12 at Beta Trading. Managed a finance team of 30.';
  assert.equal(checkSummary(mixed, JOB_MASTER).ok, false);
  const m2 = 'Managed the budget.\nA team of 10 people sat at Gamma Retail.';
  assert.equal(checkSummary('Managed a team of 10.', m2).ok, false);
  const r = checkSummary('Managed a finance team of 30.', JOB_MASTER);
  assert.equal(r.ok, false);
  assert.match(r.reason, /sentence 1 combines/);
  assert.equal(checkSummary('Managed a team of 99.', JOB_MASTER).reason, 'added number (value hidden) is not in its source');
  assert.equal(checkSummary('Reduced reconciliations by 10.', JOB_MASTER).ok, false);
  assert.match(checkSummary('Reduced reconciliations by 10.', JOB_MASTER).reason, /sentence 1 combines/);
  // each sentence has its own line
  assert.equal(checkSummary('Managed a finance team of 10. Reduced close time by 30%.', JOB_MASTER).ok, true);
});

test('refusals hide personal values: phone numbers in skills, summary and bullets never appear', () => {
  const dir = withMaster(JOB_MASTER);
  const phone = '+971 50 123 4567';
  const r = buildResume(jobInput(
    { role: 'Accountant', company: 'Beta Trading', dates: '2019 to 2021', bullets: [JOB_BULLET] },
    {
      skills: [phone, 'Excel'],
      summary: `Call ${phone} or abc123 now. Managed ${phone}.`,
      keywords_used: [phone],
    },
  ), { dir });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /971|4567|123/);
  assert.match(r.error, /skill 1 \(not in the master resume\)/);
  assert.match(r.error, /summary/);

  const n = checkBullet('Prepared 9876543 reconciliations for the finance team', JOB_BULLET.source, JOB_MASTER);
  assert.equal(n.reason, 'added number (value hidden) is not in its source');
  const w = checkBullet('Prepared 10 reconciliations for the finance team abc10', 'Prepared 10 reconciliations for the finance team', 'Prepared 10 reconciliations for the finance team');
  assert.equal(w.reason, 'added word (text hidden) is not in its source');
  assert.deepEqual(checkSkills([phone], JOB_MASTER), ['skill 1']);
});

test('a header contact segment with digits must be a substring of the master and at least 4 characters', () => {
  const m = 'Alex Testman\nalex.testman@example.com | Dubai 2 | +000 (0) 000-0000';
  assert.equal(checkHeader({ name: 'Alex Testman', contact: 'Dubai | 2' }, m).ok, false);
  assert.match(checkHeader({ name: 'Alex Testman', contact: 'Dubai | 2' }, m).reason, /contact segment 2/);
  assert.equal(checkHeader({ name: 'Alex Testman', contact: '000' }, m).ok, false);
  assert.equal(checkHeader({ name: 'Alex Testman', contact: '+000 (0) 000-0000' }, m).ok, true);
  assert.equal(checkHeader({ name: 'Alex Testman', contact: '+000 1 000' }, m).ok, false);
});

test('null or non-object items refuse instead of throwing', () => {
  const dir = withMaster(JOB_MASTER);
  const job = { role: 'Accountant', company: 'Beta Trading', dates: '2019 to 2021' };
  const cases = [
    jobInput({ ...job, bullets: [null] }),
    jobInput({ ...job, bullets: ['text'] }),
    jobInput(null),
    jobInput(42),
    jobInput({ ...job, bullets: [JOB_BULLET] }, { education: [null] }),
    jobInput({ ...job, bullets: [JOB_BULLET] }, { skills: [null, 5, {}] }),
    jobInput({ ...job, bullets: [JOB_BULLET] }, { keywords_used: [null], job_keywords: [null] }),
    jobInput({ ...job, bullets: 'x' }),
  ];
  for (const input of cases) {
    let r;
    assert.doesNotThrow(() => { r = buildResume(input, { dir }); });
    assert.equal(r.ok === false || r.ok === true, true);
  }
  assert.equal(buildResume(cases[0], { dir }).ok, false);
  assert.equal(buildResume(cases[2], { dir }).ok, false);
  assert.equal(buildResume(cases[4], { dir }).ok, false);
  assert.equal(buildResume(cases[5], { dir }).ok, false);
  assert.doesNotThrow(() => renderAtsHtml({ header: null, experience: [null, { bullets: [null] }], education: [null], skills: null }));
});

test('number tokens match across thousands commas in both directions', () => {
  assert.equal(checkBullet('Shipped 1000 invoices per month', 'Shipped 1,000 invoices per month', JOB_MASTER).ok, true);
  const m = 'Shipped 2000 invoices per month.';
  assert.equal(checkBullet('Shipped 2,000 invoices per month', 'Shipped 2000 invoices per month', m).ok, true);
  assert.equal(checkBullet('Shipped 1,001 invoices per month', 'Shipped 1,000 invoices per month', JOB_MASTER).ok, false);
});

test('a txt or md master over 1 MB reads as null and not readable', () => {
  const dir = withMaster('x'.repeat(1024 * 1024 + 1), 'master.txt');
  assert.equal(readMasterText({ dir }), null);
  assert.equal(masterStatus({ dir }).readable, false);
  const ok = withMaster('Alex Testman resume text', 'master.md');
  assert.equal(masterStatus({ dir: ok }).readable, true);
});
