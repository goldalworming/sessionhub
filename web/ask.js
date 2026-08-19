// A small dialog for asking one line of text — or two, when one of them is a
// command the user should see before it is stored. The browser's own `prompt()`
// blocks the whole page and cannot carry an explanation, so this is used
// instead.

export class Ask {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.id = 'ask';
    this.el.hidden = true;
    this.el.innerHTML =
      '<div class="abox">' +
      '<div class="atitle"></div>' +
      '<label class="alab lab1" hidden></label>' +
      '<input type="text" spellcheck="false">' +
      '<label class="alab lab2" hidden></label>' +
      '<input class="second" type="text" spellcheck="false" hidden>' +
      '<div class="anote"></div>' +
      '<div class="arow"><button class="batal">Cancel</button>' +
      '<button class="ok primary"></button></div>' +
      '</div>';
    root.appendChild(this.el);

    this.title = this.el.querySelector('.atitle');
    this.input = this.el.querySelector('input');
    this.second = this.el.querySelector('input.second');
    this.lab1 = this.el.querySelector('.lab1');
    this.lab2 = this.el.querySelector('.lab2');
    this.note = this.el.querySelector('.anote');
    this.okBtn = this.el.querySelector('.ok');

    this.el.querySelector('.batal').onclick = () => this.close(null);
    this.okBtn.onclick = () => this.close(this.input.value);
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close(null);
    });
    for (const box of [this.input, this.second]) {
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.close(this.input.value);
        else if (e.key === 'Escape') this.close(null);
        e.stopPropagation(); // typing in here is not an app shortcut
      });
    }
  }

  get open() {
    return !this.el.hidden;
  }

  /// Returns the text entered, or `null` when cancelled.
  show({ title, value = '', note = '', ok = 'Continue' }) {
    return this.open2({ title, value, note, ok });
  }

  /// Two lines instead of one. Returns `{ first, second }`, or `null` when
  /// cancelled — never a bare string, so a caller cannot read the wrong field
  /// by accident.
  showPair({ title, label1, value1 = '', label2, value2 = '', hint2 = '', note = '', ok = 'Save' }) {
    return this.open2({
      title,
      value: value1,
      note,
      ok,
      label1,
      label2,
      value2,
      hint2,
      pair: true,
    });
  }

  open2({ title, value, note, ok, label1, label2, value2 = '', hint2 = '', pair = false }) {
    this.pair = pair;
    this.title.textContent = title;
    this.input.value = value;
    this.second.value = value2;
    this.second.placeholder = hint2;
    this.second.hidden = !pair;
    this.lab1.textContent = label1 || '';
    this.lab1.hidden = !pair || !label1;
    this.lab2.textContent = label2 || '';
    this.lab2.hidden = !pair || !label2;
    this.note.textContent = note;
    this.note.hidden = !note;
    this.okBtn.textContent = ok;
    this.el.hidden = false;
    this.input.focus();
    this.input.select();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  close(value) {
    this.el.hidden = true;
    const done = this.resolve;
    this.resolve = null;
    if (!done) return;
    if (value === null) {
      done(null);
      return;
    }
    const first = String(value).trim();
    done(this.pair ? { first, second: this.second.value.trim() } : first);
  }
}
