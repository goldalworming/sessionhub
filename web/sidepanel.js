// The right panel: the Explorer column on the left, the editor beside it.
//
// The Explorer is not a tab — it is a fixed column that stays visible, like the
// file panel in any code editor. The tab bar next to it only holds open files,
// so the tree and a file never hide each other.

import { FileTree } from './filetree.js';
import { Editor } from './editor.js';
import { iconFor } from './fileicons.js';

const LS_WIDTH = 'sh.explorer.width';
/// One entry per (machine, project). The key carries both, so the same path on
/// two machines is two different sets of tabs.
const LS_FILES = 'sh.files.';
/// More than anyone keeps open, and a ceiling so a browser left running for
/// weeks cannot grow one of these without end.
const MAX_REMEMBERED = 20;
const MIN = 120;
/// Below this the code column is too narrow to read, and the Explorer is better
/// out of the way. The number is roughly 80 columns at the default font size.
const CODE_MIN = 420;

export class SidePanel {
  /// `on.list/open/save/root/projects/pick` are passed on to the tree and the
  /// editor; `on.layout()` is called whenever the content width changes, so
  /// xterm and Monaco recompute with it.
  constructor(host, on) {
    this.on = on;
    /// [{ path, name }] — in the order they were opened, within the scope
    /// currently showing.
    this.files = [];
    /// The path of the file currently shown, or null when there is none.
    this.active = null;
    /// Which (machine, project) the two above belong to, and what every other
    /// scope was holding when it was last on screen. The Explorer has always
    /// followed the project — it never stores a root, it asks for one — and
    /// this is the same idea for the tabs beside it.
    this.scope = null;
    this.byScope = new Map();
    /// The file asked for and not yet arrived: `{ scope, path, restoring }`.
    ///
    /// The scope is stamped on the request because a reply can outlive the
    /// question. Switch projects while a file is on its way and it would
    /// otherwise open a tab in whichever project you had moved to.
    this.pending = null;

    this.el = host;
    this.el.innerHTML =
      '<div class="pcols">' +
      '<div class="pexp"></div>' +
      '<div class="psplit" role="separator" aria-orientation="vertical" title="Drag to resize"></div>' +
      '<div class="pmain">' +
      '<div class="ptabs"><div class="ptabstrip"></div>' +
      '<button class="pclose" title="Close panel">✕</button></div>' +
      '<div class="pbody"></div>' +
      '<div class="pnone">Pick a file on the left.</div>' +
      '</div></div>';

    this.exp = this.el.querySelector('.pexp');

    // The strip for reopening an Explorer that folded itself away. Invisible
    // until `.pexp` gets the `folded` class.
    this.foldStrip = document.createElement('div');
    this.foldStrip.className = 'foldstrip';
    this.foldStrip.textContent = 'EXPLORER';
    this.foldStrip.title = 'Show the explorer again';
    this.foldStrip.onclick = () => this.unfold();
    this.exp.appendChild(this.foldStrip);
    this.strip = this.el.querySelector('.ptabstrip');
    this.body = this.el.querySelector('.pbody');
    this.noneEl = this.el.querySelector('.pnone');

    this.el.querySelector('.pclose').onclick = () => on.close();

    this.tree = new FileTree(this.exp, {
      list: on.list,
      // Through the panel rather than straight out, so every request carries the
      // scope it was made in.
      open: (path) => this.ask(path),
      root: on.root,
      projects: on.projects,
      pick: on.pick,
    });
    this.editor = new Editor(this.body, {
      save: on.save,
      theme: on.theme,
      dirty: () => this.paintChrome(),
      projectRoot: on.root,
      via: on.via,
    });
    this.tree.show();

    const saved = Number(localStorage.getItem(LS_WIDTH));
    if (saved >= MIN) this.exp.style.width = `${saved}px`;
    this.el.querySelector('.psplit').addEventListener('mousedown', (e) => this.drag(e));

    this.paint();
  }

  /// The Explorer retreats to a strip; the code column takes the rest.
  fold() {
    if (this.exp.classList.contains('folded')) return;
    this.exp.classList.add('folded');
    this.editor.relayout();
    this.on.layout?.();
  }

  unfold() {
    if (!this.exp.classList.contains('folded')) return;
    this.exp.classList.remove('folded');
    this.editor.relayout();
    this.tree.paint();
    this.on.layout?.();
  }

  /// Drag the boundary between the Explorer and the editor. Its upper bound is
  /// computed from the panel width rather than fixed: a narrow panel must not be
  /// draggable until the editor disappears entirely.
  drag(e) {
    // Dragging the boundary is a clear request to see the Explorer again;
    // keeping it folded would make the handle feel broken.
    this.unfold();
    e.preventDefault();
    const left = this.exp.getBoundingClientRect().left;
    const move = (ev) => {
      const max = Math.max(MIN, this.el.clientWidth - 160);
      const w = Math.min(max, Math.max(MIN, ev.clientX - left));
      this.exp.style.width = `${w}px`;
      localStorage.setItem(LS_WIDTH, String(w));
      this.editor.relayout();
      this.tree.paint();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  /// Move to another (machine, project). What was open stays open — behind the
  /// scenes, models and all — the way a terminal's xterm stays alive when its
  /// machine is not the one showing.
  setScope(key) {
    if (key === this.scope) return;
    if (this.scope) {
      this.byScope.set(this.scope, { files: this.files, active: this.active });
    }
    this.scope = key;
    this.editor.setScope(key || '');
    this.pending = null;

    const seen = key ? this.byScope.get(key) : null;
    const kept = seen || (key ? this.remembered(key) : null);
    this.files = kept ? kept.files : [];
    this.active = kept ? kept.active : null;

    if (this.active) {
      // A scope read back from storage has tabs but no contents. Only the one
      // being shown is fetched; the rest wait until they are chosen, which is
      // the difference between one round trip on arrival and twenty.
      //
      // And nothing at all while the panel is shut. Fetching a file loads
      // Monaco, and those 4.9 MB are meant to stay unrequested for anyone who
      // only came here for terminals. `wake` picks this up when it opens.
      if (this.editor.has(this.active)) this.editor.select(this.active);
      else if (!this.el.hidden) this.ask(this.active, true);
    } else {
      this.editor.clear();
    }
    this.paint();
  }

  /// The panel has been opened. If it is showing a tab whose contents were
  /// deferred, now is when they are worth asking for.
  wake() {
    if (this.active && !this.editor.has(this.active) && !this.pending) {
      this.ask(this.active, true);
    }
  }

  /// What was open in this scope the last time the page was here.
  remembered(key) {
    try {
      const v = JSON.parse(localStorage.getItem(LS_FILES + key) || 'null');
      if (!v || !Array.isArray(v.files)) return null;
      const files = v.files
        .filter((f) => f && typeof f.path === 'string' && typeof f.name === 'string')
        .slice(0, MAX_REMEMBERED);
      if (!files.length) return null;
      const active = files.some((f) => f.path === v.active) ? v.active : files[0].path;
      return { files, active };
    } catch {
      return null;
    }
  }

  remember() {
    if (!this.scope) return;
    const files = this.files.slice(-MAX_REMEMBERED);
    if (!files.length) localStorage.removeItem(LS_FILES + this.scope);
    else localStorage.setItem(LS_FILES + this.scope, JSON.stringify({ files, active: this.active }));
  }

  /// Ask the daemon for a file. `restoring` means the tab is already in the
  /// strip — it was read back from storage or clicked — so the extras that
  /// belong to opening something new are skipped.
  ask(path, restoring = false) {
    this.pending = { scope: this.scope, path, restoring };
    this.on.open(path);
  }

  /// The daemon could not open what was asked for. A tab pointing at a file
  /// that is gone is worse than no tab: it cannot be made to work by clicking.
  openFailed() {
    const p = this.pending;
    this.pending = null;
    if (p && p.scope === this.scope) this.closeFile(p.path);
  }

  /// A file arrives from the daemon: open its tab if it has none, then show it.
  async openFile(file) {
    // A file that arrives because a restored tab was chosen already has its
    // place in the strip, and the tree was never asked to go looking for it.
    const p = this.pending;
    this.pending = null;
    // The answer to a question asked in another project. Its tab is still over
    // there, without contents, and will ask again when it is next chosen.
    if (p && p.scope !== this.scope) return;
    const restoring = p ? p.restoring : false;
    if (!this.files.some((f) => f.path === file.path)) {
      this.files.push({ path: file.path, name: file.name });
    }
    this.active = file.path;
    await this.editor.load(file);
    if (!restoring) this.tree.reveal(file.path);
    // Fold only when the code really would be cramped. A panel that is already
    // wide does not have that problem, and folding there only hides the tree
    // for nothing.
    if (!restoring && this.el.clientWidth - this.exp.offsetWidth < CODE_MIN) {
      this.fold();
    }
    this.paint();
    this.remember();
  }

  select(path) {
    if (this.active === path) return;
    this.active = path;
    // A tab restored from storage has no contents yet; asking for them brings
    // it back through `openFile`, which shows it.
    if (this.editor.has(path)) this.editor.select(path);
    else this.ask(path, true);
    this.paint();
    this.remember();
  }

  closeFile(path) {
    const i = this.files.findIndex((f) => f.path === path);
    if (i < 0) return;
    this.files.splice(i, 1);
    this.editor.drop(path);
    if (this.active === path) {
      // Move to the neighbouring tab; when none are left, the editor is empty again.
      const next = this.files[i] || this.files[i - 1];
      this.active = next ? next.path : null;
      if (next) {
        if (this.editor.has(next.path)) this.editor.select(next.path);
        else this.ask(next.path, true);
      } else {
        this.editor.clear();
      }
    }
    this.paint();
    this.remember();
  }

  paint() {
    const empty = this.active === null;
    this.editor.el.hidden = empty;
    this.noneEl.hidden = !empty;
    this.tree.paint();
    if (!empty) this.editor.relayout();
    this.paintChrome();
    this.on.layout();
  }

  /// The tab bar and its colours. Also called when the editor theme or the saved
  /// state changes, without redrawing the contents.
  paintChrome() {
    // The tab bar joins its contents: a light tab above a dark editor looks like
    // two applications taped together.
    this.el.classList.toggle(
      'darkedit',
      this.active !== null && this.editor.resolvedTheme() === 'vs-dark',
    );
    this.paintTabs();
  }

  paintTabs() {
    this.strip.textContent = '';
    for (const f of this.files) {
      this.strip.appendChild(this.tab(f.path, f.name));
    }
    // The active tab is brought into view; opening a tenth file must not hide
    // its own tab off screen. Computed here because `scrollIntoView` often
    // stops before the tab is whole.
    const on = this.strip.querySelector('.ptab.on');
    if (on) {
      const s = this.strip.getBoundingClientRect();
      const r = on.getBoundingClientRect();
      if (r.right > s.right) this.strip.scrollLeft += r.right - s.right;
      else if (r.left < s.left) this.strip.scrollLeft -= s.left - r.left;
    }
  }

  tab(path, label) {
    const el = document.createElement('div');
    el.className = 'ptab' + (this.active === path ? ' on' : '');
    el.title = path;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fico');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${iconFor(label, false)}`);
    svg.appendChild(use);
    el.appendChild(svg);

    const name = document.createElement('span');
    name.className = 'ptname' + (this.editor.isDirty(path) ? ' dirty' : '');
    name.textContent = label;
    el.appendChild(name);

    const x = document.createElement('button');
    x.className = 'ptx';
    x.textContent = '✕';
    x.title = 'Close this file';
    x.onclick = (e) => {
      e.stopPropagation();
      this.closeFile(path);
    };
    el.appendChild(x);

    el.onclick = () => this.select(path);
    return el;
  }

  /// Called when the project list changes.
  syncRoots() {
    this.tree.syncRoots();
  }

  get hasUnsaved() {
    return this.editor.hasUnsaved;
  }
}
