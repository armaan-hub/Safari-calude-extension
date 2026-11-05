// Tests for the Job Watcher activity formatter (bridge/jobwatch-activity.mjs). Built-ins only. Fictional data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeToolCall, formatStreamEvent } from '../jobwatch-activity.mjs';

const call = (name, input = {}) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name, input }] },
});

const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

const toolResult = (content, extra = {}) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', content, ...extra }] },
});

test('read_page and get_page_text map to plain words', () => {
  assert.deepEqual(formatStreamEvent(call('mcp__safari__read_page')), ['reading the page']);
  assert.deepEqual(formatStreamEvent(call('mcp__safari__get_page_text')), ['reading page text']);
});

test('click shows the ref', () => {
  assert.deepEqual(formatStreamEvent(call('mcp__safari__click', { ref: 'ref_7' })), ['clicking ref_7']);
});

test('type shows the text and the ref', () => {
  assert.deepEqual(formatStreamEvent(call('mcp__safari__type', { ref: 'ref_2', text: 'hello' })), [
    'typing "hello" into ref_2',
  ]);
});

test('type never prints more than 60 characters of typed text', () => {
  const lines = formatStreamEvent(call('mcp__safari__type', { ref: 'ref_2', text: 'x'.repeat(200) }));
  assert.equal(lines.length, 1);
  const shown = /^typing "(x*)" into ref_2$/.exec(lines[0]);
  assert.ok(shown, `unexpected line: ${lines[0]}`);
  assert.equal(shown[1].length, 60);
});

test('press_key shows the key', () => {
  assert.deepEqual(formatStreamEvent(call('mcp__safari__press_key', { key: 'Enter' })), ['pressing key Enter']);
});

test('scroll shows the direction, or the ref when there is no direction', () => {
  assert.deepEqual(formatStreamEvent(call('mcp__safari__scroll', { direction: 'down' })), ['scrolling down']);
  assert.deepEqual(formatStreamEvent(call('mcp__safari__scroll', { ref: 'ref_4' })), ['scrolling to ref_4']);
});

test('navigate shows host and path only, never the query string or fragment', () => {
  const lines = formatStreamEvent(call('mcp__safari__navigate', { url: 'https://example.com/jobs/1?trk=SECRET#frag' }));
  assert.deepEqual(lines, ['opening example.com/jobs/1']);
});

test('navigate truncates a long path and handles an unparseable URL', () => {
  const lines = formatStreamEvent(call('mcp__safari__navigate', { url: `https://example.com/${'a'.repeat(300)}` }));
  assert.equal(lines[0], `opening example.com/${'a'.repeat(59)}`);
  assert.deepEqual(formatStreamEvent(call('mcp__safari__navigate', { url: 'not a url?q=SECRET' })), ['opening a page']);
});

test('wait shows the seconds', () => {
  assert.deepEqual(formatStreamEvent(call('mcp__safari__wait', { seconds: 3 })), ['waiting 3 s']);
});

test('screenshot and safari_status have their own wording', () => {
  assert.deepEqual(formatStreamEvent(call('mcp__safari__screenshot')), ['taking a screenshot']);
  assert.deepEqual(formatStreamEvent(call('mcp__safari__safari_status')), ['checking Safari connection']);
});

test('the mcp__safari__ prefix is stripped before mapping, and other tools show their bare name', () => {
  assert.deepEqual(formatStreamEvent(call('mcp__safari__weird_tool')), ['weird_tool']);
  assert.deepEqual(formatStreamEvent(call('Bash')), ['Bash']);
});

test('assistant text is shown as says: with newlines collapsed and truncated to 240 characters', () => {
  assert.deepEqual(formatStreamEvent(say('line one\nline two')), ['says: line one line two']);
  const lines = formatStreamEvent(say('a'.repeat(400)));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `says: ${'a'.repeat(240)}`);
});

test('a tool_result that is_error is shown, truncated to 160 characters', () => {
  const text = `Error: Blocked: ${'y'.repeat(300)}`;
  const lines = formatStreamEvent(toolResult(text, { is_error: true }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `result: ${text.slice(0, 160)}`);
});

test('a tool_result whose text starts with Error: is shown even without is_error', () => {
  assert.deepEqual(formatStreamEvent(toolResult('Error: Blocked: needs approval')), [
    'result: Error: Blocked: needs approval',
  ]);
});

test('a tool_result with array content is read from its text parts', () => {
  assert.deepEqual(
    formatStreamEvent(toolResult([{ type: 'text', text: 'Error: nope' }], { is_error: true })),
    ['result: Error: nope'],
  );
});

test('successful tool results print nothing', () => {
  assert.deepEqual(formatStreamEvent(toolResult('Clicked.')), []);
  assert.deepEqual(formatStreamEvent(toolResult([{ type: 'text', text: 'ok' }])), []);
});

test('one event with several content blocks gives one line per block, in order', () => {
  const ev = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', name: 'mcp__safari__read_page', input: {} },
      ],
    },
  };
  assert.deepEqual(formatStreamEvent(ev), ['says: Looking.', 'reading the page']);
});

test('unknown and malformed events return [] and never throw', () => {
  const junk = [
    null,
    undefined,
    42,
    'a string',
    [],
    {},
    { type: 'system', subtype: 'init' },
    { type: 'result', is_error: false, result: 'x' },
    { type: 'assistant' },
    { type: 'assistant', message: { content: 'not an array' } },
    { type: 'assistant', message: { content: [null, 5, 'x'] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 17 }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 12 }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: { weird: true } }] } },
  ];
  for (const ev of junk) {
    let lines;
    assert.doesNotThrow(() => {
      lines = formatStreamEvent(ev);
    }, `threw on ${JSON.stringify(ev)}`);
    assert.ok(Array.isArray(lines), `not an array for ${JSON.stringify(ev)}`);
    assert.equal(lines.length, 0, `expected [] for ${JSON.stringify(ev)}`);
  }
});

test('describeToolCall: showTyped false gives the character count instead of the typed text', () => {
  assert.equal(
    describeToolCall('mcp__safari__type', { ref: 'ref_2', text: 'Test User 42' }, { showTyped: false }),
    'typing 12 characters into ref_2',
  );
  assert.equal(
    describeToolCall('mcp__safari__type', { ref: 'ref_2', text: 'hello' }),
    'typing "hello" into ref_2',
    'default keeps the text',
  );
  assert.equal(describeToolCall('mcp__safari__click', { ref: 'ref_7' }), 'clicking ref_7');
});

test('formatStreamEvent with tools false keeps only says lines', () => {
  const ev = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', name: 'mcp__safari__read_page', input: {} },
      ],
    },
  };
  assert.deepEqual(formatStreamEvent(ev, { tools: false }), ['says: Looking.']);
  assert.deepEqual(formatStreamEvent(toolResult('Error: nope', { is_error: true }), { tools: false }), []);
  assert.deepEqual(formatStreamEvent(ev), ['says: Looking.', 'reading the page'], 'default unchanged');
});

test('open_tab shows host and path only, never the query string or fragment', () => {
  assert.equal(
    describeToolCall('mcp__safari__open_tab', { url: 'https://www.linkedin.com/jobs?x=SECRET#frag' }),
    'opening www.linkedin.com/jobs in a new tab',
  );
  assert.deepEqual(formatStreamEvent(call('mcp__safari__open_tab', { url: 'https://www.linkedin.com/jobs?k=SECRET' })), [
    'opening www.linkedin.com/jobs in a new tab',
  ]);
});

test('open_tab trims the path to 60 characters', () => {
  const longPath = 'a'.repeat(100);
  const words = describeToolCall('mcp__safari__open_tab', { url: `https://www.linkedin.com/${longPath}` });
  assert.equal(words, `opening www.linkedin.com/${'a'.repeat(59)} in a new tab`);
});

test('open_tab with an unparsable or hostless url says opening a new tab', () => {
  assert.equal(describeToolCall('mcp__safari__open_tab', { url: 'not a url' }), 'opening a new tab');
  assert.equal(describeToolCall('mcp__safari__open_tab', { url: 'javascript:alert(1)' }), 'opening a new tab');
  assert.equal(describeToolCall('mcp__safari__open_tab', {}), 'opening a new tab');
});
