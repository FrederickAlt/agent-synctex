# Logging

TeX Actions can write local diagnostic logs so normal extension and host-service usage leaves enough context to debug later failures.

## Defaults

Without any setup, logging is `off`.

When enabled, logs are written to:

```text
${XDG_STATE_HOME:-~/.local/state}/pi-pdf-preview/logs/
```

Each process writes JSON Lines (`*.jsonl`) records to its own file. The Pi extension and the host-service daemon both read the same configuration source.

## Shared config file

Create one shared user config file:

```bash
mkdir -p ~/.config/pi-pdf-preview
cat > ~/.config/pi-pdf-preview/config.json <<'JSON'
{
  "logging": {
    "level": "debug",
    "dir": "~/.local/state/pi-pdf-preview/logs"
  }
}
JSON
```

Restart the Pi session and the host service after changing the file:

```bash
systemctl --user restart show-latex.service
```

Supported levels are:

- `debug`
- `info`
- `warn`
- `error`
- `off`

## Temporary overrides

Environment variables still work for one-off debugging and override the config file:

```bash
PDF_PREVIEW_LOG_LEVEL=debug
PDF_PREVIEW_LOG_DIR=/tmp/pi-pdf-preview-logs
PDF_PREVIEW_CONFIG=/path/to/config.json
```

For normal local debugging on one machine, prefer the shared config file so the Pi extension and daemon use the same source of truth.

## Inspect logs

```bash
ls -lah ~/.local/state/pi-pdf-preview/logs
tail -f ~/.local/state/pi-pdf-preview/logs/*.jsonl
```

Log records are structured JSON. Sensitive fields such as raw LaTeX snippets, callback tokens, preambles, compiler output, and source-line contents are redacted before writing.
