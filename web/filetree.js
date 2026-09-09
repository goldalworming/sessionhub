// The file panel on the right: a tree of folders + files.
//
// Two decisions decide its speed:
//
// 1. **Lazy per folder.** A folder's contents are only requested when that
//    folder is opened. No repo-wide index is built up front — in a large repo
//    such an index scans tens of thousands of files just to draw the twenty
//    rows on screen.
//
// 2. **Virtualisation.** Only the rows inside the viewport, plus a little
//    spare, become DOM elements. Opening a `node_modules` with 5,000 entries
//    still produces ~30 elements, not 5,000.

import { installIcons, iconFor } from './fileicons.js';

const ROW = 22; // row height, must match the CSS
const OVERSCAN = 8; // spare rows above and below the window

export class FileTree {
  /// `onList(path)` asks for a folder's contents, `onOpen(path, name)` opens a
  /// file. `root()` returns the **one** project currently open; `projects()` the
  /// list of all of them, and `pick(path)` switches.
  ///
  /// `menu(x, y, items)` shows the app's context menu — the same one the sidebar
  /// and the folder picker use, so one theme covers all three. `make(parent,
  /// name, dir)` creates something, and `shell(path)` opens a terminal in a
  /// folder. Both are optional: without them the panel is exactly what it was.
  constructor(host, { list, open, root, projects, pick, menu, make, shell, up, copy }) {
    this.onList = list;
    this.onOpen = open;
    this.getRoot = root;
    this.getProjects = projects;
    this.onPick = pick;
    this.onMenu = menu;
    this.onMake = make;
    this.onShell = shell;
    /// `up(path, name)` moves the whole tree to the folder above. Optional: a
    /// daemon too old to say what that folder is gets no `..` row at all.
    this.onUp = up;
    /// `copy(path)` puts one path on the clipboard, ready to paste.
    this.onCopy = copy;
    /// Whether the daemon that answered the last listing understands
    /// `make_entry`. An older one does not, and then nothing is offered rather
    /// than a menu entry that would go unanswered. Absent means no.
    this.canMake = false;
    /// The folder a creation was asked for, so the answer knows where to look.
    this.pendingParent = null;

    /// folder path -> { entries, loading, truncated }
    this.dirs = new Map();
    /// folder paths currently expanded
    this.expanded = new Set();
    /// The tree flattened into a list of rows. Recomputed only when the
    /// structure changes, not on every scroll.
    this.rows = [];
    this.selected = null;
    this.filter = '';

    installIcons();

    this.el = document.createElement('div');
    this.el.id = 'files';
    this.el.hidden = true;
    // Refresh and close belong to the panel's tab bar; the EXPLORER title and
    // the project picker belong to this view itself.
    this.el.innerHTML =
      '<div class="fhead"><span class="ftitle">Explorer</span>' +
      '<button class="frefresh" title="Refresh">⟳</button>' +
      '<button class="fpick" title="Show a different project">▾</button></div>' +
      '<input class="ffilter" type="text" spellcheck="false" placeholder="Filter open folders…" />' +
      '<div class="fscroll"><div class="fspacer"></div><div class="frows"></div></div>' +
      '<div class="fempty">Open a project to see its files.</div>' +
      '<div class="fmenu" hidden></div>';
    host.appendChild(this.el);

    this.menuEl = this.el.querySelector('.fmenu');
    this.el.querySelector('.frefresh').onclick = () => this.refresh();
    this.el.querySelector('.fpick').onclick = (e) => {
      e.stopPropagation();
      this.togglePicker();
    };
    document.addEventListener('mousedown', (e) => {
      if (!this.menuEl.hidden && !this.menuEl.contains(e.target)) this.menuEl.hidden = true;
    });

    this.scroll = this.el.querySelector('.fscroll');
    this.spacer = this.el.querySelector('.fspacer');
    this.rowsEl = this.el.querySelector('.frows');
    this.emptyEl = this.el.querySelector('.fempty');
    this.filterEl = this.el.querySelector('.ffilter');

    this.filterEl.oninput = () => {
      this.filter = this.filterEl.value.trim().toLowerCase();
      this.rebuild();
    };
    this.filterEl.onkeydown = (e) => {
      if (e.key === 'Escape') {
        this.filterEl.value = '';
        this.filter = '';
        this.rebuild();
      }
      e.stopPropagation();
    };
    // Scrolling only redraws the window; the structure is not recomputed.
    this.scroll.addEventListener('scroll', () => this.paint(), { passive: true });
    // Below the last row there is still a folder to talk about — the project
    // root — so the empty space answers too rather than falling through to the
    // browser's own menu.
    this.scroll.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.frow')) return;
      this.showMenu(e, null);
    });
  }

  get open() {
    return !this.el.hidden;
  }

  show() {
    this.el.hidden = false;
    if (!this.rows.length) this.rebuild();
    this.paint();
  }

  hide() {
    this.el.hidden = true;
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  /// Called when the project list or the active project changes.
  syncRoots() {
    if (this.open) this.rebuild();
  }

  /// The project list, for switching by hand. Usually unnecessary: the explorer
  /// follows the active terminal on its own.
  togglePicker() {
    if (!this.menuEl.hidden) {
      this.menuEl.hidden = true;
      return;
    }
    const list = this.getProjects();
    this.menuEl.textContent = '';
    if (!list.length) {
      const none = document.createElement('div');
      none.className = 'fmitem off';
      none.textContent = 'No projects yet.';
      this.menuEl.appendChild(none);
    }
    const now = this.getRoot()?.path;
    for (const p of list) {
      const item = document.createElement('div');
      item.className = 'fmitem' + (p.path === now ? ' on' : '');
      item.textContent = p.name;
      item.title = p.path;
      item.onclick = () => {
        this.menuEl.hidden = true;
        this.onPick(p.path);
      };
      this.menuEl.appendChild(item);
    }
    this.menuEl.hidden = false;
  }

  /// Throw away everything cached and re-request what is currently open.
  refresh() {
    this.dirs.clear();
    for (const path of this.expanded) this.request(path);
    this.rebuild();
  }

  request(path) {
    const state = this.dirs.get(path);
    if (state?.loading) return;
    this.dirs.set(path, { entries: state?.entries || [], loading: true, truncated: false });
    this.onList(path);
  }

  /// The daemon's answer for one folder.
  update(msg) {
    this.canMake = msg.can_make === true;
    this.dirs.set(msg.path, {
      entries: msg.entries || [],
      loading: false,
      truncated: !!msg.truncated,
      // Both come from the machine that owns the disk, and are used exactly as
      // they arrive. A path this side assembled would be built with the
      // browser's idea of a separator, against a daemon that may not share it.
      parent: msg.parent || null,
      name: msg.name || '',
    });
    this.rebuild();
  }

  /// Something was created. The folder is asked for again rather than the new
  /// entry being spliced into the cached list by hand — the daemon's listing is
  /// the truth, and it also sorts.
  made(msg) {
    this.dirs.delete(msg.parent);
    this.expanded.add(msg.parent);
    this.request(msg.parent);
    if (msg.is_dir) {
      // A folder you just made is a folder you are about to put something in.
      this.expanded.add(msg.path);
      this.request(msg.path);
      this.selected = msg.path;
    } else {
      // A new file opens: creating one and then having to find it in the tree
      // to click it is a step that serves nothing.
      this.selected = msg.path;
      this.onOpen(msg.path, msg.path.split(/[\\/]/).pop());
    }
    this.rebuild();
  }

  /// The folder a row's actions belong to: the folder itself, or the folder a
  /// file sits in. Right-clicking `main.rs` and choosing "New file" means
  /// beside `main.rs`, which is the only reading that is ever wanted.
  folderOf(r) {
    if (!r) return this.getRoot()?.path || null;
    if (r.isDir) return r.path;
    const cut = Math.max(r.path.lastIndexOf('/'), r.path.lastIndexOf('\\'));
    return cut > 0 ? r.path.slice(0, cut) : this.getRoot()?.path || null;
  }

  /// Right-click, on a row or on the empty space below the last one.
  showMenu(e, r) {
    if (!this.onMenu) return;
    const folder = this.folderOf(r);
    if (!folder) return;
    // The browser's own menu on a file row offers nothing useful here, and the
    // one thing it does offer — "Reload" — is worse than what replaces it.
    e.preventDefault();
    e.stopPropagation();
    const name = folder.split(/[\\/]/).filter(Boolean).pop() || folder;

    const items = [];
    // The row's own path, and the row's own action — so it leads, above the
    // things that are made *in* a folder. Right-clicking a file means that
    // file; the `..` row means the folder it leads to; a `Loading…` row names
    // nothing, so it falls back to the folder it sits in.
    if (this.onCopy) {
      const target = r && r.path && !r.note ? r.path : folder;
      items.push({
        label: 'Copy path',
        hint: r && r.isDir === false ? 'file' : 'folder',
        run: () => this.onCopy(target),
      });
      items.push({ sep: true });
    }
    if (this.canMake && this.onMake) {
      items.push({ label: 'New file…', hint: name, run: () => this.askName(folder, false) });
      items.push({ label: 'New folder…', hint: name, run: () => this.askName(folder, true) });
    }
    if (this.onShell) {
      if (items.length) items.push({ sep: true });
      items.push({
        label: 'New terminal here',
        hint: 'shell',
        run: () => this.onShell(folder),
      });
    }
    if (!items.length) return;
    this.onMenu(e.clientX, e.clientY, items);
  }

  async askName(folder, dir) {
    const name = await this.onMake.ask(dir, folder);
    if (!name || !name.trim()) return;
    this.pendingParent = folder;
    this.onMake.send(folder, name.trim(), dir);
  }

  /// A folder failed to open: mark it so its row does not hang on "…".
  fail(path) {
    const state = this.dirs.get(path);
    if (state) this.dirs.set(path, { ...state, loading: false, failed: true });
    this.rebuild();
  }

  toggleDir(path) {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
    } else {
      this.expanded.add(path);
      if (!this.dirs.has(path)) this.request(path);
    }
    this.rebuild();
  }

  /// Open the tree down to a path, then highlight its row.
  reveal(path) {
    this.selected = path;
    this.rebuild();
    const i = this.rows.findIndex((r) => r.path === path);
    if (i >= 0) {
      const top = i * ROW;
      const view = this.scroll.clientHeight;
      if (top < this.scroll.scrollTop || top > this.scroll.scrollTop + view - ROW) {
        this.scroll.scrollTop = Math.max(0, top - view / 2);
      }
    }
  }

  // ------------------------------------------------------------ flattening

  /// Flatten the currently open tree into one array of rows. Only expanded
  /// folders are walked, so the cost is proportional to what is visible — not
  /// to the size of the repo.
  rebuild() {
    const rows = [];
    // One project only. When you are working inside a project, the contents of
    // other projects only lengthen the list without ever being opened.
    const root = this.getRoot();
    if (root) {
      // The root starts expanded: making the user open one level just to see
      // inside the project they are already working in is a step that serves
      // nothing.
      if (!this.dirs.has(root.path) && !this.expanded.has(root.path)) {
        this.expanded.add(root.path);
        this.request(root.path);
      }
      // `..` stands above the root, and only when the folder above is known.
      // The listing is what knows it, so the row appears a moment after the
      // tree does — which is also when there is anywhere to go.
      const here = this.dirs.get(root.path);
      if (this.onUp && here && here.parent) {
        rows.push({ path: here.parent, name: '..', isDir: true, depth: 0, up: true });
      }
      // A folder walked to is named by its listing; a project carries the name
      // the sidebar gives it, which is the one you recognise.
      const name = root.name || here?.name || root.path;
      rows.push({ path: root.path, name, isDir: true, depth: 0, root: true });
      if (this.expanded.has(root.path)) this.walk(root.path, 1, rows);
    }
    this.rows = rows;
    this.emptyEl.hidden = rows.length > 0;
    this.emptyEl.textContent = this.getProjects().length
      ? 'Open a terminal in a project, or pick one with ▾ above.'
      : 'No projects yet. Add one with ＋ in the sidebar.';
    this.spacer.style.height = `${rows.length * ROW}px`;
    this.paint();
  }

  walk(path, depth, rows) {
    const state = this.dirs.get(path);
    if (!state || state.loading) {
      rows.push({ path: `${path}\0loading`, name: 'Loading…', depth, note: true });
      return;
    }
    if (state.failed) {
      rows.push({ path: `${path}\0failed`, name: 'Could not read this folder', depth, note: true });
      return;
    }
    const q = this.filter;
    for (const e of state.entries) {
      // The filter applies to files only: hiding folders would cut the path to
      // the matching files inside them.
      if (q && !e.is_dir && !e.name.toLowerCase().includes(q)) continue;
      rows.push({ path: e.path, name: e.name, isDir: e.is_dir, size: e.size, depth });
      if (e.is_dir && this.expanded.has(e.path)) this.walk(e.path, depth + 1, rows);
    }
    if (state.truncated) {
      rows.push({
        path: `${path}\0more`,
        name: 'Too many entries — only the first 5000 are shown',
        depth,
        note: true,
      });
    }
  }

  // --------------------------------------------------------------- drawing

  /// Draw only the visible window. Row elements are reused, so scrolling fast
  /// does not tear the DOM apart and rebuild it over and over.
  paint() {
    if (this.el.hidden) return;
    const total = this.rows.length;
    const view = this.scroll.clientHeight || 400;
    const first = Math.max(0, Math.floor(this.scroll.scrollTop / ROW) - OVERSCAN);
    const count = Math.min(total - first, Math.ceil(view / ROW) + OVERSCAN * 2);

    this.rowsEl.style.transform = `translateY(${first * ROW}px)`;
    const kids = this.rowsEl.children;
    while (kids.length > Math.max(0, count)) this.rowsEl.lastChild.remove();
    while (kids.length < count) this.rowsEl.appendChild(blankRow());

    for (let i = 0; i < count; i++) {
      fillRow(kids[i], this.rows[first + i], this);
    }
  }
}

function blankRow() {
  const row = document.createElement('div');
  row.className = 'frow';
  row.innerHTML =
    '<span class="ftwist"></span>' +
    '<svg class="fico"><use href=""></use></svg>' +
    '<span class="fname"></span>';
  return row;
}

function fillRow(el, r, tree) {
  if (!r) return;
  const twist = el.children[0];
  const svg = el.children[1];
  const use = svg.firstChild;
  const name = el.children[2];

  el.style.paddingLeft = `${6 + r.depth * 12}px`;
  name.textContent = r.name;

  if (r.note) {
    el.className = 'frow note';
    twist.textContent = '';
    svg.style.display = 'none';
    el.onclick = null;
    // `Loading…` names no file, so the menu belongs to the folder it sits in —
    // reached through the row's own path, which is `<folder> loading`.
    el.oncontextmenu = (e) => tree.showMenu(e, null);
    el.title = '';
    return;
  }

  if (r.up) {
    el.className = 'frow up';
    twist.textContent = '';
    svg.style.display = '';
    const icon = iconFor('', true, false);
    if (use.getAttribute('href') !== `#${icon}`) use.setAttribute('href', `#${icon}`);
    el.title = r.path;
    el.onclick = () => tree.onUp(r.path, '');
    // The folder this row leads to is the one its menu belongs to — "New file"
    // on `..` can only sensibly mean up there.
    el.oncontextmenu = (e) => tree.showMenu(e, { path: r.path, isDir: true });
    return;
  }

  const open = r.isDir && tree.expanded.has(r.path);
  el.className = 'frow' + (tree.selected === r.path ? ' on' : '') + (r.root ? ' root' : '');
  twist.textContent = r.isDir ? (open ? '▾' : '▸') : '';
  svg.style.display = '';
  const icon = iconFor(r.name, r.isDir, open);
  // Rewriting the same href forces a pointless redraw.
  if (use.getAttribute('href') !== `#${icon}`) use.setAttribute('href', `#${icon}`);
  el.title = r.path;

  el.onclick = () => {
    if (r.isDir) tree.toggleDir(r.path);
    else {
      tree.selected = r.path;
      tree.paint();
      tree.onOpen(r.path, r.name);
    }
  };
  el.oncontextmenu = (e) => tree.showMenu(e, r);
}
