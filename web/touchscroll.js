// Drag to move through a terminal's scrollback on a touch screen.
//
// On a laptop the wheel does this and nothing here is needed. On a phone there
// is no wheel, and none of the keys on the key bar reach the scrollback either:
// the arrows and PgUp/PgDn are sent to the program as keystrokes, so in an agent
// they move through command history or through the agent's own view, never
// through what the terminal itself is still holding. Everything already said
// scrolls off the top and there is no way back to it.
//
// xterm can scroll on touch by itself, but only while the program is not
// tracking the mouse:
//
//     on('touchmove', e => { if (!coreMouseService.areMouseEventsActive) … })
//
// A full-screen agent turns mouse tracking on, so that branch is skipped and the
// drag falls through to the browser — which reads it as pull-to-refresh and
// reloads the page. Precisely in the programs worth scrolling back through,
// scrolling back is impossible.
//
// So this takes over the drag, and only in that case: while mouse tracking is
// off, xterm's own handling is left alone.
//
// What it does with the drag is send the program wheel events, NOT scroll the
// terminal. That distinction is the whole point, and it was learned the hard
// way: an agent like Claude Code runs on the ALTERNATE SCREEN (`?1049h`,
// measured from the raw PTY bytes), where a terminal keeps no scrollback at all.
// `scrollLines` there has nothing to move. The history you are trying to get
// back to belongs to the program, not to the terminal, and the only way to ask
// for it is the same way a wheel does — which is exactly why a mouse works on a
// laptop and a finger did not.

/// How far a finger must travel before this is a scroll and not a tap. Below it
/// every touch is passed through untouched, so tapping still focuses the
/// terminal and still raises the on-screen keyboard.
const CLAIM_PX = 8;

/// A fling keeps going after the finger leaves, losing this share of its speed
/// each frame. Reading back through a long session is otherwise all thumb work.
const FRICTION = 0.94;

/// Below this the fling has arrived; carrying on just burns frames.
const STOP_PX_PER_FRAME = 0.4;

/// One row in pixels. Asked of the layout rather than remembered, because the
/// font size and the window both change under us.
export const rowPx = (view, term) => Math.max(1, view.clientHeight / Math.max(1, term.rows));

/// Roughly how far a finger travels for one notch of a wheel. Three rows is what
/// a wheel click moves in most terminals, and matching it keeps a drag moving
/// about as much text as the same distance would on a trackpad.
export const notchPx = (view, term) => 3 * rowPx(view, term);

/// A device driven by touch — where the on-screen controls have a job to do.
///
/// The PRIMARY pointer decides, and nothing else. Both refinements tried here
/// were wrong in ways that only real hardware showed:
///
/// - `|| max-width` put the key bar on any laptop window snapped to half the
///   screen. A narrow window still has a real keyboard.
/// - `&& !(any-pointer: fine)` — meant to spare touchscreen laptops — switched
///   the bar off on real phones. A stylus digitizer or a once-paired Bluetooth
///   mouse makes a phone report a fine pointer somewhere, and the bar then
///   never appeared on the exact device it exists for.
///
/// `pointer: coarse` says what the screen is being driven with right now. A
/// stylus phone is still a phone; a touchscreen laptop whose browser calls the
/// finger its primary pointer is being used as a touch device at that moment,
/// and offering the ⌨ toggle there is the lesser wrong.
///
/// The width net survives only for browsers that do not understand pointer
/// queries at all, which announce themselves by matching none of the three
/// pointer values.
export function touchOnlyDevice() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const understood =
    coarse
    || window.matchMedia('(pointer: fine)').matches
    || window.matchMedia('(pointer: none)').matches;
  if (understood) return coarse;
  return window.matchMedia('(max-width: 820px)').matches;
}

/// True while the program is reading the mouse. That is both the case xterm
/// gives up on touch in, and the case where scrolling means asking the program
/// rather than moving the terminal.
export function mouseTracked(term) {
  try {
    return term.modes.mouseTrackingMode !== 'none';
  } catch {
    // `modes` needs allowProposedApi. Without it, better to do nothing than to
    // fight xterm over every gesture.
    return false;
  }
}

/// Send `n` notches of wheel to the program — down the screen when positive.
///
/// A synthetic `wheel` event rather than a mouse report written by hand: xterm
/// already listens for one and encodes it in whichever mouse protocol the
/// program asked for. Writing the bytes here would mean choosing between the old
/// encoding and SGR, and getting it wrong for somebody.
export function sendWheel(view, term, n) {
  const step = Math.sign(n);
  for (let i = 0; i < Math.abs(n); i++) wheelPx(view, term, step * notchPx(view, term));
}

/// One wheel event carrying exactly `px` pixels of movement.
///
/// This is what a drag uses, rather than a whole number of notches. xterm turns
/// deltaY into that many rows of scrolling — keeping the remainder itself
/// between events — so a finger that has moved eleven pixels moves the program
/// by eleven pixels' worth, and the next frame continues from there.
///
/// Notches were the first attempt and they are why it felt broken up: one notch
/// is three rows, about 63 px, so the first 63 px of every drag did nothing at
/// all and then the screen jumped three rows at once.
export function wheelPx(view, term, px) {
  const target = view.querySelector('.xterm-screen') || view.querySelector('.xterm');
  if (!target || !px) return;
  const box = target.getBoundingClientRect();
  // Somewhere inside the terminal: the report carries a cell position, and a
  // point outside the screen is not a cell.
  target.dispatchEvent(new WheelEvent('wheel', {
    deltaY: px,
    deltaMode: 0,
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
    bubbles: true,
    cancelable: true,
  }));
}

export function attachTouchScroll(view, term) {
  let tracking = false; // a single finger is down
  let claimed = false; // it has moved far enough to be a scroll
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let speed = 0; // px per frame, signed like `dy` below
  let carry = 0; // pixels measured but not yet sent, flushed once per frame
  let frame = 0;

  /// Everything that moves the view goes through one animation frame, so a burst
  /// of touchmove events becomes a single wheel event instead of several. The
  /// program redraws its whole screen for each one it receives, and flooding it
  /// is the other half of what made this feel bad.
  const flush = () => {
    frame = 0;
    if (carry) {
      wheelPx(view, term, carry);
      carry = 0;
    }
    if (!tracking && Math.abs(speed) >= STOP_PX_PER_FRAME) {
      carry += speed;
      speed *= FRICTION;
      frame = requestAnimationFrame(flush);
    }
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const stopFling = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    speed = 0;
    carry = 0;
  };

  // Capture, so this runs before xterm's own listeners further in: once the drag
  // is claimed they must not also see it, or the program gets a mouse drag at
  // the same time as the screen scrolls.
  view.addEventListener(
    'touchstart',
    (e) => {
      stopFling();
      tracking = e.touches.length === 1;
      claimed = false;
      carry = 0;
      if (!tracking) return;
      startY = lastY = e.touches[0].clientY;
      lastT = e.timeStamp;
    },
    { capture: true, passive: true },
  );

  view.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking || e.touches.length !== 1 || !mouseTracked(term)) return;
      const y = e.touches[0].clientY;
      if (!claimed) {
        if (Math.abs(y - startY) < CLAIM_PX) return;
        claimed = true;
        // Start measuring from here, not from where the finger landed: the first
        // CLAIM_PX are the cost of telling a scroll from a tap, and counting
        // them would make every drag begin with a jump.
        lastY = y;
        lastT = e.timeStamp;
        return;
      }
      // Ours now: no pull-to-refresh, and xterm does not see it either.
      e.preventDefault();
      e.stopPropagation();
      const dy = lastY - y;
      const dt = Math.max(1, e.timeStamp - lastT);
      // ~16 ms to a frame, so this is pixels per frame. Smoothed, because one
      // stuttering frame in the middle of a drag should not decide how far the
      // fling afterwards goes.
      speed = speed * 0.4 + ((dy / dt) * 16) * 0.6;
      lastY = y;
      lastT = e.timeStamp;
      carry += dy;
      schedule();
    },
    { capture: true, passive: false },
  );

  const end = (e) => {
    if (claimed) {
      // Belt and braces. The program never sees a half-finished click anyway:
      // what reports the mouse to it is mousedown/mouseup, and the browser only
      // synthesises those from a touch that was not prevented. Calling
      // preventDefault on the first claimed move cancels them for the whole
      // gesture — so a drag reports nothing, while a tap, which is never
      // claimed and never prevented, still arrives as a normal click.
      e.stopPropagation();
      // A finger that stopped before lifting should not fling. Without this a
      // slow drag ending in a pause still coasts away, which reads as the
      // terminal ignoring where you let go.
      if (e.timeStamp - lastT > 120) speed = 0;
      tracking = false;
      if (Math.abs(speed) >= STOP_PX_PER_FRAME) schedule();
    }
    tracking = false;
    claimed = false;
  };
  view.addEventListener('touchend', end, { capture: true });
  view.addEventListener('touchcancel', end, { capture: true });
}
