// The folder picker for a new project.
//
// What it walks is the disk of the **daemon's machine**, not of the device the
// browser is on. That is the right thing: the agent runs over there, so the
// folders that make sense are over there too — and this is exactly what makes
// it useful from a phone.

import { agentMenuRows } from './sidebar.js';
import { match } from './fuzzy.js';
import { mark } from './mark.js';

/// How long after the last keystroke the typed path is looked up.
const TYPE_MS = 500;

/// Do two spellings name the same folder? Trailing separators and slash
/// direction never matter; case only on a drive-letter path, where the
/// filesystem does not care either. Good enough to decide whether the box
/// still says what the panel shows — a wrong "different" only costs one
/// extra lookup, a wrong "same" would start an agent in the wrong place, so
/// the doubt goes the cheap way.
export function samePath(a, b) {
  const norm = (p) => {
    let s = p.trim().replace(/[\\/]+$/, '');
    if (/^[a-zA-Z]:/.test(s)) s = s.replace(/\//g, '\\').toLowerCase();
    return s;
  };
  return norm(a) === norm(b);
}

export class Picker {
  /// `on.browse(path)` asks for a folder's contents, `on.mkdir(parent, name)`
  /// creates one and steps in, `on.add(path)` makes it a project,
  /// `on.remove(path)` takes it out again.
  ///
  /// `on.agents()` names the agents that can be offered, and
  /// `on.openWith(path, agent, isProject, {pick, resume})` starts one in the
  /// folder — adding it as a project first when it is not one yet.
  /// `on.sessionsFor(path)` and `on.liveIn(path)` tell the agent rows what
  /// history and what running terminal the folder already has. `on.menu(x, y, items)` shows
  /// the app's context menu; the picker brings the choices, not the menu.
  ///
  /// `on.recall()` returns the folder last opened **on the machine now
  /// showing** and `on.remember` stores it —
  /// so opening this picker tomorrow lands where you left off instead of going
  /// home and making you walk down again.
  constructor(root, on) {
    this.on = on;
    this.dir = null;
    /// Which machine the folder on screen belongs to.
    ///
    /// A path only means something on the machine it was browsed on:
    /// `C:\data\code\analisa-video` exists on one laptop and nowhere else, and
    /// carrying it across left the panel showing that laptop's folder list under
    /// a red "No such file or directory" from the machine actually being used.
    this.scope = null;
    /// Whether a failed browse has already fallen back to home, so a home that
    /// fails too cannot loop.
    this.retried = false;
    /// The lookup that follows typing, so a keystroke resets the wait.
    this.typeTimer = null;
    /// Whether the lookup in flight was started by typing rather than by
    /// Enter, Go or a click. A path half typed does not exist yet, and saying
    /// so in red on every pause is nagging; it is told quietly instead.
    this.typed = false;
    /// Set by Enter and Go: the answer may then replace what was typed with
    /// the folder's own spelling. While typing, the box is left alone —
    /// otherwise the answer to `C:\data` lands while `\code` is being added
    /// to it, and wipes the addition.
    this.commit = false;
    /// An action waiting for the typed path to be looked up first. Every
    /// action reads the folder on screen, and the box used to be able to say
    /// something else: type a path, skip Go, pick an agent, and it started in
    /// the folder from before the typing.
    this.after = null;

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
      '<div class="pfind">' +
      '<input class="pfilter" type="text" spellcheck="false"'
      + ' placeholder="Filter these folders…" aria-label="Filter the folders listed" />' +
      '<button class="pfclear" hidden title="Clear the filter"'
      + ' aria-label="Clear the filter">✕</button>' +
      '</div>' +
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
    this.el.querySelector('.pfilter').oninput = () => this.setFilter(this.filterInput.value);
    this.el.querySelector('.pfilter').onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); // clearing the filter is not closing the panel
        this.setFilter('');
        return;
      }
      // Type a few letters, press Enter, and you are in the folder. The list is
      // sorted best-first, so the first row is the one meant often enough that
      // reaching for the mouse to confirm it would be the slower path.
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = this.list.querySelector('.pentry');
        if (first) first.click();
      }
    };
    this.el.querySelector('.pfclear').onclick = () => {
      this.setFilter('');
      this.filterInput.focus();
    };
    this.list = this.el.querySelector('.plist');
    this.filterInput = this.el.querySelector('.pfilter');
    this.filterClear = this.el.querySelector('.pfclear');
    /// What is typed in the filter box. Folder lists here are one directory
    /// deep and already capped, so this never leaves the browser — the entries
    /// to search are the ones already on screen.
    this.filter = '';
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
    this.el.querySelector('.go').onclick = () => this.commitPath();
    this.upBtn.onclick = () => this.dir?.parent && this.go(this.dir.parent);
    this.useBtn.onclick = (e) => this.openHere(e);
    this.addBtn.onclick = () => this.settle(() => this.use());
    this.dropBtn.onclick = () => this.settle(() => this.remove());
    this.mkBtn.onclick = () => this.settle(() => this.armMkdir());
    this.mkOk.onclick = () => this.create();

    this.pathInput.onkeydown = (e) => {
      if (e.key === 'Enter') this.commitPath();
    };
    // The list follows the typing, a moment behind it. Enter and Go still
    // work, but nothing depends on them any more.
    this.pathInput.oninput = () => {
      clearTimeout(this.typeTimer);
      this.typeTimer = setTimeout(() => {
        const typed = this.pending();
        if (typed === null) return;
        this.typed = true;
        this.go(typed);
      }, TYPE_MS);
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

  /// The machine now showing. Its folders are not the last machine's folders,
  /// so what is on screen is dropped rather than carried across; `recall` then
  /// supplies the folder last used over there.
  setScope(key) {
    if (key === this.scope) return;
    this.scope = key;
    this.dir = null;
    this.retried = false;
    if (this.open) this.show();
  }

  show() {
    this.el.hidden = false;
    this.setFilter('');
    this.note.textContent = 'Loading…';
    this.retried = false;
    this.disarmMkdir();
    // Empty means "start from home" — the daemon decides where that is.
    this.on.browse(this.dir?.path || this.on.recall() || '');
  }

  close() {
    this.el.hidden = true;
  }

  go(path) {
    clearTimeout(this.typeTimer);
    this.note.textContent = 'Loading…';
    this.retried = false;
    this.disarmMkdir();
    this.on.browse(path);
  }

  /// Enter or Go: look the box up now, and let the answer tidy its spelling.
  commitPath() {
    this.commit = true;
    this.typed = false;
    this.go(this.pathInput.value);
  }

  /// What the box says, when that is not the folder on screen; `null` when
  /// the two agree and there is nothing to look up.
  pending() {
    const typed = this.pathInput.value.trim();
    if (!typed) return null;
    if (this.dir && samePath(typed, this.dir.path)) return null;
    return typed;
  }

  /// Run `action` on the folder the box names — looking it up first if the
  /// panel is still showing another one, and only then, once the answer is
  /// in. A lookup that fails drops the action: nothing is started in a folder
  /// that could not be found.
  settle(action) {
    const typed = this.pending();
    if (typed === null) {
      action();
      return;
    }
    this.after = action;
    this.typed = false;
    this.commit = true;
    this.go(typed);
  }

  /// Called when the daemon answers with a folder's contents.
  update(dir) {
    // A filter belongs to the folder it was typed in. Carrying it into the next
    // one is how you step into a folder and find it apparently empty — the
    // entries are there, the old query simply matches none of them.
    const moved = dir.path !== this.dir?.path;
    this.dir = dir;
    if (moved) {
      this.filter = '';
      this.filterInput.value = '';
      this.filterClear.hidden = true;
    }
    this.on.remember(dir.path);
    // Not while the path is being typed: the answer to what was typed a
    // moment ago must not overwrite what has been typed since.
    const typing = document.activeElement === this.pathInput && !this.commit;
    if (!typing) {
      this.pathInput.value = dir.path;
      // What is useful is the tail of the path, not the `C:\Users\...` that is
      // the same everywhere — so the box is scrolled to its right end.
      this.pathInput.scrollLeft = this.pathInput.scrollWidth;
    }
    this.commit = false;
    this.typed = false;
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
    this.paintNote();
    // The action that was waiting for this folder, if any.
    const after = this.after;
    this.after = null;
    if (after) after();
  }

  paintNote() {
    const dir = this.dir;
    if (!dir) return;
    const q = this.filter.trim();
    if (q) {
      const n = this.shown().length;
      this.note.textContent = n
        ? `${n} of ${dir.entries.length} folder${dir.entries.length === 1 ? '' : 's'} match “${q}”`
        : `Nothing here matches “${q}”`;
      return;
    }
    this.note.textContent = dir.truncated
      ? `Showing the first ${dir.entries.length} folders — type a path above to jump straight there.`
      : dir.is_project
        ? 'Already in your sidebar — Open here… starts an agent in it.'
        : `${dir.entries.length} folder${dir.entries.length === 1 ? '' : 's'} here`;
  }

  /// An error message from the daemon: keep showing the folder currently open,
  /// do not empty the panel just because one step failed.
  fail(message) {
    // Whatever was waiting for this folder does not happen. Left standing,
    // it would run against the next folder that does answer.
    this.after = null;
    this.commit = false;
    this.note.textContent = message;
    // A path still being typed is expected not to exist yet; that is not
    // worth a red flash on every pause.
    if (!this.typed) {
      this.note.classList.add('bad');
      setTimeout(() => this.note.classList.remove('bad'), 6000);
    }
    this.typed = false;
    // Nothing on screen and the folder asked for is gone — a remembered one
    // since deleted. An error above an empty panel leaves nowhere to click, so
    // home is tried once; that one always exists.
    if (!this.dir && !this.retried) {
      this.retried = true;
      this.on.browse('');
    }
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

  /// The one way the filter changes, so the ✕ and the list can never disagree
  /// with the box.
  setFilter(value) {
    this.filter = value;
    this.filterInput.value = value;
    this.filterClear.hidden = value === '';
    if (this.dir) this.paintList();
    this.paintNote();
  }

  /// The folders to show, best match first.
  ///
  /// The same matcher the sidebar search uses, so a query behaves the same
  /// wherever it is typed. Ordering by score matters more here than there: the
  /// list is what you are aiming at, and the folder you meant should be the one
  /// under the cursor when you press Enter.
  shown() {
    const all = this.dir?.entries || [];
    if (!this.filter.trim()) return all.map((e) => ({ e, pos: [] }));
    return all
      .map((e) => ({ e, m: match(this.filter, e.name) }))
      .filter((r) => r.m)
      .sort((a, b) => b.m.score - a.m.score)
      .map((r) => ({ e: r.e, pos: r.m.positions }));
  }

  paintList() {
    this.list.textContent = '';
    const rows = this.shown();
    if (this.filter.trim() && !rows.length) {
      const none = document.createElement('div');
      none.className = 'pempty';
      none.textContent = `Nothing here matches “${this.filter.trim()}”.`;
      this.list.appendChild(none);
      return;
    }
    if (!this.dir.entries.length) {
      const none = document.createElement('div');
      none.className = 'pempty';
      none.textContent = 'No folders here. Use this one, or create a new folder below.';
      this.list.appendChild(none);
      return;
    }
    for (const { e, pos } of rows) {
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
      // The letters that matched are marked, so a fuzzy hit can be read as one
      // rather than looking like a folder that has no business in the list.
      if (pos.length) label.appendChild(mark(e.name, pos));
      else label.textContent = e.name;
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
    // The click that opens the menu must not reach the document listener that
    // closes any open menu — the ＋ on a sidebar row stops it the same way.
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    // The box first: the menu is built from the folder on screen, and that
    // has to be the folder the box names before it is worth building.
    this.settle(() => this.agentMenu(r));
  }

  agentMenu(r) {
    if (!this.dir) return;
    const agents = this.on.agents();
    if (!agents.length) {
      this.fail('No agents are enabled — turn one on in Settings.');
      return;
    }
    const { path, is_project } = this.dir;
    // The very rows the ＋ on a sidebar project opens, built by the same
    // function. This menu answers the same question — which agent, here — and
    // when it had a list of its own the two drifted apart: the sidebar grew a
    // row per agent with New and Resume side by side while this one still
    // offered `New claude` / `Resume claude…` as separate lines.
    //
    // A folder already in the sidebar brings its history along, so the counts
    // and a working Resume appear here too. One that is not a project yet has
    // none, and every Resume says so rather than pretending.
    this.on.menu(
      r.left,
      r.bottom + 4,
      agentMenuRows({
        agents,
        sessions: this.on.sessionsFor(path),
        live: this.on.liveIn(path),
        where: path.split(/[\\/]/).filter(Boolean).pop() || path,
        closeMenu: () => this.on.closeMenu(),
        openSettings: () => this.on.openSettings('agents'),
        start: (agent, o) => {
          this.note.textContent = `Starting ${agent}…`;
          this.on.openWith(path, agent, is_project, o);
        },
      }),
    );
  }

  remove() {
    if (!this.dir || !this.dir.is_project) return;
    this.note.textContent = 'Removing…';
    this.on.remove(this.dir.path);
  }
}
