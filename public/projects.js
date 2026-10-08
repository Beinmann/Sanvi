// Projects page: each project is an object with a directory (a path on the machine running Sanvi, typed here:
// no native file dialog, since Sanvi often runs in a container or on another host) and instructions for the agent.
export function initProjects({ el, show, api, toast, view }) {
  let list = [];

  async function load() { list = await api('GET', 'projects'); return list; }
  const warningCount = () => list.reduce((n, p) => n + p.warnings.length, 0);

  async function render() {
    try { await load(); } catch (e) { toast(`Projects failed: ${e.message}`); return; }
    paint();
  }

  function card(p) {
    const dir = el('input', { value: p.dir, placeholder: '/absolute/path on the machine running Sanvi', 'aria-label': `Directory of ${p.label}`, spellcheck: 'false' });
    const ins = el('textarea', { rows: 4, placeholder: 'Instructions for the agent: conventions, what to avoid, how to build or test…', 'aria-label': `Instructions for ${p.label}` });
    ins.value = p.instructions;
    const save = async () => {
      try {
        list = await api('PUT', 'projects', { name: p.name, dir: dir.value, instructions: ins.value });
        toast(`Saved ${p.label}`);
        paint();
        document.dispatchEvent(new Event('projects-changed'));
      } catch (e) { toast(`Not saved: ${e.message}`); }
    };
    return el('section', { class: `project${p.warnings.length ? ' warn' : ''}` },
      el('h2', {}, p.label, el('span', { class: 'muted' }, ` · ${p.tickets} ticket${p.tickets === 1 ? '' : 's'}${p.exists ? '' : ' · no project object yet'}`)),
      p.warnings.map((w) => el('div', { class: 'banner' }, `⚠ ${w}`)),
      el('label', {}, 'Directory', dir),
      el('label', {}, 'Instructions', ins),
      el('div', { class: 'buttons' }, el('button', { type: 'button', class: 'primary', onclick: save }, p.exists ? 'Save' : 'Create project object')));
  }

  function paint() {
    show(view, el('div', { class: 'detail projects' },
      el('a', { href: '#/' }, '← Board'),
      el('h1', {}, 'Projects'),
      el('p', { class: 'muted' }, 'The directory is where the agent runs for tickets and chats of that project; the instructions are sent to it as context. Used only with --agents. Stored as small Markdown files in _projects/ next to the tickets.'),
      list.map(card)));
  }

  return { render, load, warningCount };
}
