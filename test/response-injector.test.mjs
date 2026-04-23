// Behavioural tests for response-injector — round-trip, history cap,
// empty-state handling. Uses a fresh mkdtemp dir per test so the real
// ~/.claude-bridge/ is never touched and tests don't interfere.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writePendingReply,
  readPendingReply,
  hasPendingReply,
  getReplyHistory,
} from '../dist/response-injector.js';

const createdDirs = [];
function tempBridgeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cb-test-'));
  createdDirs.push(dir);
  return dir;
}

after(() => {
  for (const d of createdDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

test('round-trip: write → hasPending=true → read → hasPending=false', () => {
  const dir = tempBridgeDir();
  const reply = { content: 'hello', author: 'alice', timestamp: 1700000000000 };
  writePendingReply(reply, dir);
  assert.equal(hasPendingReply(dir), true);
  const got = readPendingReply(dir);
  assert.equal(got.content, 'hello');
  assert.equal(got.author, 'alice');
  assert.equal(got.timestamp, 1700000000000);
  assert.equal(hasPendingReply(dir), false, 'readPendingReply must consume');
});

test('readPendingReply returns null when nothing pending', () => {
  const dir = tempBridgeDir();
  assert.equal(readPendingReply(dir), null);
  assert.equal(hasPendingReply(dir), false);
});

test('readPendingReply returns null when file is corrupt JSON', () => {
  const dir = tempBridgeDir();
  // Write garbage directly — simulates a partial-write crash.
  writePendingReply({ content: 'ok', author: 'a', timestamp: 1 }, dir);
  // Overwrite with corrupt content — simulate partial-write crash.
  writeFileSync(join(dir, 'pending-reply.txt'), '{not-json');
  assert.equal(readPendingReply(dir), null, 'corrupt file treated as no-reply');
});

test('getReplyHistory returns newest-at-end, respects limit', () => {
  const dir = tempBridgeDir();
  for (let i = 0; i < 5; i++) {
    writePendingReply({ content: `msg-${i}`, author: 'alice', timestamp: i }, dir);
    readPendingReply(dir); // consume so the pending file doesn't stay
  }
  const hist = getReplyHistory(3, dir);
  assert.equal(hist.length, 3);
  assert.equal(hist[0].content, 'msg-2', '0 → 3rd-most-recent');
  assert.equal(hist[2].content, 'msg-4', 'last entry is newest');
});

test('getReplyHistory handles empty dir (no history file)', () => {
  const dir = tempBridgeDir();
  assert.deepEqual(getReplyHistory(10, dir), []);
});

test('history cap: 500-line limit enforced', () => {
  const dir = tempBridgeDir();
  for (let i = 0; i < 510; i++) {
    writePendingReply({ content: `msg-${i}`, author: 'bob', timestamp: i }, dir);
    readPendingReply(dir);
  }
  const hist = getReplyHistory(1000, dir);
  // History file is capped at 500 lines, so at most 500 returned.
  assert.ok(hist.length <= 500, `expected ≤500, got ${hist.length}`);
  // Last entry should be the newest message.
  assert.equal(hist[hist.length - 1].content, 'msg-509');
});
