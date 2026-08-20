// The finish notice.
//
// A chime says something finished. With terminals across several machines that
// is the least useful half of the message — you still have to hunt for which
// one, and the sound is gone before you start looking. So the toast names the
// terminal and the machine, and takes you there.
//
// The hover rule is the fiddly part and the reason this test exists: pointing at
// a toast does not pause its timer, it RESETS it. A toast you have moved onto is
// one you are reading, and handing back the two seconds it had left would snatch
// it away mid-sentence. Closing has to keep working the whole time, or a paused
// toast becomes a permanent tenant of the corner.
//
// Driven through the module directly rather than by waiting for a real run to
// finish: the heuristic behind that needs five seconds of output and is tested
// where it lives. What is unproven here is the notice itself.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\toasthome`;
const PROJ = `${SP}\\savedproj`;
const PORT = 7746;
const TOKEN = 'uji-toast';

const steps = [];
const check = (c, m) => {
  steps.push(c);
  console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = async () => {
  try {
    return (await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json()).version;
  } catch {
    return null;
  }
};

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
writeFileSync(
  `${HOME}\\.sessionhub\\config.toml`,
  [
    `port = ${PORT}`,
    'lan_access = false',
    `token = "${TOKEN}"`,
    `projects = ["${PROJ.split('\\').join('\\\\')}"]`,
    '',
  ].join('\n'),
);
spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 40 && !(await alive()); i++) await sleep(500);
check(!!(await alive()), `test daemon up on ${PORT}`);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => {
  cdp.onopen = r;
});
let seq = 0;
const pending = new Map();
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const cmd = (method, params = {}) => {
  const i = ++seq;
  cdp.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
const ev = async (e) =>
  (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;
const waitFor = async (expr, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr)) return true;
    await sleep(200);
  }
  return false;
};
const count = () => ev(`document.querySelectorAll('#toasts .toast').length`);

await cmd('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 820,
  deviceScaleFactor: 1,
  mobile: false,
});
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5500);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(400);

// The module under test, with a short life so the timing is checkable in a
// reasonable run. The real one is nine seconds.
await ev(`
  (async () => {
    const { Toasts } = await import('./toasts.js?probe=1');
    window.__T = new Toasts(document.body);
    window.__went = 0;
  })()
`);
await sleep(800);
check(await ev(`!!window.__T`), 'the toast module loads');

// The app mounts its own stack inside the stage, not the window. Anchored to
// the window it covers the machine tabs and the tab strip on a phone — the two
// rows that say what is running, which is what you look at after being told
// something finished.
check(
  await ev(`
    (() => {
      const boxes = [...document.querySelectorAll('#toasts')];
      const stage = document.getElementById('stage');
      return boxes.length > 0 && boxes.some(b => stage.contains(b));
    })()
  `),
  'the app mounts its toasts inside the stage, below the tab strip',
);

// --- it says what and where, and it can be gone to -------------------------
await ev(`
  window.__T.show({
    key: 'm1:7',
    title: 'telegram-bot finished',
    note: 'mcp · terminal · mac',
    onClick: () => { window.__went++; },
  })
`);
check((await count()) === 1, 'a toast appears');
const text = await ev(`document.querySelector('#toasts .toast').textContent`);
check(/telegram-bot finished/.test(text), 'naming what finished');
check(/mcp/.test(text) && /mac/.test(text), `and where it was — project and machine (${text.trim()})`);

// --- hover holds it, and resets rather than resumes -------------------------
const box = JSON.parse(
  await ev(`
    JSON.stringify((() => {
      const r = document.querySelector('#toasts .toast').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })())
  `),
);
// Most of the way through its life, then hover.
await sleep(6500);
check((await count()) === 1, 'still there most of the way through its life');
await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
await sleep(400);
check(
  await ev(`document.querySelector('#toasts .toast').classList.contains('held')`),
  'pointing at it marks it held',
);
// Past when it would have expired had the timer merely kept running.
await sleep(4000);
check((await count()) === 1, 'and it does not expire while pointed at');

// Away again: the FULL time, not the two seconds it had left. Check just after
// the remainder would have run out.
await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 400, buttons: 0 });
await sleep(3500);
check(
  (await count()) === 1,
  'leaving restarts the whole timer rather than handing back the remainder',
);
check(await waitFor(`document.querySelectorAll('#toasts .toast').length === 0`, 12000), 'and then it goes');

// --- closing works while held ----------------------------------------------
await ev(`window.__T.show({ key: 'm1:8', title: 'second', note: 'x', onClick: () => { window.__went++; } })`);
await sleep(300);
const box2 = JSON.parse(
  await ev(`
    JSON.stringify((() => {
      const r = document.querySelector('#toasts .toast .tclose').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })())
  `),
);
await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box2.x, y: box2.y, buttons: 0 });
await sleep(300);
check(
  await ev(`document.querySelector('#toasts .toast')?.classList.contains('held')`),
  'a toast under the pointer is held',
);
await ev(`document.querySelector('#toasts .toast .tclose').click()`);
await sleep(500);
check((await count()) === 0, 'and the close button still dismisses it');
check(
  (await ev(`window.__went`)) === 0,
  'closing does not also take you there — the ✕ sits inside the clickable body',
);

// --- clicking the body goes ------------------------------------------------
await ev(`window.__T.show({ key: 'm1:9', title: 'third', note: 'y', onClick: () => { window.__went++; } })`);
await sleep(300);
await ev(`document.querySelector('#toasts .toast').click()`);
await sleep(400);
check((await ev(`window.__went`)) === 1, 'clicking the toast itself goes there');
check((await count()) === 0, 'and dismisses it on the way');

// --- the same thing finishing twice refreshes, it does not stack ------------
await ev(`window.__T.show({ key: 'm1:9', title: 'again', note: 'y' })`);
await ev(`window.__T.show({ key: 'm1:9', title: 'again and again', note: 'y' })`);
await sleep(300);
check((await count()) === 1, 'the same terminal finishing twice refreshes one toast');
check(
  /again and again/.test(await ev(`document.querySelector('#toasts .toast').textContent`)),
  'showing the newer message',
);

// --- the stack is capped ----------------------------------------------------
await ev(`
  (() => { for (let i = 0; i < 9; i++) window.__T.show({ key: 'k' + i, title: 'n' + i, note: '' }); })()
`);
await sleep(400);
const shown = await count();
check(shown <= 4, `the stack is capped so the newest can still be read (${shown})`);
const left = await ev(`
  [...document.querySelectorAll('#toasts .toast')].map(t => t.querySelector('.ttitle').textContent)
`);
console.log(`    left on screen: ${left.join(', ')}`);
check(
  left.includes('n8') && !left.includes('n0'),
  'and it is the newest that survives, not the oldest',
);

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
