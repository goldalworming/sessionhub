// A small dialog for asking one line of text. The browser's own `prompt()`
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
      '<input type="text" spellcheck="false">' +
      '<div class="anote"></div>' +
      '<div class="arow"><button class="batal">Cancel</button>' +
      '<button class="ok primary"></button></div>' +
      '</div>';
    root.appendChild(this.el);

    this.title = this.el.querySelector('.atitle');
    this.input = this.el.querySelector('input');
    this.note = this.el.querySelector('.anote');
    this.okBtn = this.el.querySelector('.ok');

    this.el.querySelector('.batal').onclick = () => this.close(null);
    this.okBtn.onclick = () => this.close(this.input.value);
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close(null);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.close(this.input.value);
      else if (e.key === 'Escape') this.close(null);
      e.stopPropagation(); // typing in here is not an app shortcut
    });
  }

  get open() {
    return !this.el.hidden;
  }

  /// Returns the text entered, or `null` when cancelled.
  show({ title, value = '', note = '', ok = 'Continue' }) {
    this.title.textContent = title;
    this.input.value = value;
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
    if (done) done(value === null ? null : String(value).trim());
  }
}
