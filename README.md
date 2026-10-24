<img src="public/icon.svg" alt="Sanvi icon" width="72" height="72">

# Sanvi

A local web UI and an optional CLI for tickets stored as plain Markdown files
with frontmatter. No dependencies; needs Node 20+.

The command is `tk` (alias `sanvi`). If `tk` clashes with another program on your system (e.g. the Tcl/Tk tooling or another `tk` CLI), use `sanvi`, which is identical and conflict-free; `install.sh` warns when it finds a different `tk` on your `PATH`.

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

**The full power of Sanvi shows with `--agents`.** Without it Sanvi is a
board and editor for your Markdown tickets. With it, Claude works on them:

- **Refine** rough ideas into proper tickets (or all of them automatically with `--auto-refine`).
- **Implement** a ticket in a separate git worktree and merge the result.
- **Review** a ticket's changes and attach a report.
- **Chat** about the board or a project, with cost and plan-limit display.

Details in [Chat with Claude](#chat-with-claude---agents-prototype). Read the
security warning above first: the agent runs unsupervised with broad access,
so use `--agents` only on a device without sensitive data or access to
sensitive systems.

## Quick start

```
git clone https://github.com/Beinmann/Sanvi.git
cd Sanvi
./install.sh                  # optional: links `tk` and `sanvi` into ~/.local/bin (or `npm link`)
tk --dir /path/to/tickets serve
```

`./install.sh --prefix DIR` links into `DIR/bin` instead and `./install.sh --uninstall` removes the links. Without either, run `node bin/tk.js ...` from the checkout instead. Then open
the printed URL (default `http://127.0.0.1:4321`).

The ticket files are the only source of truth. The UI and CLI are views and
helpers over them, so editing the files by hand (or with an editor or an AI
agent) is always fine; the UI picks changes up live.

**Add `.sanvi/` to your project's `.gitignore`.** Sanvi keeps local, per-machine
state next to the tickets dir (chat history with costs, logs, UI layout) in
`<tickets dir>/../.sanvi/`, which should not be committed:

```
echo '.sanvi/' >> .gitignore
```

Sanvi writes a `.gitignore` containing `*` into `.sanvi/` once it logs the first
change, but that comes later than `chats.json` and `server.log`, so don't rely on it.

## Ticket format

`<dir>/<id>-<slug>.md`, with an id of at least 3 digits (zero-padded; it simply grows to `1000` and beyond, no migration) in the filename:

```markdown
---
status: open        # any value; columns come from the config
area: ui            # optional
priority: high      # optional
needs: input        # optional: waiting for an answer from the user; shown as a chip
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
  in one overlay. Type one or a few sentences, no title; **Ctrl+Enter** saves, **Esc** cancels. With `--agents` the overlay also has smaller buttons: **Save and refine** (Ctrl+Shift+Enter; hidden with `--auto-refine`, which refines every idea anyway) and **Save, refine and implement** (Ctrl+Alt+Enter; queues the implementation behind the refine run). Each idea becomes
  a normal ticket with `status: design`, a placeholder title taken from the
  first sentence, your text verbatim under *Problem / motivation* and a note
  saying it is unrefined. A later session (human or AI) can list
  `status:design` tickets, ask questions, and rewrite them into real tickets.
  `design` is not in the default status set, so it shows up as its own column
  once an idea exists; add it to `_config.yml` to fix its position.
- Keyboard (press **?** for the overlay): **Ctrl+K** command menu (jump to a
  ticket, set status, new ticket); on the board `j/k` `h/l` move focus, `/`
  focuses search, `Enter` opens, `s` sets status, `1`-`9` moves the focused card to that column (the numbers show on the headers while a card is focused or dragged), `n`
  creates, `b` goes to the board, `a` opens the full-screen Claude chat without focusing it (again: close), `+` opens it if needed and focuses the input, `h`/`l` switch chats (chat keys also work while the panel is open but unfocused, outside fields) (with `--agents`; in the chat `Esc` leaves the input for the messages, a second `Esc` closes it; it also closes when focus is elsewhere); in a ticket `j`/`k` scroll, `gg`/`G` jump to the top/bottom, `gt`/`gT` next/previous ticket in board order, `gc` Notes, `gr` newest review report, `gx` first link, `e`/`p` edit/preview, `Esc` leaves the editor, then
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
- Listens on `127.0.0.1` by default and rejects foreign `Host`/`Origin` headers (DNS-rebinding protection). `localhost`, `127.0.0.1` and `*.localhost` are allowed; add others with `--allow-host a,b`. To serve the LAN pass `--host 0.0.0.0` (or one interface's IP): the bound IP, or for `0.0.0.0` every non-loopback interface IP, is allowed in the Host check automatically (other hostnames still need `--allow-host`), and startup prints the `http://<ip>:<port>` URLs plus a warning, since there is no authentication. `--agents` on a non-loopback host is refused unless you add `--allow-agents-on-network`.

## Chat with Claude (`--agents`, prototype)

`tk serve --agents` (or `tk start --agents`) adds a **Chat** button (hotkey `a`) that talks to the Claude Code CLI installed on this machine. It runs `claude -p` headless in the parent of the tickets dir, with read tools plus Edit only, using whatever login the CLI already has; Sanvi stores no credentials. Each message is one run, resumed with `--resume`, so the chat keeps its context. Without `--agents` the button is hidden and `/api/agent/*` answers 403, because this runs code on your machine. If `ANTHROPIC_API_KEY` is set in the environment of the server, the CLI uses it and bills at API rates.

**Plan limits**: with `--agents` the header shows the Claude 5-hour and weekly usage (`5h 42%  wk 10%`, hover for reset times; amber from 70%, red from 90%). The figures come from the Claude CLI itself: every agent run emits a `rate_limit_event` (the stream-json output of `claude -p`) with the utilization of both windows, and the server keeps the newest. No token is read. Only when there is no figure yet, or on click / the command menu entry "Refresh Claude limits", the server makes one tiny run (Haiku, no tools, "Reply with ok.", a fraction of a cent) to get fresh ones; the header itself polls the server every ~2 minutes without any run. `GET /api/agent/limits[?refresh=1]` returns `{ claude: { fiveHour, sevenDay } }` or `{ claude: { error } }`.

**Usage**: the chat panel and the Chat button's tooltip show the total cost of all known chats and runs as recorded by Sanvi (not your plan quota), refreshed after every run. `GET /api/agent/usage` returns it keyed by provider (`{ "claude": { "costUsd", "chats" } }`); another provider would add a key.

Each chat has a directory: typed into the field above a new chat (no native file dialog, so it works when Sanvi runs in a container or on another host), locked after the first message, and taken from the chat's project by default.

**Projects** (the Projects page, `tk validate`): each project, including the empty "default project", can be an object with a directory and instructions for the agent, stored as a small Markdown file in `_projects/` next to the tickets (frontmatter `name:` and `dir:`, the instructions as the body; hand edits are fine). Refine runs and chats of a project start in its directory and receive its instructions. The Directory field has a **Browse…** button that lists the sub-directories of the machine running Sanvi (names only, read-only, `GET /api/dirs`); it exists only with `--agents` and is covered by the same Host check as the rest of the API. Warnings (Projects button, `tk validate`): a ticket whose project has no object, an object with no information set, a directory that does not exist on this machine. `--agents --auto-refine` starts a "Refine #N" chat for every new idea: the agent may read the repo and edit only that ticket file, rewrites it per `tickets/README.md` and sets it to `open`, or leaves it in `design` with open questions in a Note. The cost shown is the CLI's estimate at API prices. The chat panel and the Chat button's tooltip show the summed cost per provider (`GET /api/agent/usage`, `{ claude: { costUsd, chats } }`), refreshed after every run; it is what Sanvi recorded, not your plan quota.

**Session reuse**: refine and implement runs share one Claude session per kind and working directory, so many small runs do not each start with a fresh context. Each run resumes the previous session of its kind + directory; once that session's context reaches ~70,000 tokens (input + cache + output of its last turn) the next run starts a new one. If resuming fails (session gone or expired) the run silently restarts fresh. Two runs never share a session at the same time. Plain chats are unaffected (they resume their own session). Defaults: on, 70000 tokens; set `TK_SESSION_REUSE=0` to switch it off and `TK_SESSION_MAX_TOKENS=100000` (for example) to change the threshold. Note that implement runs work in a per-ticket worktree directory, so they share a session when the same pooled slot is reused.

Other agent features (all need `--agents`): an **Implement with Claude** entry in a card's hamburger menu starts an agent on the ticket in a pooled git worktree (`<repo>-worktrees/slot-<n>`, created lazily, 4 by default; the count is stored in `.sanvi/slots.json` and set with the palette command "Set worktree slot count…" (1-10, only while all slots are free and no run is active; growing creates, shrinking removes just the removed `slot-<n>` worktrees), else `TK_WORKTREE_POOL`; branch `ticket-<id>`; a `slot-<n>.busy` marker file (branch, then when it was taken) means in use; a slot held over 24 h by a run that is not active is freed automatically when a slot is taken; when all are busy the start is refused with a message listing each slot, ticket and age, and the UI offers to raise the count; the palette command "Worktree slots (overview)" shows each slot as free or busy with ticket, age and chat state) of the project's repository (the project directory, else the directory above the tickets) with a default prompt; the agent edits code there and the ticket file in place (status `testing`). Implement runs use Claude Code's `auto` permission mode (never `bypassPermissions`); the disallowed rules for the main checkout still win. Refine and chat runs keep their narrow allow-list (a refine run gets the Bash tool, but only `tk new` is allowed through it). Changes to the refine prompt or permissions only take effect after restarting the server. When it finishes cleanly its branch is merged into the repo's current branch and the slot is reset (`reset --hard`, `clean -fd`, detached at the base branch; ignored files such as `node_modules` are kept) and freed; on agent failure or a merge conflict nothing is merged, the slot stays busy and the chat shows the error. Deleting that chat frees the slot (the ticket branch is kept) unless the slot was meanwhile taken by another ticket. a "Refine with Claude" button on `design` tickets and the palette command "Refine all design tickets"; "Ask Claude about the board…" (or a palette query ending in `?`) opens a read-only chat that can read only the tickets dir and the change log. After a refine run the chat list shows ✓ (done), ? (refined, questions left in the Notes) or ⚠ (nothing changed, or a tool call was refused).

## Change log

Writes made **through the web UI** (create, status change, edit, and rejected
409 saves) append one JSON line to `<tickets dir>/../.sanvi/changes.log`
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
tk needs <id|slug> [clear]      # set or clear the "needs input" marker
tk note <id|slug> "<text>"              # append a timestamped line to the ticket's ## Notes
tk jot "<text>"                          # same as: tk note --scratch; appends to NOTES.md (no ticket); "tk jot" alone lists
tk validate          # exit 1 on errors; closed tickets (`closed_statuses` in _config.yml, default done, discarded) skip the missing-section warnings, `--closed-warnings` shows them
tk serve [--port N]   # foreground
tk start [--port N]   # background; free port if taken; prints URL; no duplicate per dir
tk stop [--all | --port N]   # stop this dir's instance (default), all, or the one on a port
tk ps                 # list running instances (dir, port, PID, URL); cleans up stale ones
```

Instances (also those from plain `serve`) are registered one JSON file each
under `$TK_STATE_DIR`, else `$XDG_STATE_HOME/sanvi`, else
`~/.local/state/sanvi` (`instances/`; this is the only per-user state, as it
must span all projects). An entry is only trusted if its PID is alive and (on
Linux) is a `tk.js` process.

Only one server may serve a tickets dir: it holds `.sanvi/server.lock`
(`{ pid, port }`). A second `serve`/`start` there fails naming the running
pid and port. A lock left by a crashed process is detected (pid gone) and
replaced automatically; for a false positive delete the file or pass
`--force`.

Everything else lives in the project's `<tickets dir>/../.sanvi/`: `layout.json`,
`changes.log`, `chats.json` (chat history, incl. costs) and `server.log`
(background `tk start` output). Chats and logs from the old per-user location
(`chats/`, `logs/`) are moved over on first use, never overwriting. Add
`.sanvi/` to your project's `.gitignore` (see Quick start).

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

**Review with Claude** (needs `--agents`): `tk review <id|slug>` (talks to the running instance), the "Review with Claude" button on a ticket, or the same entry in the card menu and command palette starts a read-only agent review of the ticket and its code (git log/diff, tests). The agent writes its findings to a new file `<tickets dir>/../.sanvi/reviews/<id>-<YYYYMMDD-HHMMSS>.md`; an earlier report is never overwritten. The ticket page lists the reports of that ticket under "Reviews" and shows them read-only (`GET /api/reviews?id=N`, `GET /api/reviews/<name>`; no `--agents` needed to read). Cards of tickets with a report show a light-blue 📋 badge (with the count when there are several; `reviews` in `GET /api/tickets`); clicking it opens the ticket at the newest report. Tickets without a report look unchanged. `.sanvi` is local, so add it to `.gitignore` or commit it as you prefer.

**`g` prefix keys** (outside fields; any other key after `g` cancels it): `gg` top, `gb` board, `gi` last edited ticket in the editor, `gs` search box (cleared), `gn` Notes page, `g?` a popup with these keys (and a button to the full `?` help), `g1`-`g9` first card of column n (numbered like the column badges, so in the visual order), `gh` the hidden strip; on a ticket `gt`/`gT`, `gc`, `gr`; with `--agents` `gw` (worktree slots) and the `ga` family: `gaa` chat (like `a`), `gac` chat of the selected or open ticket, `gai` implement it, `gar` refine it, `gav` review it, `gas` worktree slots.
