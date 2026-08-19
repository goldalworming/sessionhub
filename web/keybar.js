// The key bar for touch screens.
//
// An on-screen keyboard has no Esc, no Tab, and no arrows — the three keys
// pressed most often in a terminal. Without this, a session opened from a phone
// can do little beyond typing and pressing Enter.
//
// The list DELIBERATELY does not copy the bar of a remote-desktop app. Win,
// PrtScr, ScrollLock and Menu mean nothing to a PTY — all they send are keys
// that never reach the shell. What is here instead is what such a bar lacks:
// interrupt, EOF, suspend, history search, and Shift+Tab.

import { touchOnlyDevice } from './touchscroll.js';

const LS = 'sh.keybar';

/// The byte sequence each key sends. All of them are sequences a terminal
/// actually understands, not key names — the daemon passes bytes through as-is.
const ESC = '\x1b';

const ROW1 = [
  { label: 'Esc', seq: ESC, title: 'Escape' },
  { label: 'Tab', seq: '\t' },
  // On the first row, not behind ⋯: in an agent this is the key that cycles
  // input modes, pressed all session long — a key used that often must not
  // cost two taps. It took Alt's seat rather than widening the row: a tenth
  // button tips the row into scrolling on a 390 px phone, and what scrolls off
  // the end is the arrows.
  { label: '⇧Tab', seq: `${ESC}[Z`, title: 'Shift+Tab' },
  { label: 'Ctrl', mod: 'ctrl', title: 'Tap, then press a letter' },
  { label: '←', seq: `${ESC}[D`, title: 'Left' },
  { label: '↑', seq: `${ESC}[A`, title: 'Up — previous command' },
  { label: '↓', seq: `${ESC}[B`, title: 'Down' },
  { label: '→', seq: `${ESC}[C`, title: 'Right' },
];

const ROW2 = [
  // Paste has to be a KEY on a phone. The terminal is drawn on a canvas, not an
  // editable field, so a long press raises no paste bubble; and Ctrl+V through
  // this bar would only type the byte 0x16 at the program. The button reads the
  // clipboard through the browser API — which is also why it needs HTTPS (the
  // tunnel) or localhost: on plain LAN http the browser refuses.
  { label: 'Paste', act: 'paste', title: 'Paste the clipboard into the terminal' },
  // Its sibling: on a phone there is no drag-and-drop either. The picker this
  // opens is the gallery/camera; the file then rides the same route as a drop —
  // saved on the daemon's machine, its path typed into the terminal.
  { label: 'Img', act: 'upload', title: 'Send an image — its path is typed into the terminal' },
  // Alt lives here now: it arms readline's meta bindings, which is a rare need
  // from a phone, while ⇧Tab — whose seat it gave up — is pressed all day.
  { label: 'Alt', mod: 'alt', title: 'Tap, then press a key' },
  { label: '^C', seq: '\x03', title: 'Interrupt' },
  { label: '^D', seq: '\x04', title: 'End of input' },
  { label: '^R', seq: '\x12', title: 'Search history' },
  { label: 'Home', seq: `${ESC}[H` },
  { label: 'End', seq: `${ESC}[F` },
  { label: 'PgUp', seq: `${ESC}[5~` },
  { label: 'PgDn', seq: `${ESC}[6~` },
  { label: 'Del', seq: `${ESC}[3~`, title: 'Delete forward' },
  // Cut on purpose, each for its own reason:
  //  ⏎  — every phone keyboard has Enter, and without that keyboard on screen
  //       there is nothing typed for an Enter to send anyway;
  //  ^L — redraw-the-screen matters on a teletype, not under an agent that
  //       repaints constantly, and reading back is the scrollback control's job;
  //  ^Z — suspend is a trap here: one stray tap "freezes" the program, and the
  //       cure is typing `fg`, which nothing on the screen suggests.
];

/// Letters that have a control-code counterpart. `a` → 0x01 … `z` → 0x1a, plus
/// a few punctuation marks that are also valid.
function ctrlByte(ch) {
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64); // @ A..Z [ \ ] ^ _
  if (ch === '?') return '\x7f';
  return null;
}

export class KeyBar {
  /// `send(text)` sends bytes to the terminal currently active.
  /// `onResize()` is called when the bar's height changes, so the PTY is
  /// renegotiated.
  constructor(host, { send, onResize, onPaste, onUpload }) {
    this.send = send;
    this.onPaste = onPaste;
    this.onUpload = onUpload;
    this.onResize = onResize;
    this.ctrl = false;
    this.alt = false;
    this.expanded = false;

    const saved = localStorage.getItem(LS);
    /// null = follow the device; '1'/'0' = a choice made by hand.
    this.forced = saved === null ? null : saved === '1';

    this.el = document.createElement('div');
    this.el.id = 'keybar';
    this.el.hidden = true;
    host.appendChild(this.el);

    // Pressing a key here must not move focus: if focus leaves the terminal, the
    // on-screen keyboard closes itself on every tap.
    this.el.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      e.preventDefault();
      this.hit(b);
    });

    this.paint();
  }

  /// Whether this bar is any use on this device: wherever the primary pointer
  /// is touch. The shared rule (`touchOnlyDevice`) carries the history of why it
  /// is exactly that and not more — each refinement tried on top of it hid the
  /// bar from a real phone or showed it on a real laptop.
  get applicable() {
    return touchOnlyDevice();
  }

  /// Whether the bar is showing, per the choice made and the device.
  get wanted() {
    if (this.forced !== null) return this.forced;
    return this.applicable;
  }

  /// Called from `relayout()` in app.js, which already handles sizing
  /// afterwards — so this does NOT call `onResize` itself. If it did, the two
  /// would call each other without end.
  sync(hasTerminal = this.hasTerminal) {
    this.hasTerminal = hasTerminal;
    this.el.hidden = !(hasTerminal && this.wanted);
  }

  /// Turn it on or off by hand, regardless of the device.
  toggle() {
    this.forced = !(this.forced === null ? this.wanted : this.forced);
    localStorage.setItem(LS, this.forced ? '1' : '0');
    this.sync();
    this.paint();
    this.onResize();
  }

  get on() {
    return !this.el.hidden;
  }

  hit(btn) {
    const mod = btn.dataset.mod;
    if (mod) {
      this[mod] = !this[mod];
      this.paint();
      return;
    }
    if (btn.dataset.more !== undefined) {
      this.expanded = !this.expanded;
      this.paint();
      this.onResize();
      return;
    }
    if (btn.dataset.act === 'paste') {
      // Not a byte sequence: the clipboard has to be read here, in the click
      // gesture, or the browser refuses. What to do with the text is the
      // app's business (`onPaste` goes through xterm so bracketed paste works).
      this.onPaste?.();
      return;
    }
    if (btn.dataset.act === 'upload') {
      // Same constraint: a file picker only opens inside a user gesture.
      this.onUpload?.();
      return;
    }
    const seq = btn.dataset.seq;
    if (seq === undefined) return;
    this.send(this.wrap(seq));
    this.paint();
  }

  /// Wrap one piece of input with whatever modifier is armed.
  ///
  /// Used by typing from the on-screen keyboard too, not only by the keys in
  /// this bar — that is the whole point of Ctrl here: it waits for the next
  /// character, wherever it comes from.
  wrap(data) {
    let out = data;
    if (this.ctrl && data.length === 1) {
      const b = ctrlByte(data);
      if (b !== null) out = b;
    }
    if (this.alt) out = ESC + out;
    if (this.ctrl || this.alt) {
      this.ctrl = false;
      this.alt = false;
      // The redraw is deferred: `wrap` is called from the middle of the input stream.
      queueMicrotask(() => this.paint());
    }
    return out;
  }

  paint() {
    this.el.textContent = '';
    this.el.appendChild(this.row(ROW1, true));
    if (this.expanded) this.el.appendChild(this.row(ROW2, false));
  }

  row(keys, withMore) {
    const r = document.createElement('div');
    r.className = 'krow';
    for (const k of keys) r.appendChild(this.key(k));
    if (withMore) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'kkey kmore' + (this.expanded ? ' on' : '');
      more.dataset.more = '';
      more.textContent = this.expanded ? '⌄' : '⋯';
      more.title = this.expanded ? 'Fewer keys' : 'More keys';
      r.appendChild(more);
    }
    return r;
  }

  key(k) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kkey';
    b.textContent = k.label;
    if (k.title) b.title = k.title;
    if (k.mod) {
      b.dataset.mod = k.mod;
      // An armed modifier has to look armed — otherwise the next letter is a
      // surprise.
      if (this[k.mod]) b.classList.add('armed');
    } else if (k.act) {
      b.dataset.act = k.act;
    } else {
      b.dataset.seq = k.seq;
    }
    return b;
  }
}
