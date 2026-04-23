# Contributing to dario

PRs welcome. The codebase is ~1100 lines across 4 files.

## Setup

```bash
git clone https://github.com/askalf/dario
cd dario
npm install
npm run dev   # runs with tsx, no build needed
```

## Structure

| File | Purpose |
|------|---------|
| `src/proxy.ts` | HTTP proxy server, OpenAI compat, CLI backend, auth gate |
| `src/oauth.ts` | Token storage, refresh, Claude Code credential detection, auto OAuth flow |
| `src/cli.ts` | CLI entry point |
| `src/index.ts` | Library exports |

## Before submitting

1. `npm run build` — must compile clean
2. `npm audit --production --audit-level=high` — no high-severity vulnerabilities
3. Test manually: `dario proxy --verbose` and make a request
4. No new dependencies unless absolutely necessary
5. Keep it simple — this project's value is that it's small enough to audit

## Security issues

Do **not** open a public issue. Email **security@askalf.org** instead. See [SECURITY.md](SECURITY.md).
