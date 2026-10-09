// A terminal's text as plain page text, so a phone can select and copy it.
//
// The terminal itself is drawn by xterm, not laid out as page text: a long
// press there raises no selection handles and no Copy menu, and a swipe is
// already scrolling. Here the same lines sit in an ordinary element, where the
// device's own selection works — long press, drag the handles, Copy — over
// plain http as well, since that menu is the system's, not the clipboard API.

/// How many of the newest lines to show: the whole scrollback is 2000 rows,
/// and what is copied on a phone is almost always the last screenful or two.
const MAX_LINES = 1000;

/// The text to show for `lines` (logical lines, soft wraps already rejoined):
/// the newest `MAX_LINES`, each with its trailing padding cut, and the blank
/// rows below the last output dropped.
export function sheetText(lines) {
  const out = lines.slice(-MAX_LINES).map((l) => l.trimEnd());
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join('\n');
}

export class TextSheet {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.id = 'textsheet';
    this.el.hidden = true;
    this.el.innerHTML =
      '<div class="tsbox"><div class="tshead"><span class="tstitle">Select text, then Copy</span>' +
      '<button type="button" class="lcopy tsall">Copy all</button>' +
      '<button type="button" class="lcopy tsclose">Close</button></div>' +
      '<pre class="tsbody"></pre></div>';
    root.appendChild(this.el);
    this.body = this.el.querySelector('.tsbody');
    const all = this.el.querySelector('.tsall');

    all.onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.body.textContent);
        all.textContent = 'Copied';
      } catch {
        // Plain http on the LAN: the clipboard API is not there at all.
        // Selecting and the system's Copy still work either way.
        all.textContent = window.isSecureContext ? 'Copy failed' : 'Needs https';
      }
      setTimeout(() => { all.textContent = 'Copy all'; }, 1500);
    };
    this.el.querySelector('.tsclose').onclick = () => this.close();
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

  show(lines) {
    // The terminal's hidden input loses focus, so the on-screen keyboard
    // folds away instead of covering what is to be selected.
    document.activeElement?.blur?.();
    this.body.textContent = sheetText(lines) || 'Nothing in this terminal yet.';
    this.el.hidden = false;
    // The newest output is what is wanted, so start at the bottom.
    this.body.scrollTop = this.body.scrollHeight;
  }

  close() {
    this.el.hidden = true;
    window.getSelection()?.removeAllRanges();
  }
}
