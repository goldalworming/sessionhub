// Toasts: what finished, where, and one click to go there.
//
// The chime alone says only "something finished". With several terminals across
// several machines that is the least useful half of the message — you still have
// to hunt for which one, and the sound is gone by the time you start looking.
// So the sound keeps a note beside it.
//
// The hover rule is deliberate and slightly unusual: pointing at a toast does
// not merely pause its timer, it resets it. A toast you have moved the mouse
// onto is one you are reading, and giving it the two seconds it had left would
// snatch it away mid-sentence. Leaving starts the full time again. Closing works
// throughout — a paused toast that cannot be dismissed is a toast that has taken
// over the corner of the screen.

/// How long a toast stays when nobody touches it.
const LIFE_MS = 9000;

/// More than this on screen and the newest ones are pushed off before they can
/// be read. The oldest goes; it has had the most time.
const MAX_SHOWN = 4;

export class Toasts {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.id = 'toasts';
    // The stack sits above the page but must never swallow a click meant for
    // what is behind it; only the toasts themselves take pointer events.
    this.el.setAttribute('aria-live', 'polite');
    root.appendChild(this.el);
    /// Live toasts by key, so the same terminal finishing twice refreshes its
    /// note instead of stacking a second one nobody asked for.
    this.byKey = new Map();
  }

  /// `key` identifies what the toast is about — same key, same toast.
  /// `onClick` is what "go there" means; without one the toast is just a note.
  show({ key, title, note, onClick }) {
    const existing = this.byKey.get(key);
    if (existing) {
      existing.setText(title, note);
      existing.restart();
      // Moved to the end so a refreshed toast reads as the newest thing, which
      // is what it is.
      this.el.appendChild(existing.el);
      return;
    }

    const el = document.createElement('div');
    el.className = 'toast' + (onClick ? ' go' : '');
    el.dataset.key = key;

    const body = document.createElement('div');
    body.className = 'tbody';
    const h = document.createElement('div');
    h.className = 'ttitle';
    const n = document.createElement('div');
    n.className = 'tnote';
    body.appendChild(h);
    body.appendChild(n);
    el.appendChild(body);

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'tclose';
    x.textContent = '✕';
    x.title = 'Dismiss';
    x.setAttribute('aria-label', 'Dismiss');
    el.appendChild(x);

    const item = {
      el,
      timer: null,
      setText(t, s) {
        h.textContent = t;
        n.textContent = s || '';
        n.hidden = !s;
      },
      restart: () => {
        clearTimeout(item.timer);
        item.timer = setTimeout(() => this.dismiss(key), LIFE_MS);
      },
      hold: () => clearTimeout(item.timer),
    };
    item.setText(title, note);

    // Pointer events rather than mouseenter: a stylus and a mouse both mean
    // "being read", and a finger does not linger, so touch simply never pauses.
    el.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      item.hold();
      el.classList.add('held');
    });
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      el.classList.remove('held');
      // The full time again, not the remainder.
      item.restart();
    });

    // Closing beats going: the ✕ is inside the clickable body, so without this
    // dismissing one would also jump you somewhere you did not ask to be.
    x.onclick = (e) => {
      e.stopPropagation();
      this.dismiss(key);
    };
    if (onClick) {
      el.onclick = () => {
        this.dismiss(key);
        onClick();
      };
    }

    this.el.appendChild(el);
    this.byKey.set(key, item);
    item.restart();

    while (this.byKey.size > MAX_SHOWN) {
      const oldest = this.byKey.keys().next().value;
      this.dismiss(oldest);
    }
  }

  dismiss(key) {
    const item = this.byKey.get(key);
    if (!item) return;
    clearTimeout(item.timer);
    this.byKey.delete(key);
    // Removed after the fade so it does not vanish mid-animation; `isConnected`
    // guards a second dismiss arriving first.
    item.el.classList.add('gone');
    setTimeout(() => {
      if (item.el.isConnected) item.el.remove();
    }, 200);
  }

  /// Everything about one machine, for when it is forgotten or goes away — its
  /// toasts would otherwise offer to take you somewhere that no longer exists.
  dismissFor(prefix) {
    for (const key of [...this.byKey.keys()]) {
      if (key.startsWith(prefix)) this.dismiss(key);
    }
  }
}
