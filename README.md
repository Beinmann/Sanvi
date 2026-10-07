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
statuses: [open, in-progress, testing, blocked, deferred, done]
```

Without it those six are used. A ticket with any other status gets its own
column.

## Web UI

```
node bin/tk.js --dir /path/to/tickets serve [--port 4321]
```

- Kanban board; drag a card to change its status.
- Search box above the board: free text (title and body) plus
  `status:`, `area:`, `priority:` filters, comma-separated values, `-` to
  exclude (`migrate -area:research status:open,blocked`). Everything ANDs;
  `area:` alone means "not set". Unknown `key:` tokens are plain text. The
  query is stored in the URL (`#/?q=...`) so views can be bookmarked.
- **Table view**: the Board/Table switch next to the search box shows the same
  (filtered) tickets as a sortable table (id, title, status, area, priority,
  checklist progress); click a header to sort, again to reverse, click a row to
  open it. Read-only; view, sort and filter are kept in the URL
  (`#/?q=...&view=table&sort=priority&dir=desc`).
- **Column order**: drag a status column header onto another column to reorder;
  the order is written to `statuses:` in `_config.yml`, so the CLI and other
  browsers see it too.
- Ticket page: rendered Markdown, editable status/area/priority and body.
  **Ctrl+S** (or Save) writes the file.
- **+ Idea** (or `i`): quick capture. Type one or a few sentences, no title;
  **Ctrl+Enter** saves and returns to the board. **Ctrl+I** opens the same
  box as an overlay from anywhere, even mid-edit (your edit is kept). Each idea becomes
  a normal ticket with `status: design`, a placeholder title taken from the
  first sentence, your text verbatim under *Problem / motivation* and a note
  saying it is unrefined. A later session (human or AI) can list
  `status:design` tickets, ask questions, and rewrite them into real tickets.
  `design` is not in the default status set, so it shows up as its own column
  once an idea exists; add it to `_config.yml` to fix its position.
- Keyboard (press **?** for the overlay): **Ctrl+K** command menu (jump to a
  ticket, set status, new ticket); on the board `j/k` `h/l` move focus, `/`
  focuses search, `Enter` opens, `s` sets status, `1`-`9` moves the focused card to that column (the numbers show on the headers while a card is focused or dragged), `n`
  creates, `b` goes to the board; in a ticket `e`/`p` edit/preview, `Esc` leaves the editor, then
  goes back. Single-key hotkeys are off while typing in a field.
- Description editor: optional **Vim mode** (checkbox under the editor,
  remembered per browser; off by default). Home-grown subset, no
  dependencies: normal/insert/visual/visual-line, `h j k l w b e 0 ^ $ gg G`
  with counts, `d c y` (+ `dd cc yy`, visual), `x X D C s S Y p P`,
  `i a I A o O`, `u` / `Ctrl-R`, `/` `n` `N`, and `:w` `:q` `:q!` `:wq`.
  The mode is shown below the editor. In vim mode `Esc` (or `Ctrl+C` without a
  selection) only changes vim
  mode: `:w` saves, `:q` leaves the editor (refused with unsaved changes),
  `:q!` leaves and discards edits, `:wq` does both; `Ctrl+S` works in both
  modes. Without vim mode `Esc` leaves the editor as before.
  Both modes work with the 409 / changed-on-disk banners.
- Edits made outside the UI show up live. If you have unsaved edits, a
  banner offers "Load disk version" or "Keep my draft" instead of replacing
  your text.
- **Saves are refused if the file changed since you loaded it** (HTTP 409);
  nothing is written until you choose how to resolve it.
- Listens on `127.0.0.1` by default and rejects foreign `Host`/`Origin` headers (DNS-rebinding protection). `localhost`, `127.0.0.1` and `*.localhost` are allowed; add others with `--allow-host a,b`. Behind a proxy that reaches the server over a network, also pass `--host 0.0.0.0`; the Host check then still blocks direct IP access.

## Change log

Writes made **through the web UI** (create, status change, edit, and rejected
409 saves) append one JSON line to `<tickets dir>/../.tk/changes.log`
(the dir gets a `.gitignore` containing `*`). Fields: `ts`, `ticket` (id),
`action` (`create|status|edit|conflict`), `source`, `changes` (`{field, from, to}`),
`body` (lines added/removed, sections touched, ticked/unticked criteria),
`before`/`after` (content hashes). Bodies are never stored. Successive edits of
one ticket within 30 s merge into one entry (`merged: N`). No-op saves, hand
edits and CLI changes are not logged. A logging error never blocks a save.

The log rotates at 1 MB and keeps 5 files (`changes.log`, `.1` ... `.4`). Tune with
`TK_LOG_MAX_BYTES`, `TK_LOG_KEEP`, `TK_LOG_COALESCE_MS` (ms).

## CLI (optional)

```
tk list [--status S] [--area A] [--json]
tk show <id|slug> [--json]
tk idea "<text>"                         # quick capture, status design
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
- `src/changelog.js` — bounded web UI change log
- `src/instances.js` — instance registry for start/stop/ps
- `src/server.js` — JSON API, file watcher, SSE
- `public/` — frontend (`md.js` is a small safe Markdown renderer,
  `filter.js` the pure board filter, reusable by other views, `keys.js` the
  hotkeys and command menu, `vim.js` the optional editor vim mode)
- `npm test`

## Concurrency note

A save checks the file's content hash and then renames a temp file over it.
A write by another process in the few microseconds between check and rename
would be lost; this is accepted for a local single-user tool.
