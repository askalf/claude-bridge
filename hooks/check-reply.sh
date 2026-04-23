#!/bin/bash
# Claude Code hook — check for pending Discord replies
# Runs on Stop event (after Claude finishes responding)
# If a reply exists, outputs it as additional context

REPLY_FILE="$HOME/.claude-bridge/pending-reply.txt"

if [ -f "$REPLY_FILE" ]; then
  CONTENT=$(cat "$REPLY_FILE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('content',''))" 2>/dev/null)
  AUTHOR=$(cat "$REPLY_FILE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('author',''))" 2>/dev/null)

  if [ -n "$CONTENT" ]; then
    # Output as context — Claude will see this as a system reminder
    echo "[Discord reply from $AUTHOR]: $CONTENT"
    # Consume the reply
    rm -f "$REPLY_FILE"
  fi
fi
