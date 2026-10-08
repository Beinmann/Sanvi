<img src="public/icon.svg" alt="Sanvi icon" width="72" height="72">

# Sanvi

A local web UI and an optional CLI for tickets stored as plain Markdown files
with frontmatter. No dependencies; needs Node 20+.

The command is `tk` (alias `sanvi`).

> **Security warning: the AI features run an agent on your machine.** With
> `--agents` Sanvi starts the Claude Code CLI, which reads files, edits files
> and sends their contents (plus ticket text and project instructions) to an AI
> service. Ticket text is untrusted input to that agent, so a malicious ticket
> can try to steer it. Sanvi limits what the agent may do (see "Chat with Claude"
> below), but those limits are a safety net, not a sandbox. **Do not run Sanvi
> with `--agents` on a system that holds sensitive data** (keys, credentials,
> private documents, other projects). Use an isolated system instead: a
> container, a VM or a dedicated machine that contains only the project you
> want the agent to see. Without `--agents` nothing of this applies and no AI
> is used.

## Quick start

```
git clone https://github.com/Beinmann/Sanvi.git
cd Sanvi
npm link                      # optional: puts `tk` and `sanvi` on your PATH
tk --dir /path/to/tickets serve
```

Without `npm link`, run `node bin/tk.js ...` from the checkout instead. Then open
the printed URL (default `http://127.0.0.1:4321`).

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

## Projects and areas

Two optional fields with different meanings: `project:` is which product or
subproject a ticket belongs to (`project: billing`), `area:` is which part of it
(`area: ui`). One tickets dir and one board can hold several projects; use
separate dirs only for unrelated repos or different status sets.

The header's project switcher pins `project:<name>` to every search: the board
shows only that project, and new tickets and quick ideas are filed under it
(changeable in the dialog). `P`, or "Switch project…" in Ctrl+K, opens the list.
A project exists as long as some ticket has it in `project:`: type a new name
into a ticket's Project field to create one. The choices are the distinct
project values on tickets, plus "All projects" and "No project" (tickets
without one). A stored choice that no ticket has any more falls back to "All
projects". With no projects the switcher is hidden; with
exactly one (and every ticket has it) it is a plain label. The most recently used projects are listed first. The choice is kept in the browser
(`localStorage`) and mirrored as `project:<name>` in the URL; with "All
projects" each card shows its project as a label. `tk list --project P` and
`tk new --project P` work too.

## Web UI

```
tk --dir /path/to/tickets serve [--port 4321]
```

- Kanban board; drag a card to change its status.
- Search box above the board: free text (title and body; title matches sort first in a column, and cards matched only
  in the description show an "in text" chip), `title:word` (title only), `12` / `#12` (ticket by id; `#12` matches only the id) plus
  `status:`, `area:`, `priority:` filters, comma-separated values, `-` to
  exclude (`migrate -area:research status:open,blocked`). Everything ANDs;
  `area:` alone means "not set". Unknown `key:` tokens are plain text. The
  query is stored in the URL (`#/?q=...`) so views can be bookmarked.
- **Table view**: disabled for now (ticket 010); the code is kept behind `TABLE_VIEW` in `public/app.js`, and old `view=table` links open the board.
- **Column order**: drag a status column header onto another column to reorder;
  the order is written to `statuses:` in `_config.yml`, so the CLI and other
  browsers see it too.
- **Add status**: the "+ Status" button on the board (or "Add status…" in Ctrl+K) appends a
  status to `statuses:` in `_config.yml`; it becomes a column, a form option and the next number key.
- **Images**: paste or drop an image into the description editor; it is saved as
  `assets/<ticket id>-<n>.<ext>` next to the tickets (PNG/JPEG/GIF/WebP, max 5 MB) and a
  `![screenshot](assets/...)` link is inserted. `tk validate` warns about image links to missing files. The quick-idea and comment boxes take pasted/dropped
  images too (uploaded on save, so Esc leaves nothing behind); `tk idea` / `tk note` stay text-only.
- **Pick up and drop**: `Space` on a focused card picks it up; `h`/`l` choose the column (hidden ones
  too), `Space`/`Enter` drops, `1`-`9` drops at once, `Esc` cancels. Nothing is saved until the drop.
- **Search from anywhere**: `/` (or `Ctrl+/` also while typing) goes to the board and focuses the search box.
- **Selection**: the board keeps an explicit selected card (highlighted; `j`/`k`/`h`/`l` move it, a click or Tab selects, Esc clears). Keys like `Enter`, `c`, `s`, `d`, `Space` act on it, independent of browser focus; the hovered card is only used while nothing is selected.
- **Peek**: hidden statuses are reachable with the same keys as cards: `k` on a column's top card moves up onto the "Hidden: …" strip, `h`/`l` pick a status, `Enter` lists its tickets (honouring the filter) without showing the column; in the list `j`/`k` move, `Enter` opens a ticket, `Space` picks it up to move it (then as for any card), `h`/`l` switch status, `Esc` closes; `j` on the strip goes back to the cards. The ▾ next to an entry opens the same list with the mouse; items can be dragged onto a column.
- **Delete and trash**: `d` on a focused (or hovered) card, the ☰ menu or Ctrl+K asks first (Enter / `y` deletes, Esc cancels).
  The ticket and its images move to `tickets/.trash/` and stay restorable for 30 days (`TRASH_DAYS` in `src/core.js`;
  purged on server start and when the Trash view opens). The **Trash** view restores or deletes for good; a restored
  ticket whose id was reused gets the next free id. CLI: `tk rm <id>`, `tk trash`, `tk restore <id>`. Add
  `.trash/` to the outer `.gitignore` if trashed tickets should not be committed.
- **Comments**: `c` on a focused card (or the "+ note" on a card) opens a one-field box; Ctrl+Enter appends
  `- YYYY-MM-DD HH:MM: text` to the ticket's `## Notes` (created if missing).
- **Hide columns**: the × in a column header hides it; a "Hidden: …" strip above the board lists hidden
  columns with ticket counts (and how many match the current filter) and restores one on click. A ticket dropped on a hidden entry moves there without showing the column.
  Also "Show/Hide column: …" in Ctrl+K. Stored per browser, not in `_config.yml`.
- A body section `## Summary` (2-5 lines: what was done, "To test: …") is shown in a highlighted box at the top of the ticket page. Optional; nothing else changes without it.
- Ticket page: rendered Markdown, editable status/area/priority and body.
  **Ctrl+S** (or Save) writes the file.
- **+ Idea** (or `i`, or **Ctrl+I** from anywhere, even mid-edit; your edit is kept): quick capture
  in one overlay. Type one or a few sentences, no title; **Ctrl+Enter** saves, **Esc** cancels. Each idea becomes
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

## Chat with Claude (`--agents`, prototype)

`tk serve --agents` (or `tk start --agents`) adds a **Chat** button that talks to the Claude Code CLI installed on this machine. It runs `claude -p` headless in the parent of the tickets dir, with read tools plus Edit only, using whatever login the CLI already has; Sanvi stores no credentials. Each message is one run, resumed with `--resume`, so the chat keeps its context. Without `--agents` the button is hidden and `/api/agent/*` answers 403, because this runs code on your machine. If `ANTHROPIC_API_KEY` is set in the environment of the server, the CLI uses it and bills at API rates.

Each chat has a directory: typed into the field above a new chat (no native file dialog, so it works when Sanvi runs in a container or on another host), locked after the first message, and taken from the chat's project by default.

**Projects** (the Projects page, `tk validate`): each project, including the empty "default project", can be an object with a directory and instructions for the agent, stored as a small Markdown file in `_projects/` next to the tickets (frontmatter `name:` and `dir:`, the instructions as the body; hand edits are fine). Refine runs and chats of a project start in its directory and receive its instructions. Warnings (Projects button, `tk validate`): a ticket whose project has no object, an object with no information set, a directory that does not exist on this machine. `--agents --auto-refine` starts a "Refine #N" chat for every new idea: the agent may read the repo and edit only that ticket file, rewrites it per `tickets/README.md` and sets it to `open`, or leaves it in `design` with open questions in a Note. The cost shown is the CLI's estimate at API prices.

Other agent features (all need `--agents`): a "Refine with Claude" button on `design` tickets and the palette command "Refine all design tickets"; "Ask Claude about the board…" (or a palette query ending in `?`) opens a read-only chat that can read only the tickets dir and the change log. After a refine run the chat list shows ✓ (done), ? (refined, questions left in the Notes) or ⚠ (nothing changed, or a tool call was refused).

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
tk note <id|slug> "<text>"              # append a timestamped line to the ticket's ## Notes
tk jot "<text>"                          # same as: tk note --scratch; appends to NOTES.md (no ticket); "tk jot" alone lists
tk validate          # exit 1 on errors
tk serve [--port N]   # foreground
tk start [--port N]   # background; free port if taken; prints URL; no duplicate per dir
tk stop [--all | --port N]   # stop this dir's instance (default), all, or the one on a port
tk ps                 # list running instances (dir, port, PID, URL); cleans up stale ones
```

Instances (also those from plain `serve`) are registered one JSON file each
under `$TK_STATE_DIR`, else `$XDG_STATE_HOME/sanvi`, else
`~/.local/state/sanvi`; background logs go to `logs/` there. An entry is
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
