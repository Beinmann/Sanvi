# ticket-tool

A local web UI and an optional CLI for tickets stored as plain Markdown files
with frontmatter. No dependencies; needs Node 20+.

The ticket files are the only source of truth. The UI and CLI are views and
helpers over them, so editing the files by hand (or with an editor or an AI
agent) is always fine; the UI picks changes up live.

## Ticket format

`<dir>/<id>-<slug>.md`, with a 3-digit zero-padded id in the filename:

```markdown
---
status: open        # any value; columns come from the config
area: ui            # optional
priority: high      # optional
---

# Title

## Problem / motivation
...
## Acceptance criteria
- [ ] ...
```

Unknown frontmatter lines, comments and the body are never reformatted unless
you change them. Files starting with `_` or `README` are ignored.

Optional `<dir>/_config.yml` sets the status columns and their order:

```yaml
statuses: [open, in-progress, blocked, deferred, done]
```

Without it those five are used. A ticket with any other status gets its own
column.

## Web UI

```
node bin/tk.js --dir /path/to/tickets serve [--port 4321]
```

- Kanban board; drag a card to change its status.
- Ticket page: rendered Markdown, editable status/area/priority and body.
  **Ctrl+S** (or Save) writes the file.
- Edits made outside the UI show up live. If you have unsaved edits, a
  banner offers "Load disk version" or "Keep my draft" instead of replacing
  your text.
- **Saves are refused if the file changed since you loaded it** (HTTP 409);
  nothing is written until you choose how to resolve it.
- Listens on `127.0.0.1` by default and rejects foreign `Host`/`Origin` headers (DNS-rebinding protection). `localhost`, `127.0.0.1` and `*.localhost` are allowed; add others with `--allow-host a,b`. Behind a proxy that reaches the server over a network, also pass `--host 0.0.0.0`; the Host check then still blocks direct IP access.

## CLI (optional)

```
tk list [--status S] [--area A] [--json]
tk show <id|slug> [--json]
tk new "<title>" [--area A] [--status S] [--priority P]
tk status <id|slug> <status>
tk validate          # exit 1 on errors
tk serve [--port N]   # foreground
tk start [--port N]   # background; free port if taken; prints URL; no duplicate per dir
tk stop [--all | --port N]   # stop this dir's instance (default), all, or the one on a port
tk ps                 # list running instances (dir, port, PID, URL); cleans up stale ones
```

Instances (also those from plain `serve`) are registered one JSON file each
under `$TK_STATE_DIR`, else `$XDG_STATE_HOME/ticket-tool`, else
`~/.local/state/ticket-tool`; background logs go to `logs/` there. An entry is
only trusted if its PID is alive and (on Linux) is a `tk.js` process.

The tickets dir is `--dir`, `$TK_DIR`, or the nearest `./tickets` upwards.
Use `--json` for machine-readable output. Nothing requires going through it.

## Layout and tests

- `src/core.js` — parse / update / create / validate (shared by server and CLI)
- `src/instances.js` — instance registry for start/stop/ps
- `src/server.js` — JSON API, file watcher, SSE
- `public/` — frontend (`md.js` is a small safe Markdown renderer)
- `npm test`

## Concurrency note

A save checks the file's content hash and then renames a temp file over it.
A write by another process in the few microseconds between check and rename
would be lost; this is accepted for a local single-user tool.
