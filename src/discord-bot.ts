/**
 * Discord bot — sends session updates to a channel, relays user replies back.
 * Auto-reconnects on disconnect. Rate-limited sends to avoid Discord 429s.
 */

import { Client, GatewayIntentBits, TextChannel, type Message } from 'discord.js';
import { EventEmitter } from 'node:events';

export interface DiscordConfig {
  token: string;
  channelId: string;
  allowedUserIds?: string[]; // if set, only these users can send replies
}

/**
 * Is this Discord user ID allowed to send commands?
 *
 * Current contract (matches README): an empty or missing `allowedUserIds`
 * list means **anyone** in the channel is allowed. That's a footgun — a
 * user forgetting to set the field opens the bot to any channel member —
 * but changing the default is a breaking change. Exported so the
 * behavior can be pinned by a unit test; also so callers can audit
 * "what would happen" without triggering a Discord round-trip.
 */
export function isAllowed(allowedUserIds: string[] | undefined, authorId: string): boolean {
  if (!allowedUserIds || allowedUserIds.length === 0) return true;
  return allowedUserIds.includes(authorId);
}

export class DiscordBot extends EventEmitter {
  private client: Client;
  private channel: TextChannel | null = null;
  private config: DiscordConfig;
  private ready = false;
  private reconnecting = false;
  private sendQueue: string[] = [];
  private sending = false;

  constructor(config: DiscordConfig) {
    super();
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on('ready', () => {
      const ch = this.client.channels.cache.get(config.channelId);
      if (ch && ch instanceof TextChannel) {
        this.channel = ch;
        this.ready = true;
        this.reconnecting = false;
        console.log(`[bridge] Discord connected: #${ch.name}`);
        this.drainQueue();
      } else {
        console.error(`[bridge] Channel ${config.channelId} not found`);
      }
    });

    // Auto-reconnect on disconnect
    this.client.on('disconnect', () => {
      console.warn('[bridge] Discord disconnected');
      this.ready = false;
      this.scheduleReconnect();
    });

    this.client.on('error', (err) => {
      console.error('[bridge] Discord error:', err.message);
      this.ready = false;
      this.scheduleReconnect();
    });

    // Dedup — prevent double-processing
    const processed = new Set<string>();

    // Listen for user replies
    this.client.on('messageCreate', async (msg: Message) => {
      if (msg.author.bot) return;
      if (msg.channelId !== config.channelId) return;
      if (processed.has(msg.id)) return;
      processed.add(msg.id);
      if (processed.size > 100) processed.delete(processed.values().next().value!);

      // Auth check — only allowed users can control the agent.
      if (!isAllowed(config.allowedUserIds, msg.author.id)) {
        await msg.react('\u274C').catch(() => {}); // red X
        return;
      }

      // Acknowledge
      if ('sendTyping' in msg.channel) {
        await (msg.channel as TextChannel).sendTyping().catch(() => {});
      }
      await msg.react('\u2705').catch(() => {}); // green check

      this.emit('reply', {
        content: msg.content,
        author: msg.author.username,
        authorId: msg.author.id,
        timestamp: msg.createdTimestamp,
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    console.log('[bridge] Reconnecting in 10s...');
    setTimeout(async () => {
      try {
        await this.client.destroy();
        await this.client.login(this.config.token);
      } catch (e) {
        console.error('[bridge] Reconnect failed:', e instanceof Error ? e.message : e);
        this.reconnecting = false;
        this.scheduleReconnect();
      }
    }, 10_000);
  }

  async start(): Promise<void> {
    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.client.destroy();
  }

  /** Queue a message — rate-limited, auto-retries on failure. */
  async send(content: string): Promise<void> {
    if (content.length > 1900) content = content.slice(0, 1900) + '\n...';
    this.sendQueue.push(content);
    this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.sending || !this.ready || !this.channel) return;
    this.sending = true;
    while (this.sendQueue.length > 0) {
      const msg = this.sendQueue.shift()!;
      let retries = 0;
      while (retries < 3) {
        try {
          await this.channel.send(msg);
          break;
        } catch (e) {
          retries++;
          if (retries >= 3) {
            console.error('[bridge] Failed to send after 3 retries:', e instanceof Error ? e.message : e);
          } else {
            await new Promise(r => setTimeout(r, 2000 * retries));
          }
        }
      }
      // Rate limit: 1 message per second
      await new Promise(r => setTimeout(r, 1000));
    }
    this.sending = false;
  }

  /** Send a formatted session update. */
  async sendSessionUpdate(opts: {
    type: string;
    sessionId: string;
    project?: string;
    content?: string;
  }): Promise<void> {
    const shortId = opts.sessionId.slice(0, 8);
    if (opts.type === 'waiting') {
      let msg = `**Waiting for input** \`${shortId}\`${opts.project ? ` — ${opts.project}` : ''}`;
      if (opts.content) {
        // Truncate and format the last Claude message as context
        const preview = opts.content.length > 800 ? opts.content.slice(-800) + '...' : opts.content;
        msg += `\n\n> ${preview.split('\n').join('\n> ')}`;
      }
      msg += `\n\n_Reply here to respond to Claude._`;
      await this.send(msg);
    }
  }
}
