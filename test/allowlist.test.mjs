// Tests for the Discord bot's allowlist filter. Pins the current
// "empty list = anyone allowed" default so any future behavior change
// (e.g. flipping to default-deny) shows up as a test diff in the PR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed } from '../dist/discord-bot.js';

test('isAllowed — undefined list: anyone allowed (current default)', () => {
  assert.equal(isAllowed(undefined, 'user-1'), true);
  assert.equal(isAllowed(undefined, ''),       true);
});

test('isAllowed — empty list: anyone allowed (current default)', () => {
  assert.equal(isAllowed([], 'user-1'),  true);
});

test('isAllowed — non-empty list: gate by membership', () => {
  const allow = ['alice', 'bob'];
  assert.equal(isAllowed(allow, 'alice'),     true);
  assert.equal(isAllowed(allow, 'bob'),       true);
  assert.equal(isAllowed(allow, 'eve'),       false);
  assert.equal(isAllowed(allow, ''),          false);
});

test('isAllowed — exact match, not substring', () => {
  const allow = ['12345'];
  assert.equal(isAllowed(allow, '12345'),  true);
  assert.equal(isAllowed(allow, '123456'), false, 'superset ID must not match');
  assert.equal(isAllowed(allow, '1234'),   false, 'subset ID must not match');
});
