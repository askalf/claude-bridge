/**
 * Inject replies from Discord back into Claude Code sessions.
 *
 * Strategy: file-based relay. A Discord reply gets written to
 * `<bridge-dir>/pending-reply.txt`; a Claude Code hook (e.g.
 * `hooks/check-reply.sh`) reads and consumes it, piping the content to
 * the session's stdin. A history line is appended to `reply-history.jsonl`
 * (capped at 500 lines) for the `--history` CLI command.
 *
 * Tests and advanced setups can pass a custom `dir` to every function
 * (defaults to `~/.claude-bridge/`). The CLI calls the functions without
 * `dir` and uses the default — behavior for end users unchanged.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface PendingReply {
  content: string;
  author: string;
  timestamp: number;
  sessionId?: string;
}

function defaultBridgeDir(): string {
  return join(homedir(), '.claude-bridge');
}

function paths(dir?: string): { bridgeDir: string; pending: string; history: string } {
  const bridgeDir = dir ?? defaultBridgeDir();
  return {
    bridgeDir,
    pending: join(bridgeDir, 'pending-reply.txt'),
    history: join(bridgeDir, 'reply-history.jsonl'),
  };
}

function ensureDir(bridgeDir: string): void {
  if (!existsSync(bridgeDir)) {
    mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
  }
}

/** Write a pending reply for Claude Code to pick up. */
export function writePendingReply(reply: PendingReply, dir?: string): void {
  const { bridgeDir, pending, history } = paths(dir);
  ensureDir(bridgeDir);
  writeFileSync(pending, JSON.stringify(reply), { mode: 0o600 });

  // Append to history (best-effort; capped at 500 lines).
  try {
    const entry = JSON.stringify({ ...reply, receivedAt: new Date().toISOString() });
    writeFileSync(history, entry + '\n', { flag: 'a', mode: 0o600 });
    if (existsSync(history)) {
      const content = readFileSync(history, 'utf-8');
      const lines = content.trim().split('\n');
      if (lines.length > 500) {
        writeFileSync(history, lines.slice(-500).join('\n') + '\n', { mode: 0o600 });
      }
    }
  } catch { /* history is best-effort */ }
}

/** Read and consume the pending reply (returns null if none). */
export function readPendingReply(dir?: string): PendingReply | null {
  const { pending } = paths(dir);
  try {
    if (!existsSync(pending)) return null;
    const data = readFileSync(pending, 'utf-8');
    unlinkSync(pending); // consume it
    return JSON.parse(data) as PendingReply;
  } catch {
    return null;
  }
}

/** Check if there's a pending reply without consuming it. */
export function hasPendingReply(dir?: string): boolean {
  return existsSync(paths(dir).pending);
}

/** Get reply history (last N entries). */
export function getReplyHistory(limit: number = 20, dir?: string): PendingReply[] {
  const { history } = paths(dir);
  try {
    if (!existsSync(history)) return [];
    const lines = readFileSync(history, 'utf-8').trim().split('\n');
    return lines.slice(-limit).map(l => JSON.parse(l) as PendingReply);
  } catch {
    return [];
  }
}
