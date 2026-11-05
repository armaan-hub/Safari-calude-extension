#!/usr/bin/env node
// Test double for the claude CLI used by jobwatch.mjs. Built-ins only, fictional data only.
// Records its argv and stdin as one JSON line in $FAKE_CLAUDE_LOG.
// With "stream-json" in argv it prints a realistic newline-delimited event stream (assistant text, a tool_use,
// an error tool_result, more text) and then one {type:"result"} line whose "result" is the text of the file named
// by $FAKE_CLAUDE_REPLY. $FAKE_CLAUDE_NO_RESULT=1 omits the result line.
// Without "stream-json" it prints the old single JSON result object.
// Exits with $FAKE_CLAUDE_EXIT if set. $FAKE_CLAUDE_SLEEP_MS delays the answer (used for the timeout test).

import fs from 'node:fs';

const logFile = process.env.FAKE_CLAUDE_LOG;
const streamJson = process.argv.includes('stream-json');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  if (logFile) {
    fs.appendFileSync(logFile, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\n', {
      mode: 0o600,
    });
  }
  const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
  setTimeout(() => {
    const replyFile = process.env.FAKE_CLAUDE_REPLY;
    const reply = replyFile ? fs.readFileSync(replyFile, 'utf8') : '';
    const exitCode = process.env.FAKE_CLAUDE_EXIT ? Number(process.env.FAKE_CLAUDE_EXIT) : 0;
    const lines = [];
    if (streamJson) {
      lines.push(
        { type: 'system', subtype: 'init', tools: [], model: 'haiku' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Opening the job list.' }] } },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__safari__click', input: { tab_id: 42, ref: 'ref_7' } }] },
        },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                is_error: true,
                content: [{ type: 'text', text: 'Error: Blocked: the Send button needs the user to approve it.' }],
              },
            ],
          },
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the results.' }] } },
      );
      if (process.env.FAKE_CLAUDE_NO_RESULT !== '1') {
        lines.push({ type: 'result', subtype: 'success', is_error: false, result: reply });
      }
    } else {
      lines.push({ type: 'result', is_error: false, result: reply });
    }
    const out = lines.map((l) => JSON.stringify(l) + '\n').join('');
    process.stdout.write(out, () => process.exit(exitCode));
  }, sleepMs);
});
