<p align="center">
  <h1 align="center">claude-bridge</h1>
  <p align="center"><strong>Your Claude Code session, in your pocket.</strong><br>When Claude Code goes idle waiting for your input, claude-bridge pings you on Discord with the tail of the transcript; reply from your phone and a full Claude agent loop (<code>Bash</code>, <code>Read</code>, <code>Write</code>, <code>Glob</code>, <code>Grep</code>) runs on your machine via <a href="https://github.com/askalf/dario">dario</a>. Pick up exactly where you left off when you're back at the keyboard.</p>
</p>

<p align="center"><em>Pre-1.0. MIT. Independent, unofficial, third-party — see <a href="LICENSE">LICENSE</a>.</em></p>

<p align="center">
  <a href="https://github.com/askalf/claude-bridge/actions/workflows/ci.yml"><img src="https://github.com/askalf/claude-bridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/askalf/claude-bridge/blob/master/LICENSE"><img src="https://img.shields.io/github/license/askalf/claude-bridge?style=flat-square" alt="License"></a>
  <a href="https://github.com/askalf/claude-bridge/stargazers"><img src="https://img.shields.io/github/stars/askalf/claude-bridge?style=flat-square" alt="Stars"></a>
</p>

---

## The point

A long-running Claude Code task is supposed to be autonomous — you give it a goal, it grinds, it finishes. In practice it blocks on you: a permission prompt, an ambiguous question, a broken test that wants a hint. When that happens at 11 PM and you've already closed the laptop, the task just sits there until morning.

claude-bridge closes that gap. It watches `~/.claude/` for active sessions, detects when Claude is waiting on input, and DMs you the context in a Discord channel you control. Your reply runs a full Claude agent loop on your machine — same tools Claude Code has (`Bash`, `Read`, `Write`, `Glob`, `Grep`) — and posts the result back. Your work continues. You're not tethered to your desk.

Routing goes through [dario](https://github.com/askalf/dario), so every agent call bills against whatever LLM backend you've configured (Claude Max subscription, API key, local model — your choice). No hosted relay, no third-party middleman: the Discord bot talks to your laptop and your laptop talks to your LLM.

---

## 60 seconds

```bash
# 1. Install (pick one)
npm install -g @askalf/claude-bridge                     # global
#   — or —
git clone https://github.com/askalf/claude-bridge && cd claude-bridge
npm install && npm run build

# 2. Start dario if you haven't already — https://github.com/askalf/dario
dario proxy                                              # http://localhost:3456

# 3. Create a Discord application + bot at https://discord.com/developers/applications.
#    Enable the "Message Content" intent. Invite the bot to a private channel
#    only you can post in. Copy the bot token.

# 4. Configure
mkdir -p ~/.claude-bridge
cat > ~/.claude-bridge/config.json <<'JSON'
{
  "discord_token":       "YOUR_BOT_TOKEN",
  "discord_channel_id":  "CHANNEL_ID_TO_POST_IN",
  "allowed_user_ids":    ["YOUR_DISCORD_USER_ID"],
  "poll_interval_ms":    10000,
  "notify_on_waiting":   true
}
JSON
chmod 600 ~/.claude-bridge/config.json                   # protect the token

# 5. Run
claude-bridge                                            # if installed via npm -g
#   — or —
node dist/index.js                                       # if cloned
```

When Claude Code goes idle in a session, you'll get a Discord message with the last few transcript lines. Reply and the agent loop runs against your machine.

---

## What a day looks like

1. **Morning at the desk.** Start a long Claude Code task. `claude-bridge` is running in another terminal.
2. **Leave the house.** The task hits a question 20 minutes later. You get a Discord ping with the transcript tail: `> Should I rename this export or keep backwards compat with a re-export?`
3. **From your phone.** Reply: `keep backwards compat, add a one-line comment about why`. claude-bridge runs a Claude agent loop on your laptop, which edits the file and commits.
4. **Coffee shop.** Another ping. You reply a follow-up. The task keeps moving.
5. **Back at the desk.** Session is further along than when you left. Continue in Claude Code as normal.

---

## ⚠️ Security

claude-bridge is a high-trust tool: **the Discord bot token and the allowlist together grant shell-level access to your machine.** Anyone with access to your bot token can impersonate the bot; anyone whose Discord user ID is in `allowed_user_ids` can run commands through the `Bash` tool. Treat it accordingly.

### Threat model

- **Bot token compromise.** A leaked token lets an attacker act as your bot — which means posting fake "Claude is waiting" messages and tricking your allowlisted users, or joining other servers your bot has access to. Does *not* by itself grant shell access, because the token holder still needs to be in the allowlist. Still: rotate immediately if exposed.
- **Allowlist bypass.** The killer case. If your user ID is spoofable or if a bug lets an unauthorized ID slip through, that ID gets the `Bash` tool. The bot validates every incoming message against `allowed_user_ids` before any tool runs; a failed check returns a red ❌ reaction and nothing else.
- **Discord account compromise.** If *your own* Discord account is compromised, the attacker inherits your allowlist seat. Two-factor-auth your Discord account. If you lose it, rotate the bot token *and* remove the compromised user ID from the allowlist.
- **Network fragility.** Auto-reconnect on disconnect, rate-limited send queue (1 msg/sec), single-instance lockfile prevents split-brain.

### Operating recommendations

- `chmod 600 ~/.claude-bridge/config.json`
- Create a **dedicated** Discord bot (not a user-bot, not shared with another tool). Keep it in one channel only you post in.
- Keep `allowed_user_ids` to exactly the IDs that need it. For personal use: one ID, your own.
- Never commit `~/.claude-bridge/config.json` to any repo.
- If you suspect compromise: revoke the bot token at [discord.com/developers/applications](https://discord.com/developers/applications) first, cleanup second.

### Reporting

Found something? Email **security@askalf.org** — don't open a public issue. See [SECURITY.md](SECURITY.md).

---

## How it works

```
┌─────────────────┐    poll ~/.claude/    ┌──────────────────┐
│ Claude Code     │ ─────────────────▶   │ session-watcher  │
│ (your session)  │      transcripts       │  (JSONL reader)  │
└─────────────────┘                        └────────┬─────────┘
                                                    │
                             "Claude is idle         │
                              waiting for input"    │
                                                    ▼
                                           ┌──────────────────┐
                                           │ discord-bot      │
                                           │  (send + recv)   │
                                           └────┬─────────────┘
                                                │ reply from phone
                                                ▼
                                           ┌──────────────────┐    /v1/messages
                                           │ agent            │ ─────────────────▶ dario ──▶ Claude
                                           │ (5 tools)        │ ◀─────────────────
                                           └────┬─────────────┘        answer
                                                │
                                                │ Bash / Read / Write / Glob / Grep
                                                ▼
                                            your machine
```

One background loop polls `~/.claude/` for active sessions. When a session's JSONL transcript ends on an `assistant` turn (no new `user` turn for `idle_seconds`), claude-bridge considers that session idle and emits a Discord notification with the last ~20 lines of transcript. Your reply gets routed into a Claude agent loop — not Claude Code itself; a separate agent with the five CC-equivalent tools — running against dario. The agent's response is posted back to the channel.

---

## Configuration reference

`~/.claude-bridge/config.json`:

| Field | Type | Default | Description |
|---|---|---|---|
| `discord_token` | string | — | Discord bot token. **Required.** |
| `discord_channel_id` | string | — | Channel to post notifications in. **Required.** |
| `allowed_user_ids` | string[] | `[]` | Discord user IDs that can send commands. Anyone not in this list is ignored. |
| `poll_interval_ms` | number | `10000` | How often to scan `~/.claude/` for session state changes. |
| `notify_on_waiting` | boolean | `true` | When false, idle-state events are detected but no Discord message is sent. Useful for testing. |
| `idle_seconds` | number | `60` | How long a session must be idle before emitting a notification. |
| `dario_base_url` | string | `http://localhost:3456` | dario (or any Anthropic-compat) endpoint. |
| `dario_api_key` | string | `dario` | Key sent in `x-api-key`. Change this if you've set `DARIO_API_KEY` on your proxy. |
| `agent_model` | string | `claude-sonnet-4-6` | Model ID passed to the proxy. |
| `agent_cwd` | string | `$HOME` | Working directory for the agent's `Bash` / `Glob` / `Grep` tools. |
| `system_prompt` | string | *(generic coding-assistant prompt)* | Override the agent's default system prompt. Useful for scoping the agent to a specific project, persona, or workflow. |

All fields can also be set via environment variables — field name uppercased with prefixes for the Discord/Dario/agent groups: `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, `ALLOWED_USER_IDS` (comma-separated), `POLL_INTERVAL_MS`, `IDLE_SECONDS`, `NOTIFY_ON_WAITING`, `DARIO_BASE_URL`, `DARIO_API_KEY`, `AGENT_MODEL`, `AGENT_CWD`, `AGENT_SYSTEM_PROMPT`. **Env wins over the file** — lets you rotate a compromised bot token in a container without editing the committed config.

---

## CLI

```bash
claude-bridge                     # start the bridge (foreground)
claude-bridge --check             # read any pending Discord reply, exit
claude-bridge --history           # show recent Discord replies, exit
claude-bridge --help              # show usage
```

(If you cloned the repo rather than installing via npm, substitute `node dist/index.js` for `claude-bridge`.)

### Discord commands (sent as messages in your channel)

| Command | Effect |
|---|---|
| *(any plain message)* | Runs through the Claude agent loop; agent's answer is posted back. |
| `!command <text>` | Explicit agent invocation (same as above, useful for disambiguation). |
| `/reset` | Clears the agent's conversation context. |
| `/status` | Checks agent + dario health, replies with a summary. |

Unauthorized users (not in `allowed_user_ids`) get a red ❌ reaction on their message — no command runs.

---

## Files

| File | Purpose |
|---|---|
| `src/agent.ts` | Discord-native Claude agent with tool execution (5 tools). Calls dario via `/v1/messages`. |
| `src/discord-bot.ts` | Discord client — allowlist enforcement, auto-reconnect, rate-limited send queue. |
| `src/session-watcher.ts` | JSONL transcript monitor, idle detection per session. |
| `src/index.ts` | CLI entry, config load, event wiring, single-instance lockfile, crash recovery. |
| `src/response-injector.ts` | File-based reply relay — lets a CC shell hook pick up pending Discord replies without a network round-trip. |
| `hooks/check-reply.sh` | Optional: example Claude Code session hook that invokes `--check` to inject Discord replies into the session. |

One runtime dep: `discord.js`.

---

## Trust and transparency

| Signal | Status |
|---|---|
| **Runtime dependencies** | One — `discord.js`. Nothing else. |
| **Credentials** | Stored locally in `~/.claude-bridge/config.json` — recommended `0600`. Never uploaded, never logged. |
| **Network scope** | Discord gateway + Discord REST API, plus whatever LLM endpoint you configured. Nothing else. Verify with `lsof -i` during a run. |
| **Telemetry** | None. |
| **License** | MIT |
| **Affiliation** | Independent, unofficial, third-party. Not affiliated with Anthropic, Discord, or any other company mentioned. |

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the build + test flow.

---

## License

MIT — see [LICENSE](LICENSE).
