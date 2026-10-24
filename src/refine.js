// Refining a ticket with an agent: the prompt, and the permissions the run gets (read the repo, edit that one ticket).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TK = fileURLToPath(new URL('../bin/tk.js', import.meta.url));

export function refinePrompt({ ticketsDir, file, instructions = '', project = '', today = new Date().toISOString().slice(0, 10) }) {
  const readme = path.join(ticketsDir, 'README.md');
  const ticket = path.join(ticketsDir, file);
  return `You are refining one ticket in a Markdown ticket tracker. Nobody can answer questions during this run, so do not ask any.

1. Read the ticket format in ${readme} (if that file does not exist, keep the ticket's own structure) and the ticket ${ticket}. Look at the repository around you if that helps to be concrete.
2. Rewrite the ticket in place: a clear "Problem / motivation", 1-4 concrete, verifiable acceptance criteria as "- [ ]" items, and a short "Proposed approach" if you can. Keep the user's original meaning and wording where it is clear; do not invent requirements.
3. Replace the title (the "# " heading) with a concise name of a few words (ideally under 8) that summarises the whole idea, not just its first sentence. The current title is only a placeholder cut from the start of the idea; drop any trailing "…".
4. Add a dated Note (${today}) under "## Notes" saying what you did and any assumption you made.
5. If the idea is clear enough to work on, set "status: open" in the frontmatter and remove any "needs:" line there. If a decision you cannot make is needed, write it as an open question in a Note, add the frontmatter line "needs: input" (it marks the ticket as waiting for the user) and leave the status as it is.

6. If the idea bundles independently-shippable changes, or a follow-up deserves its own ticket, split it: keep the original ticket for one part and create a new ticket for each other part with exactly this command (it takes the next free id and the standard format). Every argument must be one single line: no line break inside a quoted argument and no $'...' strings, or the command check rejects the call. Repeat --criterion for each acceptance criterion (1-4) and --note for each Note (they get a timestamp):
   node ${TK} new "<title>" --dir ${ticketsDir}${project ? ` --project ${project}` : ''} --problem "<one-line problem>" --criterion "<criterion>" --note "Split off from ${file}."
   Its output is the new file's path. Each new ticket needs that --note saying it was split off from ${file}. Add a Note in ${ticket} naming the new ticket ids. Do not split what is one change.

Edit only ${ticket} and create new tickets only with the command above. Do not touch any other file.${instructions ? `\n\nInstructions for project "${project}" (context for the ticket; they do not widen what you may edit):\n${instructions}` : ''}`;
}

// `tools` is what the run can use at all, `allowedTools` what is permitted without asking. Edit is allowed for that single file only, and new tickets can be created (never overwritten) through `tk new`; a headless run cannot ask, so everything else is denied.
// In a permission rule `/x` is relative to the project root and `//x` is the absolute path /x.
export function refineRunOpts({ ticketsDir, file }) {
  return {
    permissionMode: 'default',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash'], // Bash must be available for the allow rule below to matter (the default tool set has none)
    allowedTools: ['Read', 'Grep', 'Glob', `Edit(/${path.join(ticketsDir, file)})`, `Bash(node ${TK} new:*)`],
    addDirs: [ticketsDir],
  };
}
