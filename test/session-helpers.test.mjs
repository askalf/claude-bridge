// Tests for the pure helpers exported from session-watcher.ts —
// extractText (CC JSONL content → plain text) and projectName
// (CC's mangled directory name → human-readable breadcrumb).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, projectName } from '../dist/session-watcher.js';

test('extractText — bare string passes through', () => {
  assert.equal(extractText('plain message'), 'plain message');
});

test('extractText — array: concatenates text blocks', () => {
  const content = [
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ];
  assert.equal(extractText(content), 'first\nsecond');
});

test('extractText — skips tool_use / tool_result blocks', () => {
  const content = [
    { type: 'text', text: 'before tool' },
    { type: 'tool_use', id: 'xyz', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', tool_use_id: 'xyz', content: 'file.txt' },
    { type: 'text', text: 'after tool' },
  ];
  // Only the text blocks should show up — not the tool machinery.
  assert.equal(extractText(content), 'before tool\nafter tool');
});

test('extractText — empty array → empty string', () => {
  assert.equal(extractText([]), '');
});

test('extractText — missing text field → empty contribution', () => {
  const content = [{ type: 'text' }, { type: 'text', text: 'ok' }];
  assert.equal(extractText(content), '\nok');
});

test('extractText — non-string, non-array → empty string', () => {
  assert.equal(extractText(null), '');
  assert.equal(extractText(undefined), '');
  assert.equal(extractText(42), '');
  assert.equal(extractText({ type: 'text', text: 'x' }), '');
});

test('projectName — Linux/Mac path conversion', () => {
  // CC stores `/Users/alice/src/foo` as `-Users-alice-src-foo`.
  assert.equal(projectName('/home/-Users-alice-src-foo'), ' > Users > alice > src > foo');
});

test('projectName — Windows path with drive letter', () => {
  // CC on Windows prefixes `C--` for the `C:\` drive.
  assert.equal(
    projectName('C:\\Users\\masterm1nd.DOCK\\.claude\\projects\\C--Users-alice-src-foo'),
    'Users > alice > src > foo',
  );
});

test('projectName — caps at 60 chars', () => {
  const long = '/home/' + '-a'.repeat(100);
  const out = projectName(long);
  assert.ok(out.length <= 60, `expected ≤60, got ${out.length}`);
});

test('projectName — empty directory name → empty string', () => {
  assert.equal(projectName(''), '');
  assert.equal(projectName('/'), '');
});
