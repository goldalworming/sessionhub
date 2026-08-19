// The right panel: the Explorer column on the left, the editor beside it.
//
// The Explorer is not a tab — it is a fixed column that stays visible, like the
// file panel in any code editor. The tab bar next to it only holds open files,
// so the tree and a file never hide each other.

import { FileTree } from './filetree.js';
import { Editor } from './editor.js';
import { iconFor } from './fileicons.js';

const LS_WIDTH = 'sh.explorer.width';
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
    /// [{ path, name }] — in the order they were opened.
    this.files = [];
    /// The path of the file currently shown, or null when there is none.
    this.active = null;

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
      open: on.open,
      root: on.root,
      projects: on.projects,
      pick: on.pick,
    });
    this.editor = new Editor(this.body, {
      save: on.save,
      theme: on.theme,
      dirty: () => this.paintChrome(),
      projectRoot: on.root,
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

  /// A file arrives from the daemon: open its tab if it has none, then show it.
  async openFile(file) {
    if (!this.files.some((f) => f.path === file.path)) {
      this.files.push({ path: file.path, name: file.name });
    }
    this.active = file.path;
    await this.editor.load(file);
    this.tree.reveal(file.path);
    // Fold only when the code really would be cramped. A panel that is already
    // wide does not have that problem, and folding there only hides the tree
    // for nothing.
    if (this.el.clientWidth - this.exp.offsetWidth < CODE_MIN) {
      this.fold();
    }
    this.paint();
  }

  select(path) {
    if (this.active === path) return;
    this.active = path;
    this.editor.select(path);
    this.paint();
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
      if (next) this.editor.select(next.path);
    }
    this.paint();
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
