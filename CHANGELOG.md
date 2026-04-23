# Changelog

All notable changes to this project will be documented in this file.

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it. See CONTRIBUTING for the full release
checklist.
-->

## [Unreleased]

### CI — foundation parity with dario

Brings claude-bridge's CI surface up to the maturity of the askalf/dario repo it integrates with:

- **`ci.yml`** rewritten — multi-node matrix (18 / 20 / 22), separate `typecheck` and `test` steps in addition to `build`, plus the existing `--help` smoke. Pin actions/checkout + setup-node to SHA + comment.
- **`codeql.yml`** — CodeQL javascript-typescript analysis on every PR, push to master, and weekly Monday 06:00 UTC scheduled scan to catch advisories added to the query pack since the last push.
- **`actionlint.yml`** — `actionlint` v1.7.1 on any PR or push touching `.github/workflows/**`. Statically catches interpolation/quoting/`needs:` bugs and flags untrusted-input injection risks (e.g. inline `${{ github.event.pull_request.head.ref }}` in `run:` scripts).
- **`dependabot.yml`** — weekly (Monday 09:00 UTC) npm + github-actions version updates. Non-major grouped per ecosystem; majors open individually.
- **Test infrastructure** — `test/` dir, `npm test` runs `node --test test/*.test.mjs` against the compiled output. First smoke test in `test/smoke.test.mjs` verifies all modules import and expose their documented surface.
- **`typecheck` script** (`tsc --noEmit`) added to package.json so CI can fail on type errors before the build step does, giving clearer signals.

Nothing that ships to users changes in this cut; it's all scaffolding for the feature + release work in the next phases.
