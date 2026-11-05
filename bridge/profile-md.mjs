// Profile markdown: generates profile.md from profile.json and searches its sections.
// Built-ins only. Generic: no personal keys are hard-coded. Notes the user writes between the
// notes markers survive regeneration. Output never contains values from the search "note" field.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir } from './jobwatch-state.mjs';
import { bridgeHomePath } from './paths.mjs';

const NOTES_START = '<!-- notes:start -->';
const NOTES_END = '<!-- notes:end -->';
const NOTES_HEADING = 'Notes (yours)';
const NOT_PROVIDED = 'NOT PROVIDED';

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isEmpty(v) {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

// snake_case, kebab-case and camelCase -> "Title Case".
function titleCase(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function scalar(v) {
  return isEmpty(v) ? NOT_PROVIDED : String(v);
}

// Lines for an object's entries, indented by depth (two spaces per level).
function entryLines(obj, depth) {
  const pad = '  '.repeat(depth);
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    if (isEmpty(value)) {
      out.push(`${pad}- ${key}: ${NOT_PROVIDED}`);
    } else if (Array.isArray(value)) {
      out.push(`${pad}- ${key}:`);
      out.push(...itemLines(value, depth + 1));
    } else if (isObj(value)) {
      out.push(`${pad}- ${key}:`);
      out.push(...entryLines(value, depth + 1));
    } else {
      out.push(`${pad}- ${key}: ${scalar(value)}`);
    }
  }
  return out;
}

// Lines for an array's items, indented by depth.
function itemLines(arr, depth) {
  const pad = '  '.repeat(depth);
  const out = [];
  for (const item of arr) {
    if (isEmpty(item)) {
      out.push(`${pad}- ${NOT_PROVIDED}`);
    } else if (isObj(item)) {
      out.push(`${pad}-`);
      out.push(...entryLines(item, depth + 1));
    } else if (Array.isArray(item)) {
      out.push(...itemLines(item, depth));
    } else {
      out.push(`${pad}- ${String(item)}`);
    }
  }
  return out;
}

function sectionBody(value) {
  if (isEmpty(value)) return NOT_PROVIDED;
  if (Array.isArray(value)) return itemLines(value, 0).join('\n');
  if (isObj(value)) return entryLines(value, 0).join('\n');
  return String(value);
}

function sanitiseNotes(notes) {
  return String(notes ?? '').split(NOTES_START).join('').split(NOTES_END).join('').trim();
}

// Builds the profile.md text. Keys starting with "_" are skipped.
export function renderProfileMd(profile, notes = '') {
  const lines = [
    '# Profile',
    '',
    'Generated from profile.json. Edit profile.json and regenerate; text between the notes markers is kept.',
    '',
  ];
  for (const [key, value] of Object.entries(profile ?? {})) {
    if (key.startsWith('_')) continue;
    lines.push(`## ${titleCase(key)}`, sectionBody(value), '');
  }
  lines.push(`## ${NOTES_HEADING}`, NOTES_START, sanitiseNotes(notes), NOTES_END, '');
  return lines.join('\n');
}

// Text between the notes markers, trimmed. Empty string when there are no markers.
export function extractNotes(md) {
  const text = String(md ?? '');
  const start = text.indexOf(NOTES_START);
  if (start === -1) return '';
  const from = start + NOTES_START.length;
  const end = text.indexOf(NOTES_END, from);
  if (end === -1) return '';
  return text.slice(from, end).trim();
}

function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Reads profile.json, keeps the notes from the existing output file and writes profile.md
// atomically with mode 0600. Throws an Error with a plain message on failure.
export function writeProfileMd({ profileFile, outFile } = {}) {
  const src = profileFile ?? path.join(stateDir(), 'profile.json');
  const dest =
    outFile ||
    process.env.ASSISTANT_PROFILE_FILE ||
    bridgeHomePath('profile.md');

  const raw = readOptional(src);
  if (raw === null) throw new Error(`profile.json not found: ${src}`);
  let profile;
  try {
    profile = JSON.parse(raw);
  } catch {
    throw new Error(`profile.json is not valid JSON: ${src}`);
  }
  if (!isObj(profile)) throw new Error(`profile.json must be a JSON object: ${src}`);

  const existing = readOptional(dest);
  const notes = existing === null ? '' : extractNotes(existing);
  const md = renderProfileMd(profile, notes);

  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, md, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);

  const sections = md
    .split('\n')
    .filter((l) => l.startsWith('## ') && l !== `## ${NOTES_HEADING}`).length;
  return { file: dest, sections };
}

// Splits profile markdown into {heading, text} sections. Marker lines are removed from texts.
function parseSections(md) {
  const sections = [];
  let current = null;
  for (const line of String(md ?? '').split('\n')) {
    if (line.startsWith('## ')) {
      current = { heading: line.slice(3).trim(), lines: [] };
      sections.push(current);
    } else if (current && line !== NOTES_START && line !== NOTES_END) {
      current.lines.push(line);
    }
  }
  return sections.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() }));
}

// Tokens: lower-cased letter/number runs of at least two characters.
function tokenize(query) {
  return [
    ...new Set(
      String(query ?? '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 2),
    ),
  ];
}

// Ranks sections by query tokens (a heading hit counts 2, a body hit counts 1) and returns the
// best ones within maxSections and maxChars (summed section text length).
export function searchProfile(md, query, { maxSections = 5, maxChars = 4000 } = {}) {
  const sections = parseSections(md);
  const headings = sections.map((s) => s.heading).join(', ');
  const tokens = tokenize(query);

  if (tokens.length === 0) {
    return { sections: [], truncated: false, note: `Sections: ${headings}` };
  }

  const scored = [];
  sections.forEach((s, index) => {
    const h = s.heading.toLowerCase();
    const b = s.text.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (h.includes(t)) score += 2;
      else if (b.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ ...s, score, index });
  });

  if (scored.length === 0) {
    return { sections: [], truncated: false, note: `No matching section. Sections: ${headings}` };
  }

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const out = [];
  let remaining = maxChars;
  let truncated = false;
  for (const s of scored.slice(0, maxSections)) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    let text = s.text;
    if (text.length > remaining) {
      text = text.slice(0, remaining);
      truncated = true;
    }
    out.push({ heading: s.heading, text });
    remaining -= text.length;
    if (truncated) break;
  }
  return { sections: out, truncated };
}
