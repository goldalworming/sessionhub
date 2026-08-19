// The scrollback control that sits on a terminal on a touch screen.
//
// Dragging (touchscroll.js) is the gesture people try first, and it is the one
// that should work. This is the other half of the same problem:
//
//   - a drag is imprecise. Moving back a screen at a time is a button's job.
//   - once you have scrolled up you are detached from the live end, and nothing
//     on screen says so. New output keeps arriving where you cannot see it.
//   - getting back to the bottom of a long session by dragging is a lot of
//     thumb work for something that should be one tap.
//
// Deliberately NOT a pair of arrows on the key bar. The bar already has PgUp and
// PgDn, they look like exactly this, and they mean something else entirely: they
// are keystrokes sent to the program. Two controls that look alike and go to
// different places is worse than no control at all. This one lives on the
// terminal and does the same thing a wheel does.
//
// There are two quite different things behind those buttons, because there are
// two quite different places history can live:
//
//   - a **program reading the mouse** (an agent: `?1049h` puts it on the
//     alternate screen, where a terminal keeps no scrollback whatsoever) owns
//     its own history and scrolls it when it is sent wheel events. That is why
//     a mouse works on a laptop. Here the buttons send wheel, and how far back
//     you are is the program's business — it is not something this can know, so
//     it is not claimed.
//   - a **plain shell** leaves its history in the terminal's scrollback. Here
//     the buttons move the view, and how far behind you are can be counted
//     exactly and offered as one tap back to the live end.

import { mouseTracked, rowPx, sendWheel, wheelPx, touchOnlyDevice } from './touchscroll.js';

/// What one tap moves: a few lines, the same as one notch of a wheel.
///
/// A screen per tap was the first design and it was wrong in use: reading is
/// done a few lines at a time, and a whole screen per tap tears you away from
/// the passage you were following. The distance work belongs to the HOLD, which
/// keeps going for as long as the finger stays down.
const STEP_ROWS = 3;

/// How long a press has to last before it stops being a tap and starts running.
const HOLD_MS = 350;

/// Pixels per frame while held: where it starts, where it tops out, and how
/// quickly it gets there. Slow at first, so a slightly long press does not shoot
/// off; fast at the end, so a long way back does not take all day.
const HOLD_FROM = 6;
const HOLD_TO = 30;
const HOLD_RAMP = 1.05;

/// The same "touch is the only pointer" test the key bar uses: a laptop — even a
/// touchscreen one reporting a coarse primary pointer — has a wheel, and this
/// would be clutter there.
const onTouch = () => touchOnlyDevice();

export function attachScrollPad(view, term) {
  if (!onTouch()) return null;

  const pad = document.createElement('div');
  pad.className = 'spad';
  pad.hidden = true;

  /// A double chevron, drawn rather than typed.
  ///
  /// `⌃` and `⌄` were the first attempt and they are the wrong characters for
  /// this: they are hairline glyphs at whatever weight the font happens to have,
  /// they sit off-centre in the box, and they read as punctuation. A stroked
  /// path takes its weight and its colour from the button — `currentColor`, so
  /// the theme still owns it — and doubling the chevron says "a long way", which
  /// is what these move.
  const chevrons = (up) => `
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
         stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${up ? '<path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/>'
           : '<path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/>'}
    </svg>`;

  const button = (cls, html, title) => {
    const b = document.createElement('button');
    b.className = cls;
    b.innerHTML = html;
    b.title = title;
    b.tabIndex = -1; // never steal focus from the terminal
    pad.appendChild(b);
    return b;
  };

  const up = button('sbtn', chevrons(true), 'Back a few lines — hold to keep going');
  const down = button('sbtn', chevrons(false), 'Forward a few lines — hold to keep going');
  const latest = button('sbtn slatest', '', 'Back to the latest output');

  view.appendChild(pad);

  const buf = () => term.buffer.active;

  /// `pointerdown` rather than `click`: on a touch screen a click waits for the
  /// browser to rule out a double tap, and a scroll control that answers late
  /// feels broken. preventDefault keeps the terminal's focus, and with it the
  /// on-screen keyboard, exactly where it was.
  const press = (el, fn) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
      refresh();
    });
  };

  /// One tap's worth, in whichever world this terminal is in: one wheel notch
  /// to a program that reads the mouse, a few lines of the scrollback to a
  /// plain shell. Both come to about STEP_ROWS rows.
  const move = (dir) => {
    if (mouseTracked(term)) sendWheel(view, term, dir);
    else term.scrollLines(dir * STEP_ROWS);
  };

  /// Tap nudges a few lines; HOLD keeps going, faster the longer it is held.
  /// The tap is for reading — line by line, staying with the passage — and the
  /// hold is for distance, so neither has to compromise for the other.
  const hold = (el, dir) => {
    let frame = 0;
    let timer = 0;
    let speed = HOLD_FROM;

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
      frame = 0;
      timer = 0;
      speed = HOLD_FROM;
    };

    const run = () => {
      speed = Math.min(HOLD_TO, speed * HOLD_RAMP);
      wheelPx(view, term, dir * speed);
      refresh();
      frame = requestAnimationFrame(run);
    };

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // The screen moves at once, so a tap never feels like it is waiting to
      // find out whether it was going to be a hold.
      move(dir);
      refresh();
      timer = setTimeout(() => { timer = 0; run(); }, HOLD_MS);
      // Captured, so lifting the finger anywhere still stops it — a thumb slides
      // off a 38 px target more often than it stays on.
      try { el.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    });
    for (const kind of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(kind, stop);
  };

  hold(up, -1);
  hold(down, 1);
  press(latest, () => term.scrollToBottom());

  let queued = 0;
  function refresh() {
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      if (mouseTracked(term)) {
        // The program has the history and the position. Both buttons always
        // apply, and there is nothing truthful to say about how far back you
        // are — so the pill stays away rather than showing a zero that would be
        // a lie.
        pad.hidden = false;
        down.hidden = false;
        latest.hidden = true;
        pad.classList.remove('behind');
        return;
      }
      const { baseY, viewportY } = buf();
      const behind = baseY - viewportY;
      // Nothing has scrolled off yet: there is nowhere to go back to, so the
      // control has no reason to be on screen.
      pad.hidden = baseY === 0;
      if (pad.hidden) return;
      const atBottom = behind === 0;
      down.hidden = atBottom;
      latest.hidden = atBottom;
      pad.classList.toggle('behind', !atBottom);
      if (!atBottom) latest.textContent = `↓ ${behind}`;
    });
  }

  // Both matter: the position changes when you scroll, and how far behind you
  // are changes when the program writes another line while you are reading.
  term.onScroll(refresh);
  term.onLineFeed(refresh);
  // A program switching to or from the alternate screen changes which of the two
  // worlds above we are in, and nothing else here would notice.
  term.onWriteParsed?.(refresh);
  refresh();

  return { refresh, pad };
}
