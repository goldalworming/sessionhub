// sessionhub — sidebar + terminal. A vanilla ES module, no build step.
// xterm.js is loaded as a classic script from /vendor (UMD, no ESM build).

import { Conn } from './conn.js';
import { relativeTime, bytes, basename, elapsedShort } from './format.js';
import { Palette } from './palette.js';
import { Settings } from './settings.js';
import { Ask } from './ask.js';
import { match } from './fuzzy.js';
import { mark } from './mark.js';
import { Drops, quotePath } from './drop.js';
import { Picker } from './picker.js';
import { MachineBar } from './machines.js';
import { SidePanel } from './sidepanel.js';
import { renderTree as renderSidebar, agentIcon, agentSlot } from './sidebar.js';
import { KeyBar } from './keybar.js';
import { LinksSheet, bufferLines, scanLinks } from './links.js';
import { attachTouchScroll, hasFinePointer } from './touchscroll.js';
import { attachScrollPad } from './scrollpad.js';
import { unlock as unlockAudio, ding } from './chime.js';
import { Toasts } from './toasts.js';
import { Telemetry } from './telemetry.js';

const LS = {
  token: 'sh.token',
  width: 'sh.sidebar.width',
  collapsed: 'sh.collapsed',
  mem: 'sh.mem',
  sound: 'sh.sound',
  theme: 'sh.theme',
  hidden: 'sh.sidebar.hidden',
  bookmarks: 'sh.bookmarks',
  /// Per machine: `C:\data\code\x` means nothing on a laptop that does not
  /// have it, and reopening the picker there landed on a red error above
  /// another machine's folder list.
  pickerPath: 'sh.picker.path.',
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
  filterClear: document.getElementById('filter-clear'),
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
const linksSheet = new LinksSheet(document.body);

const keybar = new KeyBar(document.getElementById('stage'), {
  send: (text) => {
    if (activeId !== null) conn.sendInput(activeId, text);
  },
  onResize: () => relayout(),
  // The 🔗 key: every URL this terminal has printed, in a tappable list. The
  // scan runs here, when asked — never per output frame.
  onLinks: () => {
    const entry = terms.get(activeId);
    if (!entry) return;
    linksSheet.show(scanLinks(bufferLines(entry.term)));
  },
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
let state = {
  projects: [],
  terminals: [],
  agents: [],
  saved: [],
  scanning: true,
  hidden_sessions: [],
  dismissed_terminals: [],
};
const collapsed = new Set(JSON.parse(localStorage.getItem(LS.collapsed) || '[]'));
/// Projects marked as focus, lifted to the top of the sidebar.
const bookmarks = new Set(JSON.parse(localStorage.getItem(LS.bookmarks) || '[]'));
/// Temporary folds while filtering — never persisted.
const filterCollapsed = new Set();

const saveCollapsed = () => localStorage.setItem(LS.collapsed, JSON.stringify([...collapsed]));
const saveBookmarks = () => localStorage.setItem(LS.bookmarks, JSON.stringify([...bookmarks]));
let terms = new Map(); // id -> { term, fit, host, awaitingReplay, lastSize }

/// Was this tab put away by hand? The daemon behind the machine being shown
/// remembers this itself now — every device reads the same list, and a
/// restart clears it on its own the moment the ids it names stop meaning
/// anything. See `SetDismissed` in proto.rs.
const isClosed = (t) => (state.dismissed_terminals || []).includes(t.id);
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
let picker = null;
/// The project chosen by hand, through a project name in the sidebar or the
/// picker in the Explorer. The last action wins: choosing a project beats the
/// active terminal, and switching terminals takes it back.
let pinnedProject = null;
/// A folder walked to with the `..` row, which need not be a project at all.
///
/// This one IS stored, unlike every other root here, and that is the point of
/// it: `explorerRoot` is recomputed from `state.projects` on every state
/// message the daemon sends, so a folder that is not a project has nowhere to
/// survive. Walking up would be undone within a second or two of arriving.
///
/// Kept per machine beside `pinnedProject`, and deliberately not written to
/// storage: a reload is a fresh start, back at the project.
let browseRoot = null;

/// Move the file panel to a project. Running terminals are untouched — this is
/// about what the panel shows, not about what is being worked on.
function focusProject(path) {
  pinnedProject = path;
  browseRoot = null;
  if (sidePanel) sidePanel.syncRoots();
  renderTree();
}

/// Move the file panel to any folder, project or not.
///
/// `path` and `name` come from the listing that named them — the daemon that
/// owns the disk. Nothing here takes a path apart.
function browseTo(path, name) {
  browseRoot = { path, name };
  if (sidePanel) sidePanel.syncRoots();
}

/// Which set of open files belongs on screen: one per (machine, project).
///
/// Derived, never stored, for the same reason `explorerRoot` is — the answer
/// changes when a terminal is switched, a project is picked, or a machine comes
/// forward, and a copy kept anywhere would be the copy that goes stale.
function fileScope() {
  const root = explorerRoot();
  return current && root ? `${current.id}\u0000${root.path}` : null;
}

function syncScope() {
  if (sidePanel) sidePanel.setScope(fileScope());
  // The picker walks the disk of the machine now showing, so it is scoped to
  // the machine alone — not to the project the Explorer happens to be on.
  if (picker) picker.setScope(current?.id || null);
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

/// What the Explorer draws at the top of its tree.
///
/// Split from `explorerRoot` on purpose, and only the tree reads this one. The
/// open files and the editor's breadcrumb stay with the project: walking up a
/// level should not close what you have open, and `fileScope` keys stored tab
/// sets on the root — one entry per machine and project is a bounded set, one
/// per folder on the disk is not.
function treeRoot() {
  return browseRoot || explorerRoot();
}

/// Every machine that is open; `current` is the one showing.
const machines = [];

/// The behaviour log — see telemetry.js. Batches go to the daemon serving this
/// page, which is always the first machine made; events about a paired
/// machine are still about what was done from here.
const tele = new Telemetry((events) => {
  const home = machines[0];
  if (!home || !home.conn.ready) return false;
  home.conn.send({ t: 'track', events });
  return true;
});
/// By what means the next `show` was asked for — set by the caller that
/// knows, read and cleared by `show`. Only a change of terminal counts.
let showHow = 'other';
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
    state: {
      projects: [],
      terminals: [],
      agents: [],
      saved: [],
      scanning: true,
      hidden_sessions: [],
      dismissed_terminals: [],
    },
    terms: new Map(),
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
    current.pinnedProject = pinnedProject;
    current.browseRoot = browseRoot;
    current.host.hidden = true;
  }
  current = m;
  state = m.state;
  terms = m.terms;
  activeId = m.activeId;
  memById = m.memById;
  pinnedProject = m.pinnedProject;
  browseRoot = m.browseRoot || null;
  m.host.hidden = false;
  // After the swap, not before: the scope is read from the machine now showing.
  syncScope();
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
  acceptClipboardWrites(term);
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
  // `onKey`, not `onData`: the latter also carries xterm's own answers to the
  // shell's queries — cursor position, device attributes — which arrive within
  // milliseconds of opening and would pass for a keystroke.
  term.onKey(() => {
    const e = terms.get(id);
    if (!e || !e.openedAt || e.firstIn) return;
    // The number behind "it is drawn but does not take a keystroke yet": how
    // long after opening the first key was pressed. Not whether the agent
    // took it — that this side cannot see — but a person who has to wait
    // presses later, and that shows.
    e.firstIn = true;
    tele.track('first_input', { ms: Math.round(performance.now() - e.openedAt) });
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
  // is how you say you want it back. Applied locally right away, for the same
  // reason `closeView` does: the daemon's answer is on its way, not here yet.
  if (isClosed({ id })) {
    state.dismissed_terminals = state.dismissed_terminals.filter((x) => x !== id);
    conn.send({ t: 'set_dismissed', id, dismissed: false });
  }
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
  if (id !== activeId && activeId !== null) tele.track('switch', { how: showHow });
  showHow = 'other';
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
  paintTabs();
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
    ? state.terminals.filter((t) => t.alive && !isClosed(t)).map((t) => t.id)
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
  // Remembered first, and whether or not a view is open here: the strip lists
  // every live terminal, including the ones this page has never attached to.
  // After a reload that is *every* tab, so bailing out on a missing view meant
  // the ✕ did nothing at all on a freshly opened window — the case the fix was
  // reported against. The process is untouched either way; the row in the
  // sidebar still shows it running.
  // Applied here too, not only sent: the daemon's own answer would say the
  // same thing, but only after a round trip, and a tab that lingers until
  // then is a tab that looks like the click missed.
  if (!state.dismissed_terminals.includes(id)) {
    state.dismissed_terminals = [...state.dismissed_terminals, id];
  }
  conn.send({ t: 'set_dismissed', id, dismissed: true });
  tele.track('close_tab');
  const entry = terms.get(id);
  if (!entry) {
    renderTabs();
    return;
  }
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
  showNextAttach = current;
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

/// `pick` asks the agent to show its own session list instead of starting a new
/// conversation — `claude --resume` with nothing after it. Which session it then
/// opens is not known here; the daemon recognises it once the agent writes to
/// it, the same way it does for a session started fresh.
/// When the last terminal was asked for, so its arrival — and the first
/// output and keystroke after it — can be timed from the click.
let spawnAskedAt = 0;

function spawn(project, agent, resume, pick = false) {
  // The starting size is taken from the terminal on show, or from the stage size
  // when there is not one yet.
  const active = terms.get(activeId);
  const size = (active && proposed(active)) || { cols: 100, rows: 30 };
  showNextAttach = current;
  spawnAskedAt = performance.now();
  tele.track('spawn_ask', { agent, resume: !!resume, pick });
  conn.send({
    t: 'spawn',
    project,
    agent,
    resume: resume || null,
    pick,
    cols: size.cols,
    rows: size.rows,
  });
  // On a narrow screen the sidebar is a drawer covering the stage: opening a
  // terminal and leaving it open means the terminal is not visible.
  closeDrawerIfNarrow();
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
  return state.terminals.filter((t) => ids.has(t.id) || (t.alive && !isClosed(t)));
}

/// The menu behind a right-click, or a long press, on anything that stands for
/// one terminal — its tab, or any of its rows in the sidebar.
///
/// `ordering` is the tab strip's alone: moving a tab left is meaningless from a
/// sidebar row, which is not in that strip and does not move with it.
function terminalMenu(t, { ordering = false } = {}) {
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
  if (ordering) {
    const order = inTabOrder(visibleTerminals()).map((x) => x.id);
    const at = order.indexOf(t.id);
    if (at > 0) items.push({ label: 'Move left', run: () => nudgeTab(t.id, -1) });
    if (at >= 0 && at < order.length - 1) {
      items.push({ label: 'Move right', run: () => nudgeTab(t.id, 1) });
    }
  }

  // The same switch is on the saved row in the sidebar — but that row only
  // exists while nothing is running under the name, and something set to start
  // with the daemon is running nearly always. Without this the switch would be
  // reachable only by first stopping the thing you want to keep running.
  const saved = t.name
    ? state.saved.find((s) => s.name === t.name && samePath(s.project, t.project))
    : null;
  if (saved) {
    items.push({
      label: 'Autostart with sessionhub',
      on: saved.autostart,
      run: () => setAutostart(saved.project, saved.name, !saved.autostart),
    });
  }

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
/// Stop a whole set at once, asking once.
///
/// Not `killTerminal` in a loop: that asks per terminal, and confirming four
/// times to stop one app is how a confirmation stops being read.
function killGroup(ids, label) {
  if (!ids.length) return;
  const n = ids.length;
  if (!confirm(`Stop ${label}? That is ${n} terminal${n === 1 ? '' : 's'}, and whatever they run.`)) {
    return;
  }
  for (const id of ids) conn.send({ t: 'kill', id });
}

/// Restart a whole set. No question asked: a relaunch keeps the tab, the folder
/// and the session — it is the recovery, not the loss.
function relaunchGroup(ids) {
  for (const id of ids) relaunch(id);
}

/// Start the named ones that are not running.
function startGroup(list) {
  for (const s of list) openSaved(s.project, s.name);
}

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
  //
  // The agent itself is never spelled out here: the tab's icon says which one,
  // the same trade the sidebar already made.
  if (t.name) return `${basename(t.project)} · ${t.name}`;
  const session = state.projects
    .flatMap((p) => p.sessions)
    .find((s) => s.session_id && s.session_id === t.session_id);
  const title = session ? session.title : '';
  return `${basename(t.project)}${title ? ' · ' + title : ''}`;
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

/// Update what changes *inside* tabs that already exist: which one is active,
/// and the memory numbers. Both used to go through `renderTabs`, which throws
/// the strip away and builds every tab, every listener and the whole button bar
/// again. With the RAM display on that ran every two seconds for numbers alone.
///
/// It checks first that the strip is still showing exactly the right tabs in the
/// right order, and rebuilds when it is not. That check is what makes this safe
/// to call from anywhere: a caller never has to know whether the list changed.
function paintTabs() {
  const want = inTabOrder(visibleTerminals()).map((t) => String(t.id));
  const tabs = [...el.tabs.querySelectorAll('.tab')];
  if (tabs.length !== want.length || tabs.some((n, i) => n.dataset.id !== want[i])) {
    renderTabs();
    return;
  }
  for (const tab of tabs) {
    tab.classList.toggle('active', tab.dataset.id === String(activeId));
    const span = tab.querySelector('.mem');
    // Turning the display on adds a span that is not there yet, so that case
    // belongs to a full render rather than to this one.
    if (memOn !== !!span) {
      renderTabs();
      return;
    }
    if (!span) continue;
    const m = memById.get(Number(tab.dataset.id));
    span.textContent = m ? bytes(m.rss_bytes) : '…';
    if (m) span.title = `${m.processes} processes in this terminal's tree`;
  }
}

function renderTabs() {
  // Never while a tab is being dragged. This rebuilds every element in the
  // strip, and the one under the cursor would go with them. The agents in these
  // terminals touch their session files constantly, each touch a registry scan
  // and a fresh state, so without this a drag rarely lives long enough to be
  // dropped. `dragend` draws whatever was missed.
  if (dragging !== null) return;
  el.tabs.textContent = '';
  // Tabs scroll inside their own strip; the buttons on the right stay put. In one
  // container the buttons would be pushed off screen as soon as there are many
  // tabs.
  const strip = document.createElement('div');
  strip.className = 'tabstrip';
  // A mouse wheel only turns one way, and the strip only scrolls the other.
  // With its scrollbar hidden on purpose, a laptop without a touchpad had no
  // way along it at all — so the wheel's vertical motion is turned sideways
  // here. `deltaX` is honoured too, so a touchpad's real sideways swipe still
  // does what it always did.
  strip.addEventListener(
    'wheel',
    (e) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d || strip.scrollWidth <= strip.clientWidth) return;
      e.preventDefault();
      strip.scrollLeft += d;
    },
    { passive: false },
  );
  el.tabs.appendChild(strip);

  const list = inTabOrder(visibleTerminals());

  for (const t of list) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (t.id === activeId ? ' active' : '') + (t.alive ? '' : ' dead');
    tab.setAttribute('role', 'tab');
    tab.dataset.id = String(t.id);
    tab.title = `${t.project}\n${t.agent} · ${t.cols}×${t.rows}`;

    // The icon comes first, before the name — a glance down the strip answers
    // "which agent, and which of these is still working" without reading
    // anything. The activity mark used to be a separate dot; now it rings the
    // icon instead, so the icon itself carries both facts. The strip is
    // rebuilt often, so the classes are re-derived from the entry.
    const act = terms.get(t.id);
    const icon = agentIcon(t.agent, agentSlot(state.agents, t.agent));
    icon.classList.toggle('busy', act?.streaming === true);
    icon.classList.toggle('done', !act?.streaming && act?.done === true);
    tab.appendChild(icon);

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

    tab.onclick = () => {
      showHow = 'tab';
      if (terms.has(t.id)) show(t.id);
      else attach(t.id);
    };
    bindMenu(tab, () => terminalMenu(t, { ordering: true }));

    // Dragging to reorder, wherever there is something that can point. On a
    // touch screen the strip scrolls sideways and a long press already belongs
    // to this tab's menu, so a drag would be competing for both gestures at
    // once; there, the menu carries "Move left" and "Move right" instead.
    //
    // The question is "is there a mouse" and not "is this a touch device": a
    // laptop with a touchscreen answers the second one wrongly on some builds,
    // and lost dragging while its trackpad sat right there.
    if (hasFinePointer()) {
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
        // Whatever changed while the strip was held still.
        renderTabs();
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
        const moved = dragging;
        dragging = null;
        moveTabTo(moved, before === moved ? null : before);
      });
    }

    strip.appendChild(tab);
  }

  const tools = document.createElement('div');
  tools.className = 'tools';

  // How busy the machine is. Text rather than a button — there is nothing to
  // press — and it sits with the controls instead of in the tab strip, which is
  // already short of room. A daemon too old to send this never does, and then
  // there is nothing here at all.
  if (current && current.load) {
    const stat = document.createElement('span');
    stat.id = 'loadstat';
    paintLoad(stat, current.load);
    tools.appendChild(stat);
  }

  // Shown at every width. On a narrow screen the sidebar is a drawer and this
  // is the only way back to it; on a wide one it is a column that can be got out
  // of the way, which is the same question asked of a bigger screen — and the
  // answer used to be a keyboard shortcut nobody had been told about.
  const menuBtn = document.createElement('button');
  menuBtn.id = 'menu-btn';
  menuBtn.textContent = '☰';
  // Read from the DOM for the same reason the Files button is: this bar is
  // drawn before anything holds that state.
  const railOn = !el.sidebar.hidden;
  menuBtn.className = railOn ? 'on' : '';
  menuBtn.title = railOn ? 'Hide the project list' : 'Show the project list';
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
    layoutBtn.onclick = () => {
      tele.track('layout', { grid: layout !== 'grid' });
      setLayout(layout === 'grid' ? 'tabs' : 'grid');
    };
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
    kbBtn.title = keybar.on ? 'Hide the key bar' : 'Show Esc, Enter, and arrow keys';
    kbBtn.onclick = () => {
      keybar.toggle();
      tele.track('keybar', { on: keybar.on });
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
    setAutostart,
    setHiddenSession,
    explorerRoot,
    saveCollapsed,
    saveBookmarks,
    attach,
    spawn,
    show,
    focusProject,
    openMenu,
    closeMenu,
    openSettings,
    killGroup,
    relaunchGroup,
    startGroup,
    samePath,
    bindMenu,
    terminalMenu,
    killTerminal,
    forkSession,
    closeDrawerIfNarrow,
    rerender: renderTree,
  };
}

function renderTree() {
  // The tab strip in the file panel follows the same answer the sidebar is
  // being drawn from, so it is kept here rather than chased through every place
  // that can change which project is showing. `setScope` returns at once when
  // nothing moved.
  syncScope();
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
    // The folder rides in the title. It is worth saying - the same name in two
    // projects is two different entries - but not worth a line of its own.
    title: already
      ? `Rename ${already.name}`
      : `Save terminal ${id} in ${basename(t.project)}`,
    label1: 'Name',
    value1: t.name || '',
    label2: 'Run when opened',
    value2: suggested,
    hint2: 'leave empty to just open a shell',
    ok: 'Save',
    // Asked here rather than left to be found later on the row: this is the
    // moment you know whether the thing you are naming is a service you want up
    // or a command you will run when you want it. Saving over an entry offers
    // back what it is already set to.
    check: {
      label: 'Autostart with sessionhub',
      on: already ? already.autostart : true,
    },
  });
  if (answer === null) return;
  conn.send({
    t: 'save_terminal',
    id,
    name: answer.first,
    command: answer.second,
    autostart: answer.third,
  });
}

/// Open a saved terminal — its shell, its folder, its command.
function openSaved(project, name) {
  const active = terms.get(activeId);
  const size = (active && proposed(active)) || { cols: 100, rows: 30 };
  showNextAttach = current;
  conn.send({ t: 'open_saved', project, name, cols: size.cols, rows: size.rows });
  closeDrawerIfNarrow();
}

/// Start it with the daemon, or stop doing that. Nothing starts or stops now:
/// this is about the next time the daemon comes up.
function setAutostart(project, name, on) {
  conn.send({ t: 'set_autostart', project, name, on });
}

/// Take a session out of "live & today", or put it back. Kept on the daemon,
/// not in this browser: the same choice reads the same way from a phone.
function setHiddenSession(sessionId, hidden) {
  conn.send({ t: 'set_hidden_session', session_id: sessionId, hidden });
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
    // A row that builds itself. Most menu entries are a word and an action, but
    // the one for starting an agent carries two buttons — New and Resume are
    // different answers to the same question and reading the list twice to find
    // the second was the whole problem with the old shape.
    if (it.node) {
      el.menu.appendChild(it.node);
      continue;
    }
    if (it.sep) {
      el.menu.appendChild(document.createElement('hr'));
      continue;
    }
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
    // A dot, so a plain row lines up with the agent rows above it. Muted and
    // colourless on purpose: it marks the column, it does not claim an identity
    // the way an agent's colour does.
    if (it.dot) {
      // Built then prepended: `prepend` answers with undefined, not the node,
      // and setting a class on that throws in the middle of building the menu —
      // which loses every row after this one.
      const mark = document.createElement('span');
      mark.className = 'dot mdot-plain';
      d.prepend(mark);
      d.classList.add('mwide');
    }
    // A quiet word at the right end — what the row will actually run, when the
    // label alone does not say it.
    if (it.hint) {
      const h = document.createElement('span');
      h.className = 'mhint';
      h.textContent = it.hint;
      d.appendChild(h);
      d.classList.add('mwide');
    }
    if (it.on) d.classList.add('mon');
    d.onclick = () => {
      closeMenu();
      it.run();
    };
    el.menu.appendChild(d);
  }
  // Placed where the finger is, then pulled back inside the screen.
  //
  // A menu opened from the ＋ at the right edge of a sidebar row used to run
  // 170px past the edge of a phone, and the half that went missing was the
  // half that mattered: `elementFromPoint` on the Resume button answered null,
  // because there was nothing there to touch.
  //
  // Measured after it is shown — the width depends on the longest agent name,
  // which is only known once the rows exist. `clientWidth` rather than
  // `innerWidth`: the latter grows with the very overflow this prevents.
  el.menu.style.left = '0px';
  el.menu.style.top = '0px';
  el.menu.hidden = false;
  const pad = 8;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const box = el.menu.getBoundingClientRect();
  const left = Math.max(pad, Math.min(x, vw - box.width - pad));
  // Below the finger when there is room, above it when there is not. Half a
  // menu hanging off the bottom is the same problem turned ninety degrees.
  const top = y + box.height > vh - pad ? Math.max(pad, y - box.height) : y;
  el.menu.style.left = `${left}px`;
  el.menu.style.top = `${top}px`;
}
function closeMenu() {
  el.menu.hidden = true;
}

/// Open `items()` where the pointer is: a right-click, or a long press where
/// there is no right button to click.
///
/// One implementation for the tab strip and the sidebar both. It is the same
/// question asked of the same terminal, and a phone that learns the gesture in
/// one place should not find nothing in the other.
function bindMenu(node, items) {
  const menuFor = (x, y) => {
    const list = items();
    // A terminal can end between the press and the release. An empty box that
    // opens where a menu was expected is worse than no menu at all.
    if (list.length) openMenu(x, y, list);
  };
  node.oncontextmenu = (e) => {
    e.preventDefault();
    menuFor(e.clientX, e.clientY);
  };
  let hold = null;
  let held = false;
  node.addEventListener(
    'touchstart',
    (e) => {
      held = false;
      const p = e.touches[0];
      hold = setTimeout(() => {
        held = true;
        menuFor(p.clientX, p.clientY);
      }, 500);
    },
    { passive: true },
  );
  const drop = () => clearTimeout(hold);
  node.addEventListener('touchmove', drop, { passive: true });
  node.addEventListener('touchend', (e) => {
    drop();
    // The menu is already open; letting the tap through would also act on what
    // was pressed — switching tabs, or opening a session.
    if (held) e.preventDefault();
  });
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

/// `CPU 7% · 7.5/15.6 GB` — the machine, not the terminal.
function paintLoad(el, load) {
  const gb = (n) => (n / 1073741824).toFixed(1);
  const cpu = Math.round(load.cpu_percent);
  el.textContent = `CPU ${cpu}% · ${gb(load.ram_used)}/${gb(load.ram_total)} GB`;
  // A machine pinned at its ceiling is worth seeing without reading the number,
  // which is the whole reason this readout is here.
  el.className = cpu >= 90 ? 'hot' : '';
  el.title = 'The whole machine — every core, and all of its memory. Not this terminal.';
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
/// Notice work that has just finished under a terminal.
///
/// Compared against the last state message rather than polled: the daemon only
/// speaks when something changed, so a `working` that went true → false is the
/// completion itself. What it was called comes from the job list as it was
/// *before* it emptied — afterwards there is nothing left to name.
function noteBackground(m, fresh) {
  const was = m.background || new Map();
  const now = new Map();
  for (const t of fresh) {
    if (t.working === true) now.set(t.id, t.jobs || []);
  }
  m.background = now;

  for (const [id, jobs] of was) {
    if (now.has(id)) continue;
    const entry = m.terms.get(id);
    // The agent may still be mid-sentence — a subagent that finished while the
    // conversation carries on is not the end of anything worth a chime.
    if (entry?.streaming) continue;
    if (lookedAt(m, id)) continue;
    if (entry) entry.done = true;
    else (m.finished ||= new Set()).add(id);
    if (soundOn) ding();
    announceDone(m, id, jobs[0]?.label || '');
  }
  // After the bookkeeping, so a rise and a fall are both drawn in one pass.
  paintAllActivity(m);
}

function announceDone(m, id, job = '') {
  const t = m.state.terminals.find((x) => x.id === id);
  if (!t) return;
  const session = m.state.projects
    .flatMap((p) => p.sessions)
    .find((s) => s.session_id && s.session_id === t.session_id);
  // The job's own name when there is one: "Download Detour final film
  // finished" is the sentence you were waiting for, and the session title is
  // not.
  const what = job || t.name || session?.title || `terminal ${t.id}`;
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
  showHow = 'sidebar';
  if (terms.has(id)) show(id);
  else attach(id);
  closeDrawerIfNarrow();
}

/// Work running under a terminal that is not the agent itself.
///
/// The daemon watches the process tree for this, which is the only way to tell
/// "the agent stopped talking" from "the work is over". A background download
/// writes nothing to the PTY, so the output-timing heuristic below sees silence
/// and would otherwise call it finished with two hours left to run.
function backgroundOf(m, id) {
  const t = m.state.terminals.find((x) => x.id === id);
  return { working: t?.working === true, jobs: t?.jobs || [] };
}

/// Is this terminal the thing the user is looking at right now?
const lookedAt = (m, id) =>
  m === current && id === activeId && document.hasFocus() && !document.hidden;

/// Repaint one terminal's activity mark wherever it shows: its tab (current
/// machine only — the strip is per machine) and its rows in the sidebar. Both
/// carry the id in a data attribute precisely so this never rebuilds anything.
function paintActivity(m, id, entry) {
  const busy = entry.streaming === true;
  // Streaming wins: while the agent is talking, that is the more immediate
  // fact. Background work only claims the mark once the terminal goes quiet.
  const working = !busy && backgroundOf(m, id).working;
  const done = !busy && !working && (entry.done === true || m.finished?.has(id) === true);
  if (m === current) {
    const icon = el.tabs.querySelector(`.tab[data-id="${id}"] .aicon`);
    if (icon) {
      icon.classList.toggle('busy', busy);
      icon.classList.toggle('bgwork', working);
      icon.classList.toggle('done', done);
    }
    for (const row of el.tree.querySelectorAll(`[data-tid="${id}"] .aicon`)) {
      row.classList.toggle('busy', busy);
      row.classList.toggle('bgwork', working);
      row.classList.toggle('done', done);
    }
  }
}

/// Repaint every live terminal's mark.
///
/// `paintActivity` needs an entry for the output-timing half; a terminal this
/// browser never attached to has none, and an empty object is the honest stand
/// in — not streaming, not done, and the background half comes from the state
/// message either way.
function paintAllActivity(m) {
  for (const t of m.state.terminals) {
    if (t.alive) paintActivity(m, t.id, m.terms.get(t.id) || {});
  }
}

/// The clock side of the heuristic: output marks the entry busy the moment it
/// arrives (in `onOutput`); this sweep is what notices the silence afterwards.
setInterval(() => {
  const now = performance.now();
  // The age on each background job line. Only while something is running, so
  // the usual case costs one map lookup.
  if (current?.background?.size) {
    for (const line of el.tree.querySelectorAll('.zjob[data-since]')) {
      const age = line.querySelector('.zjage');
      if (age) age.textContent = elapsedShort(Number(line.dataset.since));
    }
  }
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
      // The agent has stopped, but what it started has not. Announcing it now
      // would be the one thing worse than saying nothing: it is exactly the
      // moment you would walk away. The announcement waits for the tree to go
      // quiet, in `onState` below.
      if (backgroundOf(m, id).working) {
        paintActivity(m, id, entry);
        continue;
      }
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
  const kept = current?.finished?.delete(id);
  if (entry?.done || kept) {
    if (entry) entry.done = false;
    paintActivity(current, id, entry || {});
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
  showHow = 'palette';
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
  // Through the facade, like the LAN switch beside it: what is being allowed or
  // refused belongs to the machine whose settings are on screen.
  (enabled) => conn.send({ t: 'set_remote_commands', enabled }),
  // Also through the facade: the token being replaced belongs to the machine
  // whose settings are open, not to whichever one the browser happens to be
  // talking to.
  () => conn.send({ t: 'rotate_token' }),
  // The skill teaches an agent running ON that machine how to reach the others,
  // so it is written where that agent lives — the machine the panel is showing.
  () => conn.send({ t: 'install_skill' }),
  (limits) => conn.send(limits ? { t: 'set_drops', ...limits } : { t: 'sweep_drops' }),
  (name) => conn.send({ t: 'remove_agent', name }),
  // Forgetting a machine always goes to the LOCAL daemon: the paired list is its
  // own, not that of the machine being looked at.
  (name) => local.conn.send({ t: 'forget', name }),
  // And so does moving one: the address being changed is the one this machine
  // dials, whoever is on screen at the time.
  (name, addr) => local.conn.send({ t: 'set_remote_addr', name, addr }),
  // Renaming likewise: the name being changed is the one THIS machine files it
  // under. The machine on the other end never hears about it and does not need
  // to — it does not know what it is called here.
  (name, to) => local.conn.send({ t: 'set_remote_name', name, to }),
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
    showNextAttach = current;
    conn.send({ t: 'update_agent_cli', name, cols: size.cols, rows: size.rows });
    settings.close();
  },
  // Through the facade, so a remote machine's panel arranges hostnames on that
  // machine's own tunnel — every machine has its own.
  (api_token, zone_id, tunnel_id) =>
    conn.send({ t: 'set_cloudflare', api_token, zone_id, tunnel_id }),
  (url) => conn.send({ t: 'add_forward', url }),
  (name) => conn.send({ t: 'remove_forward', name }),
);

// Which address network access uses. Through the facade, like the switch it
// belongs beside: the addresses being chosen between are those of the machine
// whose panel is open.
settings.onLanAddr = (addr) => conn.send({ t: 'set_lan_addr', addr });

/// OSC 52 — how a program inside the terminal says "put this on the clipboard".
///
/// It is the only way out for anything drawing its own selection. Claude Code
/// turns on mouse reporting and selects for itself, so a drag never reaches the
/// browser; when it says "copied", this sequence is what it sent. xterm.js
/// dispatches OSC only to handlers that are registered, and it registers none
/// for 52 — so without this the sequence is dropped, the clipboard keeps what
/// it had, and the paste that follows produces the *previous* thing. The
/// message is not wrong; there was simply nothing on this end listening.
///
/// Writes only. `52;c;?` asks the terminal to send the clipboard **back** to
/// the program: whatever you last copied anywhere, handed to whatever is
/// running here, and over the wire if that is another machine. Nothing needs
/// that, and it is refused.
/// A selection can be long, but not unbounded: this arrives from a program, and
/// a runaway one must not be able to hand the browser a hundred megabytes to
/// hold.
const MAX_OSC_CLIP = 1 << 20;

function acceptClipboardWrites(term) {
  term.parser.registerOscHandler(52, (data) => {
    // `<targets>;<payload>` — which selection (clipboard, primary, cut buffer).
    // There is one clipboard in a browser, so the targets are read only far
    // enough to find the payload.
    const cut = data.indexOf(';');
    if (cut < 0) return true;
    const payload = data.slice(cut + 1);
    if (payload === '?') return true;
    // Base64 of UTF-8 bytes, so decoding is two steps: `atob` gives bytes as
    // code units, and only then is it text. Doing it in one loses every
    // character above ASCII.
    let text;
    try {
      const raw = atob(payload);
      const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
      text = new TextDecoder().decode(bytes);
    } catch {
      return true; // Not base64. Nothing to do, and nothing worth saying.
    }
    if (!text || text.length > MAX_OSC_CLIP) return true;
    clipboardFromTerminal(text);
    return true;
  });
}

/// Said once per session. The program copies on every selection, and a notice
/// on every one of those would be its own kind of broken.
let clipboardNoteShown = false;

function clipboardFromTerminal(text) {
  if (canCopy()) {
    // Quiet on success: whatever asked for this already said so in its own
    // words, and two notifications for one act is one too many. A failure is
    // different — silence there would let a copy that did not happen look
    // exactly like one that did.
    copyText(text).then((ok) => {
      if (ok) return;
      toasts.show({
        key: 'osc-clip',
        title: 'The copy did not go through',
        note: 'The browser refused the clipboard. Click the page and try again.',
      });
    });
    return;
  }
  if (clipboardNoteShown) return;
  clipboardNoteShown = true;
  toasts.show({
    key: 'osc-clip',
    title: 'Copying needs https',
    note: 'A program here copied something, but a page on plain http is not allowed to touch the clipboard. Open sessionhub over https and it will work.',
  });
}

/// Can this page put something on the clipboard by itself?
///
/// Only in a secure context: `https://`, or loopback, which browsers count as
/// secure. Over plain HTTP at a LAN address — the way this panel is most often
/// opened from a phone — `navigator.clipboard` is simply not there.
///
/// The deprecated `document.execCommand('copy')` is deliberately not used as a
/// fallback. It works in some browsers and not others, and worse, several
/// mobile ones answer `true` having copied nothing — a claim that something is
/// on the clipboard when it is not is worse than saying plainly that it cannot
/// be done.
const canCopy = () => window.isSecureContext && !!navigator.clipboard?.writeText;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Present but refused — a permissions policy, or a page that lost focus.
    return false;
  }
}

/// Open Settings, optionally straight at one section.
///
/// Shared by the toolbar button and by anything that needs to send someone to
/// the place a problem is fixed — the ＋ menu points at Agents when an agent's
/// command cannot be found.
function openSettings(section) {
  tele.track('settings', { section: section || '' });
  // What an update would cost, counted fresh each time the panel opens.
  settings.liveTerminals = state.terminals.filter((t) => t.alive).length;
  settings.setMachine(current);
  if (section) settings.section = section;
  settings.show();
  conn.send({ t: 'config' });
  closeDrawerIfNarrow();
}

document.getElementById('settings-btn').onclick = () => openSettings();

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
  // The ☰ button carries this state now, the way Files carries its own.
  renderTabs();
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
  showHow = 'key';
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
    tele.track('palette');
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

/// The one way the search box changes.
///
/// Everything goes through here — typing, Escape, the ✕, and adding a project —
/// so the ✕ can never be left showing over an empty box, or missing over a full
/// one. It was set from four places before; a fifth would have been the one
/// that forgot.
function setFilter(value, { focus = false } = {}) {
  el.filter.value = value;
  el.filterClear.hidden = value === '';
  renderTree();
  if (focus) el.filter.focus();
}

el.filter.addEventListener('input', () => setFilter(el.filter.value));
el.filter.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setFilter('');
    el.filter.blur();
  }
  e.stopPropagation(); // ordinary typing belongs to this box, not to a shortcut
});
el.filterClear.onclick = () => {
  // The cursor goes back in the box on a desktop, where clearing usually means
  // "let me type something else". On a phone it does not: the keyboard would
  // come straight back up over the list that was the reason for clearing.
  setFilter('', { focus: !window.matchMedia('(pointer: coarse)').matches });
};

// --------------------------------------------------------------- file panel

// One panel, one tab bar: `Files` is always there, and each file adds its own
// tab. Monaco is only downloaded when the first file is opened.
sidePanel = new SidePanel(el.side, {
  list: (path) => conn.send({ t: 'tree', path }),
  open: (path) => conn.send({ t: 'open_file', path }),
  save: (path, text) => conn.send({ t: 'save_file', path, text }),
  // The Explorer shows one folder at a time: the project being worked on, or
  // wherever the `..` row has been walked to since.
  root: () => treeRoot(),
  // Where `..` goes. The path was named by the listing it came from, so this
  // side never has to work out what the folder above is called.
  up: (path, name) => browseTo(path, name),
  // Quoted only when it needs to be — the same rule a dropped file already
  // follows, so what lands on the clipboard can be pasted straight into a
  // terminal without a path with spaces in it falling apart.
  copy: async (path) => {
    const text = quotePath(path);
    if (canCopy() && (await copyText(text))) {
      toasts.show({ key: 'copy-path', title: 'Path copied', note: text });
      return;
    }
    // Over plain HTTP no browser will hand the page a clipboard, so there is
    // nothing to try and nothing to wait for: the path goes straight into a
    // field, already selected, and one long-press copies it. Telling someone to
    // copy it by hand is only advice if the thing to copy is somewhere they can
    // reach.
    await ask.show({
      title: 'Copy path',
      value: text,
      note: window.isSecureContext
        ? 'This browser would not let the page reach the clipboard. The path is selected — copy it from here.'
        : 'Copying straight to the clipboard needs https, and this page is on plain http. The path is selected — copy it from here.',
      ok: 'Done',
    });
  },
  projects: () => state.projects.filter((p) => p.exists).map((p) => ({ path: p.path, name: p.name })),
  // Picking a project is the way back from wherever `..` led.
  pick: (path) => {
    pinnedProject = path;
    browseRoot = null;
    sidePanel.syncRoots();
    syncScope();
  },
  theme: () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
  // The same context menu as the sidebar and the folder picker, so the explorer
  // does not grow a third one that drifts.
  menu: (x, y, items) => openMenu(x, y, items),
  make: {
    ask: (dir, folder) =>
      ask.show({
        title: dir ? 'New folder' : 'New file',
        // A file usually wants its extension typed, so nothing is prefilled;
        // the note says where it will land, which is the thing that is easy to
        // get wrong when the tree is deep.
        value: '',
        note: `In ${folder}`,
        ok: 'Create',
      }),
    send: (parent, name, dir) => conn.send({ t: 'make_entry', parent, name, dir }),
  },
  /// A shell in the folder that was right-clicked. Deliberately not routed
  /// through `add_project`: a folder inside a project is not a project of its
  /// own, and the sidebar should not fill up with subdirectories.
  shell: (path) => {
    spawn(path, 'terminal', null);
    closeDrawerIfNarrow();
  },
  /// Which machine the open files belong to. The image viewer fetches over HTTP
  /// rather than the socket, so it is the one thing that has to be told.
  via: () => current?.via || '',
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
    // Tabs remembered from last time have been sitting there without contents,
    // deliberately: fetching one loads Monaco, and a closed panel has no use
    // for it.
    sidePanel.wake();
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
conn.on.onMade = (msg) => sidePanel.tree.made(msg);
conn.on.onFile = (msg) => sidePanel.openFile(msg);
conn.on.onSaved = (msg) => {
  sidePanel.editor.saved(msg.path);
  banner(`Saved ${msg.path.split(/[\/]/).pop()}`, true);
};

/// The width of the screen, which is not `window.innerWidth`.
///
/// Once the row is wider than the window it overflows and `innerWidth` grows
/// with it — so a ceiling computed from it recedes as the panel is dragged, and
/// stops being a ceiling at all. `documentElement.clientWidth` stays put.
function screenWidth() {
  return document.documentElement.clientWidth || window.innerWidth;
}

/// How wide the file panel is allowed to get: the screen, less the sidebar
/// beside it and a strip of terminal.
///
/// It used to be a flat 900px — most of a laptop screen, and on a tablet a
/// ceiling that could not be reached without the row overflowing and carrying
/// the terminal off the edge. What has to be protected is what is beside the
/// panel, not a number: on a wide screen this is now far past 900, and on a
/// narrow one it stops before the layout breaks.
function widestSide() {
  const rail = el.sidebar.hidden ? 0 : el.sidebar.offsetWidth;
  return Math.max(200, screenWidth() - rail - 200);
}

// The panel width is stored so your working layout is not rearranged every time
// the page opens. It is clamped rather than rejected on the way back in: a width
// dragged out on a wide screen must not be thrown away by a narrow one — or by
// the same tablet turned on its side.
{
  const saved = Number(localStorage.getItem(LS.filesWidth));
  if (saved >= 200) el.side.style.width = `${Math.min(saved, widestSide())}px`;
}
// Pointer events, not mouse events: a finger drag fires neither `mousedown` nor
// `mousemove`, so on a tablet this handle did nothing at all and the panel was
// stuck at whatever width it happened to have. Capture keeps the drag with the
// handle even when the pointer runs ahead of it.
el.fsplit.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  el.fsplit.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const w = Math.min(widestSide(), Math.max(200, screenWidth() - ev.clientX));
    el.side.style.width = `${w}px`;
    localStorage.setItem(LS.filesWidth, String(w));
    relayout();
    sidePanel.editor.relayout();
  };
  const up = (ev) => {
    el.fsplit.releasePointerCapture(ev.pointerId);
    el.fsplit.removeEventListener('pointermove', move);
    el.fsplit.removeEventListener('pointerup', up);
    el.fsplit.removeEventListener('pointercancel', up);
  };
  el.fsplit.addEventListener('pointermove', move);
  el.fsplit.addEventListener('pointerup', up);
  el.fsplit.addEventListener('pointercancel', up);
});

if (localStorage.getItem(LS.filesOpen) === '1') sidePane.show();

// ------------------------------------------------------------- new project

picker = new Picker(document.body, {
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
  recall: () => {
    // One key held the folder for every machine until this became per machine.
    // Read it once for this computer — where it was at least correct — and then
    // take it out rather than leaving it behind forever.
    const stale = localStorage.getItem('sh.picker.path');
    if (stale !== null) {
      localStorage.removeItem('sh.picker.path');
      if (!localStorage.getItem(LS.pickerPath + 'local')) {
        localStorage.setItem(LS.pickerPath + 'local', stale);
      }
    }
    return localStorage.getItem(LS.pickerPath + (current?.id || 'local')) || '';
  },
  remember: (path) =>
    localStorage.setItem(LS.pickerPath + (current?.id || 'local'), path),
  // The same agents, the same menu, as the ＋ on a sidebar project row — the
  // daemon only ever sends the enabled ones, so no filtering here either.
  agents: () => state.agents,
  menu: (x, y, items) => openMenu(x, y, items),
  closeMenu: () => closeMenu(),
  openSettings: (section) => openSettings(section),
  // What the picker cannot know on its own: a folder it is looking at may
  // already be a project with history, and then its agent rows should show the
  // same counts and offer the same Resume as the sidebar does.
  sessionsFor: (path) => (state.projects.find((p) => p.path === path) || {}).sessions || [],
  liveIn: (path) => state.terminals.filter((t) => t.alive && t.project === path).map((t) => t.agent),
  // Choosing an agent from the picker: what the dialog was really opened for.
  // Adding the project is bookkeeping that comes along — through the same
  // `add_project` path as the add-only button, so the reveal-in-sidebar and
  // the error handling that path already has keep working.
  track: (e, fields) => tele.track(e, fields),
  openWith: (path, agent, isProject, o) => {
    if (!isProject) {
      awaitingProject = path;
      conn.send({ t: 'add_project', path });
    }
    if (o.resume) spawn(path, agent, o.resume);
    else spawn(path, agent, null, !!o.pick);
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

const savedWidth = Number(localStorage.getItem(LS.width));
if (savedWidth >= 160 && savedWidth <= 600) el.sidebar.style.width = `${savedWidth}px`;

// Pointer events for the same reason the file panel's handle uses them: a
// finger drag is not a mouse drag.
el.splitter.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  el.splitter.setPointerCapture(e.pointerId);
  const move = (ev) => {
    // Never past the point where the terminal between the two panes disappears:
    // the file panel's ceiling accounts for this rail, so this one accounts for
    // the panel, and whichever is dragged the terminal keeps its strip.
    const room = screenWidth() - (el.side.hidden ? 0 : el.side.offsetWidth) - 200;
    const w = Math.min(600, Math.max(160, Math.min(ev.clientX, room)));
    el.sidebar.style.width = `${w}px`;
    localStorage.setItem(LS.width, String(w));
    relayout();
  };
  const up = (ev) => {
    el.splitter.releasePointerCapture(ev.pointerId);
    el.splitter.removeEventListener('pointermove', move);
    el.splitter.removeEventListener('pointerup', up);
    el.splitter.removeEventListener('pointercancel', up);
  };
  el.splitter.addEventListener('pointermove', move);
  el.splitter.addEventListener('pointerup', up);
  el.splitter.addEventListener('pointercancel', up);
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
window.addEventListener('resize', () => {
  // A tablet turned on its side arrives here: a width dragged out in landscape
  // is wider than the whole screen in portrait and would carry the terminal off
  // the edge. What was stored is what was ASKED for, and it is left alone; only
  // what is shown is cut to fit — so turning the tablet back gives the width
  // back rather than leaving a column that has to be dragged out again.
  if (!el.side.hidden) {
    const want = Number(localStorage.getItem(LS.filesWidth)) || el.side.offsetWidth;
    const fits = Math.min(Math.max(200, want), widestSide());
    if (Math.round(el.side.offsetWidth) !== Math.round(fits)) {
      el.side.style.width = `${fits}px`;
    }
  }
  relayout();
});

// --------------------------------------------------------------- connection

conn.on.onStatus = (kind, m) => {
  const was = m ? m.status : null;
  if (m) {
    m.status = kind;
    machineBar.paint(current);
  }
  // A background machine going down must not hijack the banner: it is not what
  // the user is looking at, and the dot on its tab already says so.
  if (m && m !== current) return;
  const retry = {
    label: 'Retry now',
    run: () => {
      if (!m) return;
      tele.track('retry', { remote: !!m.via });
      m.conn.retry();
    },
  };
  if (m && kind === 'lost' && was !== 'lost') {
    m.lostAt = performance.now();
    tele.track('conn_lost', { remote: !!m.via });
  }
  if (m && kind === 'open' && m.lostAt) {
    tele.track('conn_back', { remote: !!m.via, ms: Math.round(performance.now() - m.lostAt) });
    m.lostAt = 0;
  }
  if (kind === 'connecting') {
    // Every reconnect passes through here too; the "lost" strip already on
    // show says all there is to say, and swapping its text on each attempt
    // would only make it flicker.
    if (was === 'lost') return;
    // Not at once: most handshakes finish in well under a second, and a strip
    // that flashes on every page load says nothing. One that is still there
    // after a moment is the one that matters — a bad link can hold a handshake
    // for a long time, and until now there was nothing to press but reload.
    const who = m && m.via ? `Connecting to ${m.label}…` : 'Connecting…';
    bannerSoon(who, retry);
    return;
  }
  if (kind === 'lost') {
    banner('Connection lost, reconnecting…', false, retry);
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

/// Show the next terminal the daemon opens for us, rather than only tabbing it.
///
/// `onAttached` deliberately moves nobody: it fires for every terminal being
/// reattached after a reconnect too, and being thrown at whichever one answered
/// first is worse than staying put. But a terminal that exists only because the
/// user asked for it has to be the one on screen. Set by every path that asks
/// for one — a new terminal, a fork, a saved terminal, the agent updater —
/// because landing back on the terminal that was already there makes the click
/// look like it did nothing at all.
///
/// One shot, and only for a terminal this page did not already have, so a
/// reconnect that races the request cannot consume it. It holds the machine the
/// request went to rather than a plain `true`: a reply for a machine no longer
/// showing is dropped without a word, and a claim left standing would be handed
/// to whatever opened next on the machine you had moved to.
let showNextAttach = null;

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
  st.hidden_sessions = msg.hidden_sessions || [];
  st.dismissed_terminals = msg.dismissed_terminals || [];
  // Before anything is drawn, and for background machines too — a machine whose
  // daemon restarted while it sat in another tab must not come back holding
  // stale tabs.
  noteBackground(m, msg.terminals || []);
  if (m !== current) return;
  if (pendingReattach) {
    pendingReattach = false;
    reattachAll();
  }
  renderTree();
  renderTabs();
  paintAllActivity(m);
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
  setFilter('');
  const row = el.tree.querySelector(`[data-path="${cssEscape(found.path)}"]`);
  if (row) row.scrollIntoView({ block: 'center' });
  banner(`${basename(found.path)} added — use + on its row to start an agent.`, true);
}

conn.on.onAttached = (msg, m) => {
  if (m !== current) return;
  const asked = showNextAttach === m && !terms.has(msg.id);
  if (asked) showNextAttach = null;
  const entry = terms.get(msg.id) || makeTerminal(msg.id);
  entry.awaitingReplay = false;
  if (asked) {
    // The clock the first output and the first keystroke are read against.
    entry.openedAt = performance.now();
    tele.track('opened', { ms: Math.round(entry.openedAt - spawnAskedAt) });
  }
  entry.term.resize(msg.cols, msg.rows);
  if (asked || activeId === null || activeId === msg.id) show(msg.id);
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
    if (entry.openedAt && !entry.firstOut) {
      entry.firstOut = true;
      tele.track('first_output', { ms: Math.round(performance.now() - entry.openedAt) });
    }
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
  tele.track('error', { code: msg.code || '', remote: !!(m && m.via) });
  // Whatever was going to open did not. Leaving the claim standing would give it
  // to the next terminal opened for any reason at all.
  showNextAttach = null;
  // Asked for from the Settings panel, so answered there — the ＋ Connect box
  // this would otherwise land in may not even be open.
  if (msg.code === 'cloudflare_failed' || msg.code === 'bad_target') {
    settings.moveFailed(msg.message || msg.code);
    if (!settings.open) banner(msg.message, true);
    return;
  }
  if (msg.code === 'move_failed' || msg.code === 'rename_failed' || msg.code === 'bad_addr') {
    settings.moveFailed(msg.message || msg.code);
    if (!settings.open) banner(msg.message, true);
    return;
  }
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
  if (msg.code === 'open_failed') {
    // A tab remembered from last time can point at a file that has since been
    // deleted or renamed. It takes itself out rather than sitting there unable
    // to open.
    sidePanel.openFailed();
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

conn.on.onCloudflare = (msg, m) => {
  // Only for the machine on screen: an answer from a background machine must
  // not redraw the panel someone is looking at.
  if (m !== current) return;
  settings.setCloudflare(msg.cloudflare);
};

conn.on.onUpdate = (msg, m) => {
  // Only for the machine being looked at: a check answered by a background
  // machine must not overwrite what the open panel is showing.
  if (m !== current) return;
  settings.setRelease(msg);
};

conn.on.onLoad = (msg, m) => {
  m.load = msg;
  if (m !== current) return;
  const el = document.getElementById('loadstat');
  // Painted in place, not through `renderTabs`: this arrives every two seconds,
  // and rebuilding the tab strip that often would cut across dragging a tab or
  // a menu opened from one.
  if (el) paintLoad(el, msg);
  else renderTabs();
};

conn.on.onMem = (msg) => {
  memById.clear();
  for (const m of msg.terminals) memById.set(m.id, m);
  paintTabs();
};

let bannerTimer = null;
let bannerSoonTimer = null;
/// `action` is `{ label, run }`: a button at the end of the strip, for the
/// one thing the user can do about what it says.
function banner(text, transient = false, action = null) {
  clearTimeout(bannerTimer);
  clearTimeout(bannerSoonTimer);
  if (!text) {
    el.banner.hidden = true;
    return;
  }
  el.banner.textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.className = 'bact';
    b.textContent = action.label;
    b.onclick = action.run;
    el.banner.appendChild(b);
  }
  el.banner.hidden = false;
  if (transient) bannerTimer = setTimeout(() => (el.banner.hidden = true), 6000);
}

/// Show a banner only if nothing has replaced or cleared it within a moment.
function bannerSoon(text, action = null, after = 1000) {
  clearTimeout(bannerSoonTimer);
  bannerSoonTimer = setTimeout(() => banner(text, false, action), after);
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
  // The tab already on show has nowhere to switch to, so a press on it means
  // "try again" — the one thing worth doing to a machine that is not answering.
  pick: (m) => (m === current ? m.status !== 'open' && m.conn.retry() : switchMachine(m)),
  // Machine management always goes to the LOCAL daemon, never through the relay:
  // the machine list is its own, and remotes are not chained.
  pair: (link) => local.conn.send({ t: 'pair', link, name: '' }),
  forget: (m) => forgetMachine(m),
});

/// Switch machines: swap the data references, then redraw from the new machine's
/// data. Nothing is torn down — its xterm and file panel stay alive.
function switchMachine(m) {
  if (m === current) return;
  tele.track('machine', { remote: !!m.via });
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
conn.on.onTokenRotated = (msg, m) => {
  // Only from the machine on screen: rotating a paired machine's token does not
  // change the address of the browser's own daemon.
  if (m !== current) {
    banner(`${m.label}: token replaced — that machine must be paired again.`, true);
    return;
  }
  settings.tokenRotated(msg.url);
};

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
    // A machine whose NAME changed is the same machine — its address is what
    // did not move — so it is found here rather than falling through to be made
    // again. Remaking it would close its connection, dispose every terminal on
    // it and forget which tabs were closed. Its `id` deliberately stays as it
    // was: no daemon is ever told an id, and everything remembered per machine
    // hangs off it.
    const renamed = machines.find(
      (x) => x.via && x.addr === r.addr && !want.some((w) => w.name === x.via),
    );
    if (renamed) {
      renamed.label = r.name;
      renamed.via = r.name;
      // Read again on each connect, so the next reconnect asks for the new name.
      renamed.conn.via = r.name;
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
  settings.setRemotes(want, msg.can_move === true, msg.can_rename === true);
};

/// Drop a machine along with everything it displays.
function dropMachine(m) {
  if (m === current) switchMachine(local);
  // Its toasts go with it: one left behind would offer to take you to a
  // terminal on a machine that is no longer here. Its closed tabs stay where
  // they always were — on that machine's own daemon — so there is nothing
  // left to clean up here.
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
