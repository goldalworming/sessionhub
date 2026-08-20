// Reordering tabs.
//
// Two ways in, because a phone has neither a mouse nor a spare gesture: dragging
// with a pointer on a desktop, and **Move left / Move right** in the tab menu
// where a long press already belongs to the colour menu.
//
// The order is kept in this browser, not on the daemon. A colour is a label you
// want to recognise from any device; an order is a working arrangement that
// belongs to the screen you arranged it on.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\orderhome2`;
const PROJ = `${SP}\\savedproj`;
const PORT = 7741;
const TOKEN = 'uji-taborder';

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

// Three terminals, named so the order is readable in the assertions.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
const msgs = [];
await new Promise((r) => {
  ws.onopen = r;
});
ws.onmessage = (e) => {
  if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
};
for (const name of ['one', 'two', 'three']) {
  ws.send(
    JSON.stringify({ t: 'spawn', project: PROJ, agent: 'terminal', resume: null, cols: 80, rows: 24 }),
  );
  await sleep(2200);
  const id = msgs.filter((m) => m.t === 'attached').pop().id;
  ws.send(JSON.stringify({ t: 'save_terminal', id, name, command: '' }));
  await sleep(800);
}
ws.close();

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
    await sleep(250);
  }
  return false;
};
/// The tab labels, shortened to the name each terminal was saved under.
const order = async () =>
  await ev(`
    [...document.querySelectorAll('.tab .tname')]
      .map(x => x.textContent.split('·').pop().trim())
  `);

// --- a desktop, with a mouse ------------------------------------------------
//
// This headless Chrome reports `pointer: coarse` no matter what is emulated —
// noted in keybarui.mjs, where the same limitation puts the laptop case out of
// reach. So the media query is answered by hand for the desktop half. Only the
// browser is being faked; the app's own rule is left exactly as it is.
await cmd('Page.enable');
const asMouse = await cmd('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => {
      if (q.includes("pointer: coarse")) return { matches: false, addEventListener() {}, removeEventListener() {} };
      if (q.includes("pointer: fine")) return { matches: true, addEventListener() {}, removeEventListener() {} };
      return real(q);
    };
  })()`,
});
await cmd('Emulation.setTouchEmulationEnabled', { enabled: false });
await cmd('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 820,
  deviceScaleFactor: 1,
  mobile: false,
});
await ev(`localStorage.removeItem('sh.taborder')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5500);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(400);

check(
  await waitFor(`document.querySelectorAll('.tab').length === 3`, 20000),
  'three tabs are shown',
);
const start = await order();
console.log(`    start:  ${start.join(', ')}`);
check(start.join(',') === 'one,two,three', 'in the order they were created');
check(
  await ev(`document.querySelector('.tab').draggable === true`),
  'and with a mouse they are draggable',
);

// Drag the last one onto the left half of the first: it should land in front.
const drag = async (fromIdx, toIdx, side) => {
  const box = JSON.parse(
    await ev(`
      JSON.stringify((() => {
        const tabs = document.querySelectorAll('.tab');
        const f = tabs[${fromIdx}].getBoundingClientRect();
        const t = tabs[${toIdx}].getBoundingClientRect();
        return {
          fx: Math.round(f.x + f.width / 2), fy: Math.round(f.y + f.height / 2),
          tx: Math.round(${side === 'before'} ? t.x + t.width * 0.25 : t.x + t.width * 0.75),
          ty: Math.round(t.y + t.height / 2),
        };
      })())
    `),
  );
  // The DevTools protocol has no "drag a DOM element" verb, so the events the
  // browser would raise are raised here, at the real coordinates.
  await ev(`
    (() => {
      const tabs = document.querySelectorAll('.tab');
      const from = tabs[${fromIdx}], to = tabs[${toIdx}];
      const dt = new DataTransfer();
      const fire = (el, type, x, y) => el.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      fire(from, 'dragstart', ${box.fx}, ${box.fy});
      fire(to, 'dragover', ${box.tx}, ${box.ty});
      fire(to, 'drop', ${box.tx}, ${box.ty});
      fire(from, 'dragend', ${box.tx}, ${box.ty});
    })()
  `);
  await sleep(700);
};

await drag(2, 0, 'before');
const dragged = await order();
console.log(`    drag:   ${dragged.join(', ')}`);
check(dragged.join(',') === 'three,one,two', 'dragging the last tab to the front moves it there');

check(
  await ev(`JSON.parse(localStorage.getItem('sh.taborder') || '[]').length === 3`),
  'the order is written to this browser, not sent to the daemon',
);

await ev(`location.reload()`);
await sleep(5500);
check(
  await waitFor(`document.querySelectorAll('.tab').length === 3`, 20000),
  'the tabs come back after a reload',
);
check((await order()).join(',') === 'three,one,two', 'and keep the order they were dragged into');

// --- a phone, with no mouse and no spare gesture -----------------------------
// The pretend mouse goes away; this browser is coarse again, as a phone is.
await cmd('Page.removeScriptToEvaluateOnNewDocument', { identifier: asMouse.result.identifier });
await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cmd('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
});
await ev(`location.reload()`);
await sleep(6000);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(500);

check(
  !(await ev(`document.querySelector('.tab').draggable`)),
  'on a touch screen the tabs are not draggable — the strip scrolls sideways there',
);

// The menu the long press opens.
await ev(`
  document.querySelectorAll('.tab')[1].dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 60 }))
`);
await sleep(600);
const menu = await ev(`[...document.querySelectorAll('#menu > div')].map(x => x.textContent)`);
check(menu.includes('Move left') && menu.includes('Move right'), `the menu offers both moves (${menu.join(', ')})`);

await ev(`[...document.querySelectorAll('#menu > div')].find(x => x.textContent === 'Move left').click()`);
await sleep(700);
const moved = await order();
console.log(`    moved:  ${moved.join(', ')}`);
check(moved.join(',') === 'one,three,two', 'Move left moves that tab one place left');

// At the ends there is nowhere to go, and a dead entry teaches nothing.
await ev(`
  document.querySelectorAll('.tab')[0].dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }))
`);
await sleep(600);
const first = await ev(`[...document.querySelectorAll('#menu > div')].map(x => x.textContent)`);
check(
  !first.includes('Move left') && first.includes('Move right'),
  'the first tab is offered only Move right',
);
await ev(`document.getElementById('menu').hidden = true`);

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
