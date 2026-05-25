#!/usr/bin/env bash
set -euo pipefail
SERVICE_NAME="codex-show-latex-viewer.service"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/$SERVICE_NAME"
  systemctl --user daemon-reload 2>/dev/null || true
fi

echo "Stopped/removed user service."
echo "Remove the [mcp_servers.show-latex] block from ~/.codex/config.toml if desired."
