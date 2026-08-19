// Dragging files onto a terminal, or pasting an image from the clipboard.
//
// What is sent to the agent is not the image — an agent does not read images
// from stdin. The file is uploaded to the machine where the daemon lives, and
// then the path on that machine is typed into the terminal. That is why this is
// useful from a phone: the file lands on the computer where the agent works,
// not on the phone.

/// A path with spaces has to be quoted, or the agent reads it as two arguments.
/// Windows uses double quotes, and a `"` inside a name was already filtered out
/// by the daemon, so there is nothing left to escape.
export function quotePath(path) {
  return /[\s"']/.test(path) ? `"${path}"` : path;
}

export class Drops {
  /// `send(name, bytes)` uploads one file; it returns false while the
  /// connection is down. `note(text, isError)` shows a short message.
  constructor(host, send, note) {
    this.send = send;
    this.note = note;
    this.depth = 0; // dragenter/dragleave beruntun saat kursor melewati anak

    this.el = document.createElement('div');
    this.el.className = 'dropzone';
    this.el.hidden = true;
    this.el.innerHTML =
      '<div class="dropmsg">Drop to upload' +
      '<span>The file lands on the machine running the agent, and its path is typed in.</span>' +
      '</div>';
    host.appendChild(this.el);

    host.addEventListener('dragenter', (e) => this.enter(e));
    host.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    host.addEventListener('dragleave', () => this.leave());
    host.addEventListener('drop', (e) => this.drop(e));
  }

  enter(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    this.depth++;
    this.el.hidden = false;
  }

  leave() {
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth === 0) this.el.hidden = true;
  }

  drop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    this.depth = 0;
    this.el.hidden = true;

    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;
    this.upload(files);
  }

  /// An image from the clipboard (Ctrl+V or Cmd+V) takes the same route. Plain
  /// text is left alone — that still belongs to the terminal.
  paste(e) {
    const items = [...(e.clipboardData?.items || [])];
    const files = items
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter(Boolean);
    if (!files.length) return false;
    e.preventDefault();
    this.upload(files);
    return true;
  }

  async upload(files) {
    for (const f of files) {
      this.note(`Uploading ${f.name}…`);
      let buf;
      try {
        buf = new Uint8Array(await f.arrayBuffer());
      } catch (err) {
        this.note(`Could not read ${f.name}.`, true);
        continue;
      }
      // A file name from the clipboard is often empty; give it a sensible one.
      const name = f.name || `pasted.${(f.type.split('/')[1] || 'bin').slice(0, 8)}`;
      if (!this.send(name, buf)) {
        this.note('Not connected — the upload was not sent.', true);
        return;
      }
    }
  }
}

function hasFiles(e) {
  const t = e.dataTransfer;
  return !!t && [...(t.types || [])].includes('Files');
}
