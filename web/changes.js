// The code files changed in the project since the daemon took its snapshot —
// what the agents did, without git. Lives in the Explorer column, in place of
// the tree; a file clicked here opens as a diff beside it.
//
// Below the live list, "Earlier": what changed during snapshots that have
// ended — reviewed with ✓, or closed with the project's last terminal. The
// daemon keeps those on disk for 30 days, both sides of every file.

import { iconFor } from './fileicons.js';

/// No answer by then means the daemon on that machine predates this view.
const TOO_OLD_MS = 6000;

export class ChangesView {
  /// `list(root)`, `reset(root)` and `record(root, id)` ask the daemon,
  /// `open(path, record)` shows one file's diff, `back()` returns to the tree,
  /// `root()` is the project.
  constructor(host, { list, reset, record, open, back, root }) {
    this.on = { list, reset, record, open, back, root };
    this.files = [];
    this.history = [];
    this.state = 'taking';
    this.since = 0;
    /// Which project the list on screen belongs to.
    this.of = null;
    /// The saved record being looked at — `{ id, info, files }` — or null for
    /// the live list.
    this.viewing = null;
    this.selected = null;
    this.retry = null;
    this.silence = null;

    this.el = document.createElement('div');
    this.el.id = 'changes';
    this.el.hidden = true;
    this.el.innerHTML =
      '<div class="fhead"><span class="ftitle">Changes</span>' +
      '<button class="creset" title="Mark all as reviewed — keep them under Earlier, count from now">✓</button>' +
      '<button class="frefresh" title="Refresh">⟳</button>' +
      '<button class="cback" title="Back to the files">☰</button></div>' +
      '<div class="cnote"></div>' +
      '<div class="cscroll"></div>';
    host.appendChild(this.el);
    this.noteEl = this.el.querySelector('.cnote');
    this.listEl = this.el.querySelector('.cscroll');
    this.resetBtn = this.el.querySelector('.creset');
    this.el.querySelector('.frefresh').onclick = () => this.refresh();
    this.el.querySelector('.cback').onclick = () => this.on.back();
    this.resetBtn.onclick = () => {
      const root = this.on.root();
      if (!root) return;
      this.state = 'taking';
      this.files = [];
      this.paint();
      this.on.reset(root.path);
    };
  }

  get open() {
    return !this.el.hidden;
  }

  show() {
    this.el.hidden = false;
    this.refresh();
  }

  hide() {
    this.el.hidden = true;
    clearTimeout(this.retry);
  }

  refresh() {
    const root = this.on.root();
    if (!root) {
      this.of = null;
      this.files = [];
      this.history = [];
      this.viewing = null;
      this.paint();
      return;
    }
    if (this.of !== root.path) {
      // Another project: what was listed belongs to the old one.
      this.of = root.path;
      this.files = [];
      this.history = [];
      this.viewing = null;
      this.state = 'taking';
      this.paint();
    }
    this.on.list(root.path);
    clearTimeout(this.silence);
    this.silence = setTimeout(() => {
      if (this.state !== 'taking' || this.files.length) return;
      this.state = 'old';
      this.paint();
    }, TOO_OLD_MS);
  }

  update(msg) {
    if (msg.root !== this.of) return;
    clearTimeout(this.silence);
    this.state = msg.state;
    this.since = msg.since_ms;
    this.files = msg.files || [];
    this.history = msg.history || [];
    if (!this.viewing) this.paint();
    clearTimeout(this.retry);
    // The snapshot is still being taken; it is usually a second away.
    if (msg.state === 'taking' && this.open) this.retry = setTimeout(() => this.refresh(), 1000);
  }

  /// A saved record arrived: show its files in place of the live list.
  showRecord(msg) {
    if (msg.root !== this.of) return;
    this.viewing = { id: msg.id, info: msg.info, files: msg.files };
    this.selected = null;
    this.paint();
  }

  paint() {
    this.listEl.textContent = '';
    this.resetBtn.hidden = !!this.viewing;
    if (this.viewing) {
      const { id, info, files } = this.viewing;
      this.noteEl.textContent = `${span(info)} · ${count(info.files)}`;
      this.listEl.appendChild(this.link('‹ Back to now', () => {
        this.viewing = null;
        this.paint();
      }));
      for (const f of files) this.listEl.appendChild(this.row(f, id));
      return;
    }

    const n = this.files.length;
    this.noteEl.textContent = {
      taking: 'Taking a snapshot of the code…',
      too_big: 'This project has too much code to keep a copy of, so changes are not tracked.',
      idle: 'No terminal is open in this project, so nothing is being tracked. Changes count from when one opens.',
      old: "This machine's sessionhub is too old to track changes. Update it.",
      ready: n ? `${count(n)} changed since ${clock(this.since)}` : `Nothing changed since ${clock(this.since)}.`,
    }[this.on.root() ? this.state : 'none'] || 'Open a project to see its changes.';
    for (const f of this.files) this.listEl.appendChild(this.row(f, null));

    if (!this.history.length) return;
    const head = document.createElement('div');
    head.className = 'chead';
    head.textContent = 'Earlier';
    this.listEl.appendChild(head);
    for (const r of this.history) {
      const el = document.createElement('div');
      el.className = 'frow crec';
      el.title = `${span(r)} — what changed during this snapshot`;
      const label = document.createElement('span');
      label.className = 'fname';
      // The start alone: the column is narrow, and the whole span is the title.
      label.textContent = `${day(new Date(r.since_ms))}, ${clock(r.since_ms)}`;
      const dim = document.createElement('span');
      dim.className = 'cdir';
      dim.textContent = count(r.files);
      label.appendChild(dim);
      el.appendChild(label);
      el.appendChild(counts(r));
      el.onclick = () => this.on.record(this.of, r.since_ms);
      this.listEl.appendChild(el);
    }
  }

  link(text, run) {
    const el = document.createElement('div');
    el.className = 'frow clink';
    el.textContent = text;
    el.onclick = run;
    return el;
  }

  /// One changed file. `record` is the saved record it belongs to, or null.
  row(f, record) {
    const root = (this.of || '').replace(/[\\/]+$/, '');
    const rel = f.path.startsWith(root) ? f.path.slice(root.length).replace(/^[\\/]+/, '') : f.path;
    const cut = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
    const name = rel.slice(cut + 1);

    const row = document.createElement('div');
    const key = `${record ?? ''}\u0001${f.path}`;
    row.className = `frow crow ${f.status}` + (key === this.selected ? ' on' : '');
    row.title = `${rel} — ${f.status}`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fico');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${iconFor(name, false)}`);
    svg.appendChild(use);
    row.appendChild(svg);

    const label = document.createElement('span');
    label.className = 'fname';
    label.textContent = name;
    if (cut > 0) {
      const dir = document.createElement('span');
      dir.className = 'cdir';
      dir.textContent = rel.slice(0, cut);
      label.appendChild(dir);
    }
    row.appendChild(label);
    row.appendChild(counts(f));

    row.onclick = () => {
      this.selected = key;
      this.paint();
      this.on.open(f.path, record);
    };
    return row;
  }
}

function counts(f) {
  const el = document.createElement('span');
  el.className = 'ccount';
  el.innerHTML = (f.added ? `<b class="cadd">+${f.added}</b>` : '') + (f.removed ? `<b class="cdel">−${f.removed}</b>` : '');
  return el;
}

function count(n) {
  return `${n} file${n === 1 ? '' : 's'}`;
}

function clock(ms) {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

function day(d) {
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

/// "Tue 21 Oct, 14:02–16:40", the day said once when both ends share it.
function span(r) {
  const a = new Date(r.since_ms);
  const b = new Date(r.until_ms);
  return a.toDateString() === b.toDateString()
    ? `${day(a)}, ${clock(r.since_ms)}–${clock(r.until_ms)}`
    : `${day(a)} ${clock(r.since_ms)} – ${day(b)} ${clock(r.until_ms)}`;
}
