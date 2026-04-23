# claude-bridge

Bridge Claude Code sessions to Discord. Full remote control of Claude from your phone.

## What it does

- Monitors active Claude Code sessions for idle state
- Sends notification to Discord when Claude is waiting for input (with context)
- Runs a full Claude agent loop over Discord — execute commands, read/write files, search code
- Single-instance lock prevents duplicate bots
- Security: only authorized Discord users can send commands

## Setup

```bash
cd claude-bridge
npm install
npm run build
```

Create `~/.claude-bridge/config.json`:

```json
{
  "discord_token": "YOUR_BOT_TOKEN",
  "discord_channel_id": "CHANNEL_ID",
  "allowed_user_ids": ["YOUR_DISCORD_USER_ID"],
  "poll_interval_ms": 10000,
  "notify_on_waiting": true
}
```

## Usage

```bash
node dist/index.js          # Start bridge + agent
node dist/index.js --check  # Read pending Discord reply
node dist/index.js --history # Show reply history
```

### Discord commands

- Any message — runs through Claude agent, returns response
- `!command` — explicit agent execution
- `/reset` — clear agent conversation
- `/status` — check agent + dario health

## Architecture

```
Session idle (60s) → Discord notification with context
Discord reply → Claude agent (via dario proxy) → tool execution → Discord response
```

**5 tools:** Bash, Read, Write, Glob, Grep

**Security:**
- Lockfile prevents multiple instances
- Only allowed Discord user IDs can send commands
- Unauthorized users get red X reaction
- Auto-reconnect on Discord disconnect
- Rate-limited sends (1 msg/sec)
- Crash recovery (uncaughtException/unhandledRejection caught)

## Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/agent.ts` | 260 | Discord-native Claude agent with tool execution |
| `src/discord-bot.ts` | 165 | Discord client with auth, reconnect, send queue |
| `src/index.ts` | 284 | CLI, config, event wiring, lockfile |
| `src/session-watcher.ts` | 228 | JSONL transcript monitor for idle detection |
| `src/response-injector.ts` | 85 | File-based reply relay for CLI hook integration |

## Requirements

- Node.js 18+
- Discord bot with Message Content intent
- dario proxy running on localhost:3456
