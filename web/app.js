// sessionhub — sidebar + terminal. A vanilla ES module, no build step.
// xterm.js is loaded as a classic script from /vendor (UMD, no ESM build).

import { Conn } from './conn.js';
import { relativeTime, bytes, basename } from './format.js';
import { Palette } from './palette.js';
import { Settings } from './settings.js';
import { Ask } from './ask.js';
import { match } from './fuzzy.js';
import { mark } from './mark.js';
import { Drops, quotePath } from './drop.js';
import { Picker } from './picker.js';
import { MachineBar } from './machines.js';
import { SidePanel } from './sidepanel.js';
import { renderTree as renderSidebar } from './sidebar.js';
import { KeyBar } from './keybar.js';
import { attachTouchScroll, touchOnlyDevice } from './touchscroll.js';
import { attachScrollPad } from './scrollpad.js';
import { unlock as unlockAudio, ding } from './chime.js';
import { Toasts } from './toasts.js';

const LS = {
  token: 'sh.token',
  width: 'sh.sidebar.width',
  collapsed: 'sh.collapsed',
  mem: 'sh.mem',
  sound: 'sh.sound',
  theme: 'sh.theme',
  hidden: 'sh.sidebar.hidden',
  bookmarks: 'sh.bookmarks',
  pickerPath: 'sh.picker.path',
  layout: 'sh.layout',
  filesOpen: 'sh.files.open',
  filesWidth: 'sh.files.width',
  tabOrder: 'sh.taborder',
};

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = MAC ? '⌘' : 'Ctrl+';

const el = {
  sidebar: document.getElementById('sidebar'),
  splitter: document.getElementById('splitter'),
  tree: document.getElementById('tree'),
  tabs: document.getElementById('tabs'),
  banner: document.getElementById('banner'),
  terms: document.getElementById('terms'),
  empty: document.getElementById('empty'),
  menu: document.getElementById('menu'),
  filter: document.getElementById('filter'),
  collapseAll: document.getElementById('collapse-all'),
  expandAll: document.getElementById('expand-all'),
  backdrop: document.getElementById('backdrop'),
  newProject: document.getElementById('new-project'),
  work: document.getElementById('work'),
  side: document.getElementById('side'),
  fsplit: document.getElementById('fsplit'),
};

const isNarrow = () => window.matchMedia('(max-width: 720px)').matches;

/// Put text where the cursor is in a plain input, replacing any selection —
/// what the browser itself would do for a native paste.
///
/// `input` is dispatched afterwards because that is the event fields listen to;
/// setting `.value` alone changes what is on screen without telling anything
/// that was watching.
function insertIntoField(field, text) {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.value = field.value.slice(0, start) + text + field.value.slice(end);
  const at = start + text.length;
  field.setSelectionRange?.(at, at);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/// The key bar for touch screens. Built first because every terminal's
/// `onData` passes through it.
const keybar = new KeyBar(document.getElementById('stage'), {
  send: (text) => {
    if (activeId !== null) conn.sendInput(activeId, text);
  },
  onResize: () => relayout(),
  // The Img key: a file picker, because a phone has no drag-and-drop. On a
  // phone `accept="image/*"` opens the gallery or camera directly. The chosen
  // files ride the exact drop route — saved into the daemon's dropped folder,
  // the path typed into the terminal.
  onUpload: () => {
    if (activeId === null) return;
    uploadInput.value = '';
    uploadInput.click();
  },
  // The Paste key. Through `term.paste`, never straight to the PTY: xterm
  // knows whether the program asked for bracketed paste, and an agent that did
  // must see the wrapping or it treats a pasted prompt as typed keystrokes.
  onPaste: async () => {
    // The clipboard belongs wherever the cursor is. With a dialog open — naming
    // a terminal, say — the focused thing is an ordinary input, and sending the
    // text past it into the terminal behind drops it somewhere the user cannot
    // see and did not ask for. On a phone this button is the only way to paste
    // at all, so getting the target wrong makes those fields unfillable.
    const focused = document.activeElement;
    const field =
      focused &&
      (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA') &&
      // xterm's own hidden textarea is not a field to type into — text meant for
      // the terminal has to go through `term.paste` for bracketed paste.
      !focused.classList.contains('xterm-helper-textarea')
        ? focused
        : null;

    const entry = activeId === null ? null : terms.get(activeId);
    if (!field && !entry) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      if (field) {
        insertIntoField(field, text);
      } else {
        entry.term.paste(text);
      }
    } catch {
      // Refused, or the API is absent. The one honest cause worth naming: over
      // plain http on the LAN the browser never offers the clipboard at all.
      banner(
        window.isSecureContext
          ? 'The browser refused clipboard access — allow it for this site and try again.'
          : 'Clipboard needs HTTPS: open sessionhub through the tunnel, or copy the text by hand.',
        false,
      );
    }
  },
});

// -------------------------------------------------------------------- token

function takeToken() {
  const q = new URLSearchParams(location.search).get('token');
  if (q) {
    localStorage.setItem(LS.token, q);
    // Clear the token out of the URL so it is not bookmarked or copied along.
    history.replaceState(null, '', location.pathname);
    return q;
  }
  return localStorage.getItem(LS.token);
}

const token = takeToken();
if (!token) {
  // The cookie is still valid but localStorage is empty — the page loads and
  // then can do nothing. A message here is a dead end; the same input box as on
  // the 401 page gives a way out.
  el.empty.textContent = '';
  el.empty.hidden = false;

  const form = document.createElement('form');
  form.id = 'tokenform';
  const label = document.createElement('div');
  label.textContent = 'Paste the daemon token to sign in.';
  form.appendChild(label);

  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'token';
  input.setAttribute('aria-label', 'Token');
  form.appendChild(input);

  const go = document.createElement('button');
  go.type = 'submit';
  go.textContent = 'Sign in';
  form.appendChild(go);

  const hint = document.createElement('div');
  hint.className = 'thint';
  hint.textContent = 'It is in ~/.sessionhub/config.toml, or on the url line of `sessionhubd status`.';
  form.appendChild(hint);

  form.onsubmit = (e) => {
    e.preventDefault();
    const v = input.value.trim();
    // Through the query rather than straight into localStorage: that is the
    // existing path, and it also sets the cookie the static assets need.
    if (v) location.href = `${location.pathname}?token=${encodeURIComponent(v)}`;
  };
  el.empty.appendChild(form);
  input.focus();
}

// -------------------------------------------------------------------- state

// These names stay as bare as before, but their contents now belong to the
// active machine. Switching machines swaps the references rather than copying
// the contents — that is what keeps the rest of this file unchanged.
let state = { projects: [], terminals: [], agents: [], saved: [], scanning: true };
const collapsed = new Set(JSON.parse(localStorage.getItem(LS.collapsed) || '[]'));
/// Projects marked as focus, lifted to the top of the sidebar.
const bookmarks = new Set(JSON.parse(localStorage.getItem(LS.bookmarks) || '[]'));
/// Temporary folds while filtering — never persisted.
const filterCollapsed = new Set();

const saveCollapsed = () => localStorage.setItem(LS.collapsed, JSON.stringify([...collapsed]));
const saveBookmarks = () => localStorage.setItem(LS.bookmarks, JSON.stringify([...bookmarks]));
let terms = new Map(); // id -> { term, fit, host, awaitingReplay, lastSize }
/// Tabs closed by hand on the machine being shown. Held in memory rather than
/// stored: terminal ids start again at 1 when a daemon restarts, so a remembered
/// id would eventually hide a brand new terminal that merely inherited the
/// number. A reload gives you the full strip back, which is the right default
/// for a fresh look at what is running.
let dismissed = new Set();
let activeId = null;
/// 'tabs' = one terminal fills the stage; 'grid' = all of them at once.
let layout = localStorage.getItem(LS.layout) === 'grid' ? 'grid' : 'tabs';
// A phone never gets the grid: nine panels on a 390 px screen is nine
// unreadable postage stamps. The stored choice is left alone — it belongs to
// the desktop this browser profile may also be — only the view is overruled.
if (isNarrow()) layout = 'tabs';
let memOn = localStorage.getItem(LS.mem) === '1';
let memTimer = null;
/// The finished-terminal sound. On unless it was switched off — a default that
/// needs discovering defeats a notification.
let soundOn = localStorage.getItem(LS.sound) !== '0';
let memById = new Map();
/// Created later, but declared here so `applyTheme`, which runs earlier, can
/// check it without tripping over the TDZ.
let sidePanel = null;
/// The project chosen by hand, through a project name in the sidebar or the
/// picker in the Explorer. The last action wins: choosing a project beats the
/// active terminal, and switching terminals takes it back.
let pinnedProject = null;

/// Move the file panel to a project. Running terminals are untouched — this is
/// about what the panel shows, not about what is being worked on.
function focusProject(path) {
  pinnedProject = path;
  if (sidePanel) sidePanel.syncRoots();
  renderTree();
}

/// The project the Explorer shows: the hand-picked one, then the active
/// terminal's, then the first project that exists.
function explorerRoot() {
  const term = state.terminals.find((t) => t.id === activeId);
  const want = pinnedProject || term?.project;
  const hit = state.projects.find((p) => p.path === want)
    || state.projects.find((p) => p.path.toLowerCase() === (want || '').toLowerCase())
    || state.projects.find((p) => p.exists);
  return hit ? { path: hit.path, name: hit.name } : null;
}

/// Every machine that is open; `current` is the one showing.
const machines = [];
let current = null;

/// A thin facade over the active machine's connection.
///
/// This is what kept the change from spreading: all forty `conn.send(...)`
/// calls in this file sit inside closures, so not one of them needs to know
/// there is now more than one connection.
const conn = {
  send: (m) => current?.conn.send(m),
  sendInput: (id, text) => current?.conn.sendInput(id, text),
  sendDrop: (id, name, bytes) => (current ? current.conn.sendDrop(id, name, bytes) : false),
  /// Handlers are shared by every connection; each call carries its owning
  /// machine as the last argument.
  on: {},
};

function makeMachine({ id, label, via }) {
  const host = document.createElement('div');
  host.className = 'mhost';
  host.hidden = true;

  const m = {
    id,
    label,
    via, // '' for this machine itself
    state: { projects: [], terminals: [], agents: [], saved: [], scanning: true },
    terms: new Map(),
    /// Terminals whose tab was closed by hand. They keep running — closing a tab
    /// has never meant killing anything here — but they stop taking room in the
    /// strip until you pick them out of the sidebar again.
    dismissed: new Set(),
    activeId: null,
    pinnedProject: null,
    memById: new Map(),
    status: 'connecting',
    host,
  };
  m.conn = new Conn(token || '', { via, owner: m, handlers: conn.on });
  machines.push(m);
  return m;
}

/// Swap the machine on show. The old one is not torn down — its xterm stays
/// alive behind the scenes, so coming back to it does not mean attaching again
/// and replaying 2 MB.
function useMachine(m) {
  if (current === m) return;
  if (current) {
    current.state = state;
    current.terms = terms;
    current.activeId = activeId;
    current.memById = memById;
    current.dismissed = dismissed;
    current.pinnedProject = pinnedProject;
    current.host.hidden = true;
  }
  current = m;
  state = m.state;
  terms = m.terms;
  dismissed = m.dismissed;
  activeId = m.activeId;
  memById = m.memById;
  pinnedProject = m.pinnedProject;
  m.host.hidden = false;
}

// ----------------------------------------------------------------- terminal

/// The full 16-colour ANSI palette, read from CSS so it changes with the theme.
/// Given only a background and a foreground, xterm.js falls back on its own
/// palette, designed for dark backgrounds — and on a light theme, white text
/// from any program would vanish against a white background.
function xtermTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    background: v('--bg'),
    foreground: v('--text'),
    cursor: v('--text'),
    cursorAccent: v('--bg'),
    selectionBackground: v('--t-selection'),
    black: v('--t-black'),
    red: v('--t-red'),
    green: v('--t-green'),
    yellow: v('--t-yellow'),
    blue: v('--t-blue'),
    magenta: v('--t-magenta'),
    cyan: v('--t-cyan'),
    white: v('--t-white'),
    brightBlack: v('--t-bright-black'),
    brightRed: v('--t-bright-red'),
    brightGreen: v('--t-bright-green'),
    brightYellow: v('--t-bright-yellow'),
    brightBlue: v('--t-bright-blue'),
    brightMagenta: v('--t-bright-magenta'),
    brightCyan: v('--t-bright-cyan'),
    brightWhite: v('--t-bright-white'),
  };
}

function makeTerminal(id) {
  const host = document.createElement('div');
  host.className = 'host';
  host.hidden = true;
  // The small caption is only visible in grid mode: in tab mode the tab bar
  // above already says the same thing, and repeating it only eats height.
  const cap = document.createElement('div');
  cap.className = 'hcap';
  const capName = document.createElement('span');
  capName.className = 'hcname';
  cap.appendChild(capName);
  const capX = document.createElement('button');
  capX.className = 'hcx';
  capX.textContent = '✕';
  capX.title = 'Close view (terminal keeps running)';
  capX.onclick = (e) => {
    e.stopPropagation();
    closeView(id);
  };
  cap.appendChild(capX);
  host.appendChild(cap);

  const view = document.createElement('div');
  view.className = 'hview';
  host.appendChild(view);
  current.host.appendChild(host);

  const cs = getComputedStyle(document.documentElement);
  const term = new Terminal({
    fontFamily: cs.getPropertyValue('--mono').trim() || 'ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 1.4,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: xtermTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(view);
  // A phone has no wheel, and a full-screen agent leaves xterm's own touch
  // scrolling switched off. Without this there is no way back to what has
  // already scrolled past.
  attachTouchScroll(view, term);
  // And a control for the same job that does not depend on a gesture landing
  // right: a screen at a time, and one tap back to the live end.
  attachScrollPad(view, term);
  // Typing in a panel makes it the active one; in grid mode that decides where
  // the app shortcuts go.
  view.addEventListener('mousedown', () => {
    if (activeId !== id) {
      activeId = id;
      paintGrid();
      renderTabs();
      renderTree();
    }
  });

  // Every keystroke is passed through raw except a handful of app shortcuts.
  // Ctrl+C, Ctrl+D, Ctrl+P and Ctrl+R are deliberately never touched — they
  // belong to the agent. This handler only holds the key back; what runs the
  // action is a single listener on document, so it never fires twice.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    // Paste belongs to the browser, not to the terminal.
    //
    // Left alone, xterm treats Ctrl+V as the control byte 0x16 and calls
    // preventDefault on the key — so the browser never runs its own paste, and
    // the `paste` event that is the only way to read the clipboard is never
    // fired at all. Measured: keydown arrived unprevented, came back prevented,
    // and zero paste events followed.
    //
    // Handing the key back (returning false) makes the browser paste into the
    // hidden textarea, which xterm then picks up through its own paste
    // listener — bracketed paste included, so an agent sees pasted text as
    // pasted rather than as a burst of typing.
    //
    // The cost, named plainly: a program inside the terminal can no longer
    // receive a literal ^V (vim's visual block). On a touch screen the key
    // bar's Ctrl still produces it; on a desktop it is gone, and pasting is
    // worth far more here.
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'v' || ev.key === 'V')) {
      return false;
    }
    return !matchShortcut(ev);
  });
  // Through the keybar first: a Ctrl armed on the bar applies to the next
  // character wherever it comes from, the on-screen keyboard included.
  term.onData((data) => {
    // Typing into a terminal is as good as looking at it.
    clearDone(id);
    conn.sendInput(id, keybar.wrap(data));
  });

  const entry = { term, fit, host, view, capName, awaitingReplay: false, lastSize: null };
  terms.set(id, entry);
  return entry;
}

/// The size that fits on this client's screen — sent to the server as a request,
/// not applied here. The server decides the effective size.
function proposed(entry) {
  const dims = entry.fit.proposeDimensions();
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return null;
  return { cols: Math.max(2, dims.cols), rows: Math.max(1, dims.rows) };
}

/// Show a terminal's view. `focus: false` is used by grid mode, which opens
/// several at once without moving the active terminal over and over.
function openView(id, focus = true) {
  // Opening it is the undo for closing its tab — picking it out of the sidebar
  // is how you say you want it back.
  dismissed.delete(id);
  const entry = terms.get(id) || makeTerminal(id);
  if (layout === 'grid') entry.host.hidden = false;
  const size = proposed(entry) || { cols: 80, rows: 24 };
  entry.lastSize = size;
  // The screen is cleared first: the server will resend the ring buffer, and
  // without a reset its contents would be drawn twice after a reconnect.
  entry.term.reset();
  entry.awaitingReplay = true;
  conn.send({ t: 'attach', id, cols: size.cols, rows: size.rows });
  if (focus) show(id);
}

function attach(id) {
  openView(id, true);
}

function show(id) {
  activeId = id;
  clearDone(id);
  const grid = layout === 'grid';
  for (const [tid, e] of terms) e.host.hidden = grid ? false : tid !== id;
  el.empty.hidden = terms.size > 0;
  // The key bar appears or disappears BEFORE the size is computed: it takes
  // height, so computing first and showing it after would cut off the last row.
  keybar.sync(activeId !== null && terms.size > 0);
  paintGrid();
  const entry = terms.get(id);
  if (entry) {
    entry.term.focus();
    if (grid) for (const tid of terms.keys()) pushSize(tid);
    else pushSize(id);
  }
  // Switching terminals means switching projects; that beats a project picked
  // by hand earlier.
  pinnedProject = null;
  renderTabs();
  renderTree();
  if (sidePanel) sidePanel.syncRoots();
}

/// Apply the stage layout. The column count follows the terminal count: two
/// terminals side by side, four as 2×2, nine as 3×3 — so each panel stays as
/// square as possible instead of an unreadable thin ribbon.
function paintGrid(want) {
  const grid = layout === 'grid';
  el.terms.classList.toggle('grid', grid);
  if (grid) {
    const n = Math.max(1, want || terms.size);
    el.terms.style.setProperty('--cols', String(Math.ceil(Math.sqrt(n))));
  } else {
    el.terms.style.removeProperty('--cols');
  }
  for (const [tid, e] of terms) {
    e.host.classList.toggle('on', tid === activeId);
    if (e.capName) e.capName.textContent = labelOf(tid);
  }
}

/// Past this each panel is too small to read — and each panel means one attach
/// plus its ring buffer replay.
const GRID_MAX = 9;

/// Switch layout, then let each terminal report its size again.
function setLayout(next) {
  layout = next;
  localStorage.setItem(LS.layout, next);
  const grid = next === 'grid';

  // The grid shows live terminals, not only the ones that happen to have been
  // opened: switching layout and seeing a single panel is not what "grid" means.
  // Grid means "everything live", but not the ones deliberately put away — it
  // would undo the tidying the moment you switched layout.
  const live = grid
    ? state.terminals.filter((t) => t.alive && !dismissed.has(t.id)).map((t) => t.id)
    : [];
  const want = live.slice(0, GRID_MAX);

  for (const [tid, e] of terms) e.host.hidden = grid ? false : tid !== activeId;
  // The column count is set before the panels open, so the first size each panel
  // reports is already its grid size.
  paintGrid(Math.max(terms.size, want.length));
  for (const id of want) if (!terms.has(id)) openView(id, false);
  if (grid && activeId === null && want.length) activeId = want[0];
  paintGrid(Math.max(terms.size, want.length));
  el.empty.hidden = terms.size > 0;
  renderTabs();
  renderTree();

  if (grid && live.length > GRID_MAX) {
    banner(`Showing the first ${GRID_MAX} of ${live.length} terminals.`, true);
  }

  // The PTY size is negotiated per terminal, so each panel reports for itself.
  for (const tid of terms.keys()) {
    terms.get(tid).lastSize = null;
    pushSize(tid);
  }
}

function labelOf(id) {
  const t = state.terminals.find((x) => x.id === id);
  return t ? terminalLabel(t) : `terminal ${id}`;
}

function pushSize(id) {
  const entry = terms.get(id);
  if (!entry || entry.host.hidden) return;
  const size = proposed(entry);
  if (!size) return;
  if (entry.lastSize && size.cols === entry.lastSize.cols && size.rows === entry.lastSize.rows) return;
  entry.lastSize = size;
  conn.send({ t: 'resize', id, cols: size.cols, rows: size.rows });
}

function closeView(id) {
  const entry = terms.get(id);
  if (!entry) return;
  // Remembered, because the strip lists every live terminal and would otherwise
  // put this one straight back — closing a tab would visibly do nothing. The
  // process is untouched; the row in the sidebar still shows it running.
  dismissed.add(id);
  conn.send({ t: 'detach', id });
  entry.term.dispose();
  entry.host.remove();
  terms.delete(id);
  if (activeId === id) {
    activeId = terms.size ? [...terms.keys()][0] : null;
  }
  if (activeId === null) {
    paintGrid();
    el.empty.hidden = false;
    renderTabs();
    renderTree();
  } else {
    show(activeId);
  }
}

function killTerminal(id) {
  const t = state.terminals.find((x) => x.id === id);
  const label = t ? `${basename(t.project)} · ${t.agent}` : `terminal ${id}`;
  if (!confirm(`Kill ${label}? The agent process stops too.`)) return;
  conn.send({ t: 'kill', id });
}

const ask = new Ask(document.body);

/// Fork: continuing an old conversation into a NEW session. The original is
/// untouched, so this is safe for trying another direction.
async function forkSession(project, session) {
  const brief = state.agents.find((a) => a.name === session.agent);
  if (!brief?.can_fork) return;

  const base = session.title.replace(/…$/, '').slice(0, 40).trim();
  const wanted = await ask.show({
    title: `Fork ${session.agent} session`,
    value: `${base} (fork)`,
    ok: 'Fork',
    note: brief.fork_takes_name
      ? 'The original session is left untouched; its conversation is copied into a new ' +
        'session with this name.'
      : `The original session is left untouched. Note: ${session.agent} does not accept a ` +
        'session name on the command line, so this name will not be applied to it.',
  });
  if (wanted === null) return;

  const active = terms.get(activeId);
  const size = (active && proposed(active)) || { cols: 100, rows: 30 };
  conn.send({
    t: 'fork',
    project,
    agent: session.agent,
    session_id: session.session_id,
    name: wanted,
    cols: size.cols,
    rows: size.rows,
  });
  // A new agent writes its session file after the first message, so its row does
  // not appear in the sidebar until you type. Without this note, a fork looks
  // like nothing happened.
  banner('Fork opened in a new tab. It appears in the sidebar after the first message.', true);
  closeDrawerIfNarrow();
}

function spawn(project, agent, resume) {
  const probe = { fit: null };
  // The starting size is taken from the terminal on show, or from the stage size
  // when there is not one yet.
  const active = terms.get(activeId);
  const size = (active && proposed(active)) || { cols: 100, rows: 30 };
  conn.send({ t: 'spawn', project, agent, resume: resume || null, cols: size.cols, rows: size.rows });
  // On a narrow screen the sidebar is a drawer covering the stage: opening a
  // terminal and leaving it open means the terminal is not visible.
  closeDrawerIfNarrow();
  void probe;
}

// ------------------------------------------------------------------- render

/// The colours a tab can be tagged with. Kept in step with `config::TAB_COLORS`
/// on the daemon, which refuses anything else — so a stale client cannot push an
/// unknown value into the page.
const TAB_COLORS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];

// ------------------------------------------------------------- tab ordering

/// The order tabs were last dragged into, as terminal ids.
///
/// Kept in this browser rather than on the daemon, unlike a tab's colour. A
/// colour is a label you choose once and want to recognise from any device; an
/// order is a working arrangement you nudge constantly, and it belongs to the
/// screen you are nudging it on — a phone and a laptop do not have the same room
/// for tabs. It also keeps a drag from writing to `config.toml`.
let tabOrder = loadTabOrder();

function loadTabOrder() {
  try {
    const v = JSON.parse(localStorage.getItem(LS.tabOrder) || '[]');
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

function saveTabOrder() {
  // Ids of terminals that are gone are dropped, so the list cannot grow forever
  // in a browser left open for weeks.
  const live = new Set(state.terminals.map((t) => t.id));
  tabOrder = tabOrder.filter((id) => live.has(id));
  localStorage.setItem(LS.tabOrder, JSON.stringify(tabOrder));
}

/// Apply the stored order. Terminals never dragged keep their natural order by
/// id and follow the ones that were — so a new terminal appears at the end,
/// where it was just created, rather than somewhere in the middle.
function inTabOrder(list) {
  const at = new Map(tabOrder.map((id, i) => [id, i]));
  return [...list].sort((a, b) => {
    const ia = at.has(a.id) ? at.get(a.id) : Infinity;
    const ib = at.has(b.id) ? at.get(b.id) : Infinity;
    return ia - ib || a.id - b.id;
  });
}

/// Put `id` where `before` is, or at the end when `before` is null.
function moveTabTo(id, before) {
  const shown = inTabOrder(visibleTerminals()).map((t) => t.id);
  const from = shown.indexOf(id);
  if (from < 0) return;
  shown.splice(from, 1);
  const to = before === null ? shown.length : shown.indexOf(before);
  shown.splice(to < 0 ? shown.length : to, 0, id);
  tabOrder = shown;
  saveTabOrder();
  renderTabs();
}

/// One step left or right — how a tab is moved where there is no mouse to drag
/// with. On a touch screen a long press already opens this tab's menu, so a
/// drag would have to fight it for the same gesture.
function nudgeTab(id, delta) {
  const shown = inTabOrder(visibleTerminals()).map((t) => t.id);
  const from = shown.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= shown.length) return;
  shown.splice(to, 0, shown.splice(from, 1)[0]);
  tabOrder = shown;
  saveTabOrder();
  renderTabs();
}

/// The terminals that have a tab: the ones open here, plus every live one.
function visibleTerminals() {
  const ids = new Set([...terms.keys()]);
  // Open here, or alive and not put away. A terminal that is open wins either
  // way: it has a panel on screen, so a tab is the only way to reach it.
  return state.terminals.filter((t) => ids.has(t.id) || (t.alive && !dismissed.has(t.id)));
}

/// The menu behind a right-click, or a long press, on a tab.
function tabMenu(t) {
  const items = TAB_COLORS.map((c) => ({
    label: c,
    swatch: c,
    on: t.color === c,
    run: () => setColor(t.id, t.color === c ? '' : c),
  }));
  // Only offered when there is something to clear — a permanently greyed-out
  // row teaches nothing.
  if (t.color) items.push({ label: 'No colour', swatch: '', run: () => setColor(t.id, '') });

  // Reordering for a screen with no mouse to drag with. Offered only in the
  // direction there is somewhere to go.
  const order = inTabOrder(visibleTerminals()).map((x) => x.id);
  const at = order.indexOf(t.id);
  if (at > 0) items.push({ label: 'Move left', run: () => nudgeTab(t.id, -1) });
  if (at >= 0 && at < order.length - 1) items.push({ label: 'Move right', run: () => nudgeTab(t.id, 1) });

  // After updating an agent, a running process still holds the binary it
  // started with. This puts the new one to work without losing the conversation:
  // same tab, same folder, session resumed.
  items.push({ label: 'Relaunch', run: () => relaunch(t.id) });
  items.push({ label: 'Kill terminal…', run: () => killTerminal(t.id) });
  return items;
}

/// Tag a tab. Sent to the daemon rather than kept in this browser: the same
/// terminal is looked at from the phone and the laptop, and a mark that only one
/// of them can see is not a mark. On a named terminal it is stored with the name
/// and survives a restart.
/// Restart a terminal in place. The daemon keeps the terminal id, so the tab
/// stays where it is and everyone attached stays attached.
function relaunch(id) {
  const entry = terms.get(id);
  const size = (entry && proposed(entry)) || { cols: 100, rows: 30 };
  conn.send({ t: 'relaunch', id, cols: size.cols, rows: size.rows });
}

function setColor(id, color) {
  conn.send({ t: 'set_color', id, color });
}

function terminalLabel(t) {
  // A name you gave it wins over anything derived. It is the most specific thing
  // known about this terminal, and a tab reading `mcp · terminal` beside three
  // others reading `mcp · terminal` is the exact problem naming was meant to
  // solve — the sidebar showed the name while the tab still did not.
  if (t.name) return `${basename(t.project)} · ${t.name}`;
  const session = state.projects
    .flatMap((p) => p.sessions)
    .find((s) => s.session_id && s.session_id === t.session_id);
  const title = session ? session.title : '';
  return `${basename(t.project)} · ${t.agent}${title ? ' · ' + title : ''}`;
}

/// Bring a tab into view inside its strip.
///
/// Computed here rather than with `scrollIntoView`: that one also scrolls every
/// scrollable ancestor, and on a horizontal strip it often stops before the tab
/// is whole — exactly what happened to the last tab.
function revealTab(strip, tab) {
  if (!strip || !tab) return;
  const s = strip.getBoundingClientRect();
  const r = tab.getBoundingClientRect();
  if (r.right > s.right) strip.scrollLeft += r.right - s.right;
  else if (r.left < s.left) strip.scrollLeft -= s.left - r.left;
}

let dragging = null;

function renderTabs() {
  el.tabs.textContent = '';
  // Tabs scroll inside their own strip; the buttons on the right stay put. In one
  // container the buttons would be pushed off screen as soon as there are many
  // tabs.
  const strip = document.createElement('div');
  strip.className = 'tabstrip';
  el.tabs.appendChild(strip);

  const list = inTabOrder(visibleTerminals());

  for (const t of list) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (t.id === activeId ? ' active' : '') + (t.alive ? '' : ' dead');
    tab.setAttribute('role', 'tab');
    tab.dataset.id = String(t.id);
    tab.title = `${t.project}\n${t.agent} · ${t.cols}×${t.rows}`;

    // The activity mark comes first, before the name — a glance down the strip
    // answers "which of these is still working" without reading anything. The
    // strip is rebuilt often, so the classes are re-derived from the entry.
    const act = terms.get(t.id);
    const tdot = document.createElement('span');
    tdot.className = 'tdot'
      + (act?.streaming ? ' busy' : '')
      + (!act?.streaming && act?.done ? ' done' : '');
    tab.appendChild(tdot);

    const name = document.createElement('span');
    name.className = 'tname';
    name.textContent = terminalLabel(t);
    tab.appendChild(name);

    if (memOn) {
      const m = memById.get(t.id);
      const mem = document.createElement('span');
      mem.className = 'mem';
      mem.textContent = m ? bytes(m.rss_bytes) : '…';
      if (m) mem.title = `${m.processes} processes in this terminal's tree`;
      tab.appendChild(mem);
    }

    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'Close view (terminal keeps running)';
    x.onclick = (e) => {
      e.stopPropagation();
      closeView(t.id);
    };
    tab.appendChild(x);

    if (t.color) tab.dataset.color = t.color;

    // The panel wears the same mark as its tab. Without it the colour answers
    // "which tab" but not "which of these am I looking at", which is the harder
    // question in grid mode and the only question in tab mode.
    //
    // The bar is drawn inside the gap every panel already leaves on its left, so
    // tagging one changes nothing about how much room its terminal has.
    const entry = terms.get(t.id);
    if (entry) {
      if (t.color) entry.host.dataset.color = t.color;
      else delete entry.host.dataset.color;
    }

    tab.onclick = () => (terms.has(t.id) ? show(t.id) : attach(t.id));
    const menuFor = (x, y) => openMenu(x, y, tabMenu(t));
    tab.oncontextmenu = (e) => {
      e.preventDefault();
      menuFor(e.clientX, e.clientY);
    };
    // A phone has no right-click. A long press on the tab opens the same menu,
    // and a press that turns into a scroll of the strip does not.
    let hold = null;
    let held = false;
    tab.addEventListener('touchstart', (e) => {
      held = false;
      const p = e.touches[0];
      hold = setTimeout(() => {
        held = true;
        menuFor(p.clientX, p.clientY);
      }, 500);
    }, { passive: true });
    const drop = () => clearTimeout(hold);
    tab.addEventListener('touchmove', drop, { passive: true });
    tab.addEventListener('touchend', (e) => {
      drop();
      // The menu is already open; letting the tap through would also switch tabs.
      if (held) e.preventDefault();
    });

    // Dragging to reorder, with a mouse only. On a touch screen the strip
    // scrolls sideways and a long press already belongs to this tab's menu, so
    // a drag would be competing for both gestures at once; there, the menu
    // carries "Move left" and "Move right" instead.
    if (!touchOnlyDevice()) {
      tab.draggable = true;
      tab.addEventListener('dragstart', (e) => {
        dragging = t.id;
        tab.classList.add('drag');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox starts no drag at all without something in the payload.
        e.dataTransfer.setData('text/plain', String(t.id));
      });
      tab.addEventListener('dragend', () => {
        dragging = null;
        strip.querySelectorAll('.tab').forEach((n) => n.classList.remove('drag', 'over'));
      });
      tab.addEventListener('dragover', (e) => {
        if (dragging === null || dragging === t.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // Which side of this tab the pointer is on decides where it lands, so a
        // tab can be dropped after the last one as well as before it.
        const r = tab.getBoundingClientRect();
        tab.dataset.side = e.clientX < r.left + r.width / 2 ? 'before' : 'after';
        strip.querySelectorAll('.tab').forEach((n) => n.classList.remove('over'));
        tab.classList.add('over');
      });
      tab.addEventListener('dragleave', () => tab.classList.remove('over'));
      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragging === null || dragging === t.id) return;
        const after = tab.dataset.side === 'after';
        const order = inTabOrder(visibleTerminals()).map((x) => x.id);
        const at = order.indexOf(t.id);
        const before = after ? (order[at + 1] ?? null) : t.id;
        moveTabTo(dragging, before === dragging ? null : before);
        dragging = null;
      });
    }

    strip.appendChild(tab);
  }

  const tools = document.createElement('div');
  tools.className = 'tools';

  // Only visible on a narrow screen, where the sidebar becomes a drawer.
  const menuBtn = document.createElement('button');
  menuBtn.id = 'menu-btn';
  menuBtn.textContent = '☰';
  menuBtn.title = 'Open project list';
  menuBtn.onclick = toggleSidebar;
  tools.appendChild(menuBtn);

  // Not offered on a phone at all: the grid is meaningless there, and a button
  // whose only honest answer is "no" should not be on the screen.
  if (!isNarrow()) {
    const layoutBtn = document.createElement('button');
    layoutBtn.id = 'layout-btn';
    layoutBtn.textContent = layout === 'grid' ? 'Grid' : 'Tabs';
    layoutBtn.className = layout === 'grid' ? 'on' : '';
    layoutBtn.title =
      layout === 'grid'
        ? 'All terminals at once. Click for one at a time.'
        : 'One terminal at a time. Click to see them all at once.';
    layoutBtn.onclick = () => setLayout(layout === 'grid' ? 'tabs' : 'grid');
    tools.appendChild(layoutBtn);
  }

  const filesBtn = document.createElement('button');
  filesBtn.id = 'files-btn';
  filesBtn.textContent = 'Files';
  // Read from the DOM rather than from `sidePane`: this bar is drawn once when
  // the module loads, before the panel exists.
  const filesOn = !el.side.hidden;
  filesBtn.className = filesOn ? 'on' : '';
  filesBtn.title = filesOn ? 'Hide the file panel' : 'Show the file panel';
  filesBtn.onclick = () => sidePane.toggle();
  tools.appendChild(filesBtn);

  // Only on devices whose keyboard really is lacking. On a laptop this button
  // offers nothing — unless the bar was turned on by hand, in which case there
  // still has to be a way to turn it off.
  if (keybar.applicable || keybar.forced === true) {
    const kbBtn = document.createElement('button');
    kbBtn.id = 'kb-btn';
    kbBtn.textContent = '⌨';
    kbBtn.className = keybar.on ? 'on' : '';
    kbBtn.title = keybar.on ? 'Hide the key bar' : 'Show Esc, Tab, and arrow keys';
    kbBtn.onclick = () => {
      keybar.toggle();
      renderTabs();
    };
    tools.appendChild(kbBtn);
  }

  const memBtn = document.createElement('button');
  memBtn.id = 'mem-btn';
  memBtn.textContent = 'RAM';
  memBtn.className = memOn ? 'on' : '';
  memBtn.title = memOn ? 'Hide memory usage' : 'Show memory usage per terminal';
  memBtn.onclick = toggleMem;
  tools.appendChild(memBtn);

  // The finished-terminal sound. A drawn bell, not the emoji — the emoji's
  // weight and colour are the platform's choice, and "off" needs a slash the
  // emoji set cannot promise. `currentColor` keeps both in the theme.
  const sndBtn = document.createElement('button');
  sndBtn.id = 'sound-btn';
  sndBtn.className = soundOn ? 'on' : '';
  sndBtn.title = soundOn
    ? 'Sound on: a terminal finishing off-screen chimes. Click to mute.'
    : 'Muted. Click to chime when an unwatched terminal finishes.';
  sndBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
      ${soundOn ? '' : '<line x1="3" y1="3" x2="21" y2="21"/>'}
    </svg>`;
  sndBtn.onclick = toggleSound;
  tools.appendChild(sndBtn);

  const themeBtn = document.createElement('button');
  themeBtn.id = 'theme-btn';
  themeBtn.textContent = { system: 'system', dark: 'dark', light: 'light' }[theme];
  themeBtn.className = theme === 'system' ? '' : 'on';
  themeBtn.title = `Theme: ${theme}. Click to cycle (system → dark → light).`;
  themeBtn.onclick = () => applyTheme(NEXT_THEME[theme]);
  tools.appendChild(themeBtn);

  el.tabs.appendChild(tools);

  // After the right-hand buttons are in place, not before: while `.tools` is
  // missing, the strip is still full width and thinks the last tab already fits.
  revealTab(strip, strip.querySelector('.tab.active'));
}

/// Filter the tree by what is in the search box.
///
/// What is matched is the project name, not its full path: as a subsequence, a
/// long path like `C:\data\code\…` makes nearly every project match, and the
/// filter stops filtering anything. Paths can still be searched through the
/// command palette, which does rank its results.
///
/// While filtering, the order follows the score — this list has become a set of
/// search results, so the best match belongs on top. With no query the order
/// goes back to by-name so rows do not jump around while browsing.
function filterTree(query) {
  const q = query.trim();
  if (!q) {
    filterCollapsed.clear();
    return state.projects.map((p) => ({ p, sessions: p.sessions, open: null, pos: [] }));
  }

  // Session titles are long sentences; as a subsequence, almost all of them
  // contain the letters of a short query if they are spread out. A match only
  // counts as real when its letters are close together.
  const maxSpan = Math.max(12, q.length * 3);
  const solid = (m) => m && m.span <= maxSpan;

  // A folder every project passes through distinguishes nothing — typing `code`
  // while they all live in `C:\data\code` should not bring up the whole list.
  // Those are left out of the path matching.
  const common = commonSegments(state.projects);

  const out = [];
  for (const p of state.projects) {
    const pmRaw = match(q, p.name);
    const pm = solid(pmRaw) ? pmRaw : null;
    const hits = [];
    for (const s of p.sessions) {
      const sm = match(q, `${s.title} ${s.agent}`);
      if (solid(sm)) hits.push({ s, pos: sm.positions, score: sm.score });
    }
    // Parent folders are searched too even though they are never displayed:
    // projects are often grouped per client or per platform, and "metro" or
    // "telkom" is the folder's name, not the project's.
    const folder = parentMatch(p, q, common);
    // A project with a matching loose or saved terminal still shows, even when
    // neither its own name nor a session title matches. Searching for the name
    // you gave a terminal has to find it — that is what naming it was for.
    if (
      !pm &&
      !hits.length &&
      !folder &&
      !looseTerminals(p.path).length &&
      !savedTerminals(p.path).length
    ) {
      continue;
    }
    out.push({
      // A matching project name is stronger than a session title inside it; a
      // match through a parent folder is the weakest — what you typed is not the
      // name of anything on screen.
      score: Math.max(
        pm ? pm.score + 5 : -Infinity,
        folder ? -50 : -Infinity,
        ...hits.map((h) => h.score),
      ),
      folder,
      p,
      // A project whose name matches still shows all of its sessions; when only
      // some sessions match, only those appear.
      sessions: hits.length ? hits.map((h) => h.s) : p.sessions,
      positions: hits.length ? hits.map((h) => h.pos) : [],
      // While filtering, results are expanded automatically — folding them back
      // would only hide what was just searched for. Folds made by hand during a
      // filter are temporary and never stored.
      open: !filterCollapsed.has(p.path),
      pos: pm ? pm.positions : [],
    });
  }
  out.sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name));
  return out;
}

/// The name of a parent folder containing the query, or null.
///
/// A substring on purpose, not a subsequence like the name matching: as a
/// subsequence, a path as long as `C:\Users\…\data\code\…` makes nearly every
/// project match and the filter stops filtering. A substring still answers
/// "look for metro first" without that consequence.
function parentMatch(p, q, common) {
  const needle = q.toLowerCase();
  const parts = p.path.split(/[\\/]/).filter(Boolean);
  // The last segment is the project itself; the name matching already covers
  // that, and repeating it here only produces a double marker.
  for (const part of parts.slice(0, -1)) {
    const low = part.toLowerCase();
    if (common.has(low)) continue;
    if (low.includes(needle)) return part;
  }
  return null;
}

/// The folder segments every project passes through. With fewer than three
/// projects, "every" does not mean anything yet, so nothing is excluded.
function commonSegments(projects) {
  if (projects.length < 3) return new Set();
  let common = null;
  for (const p of projects) {
    const seg = new Set(
      p.path
        .split(/[\\/]/)
        .filter(Boolean)
        .slice(0, -1)
        .map((x) => x.toLowerCase()),
    );
    if (common === null) common = seg;
    else for (const x of [...common]) if (!seg.has(x)) common.delete(x);
    if (!common.size) break;
  }
  return common || new Set();
}

/// Everything the sidebar renderer needs, reassembled on every draw. Built fresh
/// rather than stored: `state`, `terms` and `activeId` are swapped wholesale
/// when machines change, so anything that captured them earlier would draw the
/// wrong machine's contents.
function sidebarCtx() {
  return {
    el,
    state,
    terms,
    activeId,
    bookmarks,
    collapsed,
    filterCollapsed,
    picker,
    mark,
    filterTree,
    looseTerminals,
    savedTerminals,
    saveTerminal,
    openSaved,
    forgetSaved,
    explorerRoot,
    saveCollapsed,
    saveBookmarks,
    attach,
    spawn,
    show,
    focusProject,
    openMenu,
    killTerminal,
    forkSession,
    closeDrawerIfNarrow,
    rerender: renderTree,
  };
}

function renderTree() {
  renderSidebar(sidebarCtx());
}

/// Live terminals in a project that are not tied to any session. The ones that
/// are already have their own row through that session.
function looseTerminals(project) {
  const q = el.filter.value.trim().toLowerCase();
  return state.terminals.filter(
    (t) =>
      t.alive &&
      !t.session_id &&
      t.project === project &&
      // While filtering, this row follows the same rule: it shows when the agent
      // name or the terminal number matches.
      (!q ||
        t.agent.toLowerCase().includes(q) ||
        `terminal ${t.id}`.includes(q) ||
        (t.name || '').toLowerCase().includes(q)),
  );
}

// ------------------------------------------------------------ saved terminals

/// Saved terminals in a project that are NOT running. A running one already has
/// a row of its own among the live terminals, under the same name, and two rows
/// for one thing is how you end up starting the same bot twice.
function savedTerminals(project) {
  const q = el.filter.value.trim().toLowerCase();
  return state.saved.filter(
    (s) =>
      samePath(s.project, project) &&
      s.live_terminal_id === null &&
      (!q || s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q)),
  );
}

/// Path comparison has to follow the daemon's rule, not the browser's: on
/// Windows and macOS `C:\Data` and `c:\data` are one folder.
const CASE_BLIND = /win|mac/i.test(navigator.platform || '');
function samePath(a, b) {
  const norm = (p) => {
    const s = String(p || '').replace(/[\\/]+$/, '');
    return CASE_BLIND ? s.toLowerCase().replace(/\//g, '\\') : s;
  };
  return norm(a) === norm(b);
}

/// The last command the daemon saw typed in this terminal, so naming it does not
/// mean typing the command out a second time. Empty when the daemon cannot say
/// honestly — a command recalled with ↑ never passed through it.
function lastCommand(id) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      pendingLastCommand.delete(id);
      resolve(v);
    };
    pendingLastCommand.set(id, finish);
    conn.send({ t: 'last_command', id });
    // A daemon too old to know this message would never answer, and the dialog
    // must still open.
    setTimeout(() => finish(''), 1500);
  });
}
const pendingLastCommand = new Map();

/// Name a live terminal so it outlives the daemon, and say what to run when it
/// is opened again.
async function saveTerminal(id) {
  const t = state.terminals.find((x) => x.id === id);
  if (!t) return;
  const already = state.saved.find(
    (s) => samePath(s.project, t.project) && s.name === t.name,
  );
  const suggested = already ? already.command : await lastCommand(id);

  const answer = await ask.showPair({
    title: already ? `Rename ${already.name}` : `Save terminal ${id}`,
    label1: 'Name',
    value1: t.name || '',
    label2: 'Run when opened',
    value2: suggested,
    hint2: 'leave empty to just open a shell',
    ok: 'Save',
    note:
      `Kept in ${basename(t.project)}, and it comes back after a restart. ` +
      'Opening it starts the shell in that folder and runs this line.',
  });
  if (answer === null) return;
  conn.send({ t: 'save_terminal', id, name: answer.first, command: answer.second });
}

/// Open a saved terminal — its shell, its folder, its command.
function openSaved(project, name) {
  const active = terms.get(activeId);
  const size = (active && proposed(active)) || { cols: 100, rows: 30 };
  conn.send({ t: 'open_saved', project, name, cols: size.cols, rows: size.rows });
  closeDrawerIfNarrow();
}

/// Forget the note. Anything running under that name keeps running — this
/// deletes a line in config.toml, not a process.
function forgetSaved(project, name) {
  conn.send({ t: 'forget_terminal', project, name });
}

// ---------------------------------------------------------------------- menu

function openMenu(x, y, items) {
  el.menu.textContent = '';
  for (const it of items) {
    const d = document.createElement('div');
    // A colour is easier to recognise than its name, so the swatch leads and the
    // word follows. `data-color` rather than an inline style: the palette lives
    // in the stylesheet, where it can differ between the light and dark themes.
    if (it.swatch !== undefined) {
      d.className = 'mcolor';
      const sw = document.createElement('span');
      sw.className = 'mswatch';
      if (it.swatch) sw.dataset.color = it.swatch;
      d.appendChild(sw);
      d.appendChild(document.createTextNode(it.label));
    } else {
      d.textContent = it.label;
    }
    if (it.on) d.classList.add('mon');
    d.onclick = () => {
      closeMenu();
      it.run();
    };
    el.menu.appendChild(d);
  }
  el.menu.style.left = `${x}px`;
  el.menu.style.top = `${y}px`;
  el.menu.hidden = false;
}
function closeMenu() {
  el.menu.hidden = true;
}
document.addEventListener('click', (e) => {
  if (!el.menu.hidden && !el.menu.contains(e.target)) closeMenu();
});

// ----------------------------------------------------------------------- RAM

function startMem() {
  conn.send({ t: 'mem' });
  clearInterval(memTimer);
  // Sampled periodically rather than streamed: reading the process table is
  // expensive.
  memTimer = setInterval(() => conn.send({ t: 'mem' }), 2000);
}

function toggleMem() {
  memOn = !memOn;
  localStorage.setItem(LS.mem, memOn ? '1' : '0');
  if (memOn) {
    startMem();
  } else {
    clearInterval(memTimer);
    memTimer = null;
    memById.clear();
  }
  renderTabs();
}

// ----------------------------------------------------------------- activity

/// Quiet for this long after output = the run has ended.
const IDLE_MS = 3000;
/// A run has to have lasted this long, and produced this many bytes, before its
/// end is worth announcing. Below either bar it was an echo of typing or a
/// prompt redraw, and a ding for those teaches people to turn the sound off.
const MIN_RUN_MS = 5000;
const MIN_RUN_BYTES = 2048;

// Mounted inside the stage, not the window: anchored to the window they cover
// the machine tabs and the tab strip on a phone — the two rows that say what is
// running, which is exactly what you look at after being told something
// finished.
const toasts = new Toasts(document.getElementById('stage'));

/// Say what finished and where, with one click to go there.
///
/// Built from the machine's own state rather than the global one: the terminal
/// that finished is very often on a machine you are not looking at, which is
/// exactly when being told is worth anything.
function announceDone(m, id) {
  const t = m.state.terminals.find((x) => x.id === id);
  if (!t) return;
  const session = m.state.projects
    .flatMap((p) => p.sessions)
    .find((s) => s.session_id && s.session_id === t.session_id);
  const what = t.name || session?.title || `terminal ${t.id}`;
  const where = basename(t.project);
  // The machine is named only when it is not the one on screen. On a single
  // machine, saying "This machine" on every toast is noise.
  const machine = m === current ? '' : ` · ${m.label}`;

  toasts.show({
    key: `${m.id}:${id}`,
    title: `${what} finished`,
    note: `${where} · ${t.agent}${machine}`,
    onClick: () => goToTerminal(m, id),
  });
}

/// Take the user to a terminal, wherever it is: the right machine, the right
/// project in the file panel, the terminal itself open.
function goToTerminal(m, id) {
  if (m !== current) switchMachine(m);
  const t = state.terminals.find((x) => x.id === id);
  if (t) focusProject(t.project);
  if (terms.has(id)) show(id);
  else attach(id);
  closeDrawerIfNarrow();
}

/// Is this terminal the thing the user is looking at right now?
const lookedAt = (m, id) =>
  m === current && id === activeId && document.hasFocus() && !document.hidden;

/// Repaint one terminal's activity mark wherever it shows: its tab (current
/// machine only — the strip is per machine) and its rows in the sidebar. Both
/// carry the id in a data attribute precisely so this never rebuilds anything.
function paintActivity(m, id, entry) {
  const busy = entry.streaming === true;
  if (m === current) {
    const dot = el.tabs.querySelector(`.tab[data-id="${id}"] .tdot`);
    if (dot) {
      dot.classList.toggle('busy', busy);
      dot.classList.toggle('done', !busy && entry.done === true);
    }
    for (const row of el.tree.querySelectorAll(`[data-tid="${id}"]`)) {
      row.classList.toggle('tbusy', busy);
      row.classList.toggle('tdone', !busy && entry.done === true);
    }
  }
}

/// The clock side of the heuristic: output marks the entry busy the moment it
/// arrives (in `onOutput`); this sweep is what notices the silence afterwards.
setInterval(() => {
  const now = performance.now();
  for (const m of machines) {
    for (const [id, entry] of m.terms) {
      if (entry.busySince === undefined) continue;
      // Amber means "streaming", not "a byte happened": output within the last
      // second AND at least a second of it. A prompt redrawn after a resize is
      // one burst — it never sustains, so it never flashes the tab.
      const streaming = now - entry.lastOut < 1200 && now - entry.busySince >= 900;
      if (streaming !== entry.streaming) {
        entry.streaming = streaming;
        paintActivity(m, id, entry);
      }
      if (now - entry.lastOut < IDLE_MS) continue;
      // The run is over. Whether anyone should hear about it is a different
      // question from whether it happened.
      const ranLong = entry.lastOut - entry.busySince >= MIN_RUN_MS;
      const ranReal = entry.runBytes >= MIN_RUN_BYTES;
      entry.busySince = undefined;
      entry.runBytes = 0;
      entry.streaming = false;
      if (ranLong && ranReal && !lookedAt(m, id)) {
        entry.done = true;
        if (soundOn) ding();
        // The chime says something finished; this says which, and where. With
        // terminals on several machines the sound alone is the least useful
        // half of the message, and it is gone before you start looking.
        announceDone(m, id);
      }
      paintActivity(m, id, entry);
    }
  }
}, 500);

/// Seeing it is acknowledging it.
function clearDone(id) {
  const entry = terms.get(id);
  if (entry?.done) {
    entry.done = false;
    paintActivity(current, id, entry);
  }
}

function toggleSound() {
  soundOn = !soundOn;
  localStorage.setItem(LS.sound, soundOn ? '1' : '0');
  // Turning it on both proves the sound and unlocks the AudioContext, inside
  // the click gesture the browser demands.
  if (soundOn) {
    unlockAudio();
    ding();
  }
  renderTabs();
}

// The first gesture of any kind unlocks audio, so the context is already
// running by the time some terminal finishes half an hour later.
document.addEventListener('pointerdown', () => unlockAudio(), { once: true });

// -------------------------------------------------------------------- theme

const NEXT_THEME = { system: 'dark', dark: 'light', light: 'system' };
let theme = localStorage.getItem(LS.theme) || 'system';

function applyTheme(mode) {
  theme = mode;
  localStorage.setItem(LS.theme, mode);
  // Without the attribute, CSS falls back to prefers-color-scheme; with it, the
  // user's choice wins in both directions.
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  for (const e of terms.values()) e.term.options.theme = xtermTheme();
  // The editor has a theme of its own; it only follows when set to "auto".
  // `applyTheme` also runs once as the module loads, before the panel exists.
  if (sidePanel) sidePanel.editor.appThemeChanged();
  renderTabs();
}
applyTheme(theme);
// The layout choice applies from the start. No terminal opens by itself here —
// tab mode and grid mode both wait for you to pick one.
paintGrid();

// ---------------------------------------------------------- command palette

const palette = new Palette(document.body, (item) => {
  if (item.kind === 'project') {
    collapsed.delete(item.project.path);
    localStorage.setItem(LS.collapsed, JSON.stringify([...collapsed]));
    renderTree();
    const row = el.tree.querySelector(`[data-path="${cssEscape(item.project.path)}"]`);
    if (row) row.scrollIntoView({ block: 'center' });
    return;
  }
  const live = item.session.live_terminal_id;
  if (live !== null && live !== undefined) attach(live);
  else spawn(item.project.path, item.session.agent, item.session.session_id);
});

function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}

/// Projects and sessions are searched in one list — the palette is for jumping,
/// not for browsing two separate trees.
function paletteItems() {
  const items = [];
  for (const p of state.projects) {
    items.push({
      kind: 'project',
      label: p.name,
      hint: p.path,
      haystack: `${p.name} ${p.path}`,
      project: p,
      // Sessions are already sorted newest first, so the first one sets the
      // project's age. Without this, projects always sink below every session.
      recency: p.sessions.length ? Date.parse(p.sessions[0].updated_at) || 0 : 0,
    });
    for (const s of p.sessions) {
      items.push({
        kind: 'session',
        agent: s.agent,
        label: s.title,
        hint: p.name,
        haystack: `${s.title} ${p.name} ${s.agent}`,
        project: p,
        session: s,
        recency: Date.parse(s.updated_at) || 0,
      });
    }
  }
  return items;
}

// --------------------------------------------------------------- file drops

// Without this, a file that misses the terminal makes the browser navigate to
// that file — the app appears to vanish.
for (const kind of ['dragover', 'drop']) {
  window.addEventListener(kind, (e) => e.preventDefault());
}

const drops = new Drops(
  el.terms,
  (name, bytes) => (activeId === null ? false : conn.sendDrop(activeId, name, bytes)),
  (text, isError) => banner(text, !isError),
);

// The picker behind the keybar's Img key. One hidden input, reused: `value` is
// cleared before each open so picking the same photo twice still fires change.
const uploadInput = document.createElement('input');
uploadInput.type = 'file';
uploadInput.id = 'upfile';
uploadInput.accept = 'image/*';
uploadInput.multiple = true;
uploadInput.hidden = true;
uploadInput.onchange = () => {
  const files = [...uploadInput.files];
  if (files.length) drops.upload(files);
};
document.body.appendChild(uploadInput);

document.addEventListener('paste', (e) => {
  if (activeId === null || palette.open || settings.open || ask.open || picker.open) return;
  drops.paste(e);
});

conn.on.onDropped = (msg) => {
  // The path is offered as typing rather than run straight away: you can still
  // add a sentence in front of it, or delete it if the drop was a mistake.
  conn.sendInput(msg.id, quotePath(msg.path) + ' ');
  banner(`${msg.name} uploaded (${bytes(msg.bytes)}) — path inserted`, true);
};

// ----------------------------------------------------------------- settings

const settings = new Settings(
  document.body,
  (agent) => conn.send({ t: 'set_agent', ...agent }),
  (enabled) => conn.send({ t: 'set_lan_access', enabled }),
  (limits) => conn.send(limits ? { t: 'set_drops', ...limits } : { t: 'sweep_drops' }),
  (name) => conn.send({ t: 'remove_agent', name }),
  // Forgetting a machine always goes to the LOCAL daemon: the paired list is its
  // own, not that of the machine being looked at.
  (name) => local.conn.send({ t: 'forget', name }),
  // Updating goes to the machine whose settings are on screen, through the
  // facade — so the Update section of a remote's panel updates that remote.
  (what) =>
    conn.send({
      t: { apply: 'update_apply', apply_web: 'update_apply_web' }[what] || 'update_check',
    }),
  // Updating an agent opens a terminal running its own updater, so what it says
  // is watched rather than swallowed. It lands on the machine whose settings are
  // open, which is the machine that has that agent installed.
  (name) => {
    const active = terms.get(activeId);
    const size = (active && proposed(active)) || { cols: 100, rows: 30 };
    conn.send({ t: 'update_agent_cli', name, cols: size.cols, rows: size.rows });
    settings.close();
  },
);

document.getElementById('settings-btn').onclick = () => {
  // What an update would cost, counted fresh each time the panel opens.
  settings.liveTerminals = state.terminals.filter((t) => t.alive).length;
  settings.setMachine(current);
  settings.show();
  conn.send({ t: 'config' });
  closeDrawerIfNarrow();
};

// ---------------------------------------------------------------- shortcuts

/// `persist: false` for an opening the app does itself rather than the user —
/// recording it as a choice would change the starting state on wide screens too,
/// while all that happened was a moment's help on a narrow one.
function setSidebar(hidden, persist = true) {
  el.sidebar.hidden = hidden;
  el.splitter.hidden = hidden;
  // On a narrow screen the sidebar covers the terminal, so it needs a dimmed
  // backdrop that can be tapped to close.
  el.backdrop.hidden = hidden || !isNarrow();
  if (persist) localStorage.setItem(LS.hidden, hidden ? '1' : '0');
  relayout();
}

function toggleSidebar() {
  setSidebar(!el.sidebar.hidden);
}

/// In the drawer, opening something means the user wants to see its terminal.
function closeDrawerIfNarrow() {
  if (isNarrow() && !el.sidebar.hidden) setSidebar(true);
}

function switchToIndex(n) {
  const ids = state.terminals.filter((t) => t.alive).map((t) => t.id);
  const id = ids[n - 1];
  if (id === undefined) return;
  if (terms.has(id)) show(id);
  else attach(id);
}

/// Return the name of the action when this combination belongs to the app,
/// `null` when it should be passed raw to the PTY.
function matchShortcut(ev) {
  const mod = ev.ctrlKey || ev.metaKey;
  if (!mod || ev.altKey) return null; // Alt milik readline (Alt+B, Alt+W, …)
  const key = (ev.key || '').toLowerCase();

  if (key === 'k' && !ev.shiftKey) return 'palette';
  if (key === 'b' && !ev.shiftKey) return 'sidebar';
  if (key === 'w') return ev.shiftKey ? 'kill' : 'detach';
  if (/^[1-9]$/.test(key)) return `tab:${key}`;
  return null;
}

function runShortcut(action) {
  if (action === 'palette') {
    palette.show(paletteItems());
  } else if (action === 'sidebar') {
    toggleSidebar();
  } else if (action === 'detach') {
    if (activeId !== null) closeView(activeId);
  } else if (action === 'kill') {
    if (activeId !== null) killTerminal(activeId);
  } else if (action.startsWith('tab:')) {
    switchToIndex(Number(action.slice(4)));
  }
}

document.addEventListener('keydown', (ev) => {
  // Floating layers handle their own keys.
  if (palette.open || settings.open || ask.open || picker.open) return;
  // Ctrl+K, Ctrl+B and Ctrl+W mean something of their own inside a code editor.
  // While focus is in the right panel, let that panel own them.
  if (el.side.contains(ev.target)) return;
  const action = matchShortcut(ev);
  if (!action) return;
  ev.preventDefault();
  runShortcut(action);
});

// ------------------------------------------------------------------ sidebar

// On a narrow screen the terminal should be seen first; the drawer opens when
// needed. A choice the user made is still honoured when one was stored.
const savedHidden = localStorage.getItem(LS.hidden);
setSidebar(savedHidden === null ? isNarrow() : savedHidden === '1');

el.backdrop.onclick = () => setSidebar(true);
window.matchMedia('(max-width: 720px)').addEventListener('change', () => {
  el.backdrop.hidden = el.sidebar.hidden || !isNarrow();
  // At phone width the view is always tabs; past it, the stored choice applies
  // again. The stored preference itself never changes here — this is the window
  // changing shape, not the user changing their mind — so what `setLayout`
  // persists is put back.
  const remembered = localStorage.getItem(LS.layout) === 'grid' ? 'grid' : 'tabs';
  const want = isNarrow() ? 'tabs' : remembered;
  if (want !== layout) {
    setLayout(want);
    localStorage.setItem(LS.layout, remembered);
  } else {
    // Even with nothing to switch, the layout button appears and disappears
    // with the width.
    renderTabs();
  }
  relayout();
});

// --- the search box and collapse/expand all --------------------------------

el.filter.addEventListener('input', () => renderTree());
el.filter.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    el.filter.value = '';
    renderTree();
    el.filter.blur();
  }
  e.stopPropagation(); // ordinary typing belongs to this box, not to a shortcut
});

// --------------------------------------------------------------- file panel

// One panel, one tab bar: `Files` is always there, and each file adds its own
// tab. Monaco is only downloaded when the first file is opened.
sidePanel = new SidePanel(el.side, {
  list: (path) => conn.send({ t: 'tree', path }),
  open: (path) => conn.send({ t: 'open_file', path }),
  save: (path, text) => conn.send({ t: 'save_file', path, text }),
  // The Explorer shows **one** project: the one being worked on. The contents of
  // other projects only lengthen the list without ever being opened.
  root: () => explorerRoot(),
  projects: () => state.projects.filter((p) => p.exists).map((p) => ({ path: p.path, name: p.name })),
  pick: (path) => {
    pinnedProject = path;
    sidePanel.syncRoots();
  },
  theme: () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
  close: () => sidePane.hide(),
  layout: () => relayout(),
});

const sidePane = {
  get open() {
    return !el.side.hidden;
  },
  show() {
    el.side.hidden = false;
    el.fsplit.hidden = false;
    localStorage.setItem(LS.filesOpen, '1');
    sidePanel.paint();
    renderTabs();
  },
  hide() {
    el.side.hidden = true;
    el.fsplit.hidden = true;
    localStorage.setItem(LS.filesOpen, '0');
    relayout();
    renderTabs();
  },
  toggle() {
    if (this.open) this.hide();
    else this.show();
  },
};

conn.on.onTree = (msg) => sidePanel.tree.update(msg);
conn.on.onFile = (msg) => sidePanel.openFile(msg);
conn.on.onSaved = (msg) => {
  sidePanel.editor.saved(msg.path);
  banner(`Saved ${msg.path.split(/[\/]/).pop()}`, true);
};

// The panel width is stored so your working layout is not rearranged every time
// the page opens.
{
  const saved = Number(localStorage.getItem(LS.filesWidth));
  if (saved >= 200 && saved <= 900) el.side.style.width = `${saved}px`;
}
el.fsplit.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const move = (ev) => {
    const w = Math.min(900, Math.max(200, window.innerWidth - ev.clientX));
    el.side.style.width = `${w}px`;
    localStorage.setItem(LS.filesWidth, String(w));
    relayout();
    sidePanel.editor.relayout();
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});

if (localStorage.getItem(LS.filesOpen) === '1') sidePane.show();

// ------------------------------------------------------------- new project

const picker = new Picker(document.body, {
  browse: (path) => conn.send({ t: 'browse', path }),
  mkdir: (parent, name) => conn.send({ t: 'make_dir', parent, name }),
  add: (path) => {
    awaitingProject = path;
    conn.send({ t: 'add_project', path });
  },
  remove: (path) => {
    awaitingProject = null;
    conn.send({ t: 'remove_project', path });
    // The panel stays open: what was just taken out is often wanted back in with
    // the right folder.
    setTimeout(() => picker.open && picker.go(path), 300);
  },
  // The last folder survives into the next session. Projects tend to be related
  // — the next one is nearly always a neighbour of the last.
  recall: () => localStorage.getItem(LS.pickerPath) || '',
  remember: (path) => localStorage.setItem(LS.pickerPath, path),
  // The same agents, the same menu, as the ＋ on a sidebar project row — the
  // daemon only ever sends the enabled ones, so no filtering here either.
  agents: () => state.agents,
  menu: (x, y, items) => openMenu(x, y, items),
  // Choosing an agent from the picker: what the dialog was really opened for.
  // Adding the project is bookkeeping that comes along — through the same
  // `add_project` path as the add-only button, so the reveal-in-sidebar and
  // the error handling that path already has keep working.
  openWith: (path, agent, isProject) => {
    if (!isProject) {
      awaitingProject = path;
      conn.send({ t: 'add_project', path });
    }
    spawn(path, agent, null);
    picker.close();
  },
});

// The folder whose appearance in the sidebar is being waited for. The registry
// scans first, so a new project only arrives in the next `state`.
let awaitingProject = null;

el.newProject.onclick = () => {
  picker.show();
  closeDrawerIfNarrow();
};

conn.on.onDir = (msg) => picker.update(msg);

el.collapseAll.onclick = () => {
  for (const p of state.projects) {
    collapsed.add(p.path);
    filterCollapsed.add(p.path);
  }
  saveCollapsed();
  renderTree();
};

el.expandAll.onclick = () => {
  collapsed.clear();
  filterCollapsed.clear();
  saveCollapsed();
  renderTree();
};

const savedWidth = Number(localStorage.getItem(LS.width));
if (savedWidth >= 160 && savedWidth <= 600) el.sidebar.style.width = `${savedWidth}px`;

el.splitter.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const move = (ev) => {
    const w = Math.min(600, Math.max(160, ev.clientX));
    el.sidebar.style.width = `${w}px`;
    localStorage.setItem(LS.width, String(w));
    relayout();
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});

function relayout() {
  keybar.sync(activeId !== null && terms.size > 0);
  if (layout === 'grid') {
    for (const id of terms.keys()) pushSize(id);
    return;
  }
  const entry = terms.get(activeId);
  if (entry) pushSize(activeId);
}
window.addEventListener('resize', relayout);

// --------------------------------------------------------------- connection

conn.on.onStatus = (kind, m) => {
  if (m) {
    m.status = kind;
    machineBar.paint(current);
  }
  // A background machine going down must not hijack the banner: it is not what
  // the user is looking at, and the dot on its tab already says so.
  if (m && m !== current) return;
  if (kind === 'lost') {
    banner('Connection lost, reconnecting…');
    // A WebSocket hides the status code of a refused handshake, so the reason is
    // asked for separately. Without this, a rotated token would only ever say
    // "reconnecting…" without saying what is wrong.
    fetch(`/api/status?token=${encodeURIComponent(token)}`)
      .then((r) => {
        if (r.status === 401) {
          banner('This token is no longer valid. Reopen with the URL from `sessionhubd token rotate`.');
        }
      })
      .catch(() => {}); // the network really is down; the plain strip is right
    return;
  }
  banner(null);
  // Reattaching waits for the first state to arrive: if the daemon restarted,
  // the old terminals are gone and attaching to a ghost id only produces an
  // error message.
  pendingReattach = true;
  // Sampling starts here, not only when the button is pressed — the "RAM on"
  // state is restored from localStorage when the page opens.
  if (memOn) startMem();
};

let pendingReattach = false;

function reattachAll() {
  const alive = new Set(state.terminals.filter((t) => t.alive).map((t) => t.id));
  for (const id of [...terms.keys()]) {
    if (!alive.has(id)) {
      // The terminal really is gone; close its view quietly.
      const entry = terms.get(id);
      entry.term.dispose();
      entry.host.remove();
      terms.delete(id);
      if (activeId === id) activeId = null;
      continue;
    }
    const entry = terms.get(id);
    entry.term.reset();
    entry.awaitingReplay = true;
    const size = entry.lastSize || { cols: 80, rows: 24 };
    // The server resends the ring buffer, so the screen comes back whole by itself.
    conn.send({ t: 'attach', id, cols: size.cols, rows: size.rows });
  }
  if (activeId === null && terms.size) activeId = [...terms.keys()][0];
  el.empty.hidden = terms.size > 0;
}

conn.on.onLastCommand = (msg) => {
  const waiting = pendingLastCommand.get(msg.id);
  if (waiting) waiting(msg.command || '');
};

conn.on.onState = (msg, m) => {
  // Background machines still get their data updated — so switching to one does
  // not show a second of stale state — but nothing is drawn.
  const st = m === current ? state : m.state;
  st.projects = msg.projects || [];
  st.terminals = msg.terminals || [];
  st.agents = msg.agents || [];
  st.saved = msg.saved || [];
  st.scanning = msg.scanning === true;
  if (m !== current) return;
  if (pendingReattach) {
    pendingReattach = false;
    reattachAll();
  }
  renderTree();
  renderTabs();
  revealNewProject();
  sidePanel.syncRoots();
  offerSessionPicker();
};

/// On a narrow screen, landing with no terminal open means landing on an empty
/// stage — with the drawer holding the session list shut. Once, after the first
/// state arrives, that drawer opens itself.
///
/// Once only, and not recorded as a choice: closing it and seeing it open again
/// on the next state update is far more annoying than an empty stage.
let pickerOffered = false;
function offerSessionPicker() {
  if (pickerOffered) return;
  pickerOffered = true;
  if (!isNarrow() || activeId !== null || terms.size) return;
  // Live-but-unattached terminals used to keep the drawer shut, on the theory
  // that their tabs above the stage were one tap away. In practice that leaves
  // a phone on an empty stage staring at "No session open" — an empty stage is
  // an empty stage, and the drawer is what fills it.
  //
  // Only when there is nothing to pick at all does opening it help nobody.
  if (!state.projects.length) return;
  setSidebar(false, false);
}

/// A new project is not in `state` right away: the registry scans first. As soon
/// as it appears, the picker closes and its row is brought into view — without
/// that, "Use this folder" feels like it did nothing.
function revealNewProject() {
  if (!awaitingProject) return;
  const want = awaitingProject.toLowerCase();
  const found = state.projects.find((p) => p.path.toLowerCase() === want);
  if (!found) return;
  awaitingProject = null;
  picker.close();
  collapsed.delete(found.path);
  filterCollapsed.delete(found.path);
  saveCollapsed();
  el.filter.value = '';
  renderTree();
  const row = el.tree.querySelector(`[data-path="${cssEscape(found.path)}"]`);
  if (row) row.scrollIntoView({ block: 'center' });
  banner(`${basename(found.path)} added — use + on its row to start an agent.`, true);
}

conn.on.onAttached = (msg, m) => {
  if (m !== current) return;
  const entry = terms.get(msg.id) || makeTerminal(msg.id);
  entry.awaitingReplay = false;
  entry.term.resize(msg.cols, msg.rows);
  if (activeId === null || activeId === msg.id) show(msg.id);
  else renderTabs();
};

conn.on.onSize = (msg, m) => {
  // The effective size is decided by the server (the minimum across clients). A
  // larger client leaves empty space rather than stretching the terminal.
  const entry = m.terms.get(msg.id);
  if (entry) entry.term.resize(msg.cols, msg.rows);
};

conn.on.onOutput = (id, data, m) => {
  // Output for background machines is still written into their xterm: coming
  // back has to show what happened while away, not a frozen screen.
  const entry = m.terms.get(id);
  if (entry) {
    entry.term.write(data);
    // Activity bookkeeping — but never for the attach replay: the whole ring
    // buffer arrives as one burst, and old output must not read as a job that
    // is running right now. No painting here either: whether this is a stream
    // or a one-off prompt redraw only the sweep can tell, by watching whether
    // the output keeps coming.
    if (!entry.awaitingReplay) {
      const now = performance.now();
      if (entry.busySince === undefined) {
        entry.busySince = now;
        entry.runBytes = 0;
      }
      entry.lastOut = now;
      entry.runBytes += data.byteLength ?? data.length;
    }
  }
};

conn.on.onExit = (msg, m) => {
  const entry = m.terms.get(msg.id);
  if (entry) entry.term.write(`\r\n\x1b[2m— terminal berakhir (kode ${msg.code}) —\x1b[0m\r\n`);
  if (m === current) renderTabs();
};

conn.on.onError = (msg, m) => {
  if (msg.code === 'pair_failed' || msg.code === 'unknown_remote') {
    machineBar.failed(msg.message);
    if (!machineBar.open) banner(msg.message, true);
    return;
  }
  if (m && m !== current) {
    // An error from a background machine is still named, but it has to be clear
    // where it came from.
    banner(`${m.label}: ${msg.message || msg.code}`, true);
    return;
  }
  // An error while walking folders is shown inside the picker, not in a banner
  // that the picker itself covers.
  if (msg.code === 'save_failed') {
    sidePanel.editor.failed();
    banner(msg.message, false);
    return;
  }
  if (msg.code === 'tree_failed') {
    // A folder that failed to open is marked on its own row; a banner for that
    // would only cover what is being looked at.
    const path = (/Cannot (?:open|read) (.+?):/.exec(msg.message || '') || [])[1];
    if (path) sidePanel.tree.fail(path);
    return;
  }
  if (picker.open && /^(browse|mkdir|bad_project|duplicate_project|unknown_project|config_write)/.test(msg.code || '')) {
    awaitingProject = null;
    picker.fail(msg.message || msg.code);
    return;
  }
  banner(msg.message || msg.code, true);
};

conn.on.onConfig = (msg) => settings.update(msg);

conn.on.onUpdate = (msg, m) => {
  // Only for the machine being looked at: a check answered by a background
  // machine must not overwrite what the open panel is showing.
  if (m !== current) return;
  settings.setRelease(msg);
};

conn.on.onMem = (msg) => {
  memById.clear();
  for (const m of msg.terminals) memById.set(m.id, m);
  renderTabs();
};

let bannerTimer = null;
function banner(text, transient = false) {
  clearTimeout(bannerTimer);
  if (!text) {
    el.banner.hidden = true;
    return;
  }
  el.banner.textContent = text;
  el.banner.hidden = false;
  if (transient) bannerTimer = setTimeout(() => (el.banner.hidden = true), 6000);
}

// On a touch screen there is no visible "left" and no Ctrl+K — a message that
// tells you to use both misleads exactly where it is needed most.
if (isNarrow()) {
  // One wrapper rather than three pieces directly in `#empty`: its container is
  // a grid that centres each child on its own, so without this the sentence is
  // torn into three rows far apart.
  el.empty.textContent = '';
  const msg = document.createElement('div');
  msg.className = 'emsg';
  msg.appendChild(document.createTextNode('No session open.'));
  const b = document.createElement('button');
  b.id = 'empty-open';
  b.textContent = '☰ Pick a session';
  b.onclick = () => setSidebar(false, false);
  msg.appendChild(b);
  el.empty.appendChild(msg);
} else {
  document.getElementById('modk').textContent = MAC ? '⌘K' : 'Ctrl+K';
}

// ----------------------------------------------------------------- machines

const machineBar = new MachineBar(document.getElementById('main'), {
  machines: () => machines,
  pick: (m) => switchMachine(m),
  // Machine management always goes to the LOCAL daemon, never through the relay:
  // the machine list is its own, and remotes are not chained.
  pair: (link) => local.conn.send({ t: 'pair', link, name: '' }),
  forget: (m) => forgetMachine(m),
});

/// Switch machines: swap the data references, then redraw from the new machine's
/// data. Nothing is torn down — its xterm and file panel stay alive.
function switchMachine(m) {
  if (m === current) return;
  useMachine(m);
  // Settings follows the active machine; otherwise an open panel would quietly
  // be editing the wrong machine's config.
  settings.setMachine(m);
  if (!m.started) {
    m.started = true;
    m.conn.connect();
  }
  machineBar.paint(current);
  paintGrid();
  renderTree();
  renderTabs();
  if (sidePanel) sidePanel.syncRoots();
  relayout();
}

function forgetMachine(m) {
  if (!m.via) return;
  // Terminals over there do not die with it — forgetting only means we stop
  // showing them here.
  local.conn.send({ t: 'forget', name: m.via });
}

/// The machine list from the local daemon. Tabs are created for new ones, and
/// the ones forgotten are closed.
conn.on.onRemotes = (msg, m) => {
  // Only the local daemon holds this list; remotes are not chained.
  if (m !== local) return;
  const want = msg.remotes || [];
  for (const r of want) {
    const have = machines.find((x) => x.via === r.name);
    if (have) {
      have.label = r.name;
      have.addr = r.addr;
      continue;
    }
    const fresh = makeMachine({ id: `r:${r.name}`, label: r.name, via: r.name });
    fresh.addr = r.addr;
    el.terms.appendChild(fresh.host);
    if (machineBar.open) {
      machineBar.paired(r.name);
      switchMachine(fresh);
    }
  }
  for (const gone of machines.filter((x) => x.via && !want.some((r) => r.name === x.via))) {
    dropMachine(gone);
  }
  machineBar.paint(current);
  settings.setRemotes(want);
};

/// Drop a machine along with everything it displays.
function dropMachine(m) {
  if (m === current) switchMachine(local);
  // Its toasts go with it: one left behind would offer to take you to a
  // terminal on a machine that is no longer here.
  toasts.dismissFor(`${m.id}:`);
  m.conn.close();
  for (const e of m.terms.values()) e.term.dispose();
  m.terms.clear();
  m.host.remove();
  if (m.panelEl) m.panelEl.remove();
  const i = machines.indexOf(m);
  if (i >= 0) machines.splice(i, 1);
  machineBar.paint(current);
}

// This machine itself is always present and is never forgotten.
const local = makeMachine({ id: 'local', label: 'This machine', via: '' });
useMachine(local);
el.terms.appendChild(local.host);
machineBar.paint(current);

if (token) {
  local.started = true;
  local.conn.connect();
  // The machine list is asked for once; after that it is resent whenever it
  // changes, so there is nothing to poll.
  setTimeout(() => local.conn.send({ t: 'remotes' }), 300);
}
renderTabs();
