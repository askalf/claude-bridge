#!/bin/bash
# Claude Code hook — relay a pending Discord reply into the CC session.
#
# Install by adding to `~/.claude/settings.json`:
#   {
#     "hooks": {
#       "Stop": "bash /path/to/claude-bridge/hooks/check-reply.sh"
#     }
#   }
#
# Uses the claude-bridge CLI's `--check` mode to read and consume any
# pending reply, so this script has zero deps beyond claude-bridge being
# on PATH (via `npm install -g @askalf/claude-bridge` or a symlink from
# a cloned repo's `dist/index.js`). The previous version required
# python3 to parse the pending-reply JSON — dropped for portability.

set -euo pipefail

if ! command -v claude-bridge >/dev/null 2>&1; then
  # claude-bridge not installed / not on PATH — nothing to relay, exit quietly.
  exit 0
fi

CONTENT=$(claude-bridge --check 2>/dev/null || true)
if [ -n "$CONTENT" ]; then
  echo "[Discord reply]: $CONTENT"
fi
