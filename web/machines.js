// The machine bar: `This machine` on the left, every paired machine after it.
//
// Picking one swaps the whole window — sidebar, terminal, file panel — for that
// machine's. Because only one is shown at a time, terminal ids never need a
// prefix per machine.

const STATUS = {
  open: { dot: 'ok', text: 'connected' },
  connecting: { dot: 'wait', text: 'connecting…' },
  lost: { dot: 'bad', text: 'reconnecting…' },
};

/// Complete enough to ask the daemon about? This only decides **when** to ask;
/// what decides whether it is valid is still the daemon, and its message is
/// shown as-is.
export function looksComplete(text) {
  const raw = text.trim();
  if (!raw) return false;
  const body = raw.replace(/^(sessionhub|https?|wss?):\/\//, '');
  const token = /[#?&]token=([^&\s]+)/.exec(body);
  if (!token || !token[1]) return false;
  const hostport = body.split(/[#?/]/)[0];
  const m = /^(.+):(\d+)$/.exec(hostport);
  return !!m && m[1].length > 0 && Number(m[2]) > 0;
}

export class MachineBar {
  /// `on.pick(machine)` switches machines, `on.pair(link)` pairs one,
  /// `on.forget(name)` drops one, `on.machines()` returns the current list.
  constructor(root, on) {
    this.on = on;
    this.el = document.createElement('div');
    this.el.id = 'mbar';
    this.el.innerHTML =
      '<div class="mstrip"></div>' +
      '<button class="madd" title="Connect to another machine">＋</button>';
    root.prepend(this.el);
    this.strip = this.el.querySelector('.mstrip');
    this.el.querySelector('.madd').onclick = () => this.openDialog();

    this.dlg = document.createElement('div');
    this.dlg.id = 'pairdlg';
    this.dlg.hidden = true;
    this.dlg.innerHTML =
      '<div class="pdbox">' +
      '<div class="shead"><h2>Connect to another machine</h2>' +
      '<button class="close" title="Close">✕</button></div>' +
      '<div class="pdbody">' +
      '<p class="pdhint">On the other machine, open <b>⚙ Settings → Network access</b> ' +
      'and copy its pairing link.</p>' +
      '<input class="pdlink" type="text" spellcheck="false" ' +
      'placeholder="sessionhub://192.168.0.115:7717/pair#token=…" />' +
      '<div class="pdnote"></div>' +
      '<p class="pdwarn">The link carries that machine\'s token, and it grants a ' +
      'full shell there. Only paste links you asked for.</p>' +
      '</div></div>';
    document.body.appendChild(this.dlg);

    this.linkEl = this.dlg.querySelector('.pdlink');
    this.noteEl = this.dlg.querySelector('.pdnote');
    this.dlg.querySelector('.close').onclick = () => this.closeDialog();
    this.dlg.addEventListener('mousedown', (e) => {
      if (e.target === this.dlg) this.closeDialog();
    });
    this.dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeDialog();
      e.stopPropagation();
    });

    // No Connect button: a complete link means "ask that machine", anything
    // else means "still typing".
    this.timer = null;
    this.linkEl.oninput = () => {
      clearTimeout(this.timer);
      const text = this.linkEl.value;
      if (!looksComplete(text)) {
        this.note(text.trim() ? 'Keep typing — that link is not complete yet.' : '');
        return;
      }
      this.note('Asking that machine…', 'wait');
      this.timer = setTimeout(() => this.on.pair(text.trim()), 350);
    };
  }

  get open() {
    return !this.dlg.hidden;
  }

  async openDialog() {
    this.dlg.hidden = false;
    this.linkEl.value = '';
    this.note('');
    // A link already in the clipboard is almost certainly why this button was pressed.
    try {
      const text = await navigator.clipboard.readText();
      if (looksComplete(text)) {
        this.linkEl.value = text.trim();
        this.linkEl.oninput();
      }
    } catch {
      // The clipboard needs permission, and refusing it is not an error.
    }
    this.linkEl.focus();
  }

  closeDialog() {
    clearTimeout(this.timer);
    this.dlg.hidden = true;
  }

  note(text, kind = '') {
    this.noteEl.textContent = text;
    this.noteEl.className = `pdnote${kind ? ` ${kind}` : ''}`;
  }

  /// The daemon refused the pairing; its message is shown as-is.
  failed(message) {
    if (this.open) this.note(message, 'bad');
  }

  paired(label) {
    this.note(`Connected to ${label}.`, 'ok');
    setTimeout(() => this.closeDialog(), 700);
  }

  paint(current) {
    this.strip.textContent = '';
    for (const m of this.on.machines()) {
      const tab = document.createElement('div');
      tab.className = 'mtab' + (m === current ? ' on' : '');
      tab.dataset.machine = m.id;
      const st = STATUS[m.status] || STATUS.connecting;
      tab.title = m.via ? `${m.label} — ${m.addr || ''} (${st.text})` : `This machine (${st.text})`;

      const dot = document.createElement('span');
      dot.className = `mdot ${st.dot}`;
      tab.appendChild(dot);

      const name = document.createElement('span');
      name.className = 'mname';
      name.textContent = m.label;
      tab.appendChild(name);

      // No ✕ here. There used to be one, and a single mis-tap on it silently
      // unpaired a real machine — on a phone the tab is exactly where a thumb
      // lands. Forgetting lives in Settings → Machines, behind its two-click
      // confirm; a tab is for switching, and switching is the only thing a
      // stray tap here can do.
      tab.onclick = () => this.on.pick(m);
      this.strip.appendChild(tab);
    }
    this.markOverflow();
    this.reveal(current);
  }

  /// Mark when there are tabs hidden past the right edge.
  markOverflow() {
    const more = this.strip.scrollWidth > this.strip.clientWidth + 1;
    this.el.classList.toggle('more', more);
  }

  /// Bring the active machine tab into view.
  ///
  /// Computed here rather than with `scrollIntoView`: that one often stops
  /// before the tab is whole, and it scrolls the whole page as well.
  reveal(m) {
    if (!m) return;
    const tab = this.strip.querySelector(`.mtab[data-machine="${CSS.escape(m.id)}"]`);
    if (!tab) return;
    const box = this.strip.getBoundingClientRect();
    const r = tab.getBoundingClientRect();
    if (r.right > box.right) this.strip.scrollLeft += r.right - box.right;
    else if (r.left < box.left) this.strip.scrollLeft -= box.left - r.left;
  }
}
