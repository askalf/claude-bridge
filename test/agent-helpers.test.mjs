// Tests for the pure helpers added with audit-streaming + safe-mode:
//   parseConfirmPrefix — sandbox escape-hatch parser
//   isErrorOutput      — executeTool error-string detector
//   filterTools        — allowedTools-set filter for the API tools array
//   READ_ONLY_TOOLS    — the safe-mode default tool set
//
// All four are exported from agent.ts so the contracts can be pinned
// without spinning up a real DiscordAgent (no fetch, no fs, no proxy).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfirmPrefix,
  isErrorOutput,
  filterTools,
  READ_ONLY_TOOLS,
} from '../dist/agent.js';

// ── parseConfirmPrefix ──────────────────────────────────────────────

test('parseConfirmPrefix — !confirm with task elevates and strips prefix', () => {
  assert.deepEqual(parseConfirmPrefix('!confirm fix the bug'), { confirmed: true, prompt: 'fix the bug' });
  assert.deepEqual(parseConfirmPrefix('!confirm   leading whitespace'), { confirmed: true, prompt: 'leading whitespace' });
  assert.deepEqual(parseConfirmPrefix('!confirm task with trailing  '), { confirmed: true, prompt: 'task with trailing' });
});

test('parseConfirmPrefix — bare !confirm with no task returns empty prompt', () => {
  assert.deepEqual(parseConfirmPrefix('!confirm'), { confirmed: true, prompt: '' });
  assert.deepEqual(parseConfirmPrefix('  !confirm  '), { confirmed: true, prompt: '' });
});

test('parseConfirmPrefix — plain text is not confirmed and is returned trimmed', () => {
  assert.deepEqual(parseConfirmPrefix('fix the bug'), { confirmed: false, prompt: 'fix the bug' });
  assert.deepEqual(parseConfirmPrefix('  spaced out  '), { confirmed: false, prompt: 'spaced out' });
});

test('parseConfirmPrefix — anchored to start: !confirm later in body does NOT elevate', () => {
  // Otherwise asking the agent "should I add a !confirm step here?" would
  // accidentally grant full tools to that very turn.
  const r = parseConfirmPrefix('please add a !confirm step');
  assert.equal(r.confirmed, false);
  assert.equal(r.prompt, 'please add a !confirm step');
});

test('parseConfirmPrefix — case-sensitive: !CONFIRM is not the escape hatch', () => {
  const r = parseConfirmPrefix('!CONFIRM fix');
  assert.equal(r.confirmed, false);
  assert.equal(r.prompt, '!CONFIRM fix');
});

test('parseConfirmPrefix — !confirm without trailing space (e.g. !confirmed) is not a match', () => {
  // The regex requires \s+ between `confirm` and the task text, so
  // `!confirmed` (a different word starting with the same letters) is
  // treated as plain text, not as `!confirm` with a task `ed`.
  const r = parseConfirmPrefix('!confirmed yesterday');
  assert.equal(r.confirmed, false);
  assert.equal(r.prompt, '!confirmed yesterday');
});

test('parseConfirmPrefix — multiline task content is preserved (with /s flag)', () => {
  const r = parseConfirmPrefix('!confirm fix\nthe bug\nnow');
  assert.equal(r.confirmed, true);
  assert.equal(r.prompt, 'fix\nthe bug\nnow');
});

// ── isErrorOutput ───────────────────────────────────────────────────

test('isErrorOutput — recognizes the executeTool error-string contract', () => {
  assert.equal(isErrorOutput('Error: command not found'), true);
  assert.equal(isErrorOutput('Error: '), true);
  assert.equal(isErrorOutput('Error: ENOENT: no such file'), true);
});

test('isErrorOutput — successful tool output does not match', () => {
  assert.equal(isErrorOutput(''), false);
  assert.equal(isErrorOutput('hello world'), false);
  assert.equal(isErrorOutput('No matches'), false);            // Glob/Grep miss
  assert.equal(isErrorOutput('Written to /tmp/foo'), false);   // Write success
  assert.equal(isErrorOutput('error: lowercase'), false);      // wrong case — not the contract
  assert.equal(isErrorOutput('error in something'), false);    // missing colon
  assert.equal(isErrorOutput(' Error: leading space'), false); // not at start
});

// ── filterTools ─────────────────────────────────────────────────────

const SAMPLE_TOOLS = [
  { name: 'Bash' },
  { name: 'Read' },
  { name: 'Write' },
  { name: 'Glob' },
  { name: 'Grep' },
];

test('filterTools — undefined allowed-set returns the full list (no restriction)', () => {
  const out = filterTools(SAMPLE_TOOLS, undefined);
  assert.equal(out.length, 5);
  assert.deepEqual(out.map(t => t.name), ['Bash', 'Read', 'Write', 'Glob', 'Grep']);
});

test('filterTools — empty set returns empty array', () => {
  const out = filterTools(SAMPLE_TOOLS, new Set());
  assert.equal(out.length, 0);
});

test('filterTools — subset set returns only matching tools, in original order', () => {
  const out = filterTools(SAMPLE_TOOLS, new Set(['Read', 'Glob']));
  assert.deepEqual(out.map(t => t.name), ['Read', 'Glob']);
});

test('filterTools — set members that do not name any tool are silently ignored', () => {
  const out = filterTools(SAMPLE_TOOLS, new Set(['Read', 'NotARealTool']));
  assert.deepEqual(out.map(t => t.name), ['Read']);
});

test('filterTools — returns a fresh array, not the input reference', () => {
  // Ensures the caller can't accidentally mutate TOOLS by mutating the
  // returned list.
  const out = filterTools(SAMPLE_TOOLS, undefined);
  assert.notEqual(out, SAMPLE_TOOLS, 'returned array must not be the input ref');
});

// ── READ_ONLY_TOOLS ─────────────────────────────────────────────────

test('READ_ONLY_TOOLS — exactly the three read-only tools, nothing else', () => {
  assert.equal(READ_ONLY_TOOLS.size, 3);
  assert.equal(READ_ONLY_TOOLS.has('Read'), true);
  assert.equal(READ_ONLY_TOOLS.has('Glob'), true);
  assert.equal(READ_ONLY_TOOLS.has('Grep'), true);
});

test('READ_ONLY_TOOLS — explicitly excludes mutating / shelling tools', () => {
  // The whole point of safe-mode is that these two stay out unless the
  // reply is `!confirm`-prefixed; pin them so a future "let's add Edit
  // here" PR has to consciously reach into READ_ONLY_TOOLS.
  assert.equal(READ_ONLY_TOOLS.has('Bash'),  false);
  assert.equal(READ_ONLY_TOOLS.has('Write'), false);
});

test('READ_ONLY_TOOLS + filterTools — composes to the safe-mode call set', () => {
  const out = filterTools(SAMPLE_TOOLS, READ_ONLY_TOOLS);
  assert.deepEqual(out.map(t => t.name), ['Read', 'Glob', 'Grep']);
});
