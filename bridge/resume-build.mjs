// Resume builder: the honesty gate and ATS html for tailored resumes. Built-ins only.
// Reads the user's master resume from the resume folder (never writes it, never returns its contents
// except through readMasterText to the builder). Every check is local; nothing is sent anywhere.
// Readers never throw: any failure reads as absent or unreadable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bridgeHomePath } from './paths.mjs';

const MASTER_ORDER = ['txt', 'md', 'docx', 'pdf'];
const PDF_MIN_CHARS = 50;
const TEXT_MASTER_MAX_BYTES = 1024 * 1024;
const NUMBER_RE = /\d+(?:[.,]\d+)*%?/g;
const WORD_RE = /[\p{L}\p{N}]+/gu;
const CAPITAL_RE = /^\p{Lu}/u;
const FORBIDDEN_TAG_RE = /<(table|img|header|footer|div|span)\b/i;

// Folder for the master resume: RESUME_DIR if set, else ~/.claude-safari-bridge/resume.
export function resumeDir() {
  const fromEnv = process.env.RESUME_DIR;
  if (fromEnv) return fromEnv;
  return bridgeHomePath('resume');
}

// Lower-case, every run of non-letter/non-digit characters becomes one space, trimmed.
export function normalise(s) {
  return String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// True when the normalised needle occurs in the normalised haystack on word boundaries.
function containsWords(haystackNorm, needleNorm) {
  if (!needleNorm) return false;
  return ` ${haystackNorm} `.includes(` ${needleNorm} `);
}

// Finds the first master file in the folder, in the order txt, md, docx, pdf. Returns its name or null.
function findMaster(dir) {
  try {
    const names = new Set(fs.readdirSync(dir));
    for (const ext of MASTER_ORDER) {
      if (names.has(`master.${ext}`)) return `master.${ext}`;
    }
  } catch {
    // missing folder reads as no master
  }
  return null;
}

// Reports whether a master file exists, its format, and whether its text can be read. Never returns contents.
export function masterStatus({ dir = resumeDir() } = {}) {
  const name = findMaster(dir);
  if (!name) return { present: false };
  const format = path.extname(name).slice(1);
  return { present: true, format, readable: readMasterText({ dir }) !== null };
}

// Text of the master resume, or null when missing or unreadable. Never throws.
export function readMasterText({ dir = resumeDir() } = {}) {
  try {
    const name = findMaster(dir);
    if (!name) return null;
    const file = path.join(dir, name);
    const format = path.extname(name).slice(1);
    let text;
    if (format === 'txt' || format === 'md') {
      if (fs.statSync(file).size > TEXT_MASTER_MAX_BYTES) return null;
      text = fs.readFileSync(file, 'utf8');
    } else {
      // docx and pdf go through macOS textutil. Failure or too little text reads as unreadable.
      text = execFileSync('textutil', ['-convert', 'txt', '-stdout', file], {
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (format === 'pdf' && String(text).trim().length < PDF_MIN_CHARS) return null;
    }
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    return text;
  } catch {
    return null;
  }
}

// Plain English words a reworded bullet may use even when they are not in its source: function words, neutral
// reword verbs and neutral nouns. Anything outside this set and outside the source is refused.
export const COMMON_WORDS = new Set((
  // articles, prepositions, conjunctions, pronouns, auxiliaries
  'a an the and or but nor so yet as at by for from in into of off on onto out over per than through to up upon ' +
  'with within without across along among around between during under via after before against toward towards ' +
  'while when where which who whom whose that this these those it its their them they our we my i he she his her ' +
  'is are was were be been being am do does did done have has had having will would can could should may might ' +
  'not no all any each every both either neither some such other another more most less least many much few ' +
  'also only same very well then there here how what why if once new key main whole ' +
  // neutral reword verbs
  'built build builds building developed develop develops developing created create creates creating ' +
  'delivered deliver delivers delivering designed design designs designing implemented implement implements ' +
  'implementing improved improve improves improving produced produce produces producing prepared prepare prepares ' +
  'preparing maintained maintain maintains maintaining analysed analyzed analyse analyze analyses analyzes ' +
  'analysing analyzing reviewed review reviews reviewing monitored monitor monitors monitoring tracked track ' +
  'tracks tracking automated automate automates automating streamlined streamline streamlines streamlining ' +
  'coordinated coordinate coordinates coordinating supported support supports supporting ran run runs running ' +
  'performed perform performs performing completed complete completes completing handled handle handles ' +
  'handling processed process processes processing reconciled reconcile reconciles reconciling reduced reduce ' +
  'reduces reducing wrote write writes writing written presented present presents presenting worked work works ' +
  'working helped help helps helping used use uses using applied apply applies applying contributed contribute ' +
  'contributes contributing collaborated collaborate collaborates collaborating partnered partner ' +
  'partnering provided provide provides providing enabled enable enables enabling established establish ' +
  'establishes establishing introduced introduce introduces introducing updated update updates updating ' +
  'resolved resolve resolves resolving documented document documents documenting standardised standardized ' +
  'standardise standardize standardises standardizes organised organized organise organize organises organizes ' +
  'organising organizing validated validate validates validating verified verify verifies verifying ' +
  'maintained generated generate generates generating extracted extract extracts extracting transformed ' +
  'transform transforms transforming consolidated consolidate consolidates consolidating summarised summarized ' +
  'summarise summarize summarises summarizes tested test tests testing trained train trains training ' +
  'ensured ensure ensures ensuring ' +
  // neutral nouns and adjectives
  'report reports reporting dashboard dashboards data dataset datasets analysis analyses insight insights ' +
  'team teams process processes workflow workflows project projects task tasks result results outcome outcomes ' +
  'business businesses department departments ' +
  'finance financial accounting account accounts month monthly week weekly yearly annual quarter quarterly ' +
  'daily time period periods region regions area areas market markets product products service services ' +
  'system systems tool tools model models metric metrics kpi kpis figure figures record records ledger ledgers ' +
  'statement statements spreadsheet spreadsheets table tables query queries database databases source sources ' +
  'accuracy quality efficiency efficient effective effectively timely timeliness cost costs expense expenses ' +
  'sales operations operational documentation requirement requirements need needs solution solutions ' +
  'feature features function functions step steps stage stages issue issues error errors ' +
  'detail details summary overview view views trend trends pattern patterns forecast forecasts ' +
  'month end close closing cycle cycles review audit audits control controls ' +
  'high low large small good better clear clean accurate reliable consistent automated manual ' +
  'internal external cross functional company companies organisation organization organisations organizations ' +
  'multiple several various different specific relevant key core day days ' +
  'hour hours minute minutes ' +
  'work role roles responsibility responsibilities ' +
  'visual visuals visualisation visualization visualisations visualizations chart charts ' +
  'decision decisions making make makes made ' +
  'weekly decision-making support ' +
  'improvement improvements change changes ' +
  'training'
).split(/\s+/).filter(Boolean).map((w) => normalise(w)).filter(Boolean).flatMap((w) => w.split(' ')));

// Words that assert a fact about seniority, scope, outcome or credentials. Refused when the bullet uses one that its
// source does not contain. These are never in COMMON_WORDS.
export const CLAIM_WORDS = new Set((
  'led lead leading leads managed manager managers manage manages managing supervised supervise supervises ' +
  'supervising supervisor supervisors directed direct directing director directors headed head heads owned own ' +
  'owner owning founded found founder founding architected architect certified certification certifications ' +
  'certificate degree degrees award awarded awards promoted promotion promotions patent patents published ' +
  'publication saved save saves saving savings increased increase increases increasing decreased decrease ' +
  'decreases decreasing doubled tripled halved million millions billion billions thousand thousands percent ' +
  'revenue revenues budget budgets senior principal chief vp president executive ceo cfo cto coo mentored ' +
  'mentor mentoring spearheaded pioneered oversaw oversee overseeing grew grow growth boosted boost ' +
  'accelerated doubled exceeded surpassed outperformed champion championed ranked ' +
  // self-description and tenure claims (summaries): award-winning and results-driven are split by normalise, and
  // results stays a plain COMMON_WORDS word, so only driven and winning are claim words here
  'expert experts experienced proven seasoned skilled extensive years year decade decades driven winning ' +
  'passionate specialist specialists professional ' +
  // outcome and quality words: a bullet may use one only when its own source has it
  'reduced reduce reduces reducing reduction reductions improved improve improves improving improvement ' +
  'improvements accurate accurately accuracy reliable reliably reliability timely timeliness efficient ' +
  'efficiently efficiency errors error better best good great high higher highest faster fast quicker quality ' +
  'effective effectively successfully successful strong strongest excellent outstanding optimised optimized ' +
  'optimise optimize streamlined streamline streamlines streamlining automated automate automates automating ' +
  'enhanced enhance enhances cost costs savings growth productivity performance'
).split(/\s+/).filter(Boolean).map((w) => normalise(w)).filter(Boolean).flatMap((w) => w.split(' ')));

// The two sets stay disjoint: a claim word is never a free reword word.
for (const w of CLAIM_WORDS) COMMON_WORDS.delete(w);

// Number token key: a trailing % and thousands commas are dropped, so "1,000" equals "1000" and "30%" equals "30".
function numKey(tok) {
  return tok.replace(/%$/, '').replace(/(?<=\d),(?=\d{3}(?!\d))/g, '');
}

function numberKeys(text) {
  return (String(text ?? '').match(NUMBER_RE) ?? []).map(numKey);
}

// Refusal wording for an added word. Words with a digit or an @ may be personal, so their text is hidden.
function addedWordReason(word, claim) {
  if (/[\d@]/.test(word)) return 'added word (text hidden) is not in its source';
  return claim
    ? `added claim word "${word}" is not in its source`
    : `added word "${word}" is not in its source`;
}

// Capitalisation and plain word checks against srcNorm. Every capitalised or all-caps word (except the first word of
// the text, or of each sentence when sentences is true) must appear in srcNorm. Every other word must be in srcNorm
// or be a COMMON_WORDS word, and no CLAIM_WORDS word may be added.
function checkWords(text, srcNorm, { sentences = false } = {}) {
  const t = String(text ?? '');
  const srcPadded = ` ${srcNorm} `;

  // Skip the first word: it is the action verb (bullet) or starts a sentence (summary), capitalised by convention.
  const parts = sentences ? t.split(/(?<=[.!?])\s+|\n+/) : [t];
  for (const part of parts) {
    for (const word of (part.match(WORD_RE) ?? []).slice(1)) {
      if (!CAPITAL_RE.test(word)) continue;
      if (!srcPadded.includes(` ${normalise(word)} `)) return { ok: false, reason: addedWordReason(word, false) };
    }
  }

  for (const word of t.match(WORD_RE) ?? []) {
    const w = normalise(word);
    if (!w || /^\d+$/.test(w) || srcPadded.includes(` ${w} `)) continue;
    if (CLAIM_WORDS.has(w)) return { ok: false, reason: addedWordReason(word, true) };
    if (!COMMON_WORDS.has(w)) return { ok: false, reason: addedWordReason(word, false) };
  }
  return { ok: true };
}

// Shared claim check. srcText is the raw source (a bullet's source, or the whole master for a summary). Every number
// must appear in it (1,000 equals 1000), and checkWords must pass against it. Returns { ok: true } or { ok: false, reason }.
function checkClaims(text, srcText, { sentences = false } = {}) {
  const srcNums = new Set(numberKeys(srcText));
  for (const num of numberKeys(text)) {
    if (!srcNums.has(num)) return { ok: false, reason: 'added number (value hidden) is not in its source' };
  }
  return checkWords(text, normalise(srcText), { sentences });
}

// A source must have at least this many words, so a one-word quote cannot launder a claim.
const MIN_SOURCE_WORDS = 3;

// Honesty gate for one bullet. The source must be at least 3 words and a whole-word substring of the master, and the
// bullet must pass checkClaims against that source.
export function checkBullet(bullet, source, masterText) {
  const srcNorm = normalise(source);
  if (srcNorm && srcNorm.split(' ').length < MIN_SOURCE_WORDS) return { ok: false, reason: 'source too short' };
  if (!srcNorm || !containsWords(normalise(masterText), srcNorm)) {
    return { ok: false, reason: 'source not found in the master resume' };
  }
  return checkClaims(bullet, source);
}

// Non-blank master lines with their normalised text.
function masterLines(masterText) {
  return String(masterText ?? '').split(/\r?\n/)
    .map((raw) => ({ raw, norm: normalise(raw) }))
    .filter((l) => l.norm);
}

// Honesty gate for the summary. The whole master is the source for numbers, claim words, capitalised words and plain
// words. On top of that, per summary sentence, every claim word and every number must appear together within ONE
// master line, so claims from different jobs cannot be combined.
export function checkSummary(summary, masterText) {
  const whole = checkClaims(summary, masterText, { sentences: true });
  if (!whole.ok) return whole;
  const lines = masterLines(masterText).map((l) => ({ padded: ` ${l.norm} `, nums: new Set(numberKeys(l.raw)) }));
  const sentences = String(summary ?? '').split(/(?<=[.!?])\s+|\n+/);
  for (let i = 0; i < sentences.length; i += 1) {
    const claims = [...new Set((sentences[i].match(WORD_RE) ?? []).map(normalise).filter((w) => CLAIM_WORDS.has(w)))];
    const nums = numberKeys(sentences[i]);
    if (claims.length === 0 && nums.length === 0) continue;
    const together = lines.some((l) => claims.every((w) => l.padded.includes(` ${w} `)) && nums.every((n) => l.nums.has(n)));
    if (!together) {
      return { ok: false, reason: `sentence ${i + 1} combines facts that are not together on one line of the master resume` };
    }
  }
  return { ok: true };
}

// Honesty gate for the skills list: every entry must occur in the master on word boundaries. Returns "skill N" labels
// for the bad entries; the skill text is never echoed.
export function checkSkills(skills, masterText) {
  const masterNorm = normalise(masterText);
  const bad = [];
  (Array.isArray(skills) ? skills : []).forEach((skill, i) => {
    if (!containsWords(masterNorm, normalise(typeof skill === 'string' ? skill : ''))) bad.push(`skill ${i + 1}`);
  });
  return bad;
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);

const DATE_FILLER = new Set(['to', 'and', 'from', 'until', 'till', 'through', 'since', 'in', 'of']);

// Honesty gate for one experience entry's role, company and dates. Simple rule: split the master into non-blank
// lines; some line must contain the company on word boundaries, and that line plus the line before and after must
// (together) contain the role words, every number token of the dates, and every non-number date word that is not a
// joining word such as "to" (so "Present" or "Jan" needs support). Never echoes the values.
export function checkJobHeader(job, masterText) {
  if (!isObj(job)) return { ok: false };
  const role = normalise(job.role);
  const company = normalise(job.company);
  if (!role || !company) return { ok: false };
  const dateText = String(job.dates ?? '');
  const dateNums = numberKeys(dateText);
  const dateWords = (dateText.match(WORD_RE) ?? []).map(normalise).filter((w) => w && !/^\d+$/.test(w));
  const lines = masterLines(masterText);
  for (let i = 0; i < lines.length; i += 1) {
    if (!containsWords(lines[i].norm, company)) continue;
    const win = lines.slice(Math.max(0, i - 1), i + 2);
    const winNorm = win.map((l) => l.norm).join(' ');
    const winNums = new Set(win.flatMap((l) => numberKeys(l.raw)));
    if (containsWords(winNorm, role)
      && dateNums.every((n) => winNums.has(n))
      && dateWords.every((w) => DATE_FILLER.has(w) || containsWords(winNorm, w))) {
      return { ok: true };
    }
  }
  return { ok: false };
}

// Strips spaces, hyphens, parentheses and plus signs, lower-cased. Used to compare emails and phone numbers.
function squash(s) {
  return String(s ?? '').toLowerCase().replace(/[\s\-()+]+/g, '');
}

// Honesty gate for the header. The name must be in the master on word boundaries. The contact line is split on '|'
// and ','; every non-empty segment must be in the master. Segments with an @ or a digit use the looser squashed
// check: the squashed segment must be a substring of the squashed master and at least 4 characters long. Returns
// { ok: true } or { ok: false, reason } that never echoes the contact line.
export function checkHeader(header, masterText) {
  const masterNorm = normalise(masterText);
  const masterSquash = squash(masterText);
  const name = String(header?.name ?? '').trim();
  if (!name) return { ok: false, reason: 'header name is missing' };
  if (!containsWords(masterNorm, normalise(name))) {
    return { ok: false, reason: 'header name is not in the master resume' };
  }
  const contact = String(header?.contact ?? '').trim();
  if (!contact) return { ok: false, reason: 'header contact line is missing' };
  const segments = contact.split(/[|,]/).map((p) => p.trim()).filter(Boolean);
  if (segments.length === 0) return { ok: false, reason: 'header contact line is missing' };
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const loose = /[@\d]/.test(seg);
    const found = loose
      ? squash(seg).length >= 4 && masterSquash.includes(squash(seg))
      : containsWords(masterNorm, normalise(seg));
    if (!found) return { ok: false, reason: `contact segment ${i + 1} is not in the master resume` };
  }
  return { ok: true };
}

// Minimal one-column ATS html. All text is escaped. No table, img, header, footer, div or span.
export function renderAtsHtml(resume) {
  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const list = (items) => `<ul>\n${(items ?? []).map((t) => `<li>${esc(t)}</li>`).join('\n')}\n</ul>`;

  const experience = asArray(resume.experience).map((job) => {
    const heading = `<p><strong>${esc(job?.role)}</strong>, ${esc(job?.company)}, ${esc(job?.dates)}</p>`;
    return `${heading}\n${list(asArray(job?.bullets).map((b) => b?.text))}`;
  }).join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Resume</title>',
    '<style>body { font-family: Arial, sans-serif; font-size: 11pt; margin: 2cm; color: #000; } h1 { font-size: 20pt; margin: 0 0 4pt; } h2 { font-size: 13pt; margin: 14pt 0 4pt; } ul { margin: 0 0 6pt 18pt; padding: 0; } p { margin: 0 0 6pt; }</style>',
    '</head>',
    '<body>',
    `<h1>${esc(resume.header?.name)}</h1>`,
    `<p>${esc(resume.header?.contact)}</p>`,
    '<h2>Summary</h2>',
    `<p>${esc(resume.summary)}</p>`,
    '<h2>Skills</h2>',
    `<p>${esc(asArray(resume.skills).join(', '))}</p>`,
    '<h2>Experience</h2>',
    experience,
    '<h2>Education</h2>',
    list(asArray(resume.education).map((e) => e?.text)),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

const TEXTUTIL = 'textutil';
const OSASCRIPT = '/usr/bin/osascript';

// JXA program: html file -> US Letter pdf with 54pt margins and automatic pagination, using AppKit only. Paths come
// in as arguments (argv[0] html, argv[1] pdf), never interpolated into this source.
const PDF_JXA = `
ObjC.import('AppKit');
ObjC.import('Foundation');
function run(argv) {
  var data = $.NSData.dataWithContentsOfFile($(argv[0]));
  if (!data || data.isNil()) throw new Error('cannot read html');
  var astr = $.NSAttributedString.alloc.initWithHTMLDocumentAttributes(data, $.NSDictionary.dictionary);
  if (!astr || astr.isNil()) throw new Error('cannot parse html');
  // The HTML importer yields literal bullet text plus NSTextList markers; drop the lists so each bullet draws once.
  var mas = astr.mutableCopy;
  mas.enumerateAttributeInRangeOptionsUsingBlock($.NSParagraphStyleAttributeName, $.NSMakeRange(0, mas.length), 0,
    function (v, r) {
      if (v && !v.isNil() && v.textLists.count > 0) {
        var ps = v.mutableCopy;
        ps.setTextLists($([]));
        mas.addAttributeValueRange($.NSParagraphStyleAttributeName, ps, r);
      }
    });
  var W = 612, H = 792, M = 54;
  var info = $.NSPrintInfo.alloc.initWithDictionary($.NSDictionary.dictionary);
  info.paperSize = $.NSMakeSize(W, H);
  info.topMargin = M; info.bottomMargin = M; info.leftMargin = M; info.rightMargin = M;
  info.horizontallyCentered = false; info.verticallyCentered = false;
  info.jobDisposition = $.NSPrintSaveJob;
  info.dictionary.setObjectForKey($.NSURL.fileURLWithPath($(argv[1])), $.NSPrintJobSavingURL);
  var tv = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, W - 2 * M, H - 2 * M));
  tv.textStorage.setAttributedString(mas);
  tv.textContainer.containerSize = $.NSMakeSize(W - 2 * M, 1e7);
  tv.setHorizontallyResizable(false);
  tv.setVerticallyResizable(true);
  // Size the view to its full content so the print operation paginates every line.
  tv.layoutManager.ensureLayoutForTextContainer(tv.textContainer);
  var used = tv.layoutManager.usedRectForTextContainer(tv.textContainer);
  tv.setFrameSize($.NSMakeSize(W - 2 * M, Math.ceil(used.size.height) + 10));
  var op = $.NSPrintOperation.printOperationWithViewPrintInfo(tv, info);
  op.showsPrintPanel = false;
  op.showsProgressPanel = false;
  if (!op.runOperation) throw new Error('print operation failed');
  return 'ok';
}
`;
const CUPSFILTER = '/usr/sbin/cupsfilter';
const STEM_MAX = 80;

// File name stem from company and job title: lower-case, every run of characters other than a-z or 0-9 becomes one
// hyphen, trimmed, at most 80 characters. Only a-z, 0-9 and hyphens survive, so no path separator or '..' can.
export function safeFileStem(company, title) {
  const stem = `${company ?? ''}-${title ?? ''}`.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STEM_MAX)
    .replace(/-+$/, '');
  return stem || 'resume';
}

function runTool(cmd, args) {
  return execFileSync(cmd, args, {
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function toolError(name, err) {
  if (err?.code === 'ENOENT') return `${name} is not installed on this computer`;
  return `${name} failed: ${String(err?.message ?? err).split('\n')[0].slice(0, 200)}`;
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // leftover intermediate files are not fatal
  }
}

// Formatted PDF through JXA and AppKit (US Letter, 54pt margins, Arial headings and bullets from the html). Returns
// true when a real PDF exists at pdfPath with mode 0600; otherwise removes any partial file and returns false.
function renderFormattedPdf(htmlPath, pdfPath) {
  try {
    execFileSync(OSASCRIPT, ['-l', 'JavaScript', '-e', PDF_JXA, htmlPath, pdfPath], {
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const head = fs.readFileSync(pdfPath).subarray(0, 4).toString('latin1');
    if (head !== '%PDF') throw new Error('no PDF produced');
    fs.chmodSync(pdfPath, 0o600);
    return true;
  } catch {
    removeQuietly(pdfPath);
    return false;
  }
}

// Writes the html, converts it to docx (textutil) and pdf (AppKit via JXA, falling back to html to txt with textutil
// then cupsfilter, because this Mac's CUPS has no html filter and textutil cannot write pdf). Never throws. Returns absolute paths or null.
function writeOutputFiles({ html, outDir, stem }) {
  const result = { html: null, docx: null, pdf: null };
  const htmlPath = path.join(outDir, `${stem}.html`);
  try {
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(outDir, 0o700);
    fs.writeFileSync(htmlPath, html, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(htmlPath, 0o600);
  } catch (err) {
    return { ...result, error: `Could not write the resume file: ${String(err?.message ?? err).slice(0, 200)}` };
  }
  if (process.platform !== 'darwin') {
    return { ...result, html: htmlPath, error: `textutil is not available on ${process.platform}; the html is kept at ${htmlPath}` };
  }

  const docxPath = path.join(outDir, `${stem}.docx`);
  try {
    runTool(TEXTUTIL, ['-convert', 'docx', htmlPath]);
    fs.chmodSync(docxPath, 0o600);
    result.docx = docxPath;
  } catch (err) {
    result.error = toolError('textutil (docx)', err);
  }

  const txtPath = path.join(outDir, `${stem}.txt`);
  const pdfPath = path.join(outDir, `${stem}.pdf`);
  if (renderFormattedPdf(htmlPath, pdfPath)) {
    result.pdf = pdfPath;
  } else {
    // Fallback: monospace text pdf (html to txt with textutil, then cupsfilter).
    try {
      runTool(TEXTUTIL, ['-convert', 'txt', htmlPath]);
      const pdf = runTool(CUPSFILTER, ['-m', 'application/pdf', txtPath]);
      if (pdf.length === 0 || pdf.subarray(0, 4).toString('latin1') !== '%PDF') {
        throw new Error('cupsfilter produced no PDF');
      }
      fs.writeFileSync(pdfPath, pdf, { mode: 0o600 });
      fs.chmodSync(pdfPath, 0o600);
      result.pdf = pdfPath;
    } catch (err) {
      result.pdfError = toolError('cupsfilter (pdf)', err);
    } finally {
      removeQuietly(txtPath);
    }
  }

  if (result.docx) {
    removeQuietly(htmlPath);
  } else {
    result.html = htmlPath;
  }
  return result;
}

// Builds the tailored resume and writes it under <dir>/out. Refuses the whole build if the master is missing or any
// bullet fails the gate; a refused build writes no file.
export function buildResume(input, { dir = resumeDir() } = {}) {
  const masterText = readMasterText({ dir });
  if (masterText === null) {
    return {
      ok: false,
      error: 'The master resume is missing or unreadable. Supply a Word (.docx) or text (.txt or .md) copy of it in the resume folder.',
    };
  }

  const headerCheck = checkHeader(input?.header, masterText);
  if (!headerCheck.ok) {
    return { ok: false, error: `Build refused. The resume header is not supported by the master resume: ${headerCheck.reason}` };
  }

  const refused = [];
  try {
    asArray(input?.experience).forEach((job, ji) => {
      if (!isObj(job)) {
        refused.push(`experience ${ji + 1} (not an object)`);
        return;
      }
      if (!checkJobHeader(job, masterText).ok) {
        refused.push(`experience ${ji + 1} role/company/dates (not supported together by the master resume)`);
      }
      asArray(job.bullets).forEach((b, bi) => {
        if (!isObj(b)) {
          refused.push(`experience ${ji + 1} bullet ${bi + 1} (not an object)`);
          return;
        }
        const r = checkBullet(b.text, b.source, masterText);
        if (!r.ok) refused.push(`"${b.text}" (${r.reason})`);
      });
    });
    asArray(input?.education).forEach((e, ei) => {
      if (!isObj(e)) {
        refused.push(`education ${ei + 1} (not an object)`);
        return;
      }
      const r = checkBullet(e.text, e.source, masterText);
      if (!r.ok) refused.push(`"${e.text}" (${r.reason})`);
    });
    if (input?.summary != null && String(input.summary).trim() !== '') {
      const r = checkSummary(input.summary, masterText);
      if (!r.ok) refused.push(`summary (${r.reason})`);
    }
    for (const bad of checkSkills(input?.skills, masterText)) refused.push(`${bad} (not in the master resume)`);
    const masterN = normalise(masterText);
    const skillsN = new Set(asArray(input?.skills).map((k) => normalise(typeof k === 'string' ? k : '')));
    asArray(input?.keywords_used).forEach((k, i) => {
      const n = normalise(typeof k === 'string' ? k : '');
      if (!n || !(skillsN.has(n) || containsWords(masterN, n))) refused.push(`keyword_used ${i + 1} (not in the master resume)`);
    });
  } catch {
    return { ok: false, error: 'Build refused. The resume input is malformed.' };
  }
  if (refused.length > 0) {
    return { ok: false, error: `Build refused. These items are not supported by the master resume: ${refused.join('; ')}` };
  }

  const masterNorm = normalise(masterText);
  const gaps = asArray(input?.job_keywords).filter((k) => {
    const n = normalise(typeof k === 'string' ? k : '');
    return n && !containsWords(masterNorm, n);
  });

  const written = writeOutputFiles({
    html: renderAtsHtml(input ?? {}),
    outDir: path.join(dir, 'out'),
    stem: safeFileStem(input?.company, input?.job_title),
  });
  const out = { ok: true, html: written.html, docx: written.docx, pdf: written.pdf, gaps };
  if (written.pdfError) out.pdfError = written.pdfError;
  if (written.error) out.error = written.error;
  return out;
}
