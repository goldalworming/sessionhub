// Monaco, loaded lazily.
//
// Its loader is only injected when the first file is opened. As long as you
// only use terminals — which is the whole reason this app exists — those 4.9 MB
// are never requested at all.
//
// Only `editor` + `basic-languages` are vendored, not `language/`. Which means:
// full syntax highlighting, without the 7 MB TypeScript/HTML/CSS language
// service workers that spin up background processes of their own.

import { languageFor } from './fileicons.js';

const LS_THEME = 'sh.editor.theme';
/// Dark by default, kept apart from the app theme: code is read for long
/// stretches, and that is a different preference from the rest of the interface.
const THEMES = ['dark', 'light', 'auto'];

let loading = null;

function loadMonaco() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/monaco/vs/loader.js';
    s.onload = () => {
      // Without this Monaco spins up web workers for language services that
      // were deliberately left out, and the console fills with 404s.
      window.MonacoEnvironment = { getWorker: () => null };
      window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };
    s.onerror = () => reject(new Error('could not load the editor'));
    document.head.appendChild(s);
  });
  return loading;
}

export class Editor {
  /// `onSave(path, text)` saves a file. `appTheme()` returns the app theme, used
  /// when the editor mode is "auto". `onDirty()` is called when the saved/dirty
  /// state changes, so the tab bar can mark it.
  constructor(root, { save, theme, dirty, projectRoot }) {
    this.onSave = save;
    this.appTheme = theme;
    this.onDirty = dirty;
    this.projectRoot = projectRoot;
    this.monaco = null;
    this.editor = null;
    /// path -> model. Switching tabs restores each file's cursor position and
    /// undo history.
    this.models = new Map();
    /// path -> { name, size, truncated, binary }
    this.meta = new Map();
    this.current = null;
    this.dirty = new Set();
    this.mode = THEMES.includes(localStorage.getItem(LS_THEME))
      ? localStorage.getItem(LS_THEME)
      : 'dark';

    this.el = document.createElement('div');
    this.el.id = 'editor';
    this.el.hidden = true;
    this.el.innerHTML =
      '<div class="ehead">' +
      '<span class="ecrumb"></span>' +
      '<span class="enote"></span>' +
      '<button class="etheme"></button>' +
      '<button class="esave" title="Save (Ctrl+S)">Save</button>' +
      '</div>' +
      '<div class="ebody"></div>' +
      '<div class="eimg"><img alt="" /></div>' +
      '<div class="eplace">Loading the editor…</div>';
    root.appendChild(this.el);

    this.noteEl = this.el.querySelector('.enote');
    this.crumbEl = this.el.querySelector('.ecrumb');
    this.saveBtn = this.el.querySelector('.esave');
    this.themeBtn = this.el.querySelector('.etheme');
    this.bodyEl = this.el.querySelector('.ebody');
    this.imgWrap = this.el.querySelector('.eimg');
    this.imgEl = this.imgWrap.querySelector('img');
    this.placeEl = this.el.querySelector('.eplace');

    // The real dimensions are only known once the image has loaded; that is the
    // detail most often wanted when opening an asset.
    this.imgEl.onload = () => {
      const meta = this.meta.get(this.current);
      if (meta) {
        meta.dims = `${this.imgEl.naturalWidth}×${this.imgEl.naturalHeight}`;
        this.paintHead();
      }
    };
    this.imgEl.onerror = () => {
      this.imgWrap.hidden = true;
      this.placeEl.hidden = false;
      this.placeEl.textContent = 'That image could not be loaded.';
    };

    this.saveBtn.onclick = () => this.save();
    this.themeBtn.onclick = () => {
      this.mode = THEMES[(THEMES.indexOf(this.mode) + 1) % THEMES.length];
      localStorage.setItem(LS_THEME, this.mode);
      this.applyTheme();
    };
    this.paintTheme();
  }

  get open() {
    return !this.el.hidden;
  }

  isDirty(path) {
    return this.dirty.has(path);
  }

  get hasUnsaved() {
    return this.dirty.size > 0;
  }

  /// A new file from the daemon.
  async load(file) {
    this.meta.set(file.path, {
      name: file.name,
      size: file.size,
      truncated: file.truncated,
      binary: file.binary,
      image: file.image,
    });
    this.current = file.path;
    this.el.hidden = false;
    this.paintHead();

    if (file.image) {
      this.showImage(file.path);
      return;
    }
    if (file.binary) {
      this.hideAll();
      this.placeEl.hidden = false;
      this.placeEl.textContent = `${file.name} is a binary file (${kb(file.size)}).`;
      return;
    }
    this.imgWrap.hidden = true;
    this.bodyEl.hidden = false;
    this.placeEl.hidden = false;
    this.placeEl.textContent = 'Loading the editor…';

    let monaco;
    try {
      monaco = await loadMonaco();
    } catch {
      this.placeEl.textContent = 'The editor could not be loaded.';
      return;
    }
    this.placeEl.hidden = true;
    this.monaco = monaco;
    this.ensureEditor(monaco);

    let model = this.models.get(file.path);
    if (!model || model.isDisposed()) {
      model = monaco.editor.createModel(file.text, languageFor(file.name));
      model.onDidChangeContent(() => {
        if (!this.dirty.has(file.path)) {
          this.dirty.add(file.path);
          this.onDirty();
        }
        if (this.current === file.path) this.paintHead();
      });
      this.models.set(file.path, model);
    } else if (model.getValue() !== file.text && !this.dirty.has(file.path)) {
      // The file changed on disk while our copy was still unedited.
      model.setValue(file.text);
    }
    this.attach(file.path);
  }

  /// Switch to a file whose model already exists.
  select(path) {
    this.current = path;
    this.el.hidden = false;
    const meta = this.meta.get(path);
    this.paintHead();
    if (meta?.image) {
      this.showImage(path);
      return;
    }
    if (meta?.binary) {
      this.hideAll();
      this.placeEl.hidden = false;
      this.placeEl.textContent = `${meta.name} is a binary file (${kb(meta.size)}).`;
      return;
    }
    this.imgWrap.hidden = true;
    this.bodyEl.hidden = false;
    this.placeEl.hidden = true;
    this.attach(path);
  }

  hideAll() {
    this.bodyEl.hidden = true;
    this.imgWrap.hidden = true;
    this.placeEl.hidden = true;
  }

  /// The image bytes are fetched over `GET /api/file`, not over the WebSocket:
  /// the browser can cache them, and there is no base64 swelling. The token
  /// rides along in the cookie set when the page was opened.
  showImage(path) {
    this.hideAll();
    this.imgWrap.hidden = false;
    const url = `/api/file?path=${encodeURIComponent(path)}`;
    if (this.imgEl.getAttribute('src') !== url) this.imgEl.src = url;
    this.imgEl.alt = this.meta.get(path)?.name || '';
  }

  attach(path) {
    const model = this.models.get(path);
    if (!this.editor || !model) return;
    this.editor.setModel(model);
    this.editor.updateOptions({ readOnly: !!this.meta.get(path)?.truncated });
    this.editor.focus();
  }

  ensureEditor(monaco) {
    if (this.editor) return;
    this.editor = monaco.editor.create(this.bodyEl, {
      automaticLayout: true,
      theme: this.resolvedTheme(),
      fontSize: 13,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      // Without a language service, autocomplete only offers words already in
      // the file — a distraction that does not help.
      quickSuggestions: false,
      occurrencesHighlight: 'off',
    });
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.save());
  }

  /// Drop a file along with its model.
  drop(path) {
    const model = this.models.get(path);
    if (model && !model.isDisposed()) model.dispose();
    this.models.delete(path);
    this.meta.delete(path);
    this.dirty.delete(path);
    if (this.current === path) this.current = null;
  }

  relayout() {
    if (this.editor) this.editor.layout();
  }

  // ------------------------------------------------------------------ theme

  resolvedTheme() {
    const dark = this.mode === 'dark' || (this.mode === 'auto' && this.appTheme() === 'dark');
    return dark ? 'vs-dark' : 'vs';
  }

  applyTheme() {
    this.paintTheme();
    if (this.monaco) this.monaco.editor.setTheme(this.resolvedTheme());
    this.el.classList.toggle('dark', this.resolvedTheme() === 'vs-dark');
    this.onDirty(); // bar tab ikut menyesuaikan warnanya
  }

  paintTheme() {
    this.themeBtn.textContent = this.mode;
    this.themeBtn.className = `etheme${this.mode === 'auto' ? '' : ' on'}`;
    this.themeBtn.title =
      `Editor theme: ${this.mode}. Click to cycle (dark → light → auto). ` +
      '"auto" follows the app theme.';
    this.el.classList.toggle('dark', this.resolvedTheme() === 'vs-dark');
  }

  /// The app theme changed; only meaningful when the editor mode is "auto".
  appThemeChanged() {
    if (this.mode === 'auto') this.applyTheme();
  }

  // ------------------------------------------------------------------- save

  /// The folder trail from the project root down to the file, like
  /// `src > render.h`. Shown relative to the project rather than as a full path:
  /// a prefix repeated on every row tells you nothing.
  paintCrumb() {
    const path = this.current;
    if (!path) {
      this.crumbEl.textContent = '';
      return;
    }
    const root = this.projectRoot();
    let rel = path;
    if (root && path.toLowerCase().startsWith(root.path.toLowerCase())) {
      rel = path.slice(root.path.length).replace(/^[\\/]+/, '');
    }
    const parts = rel.split(/[\\/]/).filter(Boolean);
    // <bdi> so trimming from the left does not move the slashes around.
    this.crumbEl.textContent = '';
    const bdi = document.createElement('bdi');
    bdi.textContent = parts.join(' \u203a ');
    this.crumbEl.appendChild(bdi);
    this.crumbEl.title = path;
  }

  paintHead() {
    this.paintCrumb();
    const meta = this.meta.get(this.current);
    if (!meta) return;
    const bits = [kb(meta.size)];
    if (meta.dims) bits.push(meta.dims);
    if (meta.truncated) bits.push('first 2 MB only — read-only');
    if (this.dirty.has(this.current)) bits.push('unsaved');
    this.noteEl.textContent = bits.join(' · ');
    this.saveBtn.disabled = meta.truncated || meta.binary || meta.image;
    this.saveBtn.classList.toggle('on', this.dirty.has(this.current));
  }

  save() {
    if (!this.editor || !this.current || this.saveBtn.disabled) return;
    const model = this.models.get(this.current);
    if (!model) return;
    this.saveBtn.textContent = 'Saving…';
    this.onSave(this.current, model.getValue());
  }

  saved(path) {
    this.dirty.delete(path);
    this.saveBtn.textContent = 'Save';
    if (this.current === path) this.paintHead();
    this.onDirty();
  }

  failed() {
    this.saveBtn.textContent = 'Save';
  }
}

function kb(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
