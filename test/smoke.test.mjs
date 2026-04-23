// Smoke tests: every module imports cleanly and exposes the surface
// documented in the README / referenced by other modules. Runs against
// the compiled output in dist/ — `npm test` depends on `npm run build`
// having been run first (CI enforces this via the pipeline order).
//
// These tests are the thin safety net that catches "someone deleted
// an exported function" regressions without needing to mock the runtime
// environment (filesystem, Discord API, etc.). Deeper behavioural tests
// for each module land in separate files as the code stabilises.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('response-injector exposes its documented API', async () => {
  const mod = await import('../dist/response-injector.js');
  assert.equal(typeof mod.writePendingReply, 'function', 'writePendingReply missing');
  assert.equal(typeof mod.readPendingReply,  'function', 'readPendingReply missing');
  assert.equal(typeof mod.hasPendingReply,   'function', 'hasPendingReply missing');
  assert.equal(typeof mod.getReplyHistory,   'function', 'getReplyHistory missing');
});

test('session-watcher exposes SessionWatcher class', async () => {
  const mod = await import('../dist/session-watcher.js');
  assert.equal(typeof mod.SessionWatcher, 'function', 'SessionWatcher class missing');
});

test('discord-bot exposes DiscordBot class', async () => {
  const mod = await import('../dist/discord-bot.js');
  assert.equal(typeof mod.DiscordBot, 'function', 'DiscordBot class missing');
});

test('agent exposes DiscordAgent class', async () => {
  const mod = await import('../dist/agent.js');
  assert.equal(typeof mod.DiscordAgent, 'function', 'DiscordAgent class missing');
});
