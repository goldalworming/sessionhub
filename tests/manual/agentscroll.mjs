// Scrolling back through an AGENT on a touch screen — the case the whole thing
// exists for, and the one that is easy to get wrong.
//
// An agent runs on the alternate screen (`?1049h`) and reads the mouse. Two
// consequences, and they are the reason this test is separate from the shell
// one:
//
//   - the terminal keeps NO scrollback there, so `scrollLines` has nothing to
//     move and counting "how far behind" is meaningless;
//   - the history belongs to the program, and the only way to ask for it is the
//     way a wheel does. That is why a mouse works on a laptop and a finger did
//     not.
//
// So what is checked here is not the terminal's scroll position — there is none
// — but that the PROGRAM redraws in response to the control. The screen text
// changing is the only honest evidence of that.

import { readFileSync } from 'node:fs';

const PORT = 7719;
const CFG = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
app.binaryType = 'arraybuffer';
const msgs = [];
let raw = '';
app.onmessage = (e) => {
  if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
  else raw += Buffer.from(e.data).subarray(4).toString('latin1');
};
await new Promise((r) => { app.onopen = r; });
const waitFor = async (pred, what, ms = 60000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await pred()) return true; await sleep(150); }
  throw new Error(`timed out waiting for ${what}`);
};
const lastState = () => msgs.filter((m) => m.t === 'state').pop();

// A session with a real conversation in it — a fresh agent has nothing to scroll
// back through, and the test would pass or fail on how chatty it felt today.
await waitFor(() => lastState()?.projects.some((p) => p.sessions.some((s) => s.agent === 'claude' && !s.live_terminal_id)), 'the registry scan');
const proj = lastState().projects.find((p) => p.exists && p.sessions.some((s) => s.agent === 'claude' && !s.live_terminal_id));
const sess = proj.sessions.find((s) => s.agent === 'claude' && !s.live_terminal_id);
console.log(`  resuming ${sess.session_id} in ${proj.path}`);

app.send(JSON.stringify({ t: 'spawn', project: proj.path, agent: 'claude', resume: sess.session_id, cols: 100, rows: 26 }));
await waitFor(() => msgs.find((m) => m.t === 'attached'), 'attached');
const id = msgs.find((m) => m.t === 'attached').id;

// The premise, measured rather than assumed. If an agent ever stops doing this,
// the code under test is solving a problem that no longer exists and this should
// say so loudly.
await waitFor(() => /\x1b\[\?1049h/.test(raw), 'the alternate screen');
check(true, 'the agent takes the alternate screen (?1049h) — no terminal scrollback exists');
await waitFor(() => /\x1b\[\?100[023]h/.test(raw), 'mouse tracking');
check(true, 'and it turns mouse tracking on, which is what disables xterm\'s own touch scrolling');

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0;
const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

const screen = () => ev(`
  [...document.querySelectorAll('.host:not([hidden]) .xterm-rows > div')].map(r => r.textContent).join('\\n')
`);

/// A real tap, re-measured and confirmed to be on top before it is sent — the
/// key bar settles its height after the page draws and moves everything below.
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
      await sleep(700); // the program has to redraw, not just the browser
      return;
    }
    await sleep(150);
  }
  throw new Error(`nothing tappable for ${expr}`);
}

try {
  // A touch screen, wide enough that the sidebar is docked rather than an
  // overlay whose backdrop would swallow every tap. See TESTING.md.
  await cmd('Emulation.setDeviceMetricsOverride', { width: 900, height: 780, deviceScaleFactor: 2, mobile: true });
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
  const sel = `document.querySelector('.host:not([hidden]) .xterm-viewport')`;
  const padSel = `document.querySelector('.host:not([hidden]) .spad')`;
  await waitFor(async () => {
    if (await ev(`!!${sel}`)) return true;
    await ev(`document.querySelector('.tab[data-id="${id}"]')?.click()`);
    return false;
  }, 'the terminal on screen', 40000);
  await ev(`document.getElementById('backdrop').click()`);

  // Let the agent finish drawing. Its own redraws would otherwise be mistaken
  // for the effect of the button.
  let seen = '';
  let stable = 0;
  await waitFor(async () => {
    const now = await screen();
    stable = now === seen ? stable + 1 : 0;
    seen = now;
    return stable >= 5;
  }, 'the agent to finish drawing', 60000);

  check(await ev(`!!${padSel} && !${padSel}.hidden`), 'the control is on the terminal');
  const flags = await ev(`[...document.querySelectorAll('.host:not([hidden]) .spad .sbtn')].map(b => b.hidden)`);
  check(
    JSON.stringify(flags) === '[false,false,true]',
    `both directions are offered, and no "behind" count is claimed (${JSON.stringify(flags)})`,
  );
  check(
    (await ev(`${sel}.scrollHeight <= ${sel}.clientHeight + 1`)),
    'the terminal itself has nothing to scroll — the history is the agent\'s',
  );

  // --- back ------------------------------------------------------------------
  const before = await screen();
  await tap(`document.querySelectorAll('.host:not([hidden]) .spad .sbtn')[0]`);
  const afterUp = await screen();
  check(afterUp !== before, 'tapping "back" makes the agent redraw — it scrolled its own history');

  // --- forward ---------------------------------------------------------------
  await tap(`document.querySelectorAll('.host:not([hidden]) .spad .sbtn')[1]`);
  const afterDown = await screen();
  check(afterDown !== afterUp, 'and "forward" moves it again');

  // Not "back then forward lands where it started". Where a screen back and a
  // screen forward leave you is the agent's decision — it may clamp at the end
  // of its history, or move by a different amount near the edges — and asserting
  // symmetry here would be testing Claude Code's scrolling, not this control.
  //
  // What does belong here: the button pages through history rather than toggling
  // between two states.
  const seenScreens = new Set([afterDown]);
  for (let i = 0; i < 3; i++) {
    await tap(`document.querySelectorAll('.host:not([hidden]) .spad .sbtn')[0]`);
    seenScreens.add(await screen());
  }
  check(seenScreens.size >= 3, `holding "back" keeps moving through the history (${seenScreens.size} distinct screens in 4)`);
} finally {
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cmd('Emulation.clearDeviceMetricsOverride');
  app.send(JSON.stringify({ t: 'kill', id }));
  await sleep(800);
}

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
