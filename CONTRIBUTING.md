# Contributing to claude-bridge

PRs welcome. Codebase is ~1000 lines across 5 TypeScript files plus a shell hook.

## Setup

```bash
git clone https://github.com/askalf/claude-bridge
cd claude-bridge
npm install
npm run build
npm run dev    # runs with tsx, no build needed
```

You'll also need dario running (http://localhost:3456) and a Discord bot — see the [README quickstart](README.md#60-seconds).

## Structure

| File | Purpose |
|------|---------|
| `src/agent.ts` | Discord-native Claude agent with tool execution (Bash / Read / Write / Glob / Grep). |
| `src/discord-bot.ts` | Discord client — allowlist enforcement, auto-reconnect, rate-limited send queue. |
| `src/session-watcher.ts` | JSONL transcript monitor, per-session idle detection. |
| `src/index.ts` | CLI entry, config load, event wiring, single-instance lockfile, crash recovery. |
| `src/response-injector.ts` | File-based reply relay for optional CC shell-hook integration. |
| `hooks/check-reply.sh` | Example CC session hook that calls `--check` to pick up pending replies. |

One runtime dep: `discord.js`. Resist adding more — the entire security story rests on the code being small enough to audit.

## Before submitting

1. `npm run build` — must compile under `strict: true`.
2. `node dist/index.js --help` — binary still starts.
3. Test manually against a dedicated test Discord bot and channel. Don't use the bot you run for your own machine during development.
4. If you're changing allowlist / command-dispatch code, think hard about the [threat model](SECURITY.md#threat-model) and document the change in the PR description.
5. Don't add telemetry, "helpful" error reporting, or anything that phones home. Ever.

## What we're careful about

- **Command dispatch paths.** Every tool invocation must happen after an allowlist check on the Discord author. Be suspicious of refactors that separate the check from the dispatch.
- **Credential handling.** The bot token should never appear in `console.log`, error messages, or the log tail attached to a Discord notification. If you're adding logging, scrub first.
- **Dependency changes.** Every new runtime dep widens the audit surface. Default is no.
- **"Convenience" features that broaden exposure.** Examples of things we'd push back on: running claude-bridge in multiple Discord channels at once, allowing `@everyone` in an allowlist, a web dashboard that itself needs authentication. Not because they're wrong in general, but because they change the security posture and need explicit threat-model thinking.

## Security issues

Do **not** open a public GitHub issue. Email **security@askalf.org** instead. See [SECURITY.md](SECURITY.md).

## Code style

Matches [dario](https://github.com/askalf/dario) and [deepdive](https://github.com/askalf/deepdive): small TypeScript, pure decision functions where possible, `strict: true`, no `any`, no unused imports. Node built-ins over new deps.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
