// The command palette: one input, fuzzy matched across every project and
// session at once. The sidebar is for browsing, the palette for jumping.

import { rank } from './fuzzy.js';

const MAX_ROWS = 40;

export class Palette {
  /// `onOpen(item)` is called when a row is chosen.
  constructor(root, onOpen) {
    this.onOpen = onOpen;
    this.items = [];
    this.rows = [];
    this.cursor = 0;

    this.el = document.createElement('div');
    this.el.id = 'palette';
    this.el.hidden = true;
    this.el.innerHTML =
      '<div class="pbox"><input type="text" spellcheck="false" ' +
      'placeholder="Jump to a project or session…" aria-label="Search"><div class="plist"></div></div>';
    root.appendChild(this.el);

    this.input = this.el.querySelector('input');
    this.list = this.el.querySelector('.plist');

    this.input.addEventListener('input', () => this.refresh());
    this.el.addEventListener('mousedown', (e) => {
      // A click on the backdrop closes; a click inside the box does not.
      if (e.target === this.el) this.close();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
  }

  get open() {
    return !this.el.hidden;
  }

  show(items) {
    this.items = items;
    this.el.hidden = false;
    this.input.value = '';
    this.input.focus();
    this.refresh();
  }

  close() {
    this.el.hidden = true;
    this.input.blur();
  }

  onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      this.move(1);
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      this.move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = this.rows[this.cursor];
      if (row) {
        this.close();
        this.onOpen(row.item);
      }
    }
    // The rest belongs to the input; the palette does not hijack normal typing.
    e.stopPropagation();
  }

  move(delta) {
    if (!this.rows.length) return;
    this.cursor = (this.cursor + delta + this.rows.length) % this.rows.length;
    this.paint();
  }

  refresh() {
    const q = this.input.value;
    this.rows = rank(q, this.items, (i) => i.haystack, (i) => i.recency || 0).slice(0, MAX_ROWS);
    this.cursor = 0;
    this.paint();
  }

  paint() {
    this.list.textContent = '';
    if (!this.rows.length) {
      const none = document.createElement('div');
      none.className = 'pnone';
      none.textContent = 'No matches.';
      this.list.appendChild(none);
      return;
    }
    this.rows.forEach((row, i) => {
      const d = document.createElement('div');
      d.className = 'prow' + (i === this.cursor ? ' sel' : '');

      const kind = document.createElement('span');
      kind.className = 'pkind';
      kind.textContent = row.item.kind === 'project' ? 'project' : row.item.agent;
      d.appendChild(kind);

      const label = document.createElement('span');
      label.className = 'plabel';
      label.appendChild(highlight(row.item.label, row.positions, row.item.haystack));
      d.appendChild(label);

      const hint = document.createElement('span');
      hint.className = 'phint';
      hint.textContent = row.item.hint || '';
      d.appendChild(hint);

      d.onmouseenter = () => {
        this.cursor = i;
        this.paint();
      };
      d.onclick = () => {
        this.close();
        this.onOpen(row.item);
      };
      this.list.appendChild(d);
    });
  }
}

/// Bold the matched letters. Positions are counted against `haystack`; when the
/// label is only part of it, marking is skipped rather than landing wrong.
function highlight(label, positions, haystack) {
  const frag = document.createDocumentFragment();
  if (!positions.length || !haystack.startsWith(label)) {
    frag.appendChild(document.createTextNode(label));
    return frag;
  }
  const set = new Set(positions.filter((p) => p < label.length));
  let plain = '';
  for (let i = 0; i < label.length; i++) {
    if (set.has(i)) {
      if (plain) {
        frag.appendChild(document.createTextNode(plain));
        plain = '';
      }
      const b = document.createElement('b');
      b.textContent = label[i];
      frag.appendChild(b);
    } else {
      plain += label[i];
    }
  }
  if (plain) frag.appendChild(document.createTextNode(plain));
  return frag;
}
