// The sound a finished terminal makes.
//
// Generated, not an asset: the artifact CSP allows no external fetches, an
// embedded wav is bytes nobody can read, and two sine notes from an oscillator
// are the whole requirement. Quiet on purpose — this fires while you are
// looking somewhere else, and a notification that startles gets turned off.

let ctx = null;

/// A sound of the user's own, if they dropped one into `web/`. Checked once:
/// the first name that answers wins, and the blob is held locally so later
/// dings cost no request.
let custom = null;
let probed = false;
async function probe() {
  if (probed) return;
  probed = true;
  for (const name of ['notify.mp3', 'notify.wav', 'notify.ogg']) {
    try {
      const r = await fetch(`/${name}`);
      if (r.ok) {
        custom = URL.createObjectURL(await r.blob());
        return;
      }
    } catch {
      /* absent is the normal case */
    }
  }
}

/// Browsers refuse to start audio outside a user gesture. Called from any
/// pointerdown (a one-shot listener in app.js) and from the sound toggle, so
/// that by the time a terminal finishes, the context is already running.
export function unlock() {
  probe();
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

/// Two short notes, a fifth apart, ~0.3 s in total.
///
/// Always announces itself as a DOM event too: headless tests cannot hear, and
/// `sh:ding` is the only observable trace that a sound really fired.
export function ding() {
  document.dispatchEvent(new CustomEvent('sh:ding'));
  // A user-supplied sound beats the generated one. `web/notify.mp3` (or .wav,
  // .ogg) is all it takes — drop the file in, no setting to flip.
  if (custom) {
    const a = new Audio(custom);
    a.volume = 0.5;
    a.play().catch(() => {});
    return;
  }
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  for (const [freq, at] of [[660, 0], [990, 0.12]]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // A fast attack and an exponential tail: a click-free "dink" rather than a
    // square-edged beep.
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(0.06, t0 + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.2);
  }
}
