# Changelog

All notable changes to this project will be documented in this file.

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it. See CONTRIBUTING for the full release
checklist.
-->

## [Unreleased]

### Hooks — drop python3 dep from check-reply, add Windows PowerShell equivalent

Phase 3.4. `hooks/check-reply.sh` previously parsed the pending-reply JSON via `python3 -c "import sys,json; …"` — a hard python3 dependency for a Node.js project, and silently no-op on systems without python3. Both fixed:

- **`hooks/check-reply.sh`** rewritten to delegate to `claude-bridge --check`, which consumes the pending reply and prints its content. Zero non-claude-bridge deps. Uses `command -v` to gracefully no-op if claude-bridge isn't on PATH (e.g. hook left in place after uninstall).
- **`hooks/check-reply.ps1`** — new, does the same on Windows. Docstring includes the `settings.json` hook snippet to register it against CC's `Stop` event. Pre-1.0 users on Windows had no supported hook path; now they do.

No runtime-behavior change for users who were already on the sh hook + had python3; the relayed content is the same. Readers on Linux/Mac who lacked python3 (or whose `python3` pointed at a broken install) get a working hook for the first time.

### Release — publishable on npm as `@askalf/claude-bridge`

Phase 3 of the build-out. Prepares the package for npm publication and wires the release pipeline:

- `package.json`: name changed to scoped `@askalf/claude-bridge` (matches the `@askalf/dario` convention). `private: true` removed — the package is now publishable. Added the fields npm registry shows on the package page (`repository`, `bugs`, `homepage`, `keywords`, `author`, `license`, `types`, `exports`), plus a `files` allowlist (`dist`, `hooks`, `README.md`, `LICENSE`, `SECURITY.md`, `CHANGELOG.md`) so the tarball ships only what users need, no source.
- `prepublishOnly` script runs `npm run build && npm test` before publishing, so a local `npm publish` can't ship a stale `dist/` or a test-failing build. The CI publish workflow does the same checks earlier in its pipeline, making this a belt-and-braces guard for accidental manual publish.
- New `.github/workflows/publish.yml` — fires on `release: [published]`, runs `npm ci → typecheck → build → test → --help smoke → npm publish --access public --provenance`. Provenance requires `id-token: write` and attaches a signed SLSA attestation so consumers can verify the tarball was built from this exact commit via Actions. Uses the `NPM_TOKEN` repository secret.
- README install snippet gains the `npm install -g @askalf/claude-bridge` option alongside the clone-and-build path. CLI examples use the `claude-bridge` binary name (with a note on how to invoke when cloned).

The first release tag after this merges — `v0.1.0` — will trigger the publish workflow and put the package on npm. Nothing in runtime behavior changes.

### Tests — behavioural coverage for response-injector, session-watcher helpers, allowlist

Pure-function extraction + behavioural tests for the three modules with the most regression risk: credential/IPC plumbing (`response-injector`), JSONL parsing (`session-watcher`), allowlist auth (`discord-bot`). 4 → 24 tests.

- **`response-injector` refactored for hermetic testing.** `writePendingReply`, `readPendingReply`, `hasPendingReply`, `getReplyHistory` all accept an optional `dir` parameter (defaults to `~/.claude-bridge/`). Tests use `mkdtempSync` for a per-test throwaway dir; end-user callers never pass `dir` and get the original behavior. 6 new tests: round-trip, empty-state, corrupt-file, history ordering, history 500-line cap.
- **`session-watcher` exports the pure helpers** `extractText` and `projectName` at module level. The class still uses them internally; tests import them directly without instantiating `SessionWatcher`. 10 new tests covering CC JSONL content-block extraction (string / text-array / tool-use-blocks skipped / empty / non-text), plus `projectName` across Linux/Mac/Windows paths and the 60-char cap.
- **`discord-bot` exports `isAllowed(allowedUserIds, authorId)`** as a pure function; the `messageCreate` handler calls it instead of inlining the branch. 4 new tests pin the current "empty/undefined list = anyone allowed" default (documented footgun) so any future default-deny flip shows up as a test diff in the PR.

Total: 24 passing tests across 4 files. `node --test test/*.test.mjs` runs in ~1.8s. Smoke test from Phase 1 still pins module export surface; Phase 3.3 adds the behaviour-level coverage underneath it.

### Agent — generic system prompt, config wire-through, command-injection fix

Phase 2 of the build-out: fix what the code-review pass surfaced.

**Security**

- **Removed personal-context leak in the default system prompt.** The old prompt said "You are the askalf engineering assistant, running on Thomas's machine… mux is at integration.tax… 17 fleet agents running in Docker (forge)." That was shipping to every user who installed the package. New default prompt is generic ("a coding and operations assistant running on the user's local machine") and callers can override via the `system_prompt` config field or `AGENT_SYSTEM_PROMPT` env var.
- **Fixed command-injection risk in `Glob` and `Grep` tools.** Both used `execSync` with LLM-controlled `pattern` / `dir` values interpolated into a shell string — a `pattern` like `"; rm -rf /tmp; echo "` would have executed. Now uses `execFileSync` with an argv array so arguments are passed as distinct `argv[]` entries, not spliced into a shell command.
- **Removed the `Bash` blocklist** (`['rm -rf /', 'mkfs', 'dd if=', …]`). A string-match blocklist on shell input is trivially bypassed with whitespace or path tricks; the false sense of security was worse than owning the threat model explicitly. Added a comment at the top of `executeTool` stating that the allowlist in `discord-bot` is the security boundary — if shell access to your machine from a chat client isn't acceptable, don't run claude-bridge.

**Correctness / README ↔ code drift**

- **`Config` interface aligned with the README's documented surface.** Added `idle_seconds`, `dario_base_url`, `dario_api_key`, `agent_model`, `agent_cwd`, `system_prompt`. Removed `notify_on_session_start` / `notify_on_session_end` (documented in the in-`--help` text but never actually emitted by the watcher — dead config).
- **`loadConfig` env-var overrides for every field**, as the README promised. Env wins over file. Mapping is `field_name` → `FIELD_NAME`.
- **`/status` command now uses `config.dario_base_url`** instead of hardcoded `http://localhost:3456/health`.
- **Agent reads `dario_base_url` / `dario_api_key` / `agent_model` / `agent_cwd` / `system_prompt` from config** instead of hardcoded values. Env vars `DARIO_URL`, `DARIO_API_KEY`, `AGENT_MODEL`, `AGENT_CWD`, `AGENT_SYSTEM_PROMPT` are still honored as fallback.
- **`poll_interval_ms` default aligned to 10 000ms** (matching the README) in both the initial start and the watchdog-restart path. Previously 3000ms on start, 10000ms on restart.
- **`idle_seconds` is now actually honored** — was a hardcoded 60s constant in `session-watcher.ts`; now threaded from config through `SessionWatcher.start(pollMs, idleSeconds)`.

**Dead-code cleanup**

- Removed `SessionWatcher.markAwaitingResponse` and the private `checkForAssistantResponse` — the only code path that consumed `awaitingResponse` / `lastReadSize` state was never reachable (a `continue` skipped past it). Dropped the supporting fields from `TrackedSession`.
- Removed the unused `SessionEvent` types `session_start`, `session_end`, `assistant_response` — never emitted.
- Removed the unused `MAX_OUTPUT` constant in `agent.ts`.

### CI — foundation parity with dario

Brings claude-bridge's CI surface up to the maturity of the askalf/dario repo it integrates with:

- **`ci.yml`** rewritten — multi-node matrix (18 / 20 / 22), separate `typecheck` and `test` steps in addition to `build`, plus the existing `--help` smoke. Pin actions/checkout + setup-node to SHA + comment.
- **`codeql.yml`** — CodeQL javascript-typescript analysis on every PR, push to master, and weekly Monday 06:00 UTC scheduled scan to catch advisories added to the query pack since the last push.
- **`actionlint.yml`** — `actionlint` v1.7.1 on any PR or push touching `.github/workflows/**`. Statically catches interpolation/quoting/`needs:` bugs and flags untrusted-input injection risks (e.g. inline `${{ github.event.pull_request.head.ref }}` in `run:` scripts).
- **`dependabot.yml`** — weekly (Monday 09:00 UTC) npm + github-actions version updates. Non-major grouped per ecosystem; majors open individually.
- **Test infrastructure** — `test/` dir, `npm test` runs `node --test test/*.test.mjs` against the compiled output. First smoke test in `test/smoke.test.mjs` verifies all modules import and expose their documented surface.
- **`typecheck` script** (`tsc --noEmit`) added to package.json so CI can fail on type errors before the build step does, giving clearer signals.

Nothing that ships to users changes in this cut; it's all scaffolding for the feature + release work in the next phases.
