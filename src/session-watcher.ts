/**
 * Watch for Claude Code sessions that are genuinely waiting for user input.
 *
 * Strategy: Only track sessions modified in the last 2 minutes.
 * Only emit 'waiting' after `idleSeconds` of zero changes (default 60s).
 * Max one notification per session until the file changes again.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';

export interface SessionEvent {
  type: 'waiting';
  sessionId: string;
  projectPath?: string;
  content?: string;
  timestamp: number;
}

interface TrackedSession {
  path: string;
  dir: string;
  lastSize: number;
  lastModified: number;
  lastChangeSeen: number;
  notifiedIdle: boolean;
}

const DEFAULT_IDLE_THRESHOLD_MS = 60_000;  // 60s of no changes = actually idle
const ACTIVE_WINDOW_MS = 2 * 60_000;       // only track files modified in last 2 min

export class SessionWatcher extends EventEmitter {
  private claudeDir: string;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private sessions = new Map<string, TrackedSession>();
  private idleThresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS;

  constructor() {
    super();
    this.claudeDir = join(homedir(), '.claude');
  }

  start(pollMs: number = 10_000, idleSeconds?: number): void {
    if (typeof idleSeconds === 'number' && idleSeconds > 0) {
      this.idleThresholdMs = idleSeconds * 1000;
    }
    this.pollInterval = setInterval(() => this.poll(), pollMs);
    this.pollInterval.unref();
    console.log(`[bridge] Watching ${this.claudeDir}/projects/ (poll every ${pollMs / 1000}s, idle threshold ${this.idleThresholdMs / 1000}s)`);
  }

  stop(): void {
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
  }

  private getProjectDirs(): string[] {
    try {
      const projectsDir = join(this.claudeDir, 'projects');
      return readdirSync(projectsDir)
        .map(e => join(projectsDir, e))
        .filter(p => { try { return statSync(p).isDirectory(); } catch { return false; } });
    } catch { return []; }
  }

  private poll(): void {
    const now = Date.now();

    for (const dir of this.getProjectDirs()) {
      try {
        for (const file of readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
          const fullPath = join(dir, file);
          const sessionId = file.replace('.jsonl', '');

          try {
            const stat = statSync(fullPath);

            // Only care about recently active files
            if (now - stat.mtimeMs > ACTIVE_WINDOW_MS) continue;

            const existing = this.sessions.get(sessionId);

            if (!existing) {
              this.sessions.set(sessionId, {
                path: fullPath,
                dir,
                lastSize: stat.size,
                lastModified: stat.mtimeMs,
                lastChangeSeen: now,
                notifiedIdle: false,
              });
              continue;
            }

            // File changed — reset idle tracking.
            if (stat.size !== existing.lastSize || stat.mtimeMs !== existing.lastModified) {
              existing.lastSize = stat.size;
              existing.lastModified = stat.mtimeMs;
              existing.lastChangeSeen = now;
              existing.notifiedIdle = false;
              continue;
            }

            // File unchanged for >= idle threshold — emit 'waiting' once.
            const idleMs = now - existing.lastChangeSeen;
            if (idleMs >= this.idleThresholdMs && !existing.notifiedIdle) {
              existing.notifiedIdle = true;
              const lastMessage = this.getLastAssistantMessage(existing.path);
              this.emit('session', {
                type: 'waiting',
                sessionId,
                projectPath: projectName(dir),
                content: lastMessage,
                timestamp: now,
              } satisfies SessionEvent);
            }
          } catch {}
        }
      } catch {}
    }

    // Drop sessions we haven't seen change in a while
    for (const [id, info] of this.sessions) {
      if (now - info.lastChangeSeen > 5 * 60_000) {
        this.sessions.delete(id);
      }
    }
  }

  /** Read the last assistant message from a session transcript. */
  private getLastAssistantMessage(filePath: string): string {
    try {
      const data = readFileSync(filePath, 'utf-8');
      const lines = data.trim().split('\n');
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>;
          if (entry.type === 'assistant') {
            // Claude Code JSONL: entry.message.content[].text
            const msg = entry.message as Record<string, unknown> | undefined;
            const content = msg?.content;
            const text = extractText(content);
            if (text && text.length > 5) return text.slice(0, 1500);
          }
        } catch {}
      }
    } catch {}
    return '';
  }

}

// ── Pure helpers, exported for unit testing ──

/**
 * Pull the plain text out of a Claude Code JSONL `message.content` field.
 * CC's wire format is either a bare string (old sessions) or an array of
 * content blocks where `{ type: 'text', text: '...' }` carries the chat
 * text. Tool-use and tool-result blocks are skipped — they're not the
 * "last thing Claude said" a human would want to see in a Discord ping.
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: { type?: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join('\n');
  }
  return '';
}

/**
 * Project directory name → human-readable breadcrumb.
 * CC encodes a project's full path in the directory name by replacing
 * `/` with `-` (e.g. `-Users-alice-src-foo` for `/Users/alice/src/foo`).
 * On Windows CC prefixes the drive letter as `C--`. We reverse both and
 * render as a `>`-separated breadcrumb, capped at 60 chars for Discord.
 */
export function projectName(dir: string): string {
  return (dir.split(/[/\\]/).pop() ?? '').replace(/^[A-Z]--/, '').replace(/-/g, ' > ').slice(0, 60);
}
