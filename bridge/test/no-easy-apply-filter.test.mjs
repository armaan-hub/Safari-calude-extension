import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TEST_PROFILE } from './fixtures.mjs';
import { pickCombos, buildSearchUrl, buildDiscoverPrompt } from '../jobwatch-rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('buildSearchUrl never adds the Easy Apply filter (f_AL)', () => {
  const url = buildSearchUrl('"BI analyst"', 'United Arab Emirates');
  assert.equal(url.includes('f_AL'), false);
  assert.match(url, /f_TPR=r10800/);
});

test('every planned search_url from pickCombos is free of f_AL', () => {
  const combos = pickCombos(TEST_PROFILE, 0, 8);
  assert.ok(combos.length > 0, 'pickCombos returns combos for the fixture profile');
  for (const c of combos) {
    assert.equal(c.search_url.includes('f_AL'), false, `${c.id} search_url has no f_AL`);
  }
});

test('discover system rules state the Easy Apply filter rule', () => {
  const { system } = buildDiscoverPrompt({ combos: [], tabId: 1, maxJobPages: 1, skills: [] });
  assert.match(system, /Easy Apply filter/);
});

test('filer.md states the Easy Apply filter rule', () => {
  const text = readFileSync(join(here, '..', 'agents', 'filer.md'), 'utf8');
  assert.match(text, /Easy Apply filter/i);
});
