#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/plugins/codex-show-latex-mcp}"
CONFIG_FILE="${CODEX_CONFIG:-$HOME/.codex/config.toml}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/codex-show-latex-viewer.service"
TMP_DIR="/tmp/codex-show-latex"

mkdir -p "$(dirname "$INSTALL_DIR")"

SRC_REAL="$(realpath -m "$SRC_DIR")"
DEST_REAL="$(realpath -m "$INSTALL_DIR")"
if [[ "$SRC_REAL" != "$DEST_REAL" ]]; then
  rm -rf "$INSTALL_DIR.tmp"
  mkdir -p "$INSTALL_DIR.tmp"
  (cd "$SRC_DIR" && tar -cf - .) | (cd "$INSTALL_DIR.tmp" && tar -xf -)
  rm -rf "$INSTALL_DIR"
  mv "$INSTALL_DIR.tmp" "$INSTALL_DIR"
fi

chmod +x "$INSTALL_DIR/scripts/show_latex_mcp.py" "$INSTALL_DIR/scripts/show_latex_viewer.py"
mkdir -p "$TMP_DIR"
chmod 700 "$TMP_DIR"

mkdir -p "$(dirname "$CONFIG_FILE")"
python3 - "$CONFIG_FILE" "$INSTALL_DIR" <<'PY'
from pathlib import Path
import sys

config_path = Path(sys.argv[1])
install_dir = Path(sys.argv[2])
script = install_dir / "scripts" / "show_latex_mcp.py"

block = f'''
[mcp_servers.show-latex]
command = "python3"
args = ["{script}"]
startup_timeout_sec = 20
tool_timeout_sec = 90
enabled = true
default_tools_approval_mode = "approve"
'''.strip()

text = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
remove_sections = {
    "mcp_servers.show-latex", "mcp_servers.show-latex.env",
    "mcp_servers.show-latex-split", "mcp_servers.show-latex-split.env",
    "mcp_servers.codex-show-latex", "mcp_servers.codex-show-latex.env",
}
out = []
skip = False
for line in text.splitlines():
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        section = stripped.strip("[]").strip()
        skip = section in remove_sections
        if not skip:
            out.append(line)
        continue
    if not skip:
        out.append(line)

new_text = "\n".join(out).rstrip()
if new_text:
    new_text += "\n\n"
new_text += block + "\n"
config_path.write_text(new_text, encoding="utf-8")
PY

mkdir -p "$SERVICE_DIR"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Codex Show LaTeX desktop viewer helper
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/scripts/show_latex_viewer.py
Restart=on-failure
RestartSec=2
Environment=PYTHONUNBUFFERED=1
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XDG_SESSION_TYPE XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS XAUTHORITY 2>/dev/null || true
  if ! systemctl --user daemon-reload || ! systemctl --user enable --now codex-show-latex-viewer.service; then
    echo "Could not start the systemd user service automatically." >&2
    echo "Start it manually with:" >&2
    echo "  $INSTALL_DIR/scripts/show_latex_viewer.py" >&2
  fi
else
  echo "systemctl not found; start the viewer helper manually:" >&2
  echo "  $INSTALL_DIR/scripts/show_latex_viewer.py" >&2
fi

cat <<EOF
Installed secure split Show LaTeX MCP.

MCP server:
  $INSTALL_DIR/scripts/show_latex_mcp.py

Viewer helper service:
  $SERVICE_FILE

Model-facing tools:
  show_latex(latex_source: string, compiler?: lualatex|pdflatex|xelatex|latexmk)
  note: auto-loads ./preamble.tex or ./praeamble.tex when present
  show_latex_status()

Restart Codex fully, then check /mcp.
EOF
