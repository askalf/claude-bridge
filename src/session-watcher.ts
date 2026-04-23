/**
 * Watch for Claude Code sessions that are genuinely waiting for user input.
 *
 * Strategy: Only track sessions modified in the last 2 minutes.
 * Only emit 'waiting' after 60 seconds of zero changes.
 * Max one notification per session until the file changes again.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';

export interface SessionEvent {
  type: 'waiting' | 'session_start' | 'session_end' | 'assistant_response';
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
  awaitingResponse: boolean; // true after a reply was injected
  lastReadSize: number;      // last byte position we read content from
}

const IDLE_THRESHOLD_MS = 60_000;    // 60s of no changes = actually idle
const ACTIVE_WINDOW_MS = 2 * 60_000; // only track files modified in last 2 min

export class SessionWatcher extends EventEmitter {
  private claudeDir: string;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private sessions = new Map<string, TrackedSession>();

  constructor() {
    super();
    this.claudeDir = join(homedir(), '.claude');
  }

  start(pollMs: number = 10_000): void {
    this.pollInterval = setInterval(() => this.poll(), pollMs);
    this.pollInterval.unref();
    console.log(`[bridge] Watching ${this.claudeDir}/projects/ (poll every ${pollMs / 1000}s, idle threshold ${IDLE_THRESHOLD_MS / 1000}s)`);
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
                awaitingResponse: false,
                lastReadSize: stat.size,
              });
              continue;
            }

            // File changed
            if (stat.size !== existing.lastSize || stat.mtimeMs !== existing.lastModified) {
              const grew = stat.size > existing.lastSize;
              existing.lastSize = stat.size;
              existing.lastModified = stat.mtimeMs;
              existing.lastChangeSeen = now;
              existing.notifiedIdle = false;

              // Response detection disabled — agent sends responses directly to Discord
              continue;
            }

            // File unchanged — check idle
            const idleMs = now - existing.lastChangeSeen;
            if (idleMs >= IDLE_THRESHOLD_MS && !existing.notifiedIdle) {
              existing.notifiedIdle = true;
              // Read the last assistant message for context
              const lastMessage = this.getLastAssistantMessage(existing.path);
              this.emit('session', {
                type: 'waiting',
                sessionId,
                projectPath: this.projectName(dir),
                content: lastMessage,
                timestamp: now,
              } satisfies SessionEvent);
            }

            // Response detection disabled — agent handles responses directly
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
            const text = this.extractText(content);
            if (text && text.length > 5) return text.slice(0, 1500);
          }
        } catch {}
      }
    } catch {}
    return '';
  }

  /** Mark the most recently active session as awaiting a response. */
  markAwaitingResponse(): void {
    let mostRecent: TrackedSession | null = null;
    let mostRecentTime = 0;
    for (const s of this.sessions.values()) {
      if (s.lastChangeSeen > mostRecentTime) {
        mostRecent = s;
        mostRecentTime = s.lastChangeSeen;
      }
    }
    if (mostRecent) {
      mostRecent.awaitingResponse = true;
      mostRecent.lastReadSize = mostRecent.lastSize;
    }
  }

  /** Check for new assistant messages in the JSONL transcript. */
  private checkForAssistantResponse(session: TrackedSession, sessionId: string): void {
    try {
      const data = readFileSync(session.path, 'utf-8');
      // Only look at content added since lastReadSize
      const newContent = data.slice(session.lastReadSize);
      if (!newContent.trim()) return;

      const lines = newContent.trim().split('\n');
      for (const line of lines.reverse()) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.type === 'assistant') {
            const msg = entry.message as Record<string, unknown> | undefined;
            const text = this.extractText(msg?.content);
            if (text && text.length > 10) {
              session.awaitingResponse = false;
              session.lastReadSize = data.length;
              this.emit('session', {
                type: 'assistant_response',
                sessionId,
                projectPath: this.projectName(session.dir),
                content: text.slice(0, 1800),
                timestamp: Date.now(),
              } satisfies SessionEvent);
              return;
            }
          }
        } catch {}
      }
      session.lastReadSize = data.length;
    } catch {}
  }

  private extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((b: { type?: string }) => b.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join('\n');
    }
    return '';
  }

  private projectName(dir: string): string {
    return (dir.split(/[/\\]/).pop() ?? '').replace(/^[A-Z]--/, '').replace(/-/g, ' > ').slice(0, 60);
  }
}
