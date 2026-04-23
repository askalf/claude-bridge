# Security Policy

claude-bridge grants remote command execution on your machine to Discord users you've allowlisted. This file describes the threat model, how to report vulnerabilities, and what's in scope.

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Email **security@askalf.org** with:

1. A description of the issue
2. Reproduction steps
3. Potential impact (who can do what, under what conditions)

Response SLA:
- Acknowledgment within 48 hours
- Fix released within 7 days for critical issues (credential leaks, allowlist bypass, remote code execution outside intended scope)
- Fix released within 30 days for non-critical issues
- Disclosure coordinated with the reporter before publication

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.x (pre-1.0) | Yes — latest only |

The project is pre-1.0. Please run the latest `master` before filing a security report.

## Threat model

claude-bridge's security posture rests on two assumptions:

1. **Your Discord bot token is secret.** A leaked token lets an attacker impersonate the bot — post fake "Claude is waiting" messages, join other servers the bot has access to, etc. It does *not* by itself grant shell access, because the reply path still requires membership in `allowed_user_ids`.
2. **Your Discord account's user ID is not spoofable on Discord's side.** If Discord's own authentication fails (your account is compromised, or Discord itself is breached), anyone with your seat in `allowed_user_ids` inherits remote-command authority. Use 2FA on your Discord account.

If both assumptions hold, the only way to escalate beyond intended scope is to exploit a bug in claude-bridge itself.

## In scope

- **Bot token leakage** — token printed to logs, stack traces, error messages, or sent to any destination other than Discord's auth flow.
- **Allowlist bypass** — any code path that invokes a tool (Bash, Read, Write, Glob, Grep) without first checking the Discord author's user ID against `allowed_user_ids`.
- **Lockfile / race conditions** — two instances running simultaneously, or a crashed instance leaving a lockfile that prevents recovery.
- **Command injection** — Discord message content influencing command construction in a way the allowlist check doesn't protect against.
- **Path traversal** — a reply causing a tool to read or write files outside the user's home / repo context in ways the agent's system prompt forbids.
- **Denial of service** — an unauthorized user flooding the channel in a way the bot can't rate-limit its way through.
- **Unsafe defaults** — any shipped default that weakens one of the assumptions above.

## Out of scope

- Compromise of your Discord account via Discord's own systems (use 2FA; we can't fix Discord).
- Compromise of your machine via other vectors (malware, physical access, etc.).
- Upstream LLM behavior — if the Claude model misbehaves given a valid prompt, that's an LLM-provider issue, not a claude-bridge issue.
- Social engineering of allowlisted users — e.g. someone DMs you "run this command" and you relay it into the bot channel. claude-bridge runs exactly what an allowlisted user asks it to run. That's the design.

## Security architecture

**Credential storage.** Bot token lives in `~/.claude-bridge/config.json`. Recommended mode `0600` (documented in the README quickstart). Never read by the bridge from env vars it echoes anywhere.

**Allowlist enforcement.** Every message received from Discord is checked against `allowed_user_ids` *before* any tool code path is reached. Failed checks return a red ❌ reaction and do nothing else. No partial execution, no command-line preview, no error message with payload echoed back.

**Single-instance lockfile.** `~/.claude-bridge/lock` prevents a second instance from starting. Lock file records the PID; a stale lock (PID not running) is recoverable via `--force-unlock`.

**Rate limiting.** Outbound Discord messages are serialized through a 1-msg/sec send queue. Protects you from the bot getting rate-limited by Discord on outbound bursts.

**Auto-reconnect.** Discord gateway disconnects trigger backoff + reconnect; received messages during the outage are replayed on reconnect.

**Crash recovery.** `uncaughtException` and `unhandledRejection` are caught, logged, and the process exits cleanly so a supervisor (systemd, pm2, a shell loop) can restart it.

**No telemetry.** No analytics, no phoning home, no error reports to a third party. The only outbound traffic is Discord and your configured LLM endpoint.

## Credential rotation

If you believe the bot token has leaked:

1. **Revoke first.** Discord Developer Portal → your app → Bot → Reset Token. This invalidates every session using the old token.
2. Update `~/.claude-bridge/config.json` with the new token.
3. Restart the bridge.
4. Audit your Discord application's recent activity for suspicious joins or messages.

If you believe your own Discord account is compromised:

1. Regain access to the account (Discord support) and enable 2FA.
2. Rotate the bot token as above.
3. Review `allowed_user_ids` — remove any ID you don't fully control.

## Acknowledgments

We credit reporters (with consent) in release notes for confirmed vulnerabilities.
