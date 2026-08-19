// Reading back through a terminal on a touch screen.
//
// Two things do this job, and they are tested very differently.
//
// The scrollback control (`web/scrollpad.js`) is driven straight from its
// buttons, so everything below is deterministic: a screen back, a screen
// forward, how far behind you are, and one tap to the live end.
//
// The drag (`web/touchscroll.js`) is NOT asserted here, on purpose. Its whole
// point is to take over from xterm while the program is tracking the mouse —
// which is the one condition that cannot be produced in this environment:
// ConPTY does not forward `?1000h` from an ordinary program (measured, from
// PowerShell and from `node -e` alike; the bytes never reach the client), and an
// agent resumed to set the mode redraws inside the window without filling the
// scrollback. Asserting a drag against a plain shell would only be measuring
// xterm's own touch scrolling — which is flaky under synthetic touch events, and
// green or red it says nothing about the code here. The drag was verified by
// hand instead; see TESTING.md.

import { readFileSync } from 'node:fs';

const PORT = 7719;
const CFG = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here fails as "cannot connect", which says nothing about what
// this test is actually checking.
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');

// --- a terminal with something to scroll back through ------------------------
const app = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
app.binaryType = 'arraybuffer';
const msgs = [];
let screen = '';
app.onmessage = (e) => {
  if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
  else screen += strip(Buffer.from(e.data).subarray(4).toString('utf8'));
};
await new Promise((r) => { app.onopen = r; });
const find = (t) => msgs.find((m) => m.t === t);
/// `pred` may be async — awaited, because a promise is always truthy and a
/// predicate that talks to the browser would otherwise be "true" at once.
const waitFor = async (pred, what, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await pred()) return true; await sleep(120); }
  throw new Error(`timed out waiting for ${what}`);
};

// Not merely the first `state`: the daemon sends one while it is still scanning
// the registry, and that one has no projects in it yet. Wait for a project that
// really is on disk — spawning into a folder that is not there fails later, and
// for a reason that has nothing to do with scrolling.
const lastState = () => msgs.filter((m) => m.t === 'state').pop();
await waitFor(() => lastState()?.projects.some((p) => p.exists), 'the registry scan');
const project = lastState().projects.find((p) => p.exists).path;
app.send(JSON.stringify({ t: 'spawn', project, agent: 'shell', resume: null, cols: 90, rows: 24 }));
await waitFor(() => find('attached'), 'attached');
const id = find('attached').id;
await waitFor(() => /PS [A-Z]:/.test(screen), 'the prompt');

/// Typing goes down the socket as a binary frame — the terminal id, then the
/// bytes. There is no JSON message for it.
const input = (text) => {
  const body = Buffer.from(text, 'utf8');
  const f = Buffer.alloc(4 + body.length);
  f.writeUInt32LE(id, 0);
  body.copy(f, 4);
  app.send(f);
};
// Far more lines than the window holds, so there is a real scrollback.
input('1..300 | ForEach-Object { "scrollback line $_" }\r');
await waitFor(() => /scrollback line 300/.test(screen), 'the 300 lines');
await sleep(800);

// --- drive the browser -------------------------------------------------------
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0;
const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

const sel = `document.querySelector('.host:not([hidden]) .xterm-viewport')`;
const padSel = `document.querySelector('.host:not([hidden]) .spad')`;
const scrollTop = () => ev(`${sel}?.scrollTop`);
const btn = (n) => `document.querySelectorAll('.host:not([hidden]) .spad .sbtn')[${n}]`;

/// A real tap in the middle of that element.
///
/// The point is measured, then checked to still belong to that element before
/// anything is dispatched. The key bar settles its height a moment after the
/// page draws, which moves the terminal and everything in it — and a tap sent to
/// coordinates measured just before that lands on a line of output instead of
/// the button, which reads as "the button does nothing".
async function tap(expr) {
  for (let i = 0; i < 60; i++) {
    const r = await ev(`
      (() => {
        const e = ${expr};
        if (!e || e.hidden) return null;
        const b = e.getBoundingClientRect();
        if (!b.width || !b.height) return null;
        const x = b.x + b.width / 2;
        const y = b.y + b.height / 2;
        return { x, y, onTop: document.elementFromPoint(x, y) === e };
      })()
    `);
    if (r && r.onTop) {
      await cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
      await sleep(40);
      await cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(350);
      return;
    }
    await sleep(150);
  }
  // Say what was in the way. "Nothing tappable" on its own sends the next
  // person back through the same hour of guessing.
  const blocking = await ev(`
    (() => {
      const e = ${expr};
      if (!e) return 'the element is not in the page';
      if (e.hidden) return 'the element is hidden';
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height) return 'the element has no size';
      const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return 'covered by ' + (top ? (top.id || top.className || top.tagName) : 'nothing');
    })()
  `);
  const pads = await ev(`
    JSON.stringify([...document.querySelectorAll('#terms .spad')].map((p) => ({
      hostHidden: !!p.closest('.host')?.hidden,
      machineHidden: !!p.closest('.mhost')?.hidden,
      padHidden: !!p.hidden,
      buttons: [...p.querySelectorAll('.sbtn')].map((b) => (b.hidden ? 'hidden' : Math.round(b.getBoundingClientRect().width))),
    })))
  `);
  throw new Error(`nothing tappable for ${expr}: ${blocking}\n    spads: ${pads}`);
}

// Everything after this point runs inside the try, so a failure still puts the
// browser back the way it was found. A run that dies holding mobile emulation
// makes every later test in the suite fail for reasons of its own making.
try {
  // A touch screen, but wide enough that the sidebar is docked rather than an
  // overlay — a tablet in landscape. What the control keys on is the pointer,
  // not the width, so this is the same case; and it keeps the sidebar's backdrop
  // (which opens by itself when nothing is attached yet, and covers the whole
  // stage) from swallowing taps meant for the terminal.
  await cmd('Emulation.setDeviceMetricsOverride', { width: 900, height: 780, deviceScaleFactor: 2, mobile: true });
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // Say `pointer: coarse` out loud. Touch emulation and `mobile: true` do NOT
  // move that media query on their own — on a browser started fresh the control
  // never mounted and this test failed at the first tap. It passed before only
  // because an earlier script in the suite had left the emulation behind, which
  // is exactly the kind of borrowed green this file is meant not to report.
  await cmd('Emulation.setEmulatedMedia', {
    features: [
      { name: 'pointer', value: 'coarse' },
      { name: 'any-pointer', value: 'coarse' },
      { name: 'hover', value: 'none' },
    ],
  });
  await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
  // Wait for the tab to exist rather than for a fixed number of seconds: a slow
  // load once left every check below failing on an empty page.
  await waitFor(async () => await ev(`!!document.querySelector('.tab[data-id="${id}"]')`), 'our tab', 30000);
  // Our own terminal, by id: another one may already be open, and the first tab
  // would be somebody else's screen with nothing to scroll through.
  //
  // Clicked again on every pass rather than once. A tab can be in the DOM a
  // moment before its handler is attached, and that first click then lands on
  // nothing — which showed up here as the scrollback never arriving, twenty
  // seconds after a click that had quietly done nothing at all.
  await waitFor(async () => {
    if (await ev(`!!${sel} && ${sel}.scrollHeight > ${sel}.clientHeight`)) return true;
    await ev(`document.querySelector('.tab[data-id="${id}"]')?.click()`);
    return false;
  }, 'the scrollback', 30000);

  // Wait for the replay to stop growing before touching anything. While lines
  // are still arriving the terminal is pinned to the bottom, so a scroll back
  // is undone by the next line and the button looks broken when it is not.
  // Close the sidebar first. On a narrow window it opens by itself when no
  // session is attached yet, and it comes with a backdrop across the whole
  // stage — so every tap below would land on that instead of on the control.
  // Clicking a tab through the DOM attaches the terminal but does not dismiss
  // it, the way tapping the tab on a real screen never could.
  await ev(`document.getElementById('backdrop').click()`);
  await waitFor(async () => await ev(`document.getElementById('backdrop').hidden`), 'the sidebar to close', 10000);

  // Four polls, not one: a shell goes quiet for a moment between the last line
  // of output and its prompt, and a single stable sample lands in that gap and
  // calls it finished.
  let last = -1;
  let stable = 0;
  await waitFor(async () => {
    const now = await ev(`${sel}.scrollHeight + ':' + ${sel}.scrollTop`);
    stable = now === last ? stable + 1 : 0;
    last = now;
    return stable >= 4;
  }, 'the replay to settle', 25000);

  check(
    // `includes`, not `endsWith`: module URLs carry a `?v=<hash>` stamp so that
    // updates reach cached phones, and the stamp sits after the name.
    await ev(`['/touchscroll.js', '/scrollpad.js'].every(n => performance.getEntriesByType('resource').some(r => r.name.includes(n)))`),
    'the page loads both the drag and the control',
  );

  const overscroll = await ev(`getComputedStyle(document.body).overscrollBehaviorY`);
  check(overscroll === 'none', `a drag can never become pull-to-refresh (overscroll-behavior: ${overscroll})`);

  check(await ev(`!!${sel} && ${sel}.scrollHeight > ${sel}.clientHeight`), 'the terminal has a scrollback taller than its window');
  const bottom = await scrollTop();
  check(bottom > 0, `and it opens at the bottom of it (scrollTop ${bottom})`);

  // --- the control is there, and says only what applies ----------------------
  check(await ev(`!!${padSel} && !${padSel}.hidden`), 'the scrollback control is on the terminal');
  const atBottom = await ev(`
    [...document.querySelectorAll('.host:not([hidden]) .spad .sbtn')].map(b => b.hidden)
  `);
  check(
    JSON.stringify(atBottom) === '[false,true,true]',
    `at the live end only "back" is offered (${JSON.stringify(atBottom)})`,
  );

  // --- a tap nudges a few lines ----------------------------------------------
  await tap(btn(0));
  const back = await scrollTop();
  check(back < bottom, `tapping it goes back (${bottom} -> ${back})`);

  // How many rows this window actually holds — NOT the 24 the terminal was
  // spawned with. The size is negotiated down to the smallest attached client,
  // and on a phone-sized window that is fewer; measuring against 24 would make
  // this pass or fail for the wrong reason.
  const rows = await ev(`document.querySelectorAll('.host:not([hidden]) .xterm-rows > div').length`);
  const rowPx = await ev(`${sel}.clientHeight`) / rows;

  // A few lines, NOT a screen. A screen per tap was the first design and it
  // tore the reader away from the passage they were following; a tap is now a
  // nudge of STEP_ROWS (3) rows, and covering distance is the hold's job.
  const stepped = Math.round((bottom - back) / rowPx);
  check(
    stepped >= 1 && stepped <= 4,
    `and a tap is a nudge, not a screen: ${stepped} of ${rows} rows`,
  );

  // A shell keeps writing — a prompt, a blank line — and every line it adds puts
  // one more between you and the live end. So the count is checked against what
  // the view actually moved, with room for the lines that arrived meanwhile.
  const behind = await ev(`document.querySelector('.host:not([hidden]) .slatest').textContent`);
  const said = Number(/\d+/.exec(behind || '')?.[0]);
  check(
    said >= stepped && said <= stepped + 4,
    `and it says how far behind you are ("${behind}", the view moved ${stepped} rows)`,
  );

  // --- and forward again ------------------------------------------------------
  await tap(btn(1));
  const forward = await scrollTop();
  check(forward > back, `the second button comes forward again (${back} -> ${forward})`);

  // --- a HOLD is what covers distance -----------------------------------------
  // With the tap now a three-row nudge, the hold carries the rest of the job.
  // The finger goes down on the button and stays there past HOLD_MS; by release
  // it must have moved far further than any tap could.
  {
    const start = await scrollTop();
    const r = await ev(`
      (() => { const b = ${btn(0)}; const x = b.getBoundingClientRect();
               return { x: x.x + x.width / 2, y: x.y + x.height / 2 }; })()
    `);
    await cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
    await sleep(1300);
    await cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(400);
    const held = await scrollTop();
    const heldRows = Math.round((start - held) / rowPx);
    check(heldRows >= 8, `holding the button keeps going (${heldRows} rows in ~1.3s)`);
    // And letting go stops it: no coasting a second later.
    await sleep(700);
    check((await scrollTop()) === held, 'and it stops the moment the finger lifts');
    // Back to the bottom so the pill checks below start from a known place.
    await tap(`document.querySelector('.host:not([hidden]) .slatest')`);
    await tap(btn(0));
  }

  // --- and one tap back to the live end --------------------------------------
  await tap(btn(0));
  await tap(btn(0));
  const far = await scrollTop();
  check(far < back, `two more taps go further back (${far})`);
  await tap(`document.querySelector('.host:not([hidden]) .slatest')`);
  // At the bottom as it is NOW, not back at the number from before: if the shell
  // wrote another line while we were reading, the live end has moved, and going
  // to the live end is what the pill promises.
  const atEnd = await ev(`Math.abs(${sel}.scrollHeight - ${sel}.clientHeight - ${sel}.scrollTop) <= 1`);
  check(atEnd, `and the pill returns to the latest output in one tap (${far} -> ${await scrollTop()})`);
  check(
    JSON.stringify(await ev(`[...document.querySelectorAll('.host:not([hidden]) .spad .sbtn')].map(b => b.hidden)`)) === '[false,true,true]',
    'which puts the control back to offering only "back"',
  );

  // --- a tap on the terminal is still a tap ----------------------------------
  const beforeTap = await scrollTop();
  const mid = await ev(`(() => { const b = ${sel}.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  // A tap, with no movement at all. A few pixels of drift would be scrolled by
  // the browser itself — correctly, since with the mouse untracked xterm's own
  // touch handling is in charge — and that would say nothing about this code.
  await cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mid.x, y: mid.y }] });
  await sleep(60);
  await cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
  check((await scrollTop()) === beforeTap, 'a tap on the terminal does not scroll it');

  check(
    (await ev(`window.scrollY`)) === 0 && (await ev(`document.readyState`)) === 'complete',
    'and the page itself never scrolled or reloaded',
  );

  // --- nothing of this on a machine with a mouse -----------------------------
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cmd('Emulation.clearDeviceMetricsOverride');
  // The laptop case cannot be checked here, and the reason is worth stating
  // rather than skipping quietly.
  //
  // This headless Chrome reports `pointer: coarse` unconditionally —
  // `maxTouchPoints` is 10 with no emulation of any kind, and asking for
  // `pointer: fine` through `Emulation.setEmulatedMedia` changes nothing. So
  // there is no way to make the browser look like a machine with a mouse.
  //
  // Worse, the obvious assertion is a trap: `!document.querySelector('.spad')`
  // goes green whenever no terminal happens to be on screen, which is most of
  // the time right after a reload. It was passing that way, saying nothing.
  await cmd('Emulation.setEmulatedMedia', {
    features: [
      { name: 'pointer', value: 'fine' },
      { name: 'any-pointer', value: 'fine' },
      { name: 'hover', value: 'hover' },
    ],
  });
  const stillCoarse = await ev(`window.matchMedia('(pointer: coarse)').matches`);
  console.log(
    stillCoarse
      ? `  [note] this browser reports a coarse pointer even when asked for a mouse `
        + `(maxTouchPoints ${await ev('navigator.maxTouchPoints')}), so the laptop case is not checked here`
      : '  [note] unexpected: the pointer can now be made fine — the laptop case is worth asserting again',
  );
} finally {
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cmd('Emulation.clearDeviceMetricsOverride');
  // Put the media query back too, or every script after this one runs as a
  // touch screen and quietly tests the wrong case.
  await cmd('Emulation.setEmulatedMedia', { features: [] });
  app.send(JSON.stringify({ t: 'kill', id }));
  await sleep(600);
}

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
