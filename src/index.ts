#!/usr/bin/env node
/**
 * claude-bridge — Bridge Claude Code sessions to Discord.
 *
 * Watches for active Claude Code sessions, sends updates to a Discord channel,
 * and relays user replies back. Runs as an independent daemon — no dependency
 * on Docker, platform, mux, or any other askalf infrastructure.
 *
 * Usage:
 *   DISCORD_TOKEN=... DISCORD_CHANNEL_ID=... claude-bridge
 *
 * Or with a config file:
 *   claude-bridge --config ~/.claude-bridge/config.json
 */

import { SessionWatcher, type SessionEvent } from './session-watcher.js';
import { DiscordBot } from './discord-bot.js';
import { writePendingReply, readPendingReply } from './response-injector.js';
import { DiscordAgent } from './agent.js';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';

// ── Single instance lock ──
const LOCK_FILE = join(homedir(), '.claude-bridge', 'bridge.lock');

function acquireLock(): boolean {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = readFileSync(LOCK_FILE, 'utf-8').trim();
      // Check if the PID is still running
      try {
        process.kill(parseInt(pid), 0);
        return false; // process exists, lock is held
      } catch {
        // process is dead, stale lock
        unlinkSync(LOCK_FILE);
      }
    }
    writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try { unlinkSync(LOCK_FILE); } catch {}
}
import { join } from 'node:path';
import { homedir } from 'node:os';

interface Config {
  discord_token: string;
  discord_channel_id: string;
  allowed_user_ids?: string[];  // Discord user IDs that can reply (empty = anyone)
  poll_interval_ms?: number;
  notify_on_waiting?: boolean;
}

function loadConfig(): Config {
  // Check CLI args
  const configArg = process.argv.find(a => a.startsWith('--config='));
  const configPath = configArg
    ? configArg.split('=')[1]
    : join(homedir(), '.claude-bridge', 'config.json');

  // Try config file first
  if (existsSync(configPath)) {
    try {
      const data = JSON.parse(readFileSync(configPath, 'utf-8')) as Config;
      return data;
    } catch (e) {
      console.error(`[bridge] Failed to parse config at ${configPath}:`, e);
    }
  }

  // Fall back to env vars
  const token = process.env.DISCORD_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;

  if (!token || !channelId) {
    console.error(`[bridge] Missing configuration. Either:
  1. Create ~/.claude-bridge/config.json:
     { "discord_token": "...", "discord_channel_id": "..." }

  2. Or set environment variables:
     DISCORD_TOKEN=... DISCORD_CHANNEL_ID=... claude-bridge
`);
    process.exit(1);
  }

  return {
    discord_token: token,
    discord_channel_id: channelId,
  };
}

async function main(): Promise<void> {
  // Help
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
claude-bridge — Bridge Claude Code sessions to Discord

Usage:
  claude-bridge                     Start with env vars or config file
  claude-bridge --config=PATH       Start with specific config file
  claude-bridge --check             Check for pending Discord reply
  claude-bridge --history           Show reply history

Environment:
  DISCORD_TOKEN          Discord bot token
  DISCORD_CHANNEL_ID     Channel ID for bridge messages

Config file (~/.claude-bridge/config.json):
  {
    "discord_token": "...",
    "discord_channel_id": "...",
    "poll_interval_ms": 3000,
    "notify_on_waiting": true,
    "notify_on_session_start": true,
    "notify_on_session_end": false
  }
`);
    process.exit(0);
  }

  // Single instance enforcement
  if (!process.argv.includes('--check') && !process.argv.includes('--history')) {
    if (!acquireLock()) {
      console.error('[bridge] Another instance is already running. Kill it first or delete ~/.claude-bridge/bridge.lock');
      process.exit(1);
    }
    process.on('exit', releaseLock);
    process.on('SIGINT', () => { releaseLock(); process.exit(0); });
    process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
  }

  // Check mode — read pending reply (for use in Claude Code hooks)
  if (process.argv.includes('--check')) {
    const reply = readPendingReply();
    if (reply) {
      console.log(reply.content);
    }
    process.exit(reply ? 0 : 1);
  }

  // History mode
  if (process.argv.includes('--history')) {
    const { getReplyHistory } = await import('./response-injector.js');
    const history = getReplyHistory();
    if (history.length === 0) {
      console.log('No reply history.');
    } else {
      for (const h of history) {
        const time = new Date(h.timestamp).toLocaleTimeString();
        console.log(`[${time}] ${h.author}: ${h.content}`);
      }
    }
    process.exit(0);
  }

  const config = loadConfig();

  console.log('[bridge] Starting claude-bridge...');

  // Session watcher
  const watcher = new SessionWatcher();

  // Discord bot
  const bot = new DiscordBot({
    token: config.discord_token,
    channelId: config.discord_channel_id,
    allowedUserIds: config.allowed_user_ids,
  });

  // Track last notification per session to avoid spam
  const lastNotified = new Map<string, number>();
  const COOLDOWN_MS = 120_000; // 2 min between notifications for same session

  // Discord agent — runs tool-equipped Claude directly, no CLI needed
  const agent = new DiscordAgent({
    model: process.env.AGENT_MODEL || 'claude-sonnet-4-6',
    cwd: process.env.AGENT_CWD,
  });

  // Handle Discord replies
  bot.on('reply', async (reply: { content: string; author: string; timestamp: number }) => {
    console.log(`[bridge] Reply from ${reply.author}: ${reply.content.slice(0, 80)}`);

    const content = reply.content.trim();

    // Special commands
    if (content === '/reset') {
      agent.reset();
      bot.send('Agent conversation reset.').catch(() => {});
      return;
    }

    if (content === '/status') {
      const darioHealth = await fetch('http://localhost:3456/health').then(r => r.json()).catch(() => null);
      bot.send(`**Status**\nAgent busy: ${agent.isBusy}\nDario: ${darioHealth ? 'healthy' : 'offline'}`).catch(() => {});
      return;
    }

    // Also save to pending file (for CLI sessions to pick up via hook)
    writePendingReply({ content, author: reply.author, timestamp: reply.timestamp });
    watcher.markAwaitingResponse();

    // If message starts with !, run through the agent loop directly
    if (content.startsWith('!') || content.startsWith('/run ')) {
      const prompt = content.startsWith('!') ? content.slice(1).trim() : content.slice(5).trim();
      if (!prompt) return;

      bot.send(`Running...`).catch(() => {});

      const response = await agent.process(
        prompt,
        (name, args) => { bot.send(`\`[${name}]\` ${args}`).catch(() => {}); },
      );

      // Split long responses across multiple messages
      const chunks = splitMessage(response);
      for (const chunk of chunks) {
        await bot.send(chunk);
      }
    } else {
      // Regular message — run through agent
      const response = await agent.process(content);
      const chunks = splitMessage(response);
      for (const chunk of chunks) {
        await bot.send(chunk);
      }
    }
  });

  function splitMessage(text: string, maxLen = 1900): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    while (text.length > 0) {
      // Try to split at newline
      let splitAt = text.lastIndexOf('\n', maxLen);
      if (splitAt <= 0) splitAt = maxLen;
      chunks.push(text.slice(0, splitAt));
      text = text.slice(splitAt);
    }
    return chunks;
  }

  // Start everything
  await bot.start();
  watcher.start(config.poll_interval_ms ?? 3000);

  console.log('[bridge] Watching for Claude Code sessions...');
  console.log('[bridge] Press Ctrl+C to stop.\n');

  // Watchdog — restart if stuck
  let lastActivity = Date.now();
  const WATCHDOG_INTERVAL = 60_000;
  const WATCHDOG_TIMEOUT = 5 * 60_000;

  watcher.on('session', () => { lastActivity = Date.now(); });
  bot.on('reply', () => { lastActivity = Date.now(); });

  setInterval(() => {
    const idle = Date.now() - lastActivity;
    if (idle > WATCHDOG_TIMEOUT) {
      console.warn(`[bridge] Watchdog: no activity for ${Math.round(idle / 60_000)}min, restarting watcher...`);
      watcher.stop();
      watcher.start(config.poll_interval_ms ?? 10_000);
      lastActivity = Date.now();
    }
  }, WATCHDOG_INTERVAL).unref();

  // Forward session idle notifications to Discord (only when agent is NOT busy)
  watcher.on('session', (event: SessionEvent) => {
    if (agent.isBusy) return;
    if (event.type !== 'waiting') return;

    const now = Date.now();
    const lastTime = lastNotified.get(event.sessionId) ?? 0;
    if (now - lastTime < COOLDOWN_MS) return;

    if (config.notify_on_waiting !== false) {
      lastNotified.set(event.sessionId, now);
      bot.sendSessionUpdate({
        type: 'waiting',
        sessionId: event.sessionId,
        project: event.projectPath,
        content: event.content,
      }).catch(e => console.error('[bridge] Discord send error:', e));
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[bridge] Shutting down...');
    watcher.stop();
    bot.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Crash recovery — don't let unhandled rejections kill the process
  process.on('uncaughtException', (err) => {
    console.error('[bridge] Uncaught exception:', err.message);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[bridge] Unhandled rejection:', err instanceof Error ? err.message : err);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
