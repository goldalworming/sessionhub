// The links a terminal has printed, gathered into a tappable list.
//
// On a desktop the mouse already handles this: hover a URL, click it. A finger
// cannot hover, so on a phone xterm's link activation is a coin toss — and the
// URLs that matter most, the long ones an agent prints, are often broken by the
// PROGRAM with a real newline plus indentation, which no link addon rejoins
// because by the time it looks, the break is just text.
//
// So instead of fighting the hover model, this collects: scan the scrollback
// when asked, stitch the broken URLs back together, and show them as rows big
// enough for a thumb. Scanning happens only when the sheet opens — never per
// output frame — so it costs nothing until the moment it is wanted, and a URL
// split across two WebSocket frames is no concern because the buffer has long
// since been assembled.

const MAX_ROWS = 40;

/// What may appear inside a URL. Deliberately close to the web-links addon's
/// idea of one, minus the characters that end a match there too.
const URL_CHARS = /[-A-Za-z0-9._~:/?#[\]@!$&'*+,;=%()]/;

/// Trailing characters that are almost always prose punctuation, not URL:
/// `…link.` or `(see https://x)` — the addon trims these and so does this.
const TRAILING = /[.,;:!?'")\]]+$/;

const URL_RE = /https?:\/\/[^\s"'<>`]+/g;

/// Every URL in `lines`, newest first, deduped, hard breaks stitched.
///
/// `lines` are LOGICAL lines: the caller has already rejoined the rows the
/// terminal soft-wrapped (xterm marks those with `isWrapped`). What remains
/// broken here was broken by the program that printed it. The stitch rule:
/// a match that runs to the very end of its line continues onto the next line
/// if, after stripping leading whitespace and the vertical bars TUIs draw
/// margins with, that line begins with URL characters — then the first
/// unbroken run of them is appended, and the rule applies again. Indented
/// continuations are exactly how agents wrap long URLs; a margin bar is how
/// quoted output arrives.
export function scanLinks(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(lines[i])) !== null) {
      let url = m[0];
      // Stitch: only from the very end of the line, and only onto a line that
      // looks like a continuation. `trimEnd` because a caller may pass raw
      // strings still padded with the spaces a terminal row ends in.
      let atEnd = m.index + m[0].length === lines[i].trimEnd().length;
      let row = i;
      while (atEnd && row + 1 < lines.length) {
        const next = lines[row + 1].replace(/^[\s│┃|]+/, '');
        if (!next || !URL_CHARS.test(next[0])) break;
        // A line with a scheme of its own is its own URL, not a continuation —
        // the outer loop will reach it on its own.
        if (/^https?:\/\//.test(next)) break;
        let take = 0;
        while (take < next.length && URL_CHARS.test(next[take])) take++;
        const run = next.slice(0, take);
        // A short run of nothing but letters is a word, not a URL tail: `and`,
        // `done`. What agents actually wrap — ids, paths, query strings — has
        // digits or punctuation in it, or is long. `html` alone is lost to
        // this rule; ids are what this exists for.
        if (run.length <= 10 && !/[^A-Za-z]/.test(run)) break;
        url += run;
        row++;
        // Consumed the whole line: the URL may continue further still. Ended
        // mid-line: it is over. The swallowed fragments are never re-matched
        // by the outer loop — without a scheme they cannot be.
        atEnd = take === next.length;
      }
      url = url.replace(TRAILING, '');
      if (url.length > 'https://'.length + 1) found.push(url);
    }
  }
  // Newest first, keeping only the newest occurrence of a repeated URL.
  const seen = new Set();
  const out = [];
  for (let i = found.length - 1; i >= 0 && out.length < MAX_ROWS; i--) {
    if (seen.has(found[i])) continue;
    seen.add(found[i]);
    out.push(found[i]);
  }
  return out;
}

/// The logical lines of an xterm buffer: soft-wrapped rows rejoined.
export function bufferLines(term) {
  const buf = term.buffer.active;
  const lines = [];
  let carry = '';
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped) {
      carry += text;
    } else {
      if (carry) lines.push(carry);
      carry = text;
    }
  }
  if (carry) lines.push(carry);
  return lines;
}

/// The sheet itself. One per page, shown for whichever terminal is active.
export class LinksSheet {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.id = 'linksheet';
    this.el.hidden = true;
    this.el.innerHTML =
      '<div class="lbox"><div class="lhead">Links in this terminal</div>' +
      '<div class="llist"></div></div>';
    root.appendChild(this.el);
    this.list = this.el.querySelector('.llist');

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

  show(urls) {
    this.el.hidden = false;
    this.list.textContent = '';
    if (!urls.length) {
      const none = document.createElement('div');
      none.className = 'lnone';
      none.textContent = 'No links in this terminal yet.';
      this.list.appendChild(none);
      return;
    }
    for (const url of urls) {
      const row = document.createElement('div');
      row.className = 'lrow';

      const a = document.createElement('a');
      a.className = 'lurl';
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = url;
      // A real anchor, so the browser does the opening: no popup blocker
      // arguments, long-press offers its own copy/share menu, and the tap
      // closes the sheet on its way out.
      a.addEventListener('click', () => this.close());
      row.appendChild(a);

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'lcopy';
      copy.textContent = 'Copy';
      copy.title = 'Copy the link';
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(url);
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
        } catch {
          // Plain http on the LAN: the clipboard API refuses there, the same
          // way Paste does. The long-press menu on the link still copies.
          copy.textContent = 'No access';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
        }
      };
      row.appendChild(copy);

      this.list.appendChild(row);
    }
  }

  close() {
    this.el.hidden = true;
  }
}
