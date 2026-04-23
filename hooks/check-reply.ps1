# Claude Code hook — relay a pending Discord reply into the CC session.
#
# Windows PowerShell equivalent of check-reply.sh. Install by adding to
# %USERPROFILE%\.claude\settings.json:
#   {
#     "hooks": {
#       "Stop": "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\path\\to\\claude-bridge\\hooks\\check-reply.ps1"
#     }
#   }
#
# Requires claude-bridge on PATH (via `npm install -g @askalf/claude-bridge`).

$ErrorActionPreference = 'Stop'

if (-not (Get-Command claude-bridge -ErrorAction SilentlyContinue)) {
  # claude-bridge not installed / not on PATH — nothing to relay.
  exit 0
}

$content = & claude-bridge --check 2>$null
if ($LASTEXITCODE -eq 0 -and $content) {
  Write-Output "[Discord reply]: $content"
}
