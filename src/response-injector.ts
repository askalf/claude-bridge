/**
 * Inject responses from Discord back into Claude Code sessions.
 *
 * Strategy: Write to a known file that Claude Code's hooks or the user
 * can pick up. We can't directly inject into the CLI's stdin from a
 * separate process, so we use a file-based relay:
 *
 * 1. Discord reply comes in
 * 2. Write to ~/.claude-bridge/pending-reply.txt
 * 3. A Claude Code hook (PreToolUse or custom) reads this file
 *    OR the user types `!bridge` in their session to pull the reply
 *
 * For direct stdin injection on supported platforms, we can also use
 * named pipes or the Claude Code session WebSocket if available.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BRIDGE_DIR = join(homedir(), '.claude-bridge');
const PENDING_FILE = join(BRIDGE_DIR, 'pending-reply.txt');
const HISTORY_FILE = join(BRIDGE_DIR, 'reply-history.jsonl');

export interface PendingReply {
  content: string;
  author: string;
  timestamp: number;
  sessionId?: string;
}

/** Ensure bridge directory exists. */
function ensureDir(): void {
  if (!existsSync(BRIDGE_DIR)) {
    mkdirSync(BRIDGE_DIR, { recursive: true, mode: 0o700 });
  }
}

/** Write a pending reply for Claude Code to pick up. */
export function writePendingReply(reply: PendingReply): void {
  ensureDir();
  writeFileSync(PENDING_FILE, JSON.stringify(reply), { mode: 0o600 });

  // Append to history (capped at 500 lines / ~250KB)
  try {
    const entry = JSON.stringify({ ...reply, receivedAt: new Date().toISOString() });
    writeFileSync(HISTORY_FILE, entry + '\n', { flag: 'a', mode: 0o600 });
    // Trim if too large
    if (existsSync(HISTORY_FILE)) {
      const content = readFileSync(HISTORY_FILE, 'utf-8');
      const lines = content.trim().split('\n');
      if (lines.length > 500) {
        writeFileSync(HISTORY_FILE, lines.slice(-500).join('\n') + '\n', { mode: 0o600 });
      }
    }
  } catch { /* history is best-effort */ }
}

/** Read and consume the pending reply (returns null if none). */
export function readPendingReply(): PendingReply | null {
  try {
    if (!existsSync(PENDING_FILE)) return null;
    const data = readFileSync(PENDING_FILE, 'utf-8');
    unlinkSync(PENDING_FILE); // consume it
    return JSON.parse(data) as PendingReply;
  } catch {
    return null;
  }
}

/** Check if there's a pending reply without consuming it. */
export function hasPendingReply(): boolean {
  return existsSync(PENDING_FILE);
}

/** Get reply history (last N entries). */
export function getReplyHistory(limit: number = 20): PendingReply[] {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    const lines = readFileSync(HISTORY_FILE, 'utf-8').trim().split('\n');
    return lines.slice(-limit).map(l => JSON.parse(l) as PendingReply);
  } catch {
    return [];
  }
}
