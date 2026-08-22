// The folder picker for a new project.
//
// What it walks is the disk of the **daemon's machine**, not of the device the
// browser is on. That is the right thing: the agent runs over there, so the
// folders that make sense are over there too — and this is exactly what makes
// it useful from a phone.

export class Picker {
  /// `on.browse(path)` asks for a folder's contents, `on.mkdir(parent, name)`
  /// creates one and steps in, `on.add(path)` makes it a project,
  /// `on.remove(path)` takes it out again.
  ///
  /// `on.agents()` names the agents that can be offered, and
  /// `on.openWith(path, agent, isProject)` starts one in the folder — adding it
  /// as a project first when it is not one yet. `on.menu(x, y, items)` shows
  /// the app's context menu; the picker brings the choices, not the menu.
  ///
  /// `on.recall()` returns the folder last opened and `on.remember` stores it —
  /// so opening this picker tomorrow lands where you left off instead of going
  /// home and making you walk down again.
  constructor(root, on) {
    this.on = on;
    this.dir = null;

    this.el = document.createElement('div');
    this.el.id = 'picker';
    this.el.hidden = true;
    this.el.innerHTML =
      '<div class="pbox">' +
      '<div class="shead"><h2>New project</h2><button class="close" title="Close">✕</button></div>' +
      '<div class="ptop">' +
      '<button class="up" title="Go up one folder">↑</button>' +
      '<input class="ppath" type="text" spellcheck="false" placeholder="Type or paste a folder path" />' +
      '<button class="go">Go</button>' +
      '</div>' +
      '<div class="proots"></div>' +
      '<div class="plist"></div>' +
      '<div class="pmk"><button class="mk">New folder</button>' +
      '<input class="mkname" type="text" spellcheck="false" placeholder="Folder name" hidden />' +
      '<button class="mkok" hidden>Create</button></div>' +
      '<div class="pfoot"><span class="pnote"></span>' +
      '<button class="drop" hidden>Remove from sidebar</button>' +
      '<button class="addonly">Add to sidebar only</button>' +
      '<button class="use">Open here…</button></div>' +
      '</div>';
    root.appendChild(this.el);

    this.pathInput = this.el.querySelector('.ppath');
    this.list = this.el.querySelector('.plist');
    this.roots = this.el.querySelector('.proots');
    this.note = this.el.querySelector('.pnote');
    this.upBtn = this.el.querySelector('.up');
    this.useBtn = this.el.querySelector('.use');
    this.addBtn = this.el.querySelector('.addonly');
    this.dropBtn = this.el.querySelector('.drop');
    this.mkBtn = this.el.querySelector('.mk');
    this.mkName = this.el.querySelector('.mkname');
    this.mkOk = this.el.querySelector('.mkok');

    this.el.querySelector('.close').onclick = () => this.close();
    this.el.querySelector('.go').onclick = () => this.go(this.pathInput.value);
    this.upBtn.onclick = () => this.dir?.parent && this.go(this.dir.parent);
    this.useBtn.onclick = (e) => this.openHere(e);
    this.addBtn.onclick = () => this.use();
    this.dropBtn.onclick = () => this.remove();
    this.mkBtn.onclick = () => this.armMkdir();
    this.mkOk.onclick = () => this.create();

    this.pathInput.onkeydown = (e) => {
      if (e.key === 'Enter') this.go(this.pathInput.value);
    };
    this.mkName.onkeydown = (e) => {
      if (e.key === 'Enter') this.create();
      if (e.key === 'Escape') this.disarmMkdir();
    };
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      e.stopPropagation(); // typing in here is not an app shortcut
    });
  }

  get open() {
    return !this.el.hidden;
  }

  show() {
    this.el.hidden = false;
    this.note.textContent = 'Loading…';
    this.disarmMkdir();
    // Empty means "start from home" — the daemon decides where that is.
    this.on.browse(this.dir?.path || this.on.recall() || '');
  }

  close() {
    this.el.hidden = true;
  }

  go(path) {
    this.note.textContent = 'Loading…';
    this.disarmMkdir();
    this.on.browse(path);
  }

  /// Called when the daemon answers with a folder's contents.
  update(dir) {
    this.dir = dir;
    this.on.remember(dir.path);
    this.pathInput.value = dir.path;
    // What is useful is the tail of the path, not the `C:\Users\...` that is the
    // same everywhere — so the box is scrolled to its right end.
    this.pathInput.scrollLeft = this.pathInput.scrollWidth;
    this.upBtn.disabled = !dir.parent;
    // "Open here…" never goes dead. It used to become a disabled "Already a
    // project" — a dead end that told you what you could not do, in the exact
    // place you came to do something. Opening an agent works the same on a
    // project and a non-project; only the bookkeeping differs.
    this.useBtn.disabled = false;
    // The add-only path is the one that makes no sense on a project.
    this.addBtn.hidden = dir.is_project;
    // Offered only when it can actually be done: a project discovered from an
    // agent session is not recorded in the config, so there is nothing to take
    // out of it.
    this.dropBtn.hidden = !dir.is_project;
    this.paintRoots();
    this.paintList();
    this.note.textContent = dir.truncated
      ? `Showing the first ${dir.entries.length} folders — type a path above to jump straight there.`
      : dir.is_project
        ? 'Already in your sidebar — Open here… starts an agent in it.'
        : `${dir.entries.length} folder${dir.entries.length === 1 ? '' : 's'} here`;
  }

  /// An error message from the daemon: keep showing the folder currently open,
  /// do not empty the panel just because one step failed.
  fail(message) {
    this.note.textContent = message;
    this.note.classList.add('bad');
    setTimeout(() => this.note.classList.remove('bad'), 6000);
  }

  paintRoots() {
    this.roots.textContent = '';
    for (const r of this.dir.roots || []) {
      const b = document.createElement('button');
      b.className = 'root' + (this.dir.path === r.path ? ' on' : '');
      b.textContent = r.name;
      b.onclick = () => this.go(r.path);
      this.roots.appendChild(b);
    }
  }

  paintList() {
    this.list.textContent = '';
    if (!this.dir.entries.length) {
      const none = document.createElement('div');
      none.className = 'pempty';
      none.textContent = 'No folders here. Use this one, or create a new folder below.';
      this.list.appendChild(none);
      return;
    }
    for (const e of this.dir.entries) {
      const row = document.createElement('div');
      row.className = 'pentry' + (e.is_project ? ' taken' : '');
      row.tabIndex = 0;

      const icon = document.createElement('span');
      icon.className = 'pico';
      icon.textContent = e.is_repo ? '◆' : '▸';
      icon.title = e.is_repo ? 'Git repository' : '';
      row.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'pname';
      label.textContent = e.name;
      row.appendChild(label);

      if (e.is_project) {
        const tag = document.createElement('span');
        tag.className = 'ptag';
        tag.textContent = 'project';
        row.appendChild(tag);
      }

      const enter = () => this.go(e.path);
      row.onclick = enter;
      row.onkeydown = (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          enter();
        }
      };
      this.list.appendChild(row);
    }
  }

  armMkdir() {
    this.mkName.hidden = false;
    this.mkOk.hidden = false;
    this.mkBtn.hidden = true;
    this.mkName.value = '';
    this.mkName.focus();
  }

  disarmMkdir() {
    this.mkName.hidden = true;
    this.mkOk.hidden = true;
    this.mkBtn.hidden = false;
  }

  create() {
    const name = this.mkName.value.trim();
    if (!name) {
      this.fail('Give the folder a name.');
      return;
    }
    this.note.textContent = 'Creating…';
    // The daemon creates it and answers straight away with the new folder's
    // contents, so "create then step in" needs no second step from here.
    this.on.mkdir(this.dir.path, name);
    this.disarmMkdir();
  }

  use() {
    if (!this.dir || this.dir.is_project) return;
    this.note.textContent = 'Adding…';
    this.on.add(this.dir.path);
  }

  /// The primary action: pick an agent, get it running in this folder.
  ///
  /// The menu lists exactly what the ＋ on a sidebar project row lists, through
  /// the same app menu — one folder-to-agent vocabulary, not two.
  openHere(e) {
    if (!this.dir) return;
    // The click that opens the menu must not reach the document listener that
    // closes any open menu — the ＋ on a sidebar row stops it the same way.
    e.stopPropagation();
    const agents = this.on.agents();
    if (!agents.length) {
      this.fail('No agents are enabled — turn one on in Settings.');
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const { path, is_project } = this.dir;
    this.on.menu(
      r.left,
      r.bottom + 4,
      agents.flatMap((a) => {
        const start = (pick) => () => {
          this.note.textContent = `Starting ${a.name}…`;
          this.on.openWith(path, a.name, is_project, pick);
        };
        const rows = [{ label: `New ${a.name}`, run: start(false) }];
        // An agent that can show its own session list says so; the rest cannot
        // be asked.
        if (a.can_pick) {
          rows.push({ label: `Resume ${a.name}…`, run: start(true) });
        }
        return rows;
      }),
    );
  }

  remove() {
    if (!this.dir || !this.dir.is_project) return;
    this.note.textContent = 'Removing…';
    this.on.remove(this.dir.path);
  }
}
