// Projects page: each project is an object with a directory (a path on the machine running Sanvi, typed here:
// no native file dialog, since Sanvi often runs in a container or on another host) and instructions for the agent.
export function initProjects({ el, show, api, toast, view, canBrowse = () => false }) {
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
    const picker = el('div', { class: 'dirpicker', hidden: true });
    let showHidden = false;
    // Lists the sub-directories of `at`; a bad path shows its message and keeps the picker usable.
    async function browse(at) {
      let r;
      try { r = await api('GET', `dirs?path=${encodeURIComponent(at || '~')}${showHidden ? '&hidden=1' : ''}`); } catch (e) {
        if (!at || at === '~') { picker.hidden = false; show(picker, el('div', { class: 'banner' }, `⚠ ${e.message}`)); return; }
        picker.hidden = false;
        await browse('~'); // the typed path is not usable: start from the home directory and say why
        picker.prepend(el('div', { class: 'banner' }, `⚠ ${e.message}; showing ~ instead`));
        return;
      }
      picker.hidden = false;
      show(picker,
        el('div', { class: 'dirbar' },
          el('button', { type: 'button', title: 'Parent directory', disabled: !r.parent, onclick: () => browse(r.parent) }, '↑'),
          el('code', { class: 'dirpath', title: r.path }, r.path),
          el('label', { class: 'muted' }, el('input', { type: 'checkbox', checked: showHidden, onchange: (e) => { showHidden = e.target.checked; browse(r.path); } }), ' hidden'),
          el('button', { type: 'button', class: 'primary', title: 'Put this directory into the field (press Save to keep it)', onclick: () => { dir.value = r.path; picker.hidden = true; } }, 'Use this directory'),
          el('button', { type: 'button', title: 'Close', onclick: () => { picker.hidden = true; } }, '×')),
        el('ul', { class: 'dirlist' }, r.dirs.length
          ? r.dirs.map((name) => el('li', {}, el('button', { type: 'button', onclick: () => browse(`${r.path === '/' ? '' : r.path}/${name}`) }, `${name}/`)))
          : el('li', { class: 'muted' }, 'no sub-directories')));
    }
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
      el('label', {}, 'Directory', el('span', { class: 'dirfield' }, dir,
        canBrowse() ? el('button', { type: 'button', title: 'Browse the directories of the machine running Sanvi', onclick: () => browse(dir.value.trim() || '~') }, 'Browse…') : null)),
      picker,
      el('label', {}, 'Instructions', ins),
      el('div', { class: 'buttons' }, el('button', { type: 'button', class: 'primary', onclick: save }, p.exists ? 'Save' : 'Create project object')));
  }

  function paint() {
    show(view, el('div', { class: 'detail projects' },
      el('a', { href: '#/' }, '← Board'),
      el('h1', {}, 'Projects'),
      el('p', { class: 'muted' }, 'The directory is where the agent runs for tickets and chats of that project; the instructions are sent to it as context. Used only with --agents; the Browse… button needs it too. Stored as small Markdown files in _projects/ next to the tickets.'),
      list.map(card)));
  }

  return { render, load, warningCount };
}
