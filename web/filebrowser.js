// A file-finder dialog: Places/Storage shortcuts, breadcrumb navigation, a
// sortable Name/Type/Date/Size table, real thumbnails for images.
//
// A separate modal over whatever the Explorer's tree is showing, not another
// mode it switches into (see `filetree.js`'s own tree — a different tool for
// a different job: the tree is for a codebase you're working in, this is for
// finding a file somewhere else on disk — Downloads, Desktop — without
// disturbing the project the tree has open). It rides the same `ClientMsg::
// Tree` request/response the tree itself uses for navigation — no new
// protocol message for that, the daemon already returns files, sizes, and a
// breadcrumb (`crumbs`) alongside what the tree already used. `Shortcuts` is
// the one new request, asked for once.

import { installIcons, iconFor, placeIconFor, driveIconFor, folderIconFor } from './fileicons.js';

const SORT_KEYS = ['name', 'type', 'date', 'size'];

/// The same extensions `files::is_image()` draws as pictures rather than
/// text — kept in sync by hand, there being no shared source of truth
/// between a Rust match arm and a JS array.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico']);

/// How much of a file the preview pane reads as text, and the size past
/// which `/api/file` refuses to serve it at all (its own `MAX_INLINE`).
const PREVIEW_BYTES = 64 * 1024;
const PREVIEW_MAX_FILE = 25 * 1024 * 1024;

export class FileBrowser {
  /// `list(path)` asks for a folder's contents; `shortcuts()` asks for the
  /// Places/Storage entries, once; `open(path, name)` opens a file; `via()`
  /// names the paired machine these files belong to, for the thumbnail URLs
  /// (empty string for this machine); `menu`/`copy` are the same context-menu
  /// plumbing the tree uses.
  constructor(host, { list, shortcuts, open, openProject, menu, copy, via }) {
    this.onList = list;
    this.onShortcuts = shortcuts;
    this.onOpen = open;
    this.onOpenProject = openProject;
    this.onMenu = menu;
    this.onCopy = copy;
    this.getVia = via || (() => '');

    /// The folder actually on screen, and the one most recently asked for —
    /// separate, so a reply for a folder already left behind (a fast double
    /// click into two different folders) is dropped rather than drawn.
    this.path = null;
    this.pending = null;
    this.crumbs = [];
    this.parent = null;
    this.entries = [];
    /// Paths visited, oldest first; `forward` is only ever populated by
    /// stepping back, and is dropped the moment a fresh folder is opened by
    /// clicking into it — the same rule a browser's own history follows.
    this.back = [];
    this.forward = [];

    /// null until the `shortcuts` request actually answers — asked the first
    /// time this dialog is shown, not before, so a page that never opens it
    /// never pays for it. Checked, not a one-shot flag: a request sent to a
    /// daemon too old to answer it (say, mid-rebuild) would otherwise never
    /// be retried even once the daemon comes back able to — the WebSocket
    /// itself reconnects on its own, but nothing here would know to ask
    /// again without reopening the whole page.
    this.places = null;
    this.drives = null;
    /// Whether these files are on a Mac — from the `shortcuts` reply.
    this.mac = false;

    this.sortKey = 'name';
    this.sortAsc = true;
    /// 'list' (default — the detail table, never fetches a thumbnail image),
    /// 'small' or 'thumbnail' (an icon grid, real thumbnails for pictures).
    /// List stays the default so opening this dialog on a folder full of
    /// photos never fetches a single one until asked to.
    this.viewMode = 'list';
    /// Downloads' date grouping (see `grouped`), and which groups are folded
    /// — the old ones start folded: what is looked for there is recent.
    this.groupDownloads = true;
    this.collapsed = new Set(['Last month', 'Earlier this year', 'A long time ago']);

    installIcons();

    this.el = document.createElement('div');
    this.el.id = 'browser';
    this.el.hidden = true;
    this.el.innerHTML =
      '<div class="bbox">' +
      '<div class="shead"><h2>Browse files</h2><button class="close" title="Close">✕</button></div>' +
      '<div class="bsplit">' +
      '<div class="bside"><div class="fscroll"><div class="bshortcuts"></div></div></div>' +
      '<div class="bmain">' +
      '<div class="bhead">' +
      '<button class="bnav bback" title="Back" disabled>‹</button>' +
      '<button class="bnav bfwd" title="Forward" disabled>›</button>' +
      '<button class="bnav bup" title="Up a folder" disabled>⇧</button>' +
      '<div class="bcrumb"></div>' +
      '<button class="bnav bproj" title="Open this folder as a project — New or Resume" disabled>Open here…</button>' +
      '<div class="bviewgroup">' +
      '<button class="bview" data-mode="list" title="List">☰</button>' +
      '<button class="bview" data-mode="small" title="Small icons">▦</button>' +
      '<button class="bview" data-mode="thumbnail" title="Thumbnails">▣</button>' +
      '</div>' +
      '</div>' +
      '<div class="fscroll"><div class="frows"></div></div>' +
      '<div class="fempty" hidden>This folder is empty.</div>' +
      '</div>' +
      '<div class="bprev">' +
      '<div class="bpbody"><div class="bpnote">Select a file to preview it.</div></div>' +
      '<div class="bpinfo" hidden><div class="bpname"></div><div class="bpmeta"></div>' +
      '<div class="bpacts"><button class="secbtn bpcopy">Copy path</button>' +
      '<button class="secbtn bpopen">Open in editor</button></div></div>' +
      '</div>' +
      '</div>' +
      '</div>';
    host.appendChild(this.el);

    this.prevEl = this.el.querySelector('.bprev');
    this.prevBody = this.el.querySelector('.bpbody');
    this.prevInfo = this.el.querySelector('.bpinfo');
    /// The file on preview, and a counter so a slow answer for a file already
    /// clicked away from is dropped instead of drawn over the newer one.
    this.selected = null;
    this.previewSeq = 0;
    this.previewAbort = null;
    this.el.querySelector('.bpcopy').onclick = () => this.selected && this.onCopy?.(this.selected.path);
    this.el.querySelector('.bpopen').onclick = () =>
      this.selected && this.onOpen(this.selected.path, this.selected.name);

    this.crumbEl = this.el.querySelector('.bcrumb');
    this.shortcutsEl = this.el.querySelector('.bshortcuts');
    this.rowsEl = this.el.querySelector('.bmain .frows');
    this.emptyEl = this.el.querySelector('.fempty');
    this.backBtn = this.el.querySelector('.bback');
    this.fwdBtn = this.el.querySelector('.bfwd');
    this.upBtn = this.el.querySelector('.bup');

    this.backBtn.onclick = () => this.goBack();
    this.fwdBtn.onclick = () => this.goForward();
    this.upBtn.onclick = () => {
      if (this.parent) this.navigate(this.parent);
    };
    this.projBtn = this.el.querySelector('.bproj');
    this.projBtn.hidden = !this.onOpenProject;
    this.projBtn.onclick = () => {
      if (!this.path) return;
      const path = this.path;
      this.close();
      this.onOpenProject(path);
    };
    // Empty space around the entries stands for the folder on screen itself.
    const mainScroll = this.el.querySelector('.bmain .fscroll');
    mainScroll.addEventListener('contextmenu', (ev) => {
      if ((ev.target === mainScroll || ev.target === this.rowsEl) && this.path) {
        this.showMenu(ev, this.path, true);
      }
    });
    this.viewBtns = [...this.el.querySelectorAll('.bview')];
    for (const b of this.viewBtns) {
      b.classList.toggle('on', b.dataset.mode === this.viewMode);
      b.onclick = () => {
        if (this.viewMode === b.dataset.mode) return;
        this.viewMode = b.dataset.mode;
        for (const other of this.viewBtns) other.classList.toggle('on', other === b);
        this.paintRows();
      };
    }
    this.el.querySelector('.close').onclick = () => this.close();
    // Same convention every other dialog here uses: a click on the backdrop
    // itself (not something inside `.bbox`) or Escape closes it, and keys
    // typed in here are not an app-wide shortcut.
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      e.stopPropagation();
    });
  }

  get open() {
    return !this.el.hidden;
  }

  show() {
    this.el.hidden = false;
    // Re-asked every time this dialog opens until an answer actually lands —
    // cheap once it has (see `updateShortcuts`), and the one way a daemon
    // that only just gained this feature is retried without needing a full
    // page reload, not just a reconnect.
    if (this.places === null) this.onShortcuts?.();
  }

  close() {
    this.el.hidden = true;
  }

  /// Open a folder fresh — switching into Browser mode, or switching project.
  /// Clears history: this is a new place to start from, not a step within
  /// whatever trail was being followed before.
  open(path) {
    this.back = [];
    this.forward = [];
    this.navigate(path, false);
  }

  /// Move to `path`. `record` is false only for the very first folder shown
  /// (nothing to remember yet) and for a back/forward step (the history
  /// itself is doing the recording).
  navigate(path, record = true) {
    if (record && this.path) {
      this.back.push(this.path);
      this.forward = [];
    }
    this.pending = path;
    this.onList(path);
  }

  goBack() {
    if (!this.back.length) return;
    this.forward.push(this.path);
    this.navigate(this.back.pop(), false);
  }

  goForward() {
    if (!this.forward.length) return;
    this.back.push(this.path);
    this.navigate(this.forward.pop(), false);
  }

  /// A folder opens on one click. A file shows in the preview pane on one
  /// click — the dialog stays, so looking through a folder is click, click,
  /// click — and opens in the editor on two. With no room for the pane (a
  /// phone), one click opens it, as before there was a pane at all.
  bindEntry(node, e) {
    node.dataset.path = e.path;
    if (!e.is_dir && this.selected && samePath(this.selected.path, e.path)) node.classList.add('sel');
    node.onclick = () => {
      if (e.is_dir) this.navigate(e.path);
      else if (getComputedStyle(this.prevEl).display === 'none') this.onOpen(e.path, e.name);
      else this.preview(e);
    };
    if (!e.is_dir) node.ondblclick = () => this.onOpen(e.path, e.name);
  }

  clearPreview() {
    this.previewAbort?.abort();
    this.previewSeq++;
    this.selected = null;
    this.prevInfo.hidden = true;
    this.prevBody.innerHTML = '<div class="bpnote">Select a file to preview it.</div>';
  }

  preview(e) {
    if (this.selected && samePath(this.selected.path, e.path)) return;
    this.previewAbort?.abort();
    const seq = ++this.previewSeq;
    this.selected = e;
    for (const n of this.rowsEl.querySelectorAll('.sel')) n.classList.remove('sel');
    for (const n of this.rowsEl.querySelectorAll('[data-path]')) {
      if (n.dataset.path === e.path) n.classList.add('sel');
    }
    this.prevInfo.hidden = false;
    this.prevInfo.querySelector('.bpname').textContent = e.name;
    this.prevInfo.querySelector('.bpname').title = e.path;
    this.prevInfo.querySelector('.bpmeta').textContent =
      [typeOf(e), humanSize(e.size), humanDate(e.modified_ms)].filter(Boolean).join(' · ');
    this.prevBody.textContent = '';

    const dot = e.name.lastIndexOf('.');
    const ext = dot > 0 ? e.name.slice(dot + 1).toLowerCase() : '';
    if (IMAGE_EXT.has(ext)) {
      const img = document.createElement('img');
      img.className = 'bpimg';
      img.alt = '';
      img.src = this.fileUrl(e.path);
      img.onerror = () => {
        if (seq === this.previewSeq) this.previewNote('This image could not be shown.');
      };
      this.prevBody.appendChild(img);
      return;
    }
    if (e.size > PREVIEW_MAX_FILE) {
      this.previewNote('Too large to preview.');
      return;
    }
    this.previewNote('Loading…');
    this.previewText(e, seq);
  }

  /// The head of a file as text — only the first `PREVIEW_BYTES` are read,
  /// then the download is cancelled, so a large log costs a few dozen KB, not
  /// all of it. A NUL byte in there means it is not text at all.
  async previewText(e, seq) {
    const abort = new AbortController();
    this.previewAbort = abort;
    try {
      const res = await fetch(this.fileUrl(e.path), { signal: abort.signal });
      if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      let more = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (got >= PREVIEW_BYTES) {
          more = true;
          reader.cancel().catch(() => {});
          break;
        }
      }
      if (seq !== this.previewSeq) return;
      const bytes = new Uint8Array(Math.min(got, PREVIEW_BYTES));
      let at = 0;
      for (const c of chunks) {
        const take = Math.min(c.length, bytes.length - at);
        bytes.set(c.subarray(0, take), at);
        at += take;
        if (at === bytes.length) break;
      }
      if (bytes.subarray(0, 8192).includes(0)) {
        this.previewNote('Binary file — no preview.');
        return;
      }
      // `stream: true` holds back a character cut in half at the end, rather
      // than drawing it as a replacement glyph.
      const text = new TextDecoder().decode(bytes, { stream: true });
      this.prevBody.textContent = '';
      if (!text) {
        this.previewNote('Empty file.');
        return;
      }
      const pre = document.createElement('pre');
      pre.className = 'bptext';
      pre.textContent = text;
      this.prevBody.appendChild(pre);
      if (more) {
        const n = document.createElement('div');
        n.className = 'bpnote';
        n.textContent = `First ${humanSize(PREVIEW_BYTES)} shown — open it for the rest.`;
        this.prevBody.appendChild(n);
      }
    } catch (err) {
      if (err.name === 'AbortError' || seq !== this.previewSeq) return;
      this.previewNote(`No preview: ${err.message}`);
    }
  }

  previewNote(text) {
    this.prevBody.textContent = '';
    const n = document.createElement('div');
    n.className = 'bpnote';
    n.textContent = text;
    this.prevBody.appendChild(n);
  }

  /// The daemon's answer for one folder — the same shape the tree gets.
  update(msg) {
    // `Tree` answers the ordinary file tree too — every reply flows through
    // here regardless of who asked, so one with nothing pending is not for
    // this dialog at all, not just a stale one. And not a plain `===` when it
    // is pending: the path handed to `onList` may still have whatever
    // separator style it arrived in (a project's path as stored, say), while
    // the daemon always answers with its own normalised form. Comparing case-
    // and separator-insensitively catches an actually-stale reply (a folder
    // navigated away from before it answered) without rejecting the answer to
    // the very question just asked.
    if (this.pending === null || !samePath(msg.path, this.pending)) return;
    if (!samePath(msg.path, this.path || '')) {
      this.clearPreview();
      this.groupDownloads = true;
    }
    this.path = msg.path;
    this.pending = null;
    this.parent = msg.parent || null;
    this.crumbs = msg.crumbs || [];
    this.entries = msg.entries || [];
    this.paint();
  }

  /// The one-time answer to `shortcuts`.
  updateShortcuts(msg) {
    this.places = msg.places || [];
    this.drives = msg.drives || [];
    // Finder-style icons when the files live on a Mac — the daemon's OS, not
    // the browser's: a Windows laptop can be browsing a paired Mac.
    const mac = msg.os === 'macos';
    this.mac = mac;
    this.paintShortcuts();
    // Also whether this folder is Downloads, which only the Places list says.
    if (this.entries.length) this.paintRows();
  }

  /// A folder gets the finder's own folder (not the tree's flat grey one), a
  /// file its type badge.
  entryIcon(e) {
    return e.is_dir ? useIcon(folderIconFor(this.mac)) : icon(e.name, false);
  }

  paint() {
    this.paintCrumb();
    this.paintRows();
    this.backBtn.disabled = this.back.length === 0;
    this.fwdBtn.disabled = this.forward.length === 0;
    this.upBtn.disabled = !this.parent;
    this.projBtn.disabled = !this.path;
  }

  paintCrumb() {
    this.crumbEl.textContent = '';
    this.crumbs.forEach((c, i) => {
      const last = i === this.crumbs.length - 1;
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'bsep';
        sep.textContent = '›';
        this.crumbEl.appendChild(sep);
      }
      const seg = document.createElement('span');
      seg.className = 'bseg' + (last ? ' on' : '');
      seg.textContent = c.name;
      if (!last) seg.onclick = () => this.navigate(c.path);
      this.crumbEl.appendChild(seg);
    });
  }

  /// The left column — Places/Storage, own scroll, independent of whatever
  /// folder the right side is showing. Painted once the one `shortcuts`
  /// reply lands and never again after, same as the reference Explorer/
  /// Finder sidebars this is modelled on.
  paintShortcuts() {
    this.shortcutsEl.textContent = '';
    // "Places" either way: one label works fine regardless of which OS the
    // daemon happens to be on, and the folder set underneath it already
    // adapts there (`browse::places`/`drives`).
    if (this.places?.length) this.shortcutsEl.appendChild(this.buildSection('Places', this.places));
    if (this.drives?.length) this.shortcutsEl.appendChild(this.buildSection('Storage', this.drives));
  }

  /// The right column — the current folder's own entries, the only thing
  /// that changes as navigation happens; the left column never repaints
  /// alongside it.
  paintRows() {
    this.rowsEl.textContent = '';
    this.rowsEl.className = this.viewMode === 'list' ? 'frows' : `frows bgrid bgrid-${this.viewMode}`;
    this.emptyEl.hidden = this.entries.length > 0;
    const list = this.viewMode === 'list';
    const build = (e) => (list ? this.buildRow(e) : this.buildTile(e));
    if (list && this.entries.length) this.rowsEl.appendChild(this.buildColumnHeader());
    if (this.grouped()) {
      for (const [label, items] of dateGroups(this.entries)) {
        const shut = this.collapsed.has(label);
        this.rowsEl.appendChild(this.buildGroupHeader(label, items.length, shut));
        if (!shut) for (const e of items) this.rowsEl.appendChild(build(e));
      }
    } else {
      for (const e of this.sortedEntries()) this.rowsEl.appendChild(build(e));
    }
    // The Places/Storage row for wherever navigation just landed lights up
    // to match — a plain repaint rather than tracked incrementally, since
    // the whole list is at most a couple dozen rows.
    this.paintShortcutSelection();
  }

  /// Which Places/Storage row (if any) matches the folder now on screen —
  /// kept separate from the (much more frequent) `paintShortcuts()` so
  /// navigating around does not rebuild the sidebar from scratch every time.
  paintShortcutSelection() {
    for (const row of this.shortcutsEl.querySelectorAll('.bshort')) {
      row.classList.toggle('on', samePath(row.dataset.path, this.path || ''));
    }
  }

  buildSection(title, items) {
    const isStorage = title === 'Storage';
    const frag = document.createDocumentFragment();
    const label = document.createElement('div');
    label.className = 'bsectitle';
    label.textContent = title;
    frag.appendChild(label);
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'frow bshort' + (samePath(it.path, this.path || '') ? ' on' : '');
      row.title = it.path;
      row.dataset.path = it.path;
      row.appendChild(useIcon(isStorage ? driveIconFor(this.mac) : placeIconFor(it.name, this.mac)));
      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = it.name;
      row.appendChild(name);
      row.onclick = () => this.navigate(it.path);
      frag.appendChild(row);
    }
    return frag;
  }

  /// Downloads is shown grouped by when things arrived — Today, Yesterday, …
  /// — the way Explorer shows it, since "the thing I just downloaded" is
  /// what that folder is opened for. Recognised by the path of its Places
  /// entry, never by a folder merely named "Downloads". Sorting by any column
  /// turns it off until Downloads is opened again.
  grouped() {
    if (!this.groupDownloads || !this.path) return false;
    const dl = this.places?.find((p) => p.name === 'Downloads');
    return !!dl && samePath(dl.path, this.path);
  }

  buildGroupHeader(label, count, shut) {
    const head = document.createElement('div');
    head.className = 'bgroup' + (shut ? ' shut' : '');
    head.dataset.group = label;
    const twist = document.createElement('span');
    twist.className = 'btwist';
    twist.textContent = shut ? '▸' : '▾';
    const name = document.createElement('span');
    name.textContent = label;
    const n = document.createElement('span');
    n.className = 'bgcount';
    n.textContent = `(${count})`;
    head.append(twist, name, n);
    head.onclick = () => {
      if (this.collapsed.has(label)) this.collapsed.delete(label);
      else this.collapsed.add(label);
      this.paintRows();
    };
    return head;
  }

  buildColumnHeader() {
    const row = document.createElement('div');
    // `.frow` for the row shape (height, flex, gap) — deliberately not
    // `.brow`, which marks an actual entry; the header must never be
    // mistaken for one by anything that walks entry rows looking for a name.
    row.className = 'frow bcols';
    for (const key of SORT_KEYS) {
      const col = document.createElement('span');
      col.className = `bcol bcol-${key}`;
      const label = document.createElement('span');
      label.className = 'blabel';
      label.textContent = COLUMN_LABEL[key];
      col.appendChild(label);
      // Grouped, the order is newest first — shown as such on Date.
      const grouped = this.grouped();
      if (grouped ? key === 'date' : this.sortKey === key) col.appendChild(sortArrow(grouped ? false : this.sortAsc));
      col.onclick = () => {
        if (grouped) {
          this.groupDownloads = false;
          this.sortKey = key;
          this.sortAsc = key !== 'date';
        } else if (this.sortKey === key) this.sortAsc = !this.sortAsc;
        else {
          this.sortKey = key;
          this.sortAsc = true;
        }
        this.paintRows();
      };
      row.appendChild(col);
    }
    return row;
  }

  sortedEntries() {
    const dir = this.sortAsc ? 1 : -1;
    const key = this.sortKey;
    return [...this.entries].sort((a, b) => {
      // Folders stay grouped above files regardless of the column sorted —
      // the same convention the tree and the daemon's own listing already
      // follow; only the order *within* each group changes.
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      if (key === 'size') return (a.size - b.size) * dir;
      if (key === 'date') return (a.modified_ms - b.modified_ms) * dir;
      if (key === 'type') return typeOf(a).localeCompare(typeOf(b)) * dir || a.name.localeCompare(b.name);
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) * dir;
    });
  }

  /// `/api/file` is fetched over HTTP, not the socket the rest of this
  /// dialog rides on, so the paired machine it belongs to is the one thing
  /// that has to be spelled out — same reasoning as the editor's own image
  /// viewer, which fetches this exact route the same way.
  fileUrl(path) {
    const via = this.getVia();
    return `/api/file?path=${encodeURIComponent(path)}${via ? `&via=${encodeURIComponent(via)}` : ''}`;
  }

  buildRow(e) {
    const row = document.createElement('div');
    row.className = 'frow brow';
    row.title = e.path;
    // List mode never fetches a thumbnail — that's the point of it being the
    // default: a folder full of photos costs nothing until Small/Thumbnail
    // is actually picked.
    row.appendChild(this.entryIcon(e));

    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = e.name;
    row.appendChild(name);

    const type = document.createElement('span');
    type.className = 'bcell bcol-type';
    type.textContent = typeOf(e);
    row.appendChild(type);

    const date = document.createElement('span');
    date.className = 'bcell bcol-date';
    date.textContent = e.is_dir ? '' : humanDate(e.modified_ms);
    row.appendChild(date);

    const size = document.createElement('span');
    size.className = 'bcell bcol-size';
    size.textContent = e.is_dir ? '' : humanSize(e.size);
    row.appendChild(size);

    this.bindEntry(row, e);
    row.oncontextmenu = (ev) => this.showMenu(ev, e.path, e.is_dir);
    return row;
  }

  /// Small/Thumbnail mode: an icon grid instead of the detail table — real
  /// pictures get a real thumbnail here (unlike `buildRow`), since browsing
  /// for a photo by sight is the whole point of switching to this mode.
  buildTile(e) {
    const tile = document.createElement('div');
    tile.className = 'btile';
    tile.title = e.path;
    tile.appendChild(this.thumbOrIcon(e));

    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = e.name;
    tile.appendChild(name);

    this.bindEntry(tile, e);
    tile.oncontextmenu = (ev) => this.showMenu(ev, e.path, e.is_dir);
    return tile;
  }

  /// The right-click menu for one entry, or for the folder on screen itself
  /// (a click on empty space). A folder can also become a project: this
  /// closes and hands over to the New project dialog already on that folder,
  /// where New and Resume per agent are offered exactly as everywhere else.
  showMenu(ev, path, isDir) {
    if (!this.onMenu) return;
    ev.preventDefault();
    ev.stopPropagation();
    const items = [{ label: 'Copy path', run: () => this.onCopy?.(path) }];
    if (isDir && this.onOpenProject) {
      items.push({
        label: 'Open as project…',
        run: () => {
          this.close();
          this.onOpenProject(path);
        },
      });
    }
    this.onMenu(ev.clientX, ev.clientY, items);
  }

  /// A real thumbnail for a picture — this dialog exists as much for "which
  /// of these photos was it" as for "which of these files" — the generic
  /// icon everywhere else. `loading="lazy"` is doing the real work: the
  /// browser itself defers the fetch until the row is actually scrolled
  /// near, so a folder of hundreds of photos costs nothing for the ones
  /// never scrolled to, with no `IntersectionObserver` of this dialog's own.
  thumbOrIcon(e) {
    const dot = e.name.lastIndexOf('.');
    const ext = dot > 0 ? e.name.slice(dot + 1).toLowerCase() : '';
    if (e.is_dir || !IMAGE_EXT.has(ext)) return this.entryIcon(e);
    const img = document.createElement('img');
    img.className = 'fico bthumb';
    img.loading = 'lazy';
    img.alt = '';
    img.src = this.fileUrl(e.path);
    // A corrupt or unreadable image must not leave a broken-image glyph
    // sitting in a list meant to make scanning easier, not harder.
    img.onerror = () => img.replaceWith(icon(e.name, false));
    return img;
  }
}

const COLUMN_LABEL = { name: 'Name', type: 'Type', date: 'Date Modified', size: 'Size' };

function sortArrow(asc) {
  const span = document.createElement('span');
  span.className = 'bsortdir';
  span.textContent = asc ? '▲' : '▼';
  return span;
}

function useIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'fico');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

function icon(name, isDir) {
  return useIcon(iconFor(name, isDir));
}

/// Entries grouped by when they were last modified, newest first, as
/// `[label, entries]` for the groups that have any — Explorer's own buckets.
/// Each entry lands in the first group whose start it is not older than, so
/// where two starts overlap (the week began last month) the nearer one wins.
/// `now` is only there for the self-check below.
export function dateGroups(entries, now = new Date()) {
  const day = 86400000;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Weeks start on Monday.
  const week = today - ((now.getDay() + 6) % 7) * day;
  const starts = [
    ['Today', today],
    ['Yesterday', today - day],
    ['Earlier this week', week],
    ['Last week', week - 7 * day],
    ['Earlier this month', new Date(now.getFullYear(), now.getMonth(), 1).getTime()],
    ['Last month', new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime()],
    ['Earlier this year', new Date(now.getFullYear(), 0, 1).getTime()],
  ];
  const groups = new Map([...starts.map(([l]) => [l, []]), ['A long time ago', []]]);
  const sorted = [...entries].sort((a, b) => b.modified_ms - a.modified_ms || a.name.localeCompare(b.name));
  for (const e of sorted) {
    const hit = starts.find(([, t]) => e.modified_ms >= t);
    groups.get(hit ? hit[0] : 'A long time ago').push(e);
  }
  return [...groups].filter(([, items]) => items.length);
}

/// "File folder" for a directory, the bare extension for a file (`.jpg`) —
/// the same shape Explorer's own Type column uses. Reading an extension off
/// a plain file *name* (never a full path) is not the separator-guessing
/// this codebase otherwise avoids; there is only ever one meaning for the
/// text after the last dot in a name.
function typeOf(e) {
  if (e.is_dir) return 'File folder';
  const dot = e.name.lastIndexOf('.');
  return dot > 0 ? e.name.slice(dot).toLowerCase() : '';
}

/// A loose "is this the same folder" check for dropping stale replies —
/// never used to navigate or split a path into pieces, only to compare two
/// full paths the daemon itself produced (or a project path it was handed
/// back unchanged).
function samePath(a, b) {
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

function humanDate(ms) {
  if (!ms) return '';
  // Numeric and short on purpose — this column has little room to spare in
  // a panel this narrow, and a full "Sep 29, 2026" pushes the Name column
  // down to a couple of characters before it even gets to ellipsis.
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'numeric', day: 'numeric' });
}
